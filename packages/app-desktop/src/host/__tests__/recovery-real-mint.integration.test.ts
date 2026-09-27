/**
 * ADR 0016 through the WHOLE host against a REAL Cashu mint (integration fix 2). Opt-in: runs only
 * when `NUTFLIX_REAL_MINT_URL` names a mint — never in plain `npm test`, CI stays offline.
 * `scripts/real-mint/` starts a local Nutshell or cdk-mintd with a fake Lightning backend (nothing
 * real moves):
 *
 *   NUTFLIX_REAL_MINT_URL=http://127.0.0.1:3399 \
 *     npx vitest run packages/app-desktop/src/host/__tests__/recovery-real-mint.integration.test.ts
 *
 * The host takes https mints only (main's native fee dialog shows nothing else), so the wallet
 * names the mint by an https alias and the host's own transport (`mint-transport.ts`, node:http,
 * one attempt per request) carries each request to the local mint. Every run uses a fresh
 * identity and fresh phrases, so earlier runs against the same mint never collide.
 *
 * What only a real mint answers, end to end through the host and core's real NUT-13 code:
 *   - device A: funded with 2 000 sats, the phrase set up, its balance reissued into seeded
 *     outputs at the mint's real input fee — the fee main's dialog showed is the fee paid;
 *   - device B (a fresh profile, the same identity, relays that lost the ecash events): its own
 *     phrase set up (nothing to reissue), then a restore reads A's relay copy and gets the
 *     reissued balance back from the mint (NUT-09, NUT-12 DLEQ, NUT-07), spendable there: a send
 *     swaps part of it at the mint.
 */
import { randomBytes } from 'node:crypto';

import { getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { describe, expect, it, vi } from 'vitest';

import type { CashuP2pkPubkey, MintUrl, NostrEvent, Sats } from '@sovit/core';
import { nostr, wallet as walletMod } from '@sovit/core';

import { MELT_REQUEST_TIMEOUT_MS, MINT_REQUEST_TIMEOUT_MS } from '../../ipc/deadlines.js';
import type { ConfirmForm, HostOut } from '../../ipc/protocol.js';
import { hostRawHttp } from '../mint-transport.js';
import { entropyHexOf, wordsOf } from './support/fake-recovery.js';
import { LOST_ECASH_KINDS, fundWallet, recoveryProfile } from './support/real-recovery.js';

const REAL = process.env['NUTFLIX_REAL_MINT_URL'];
/** The name the wallet knows the mint by (the host takes https mints only). */
const ALIAS = 'https://real-mint.recovery.test' as MintUrl;
const PASS = 'a long enough passphrase';
const TO = Buffer.from(getPubKeyFromPrivKey(new Uint8Array(32).fill(0x4e))).toString(
  'hex',
) as CashuP2pkPubkey;

vi.setConfig({ testTimeout: 180_000 });

/** The host's transport, with the alias carried to the local mint; any other mint is refused. */
function aliasRequest(real: string) {
  const http: walletMod.RawHttp = (req) =>
    req.url.startsWith(`${ALIAS}/`)
      ? hostRawHttp({ ...req, url: `${real}${req.url.slice(ALIAS.length)}` })
      : Promise.reject(new Error('only the test mint is reachable'));
  const request = walletMod.cashuRequestFn(http, {
    timeoutMs: MINT_REQUEST_TIMEOUT_MS,
    meltTimeoutMs: MELT_REQUEST_TIMEOUT_MS,
  });
  return () => request;
}

async function inputFeePpk(real: string): Promise<number> {
  const res = (await (await fetch(`${real}/v1/keysets`)).json()) as {
    keysets: { unit: string; active: boolean; input_fee_ppk?: number }[];
  };
  return res.keysets.find((k) => k.active && k.unit === 'sat')?.input_fee_ppk ?? 0;
}

function reissueDialogs(
  posted: readonly HostOut[],
): Extract<ConfirmForm, { kind: 'recovery-reissue' }>[] {
  return posted.flatMap((o) =>
    o.kind === 'confirm' && o.form.kind === 'recovery-reissue' ? [o.form] : [],
  );
}

describe.skipIf(REAL === undefined)(
  `the recovery phrase through the host on a real mint (${REAL ?? 'NUTFLIX_REAL_MINT_URL unset'})`,
  () => {
    it('setup → reissue at the real fee → a fresh device of the same identity restores the balance from the relay copy and spends it', async () => {
      const real = REAL!.replace(/\/+$/, '');
      const mintRequest = aliasRequest(real);
      const key = randomBytes(32).toString('hex');
      const ppk = await inputFeePpk(real);

      // ---- device A ----------------------------------------------------------------------
      const a = await recoveryProfile({
        mintRequest,
        mints: [ALIAS],
        passphrase: PASS,
        secretKeyHex: key,
      });
      let kept: NostrEvent[];
      let reissued: number;
      let phraseA: readonly number[];
      try {
        await a.connect();
        await fundWallet(a, ALIAS, 2_000);
        expect(await a.r.host.adapter.wallet.balance(ALIAS)).toBe(2_000);
        const setup = await a.invoke('desktop.wallet.recovery.setup');
        expect(setup.ok).toBe(true);
        const result = setup.ok
          ? (setup.result as {
              status: unknown;
              reissuedSats: number;
              feeSats: number;
              reissueFailed: number;
            })
          : undefined;
        expect(result?.status).toEqual({
          state: 'covered',
          reissuePending: false,
          relayCopy: true,
        });
        expect(result?.reissueFailed).toBe(0);
        // The fee main's native dialog showed is the mint's input fee on those inputs, and it is
        // what the reissue cost.
        const [dialog] = reissueDialogs(a.posted);
        const plan = dialog?.plans[0];
        expect(plan).toMatchObject({ mint: ALIAS, amount: 2_000 });
        expect(plan?.feeSats).toBe(Math.ceil(((plan?.inputs ?? 0) * ppk) / 1000));
        expect(result?.feeSats).toBe(plan?.feeSats);
        reissued = result?.reissuedSats ?? 0;
        expect(reissued).toBe(2_000 - (plan?.feeSats ?? 0));
        expect(await a.r.host.adapter.wallet.balance(ALIAS)).toBe(reissued);
        phraseA = a.shown[0] ?? [];
        expect(phraseA).toHaveLength(12);
        kept = a.r.pool.events().filter((e) => !LOST_ECASH_KINDS.has(e.kind));
        expect(kept.some((e) => e.kind === walletMod.RECOVERY_RELAY_KIND)).toBe(true);
      } finally {
        await a.close();
      }

      // ---- device B: a fresh profile, the same identity, relays without the ecash events ----
      const pool = new nostr.FakeRelayPool();
      for (const e of kept) pool.store(e);
      const b = await recoveryProfile({
        mintRequest,
        mints: [ALIAS],
        passphrase: PASS,
        secretKeyHex: key,
        pool,
      });
      try {
        await b.connect();
        const wallet = b.r.host.adapter.wallet;
        expect(await wallet.balance(ALIAS)).toBe(0);
        const setup = await b.invoke('desktop.wallet.recovery.setup');
        expect(setup.ok && setup.result).toEqual({
          status: { state: 'covered', reissuePending: false, relayCopy: true },
          reissuedSats: 0,
          feeSats: 0,
          reissueFailed: 0,
        });
        const restored = await b.invoke('desktop.wallet.recovery.restore');
        expect(restored.ok && restored.result).toEqual({
          phrases: 2,
          reports: [{ mint: ALIAS, outcome: 'restored', restoredSats: reissued }],
        });
        expect(await wallet.balance(ALIAS)).toBe(reissued);
        // Spendable at the mint: a send swaps part of it there (its change derived from B's own
        // phrase, its input fee paid).
        await wallet.send(100 as Sats, { p2pk: TO, mint: ALIAS });
        const left = await wallet.balance(ALIAS);
        expect(left).toBeLessThan(reissued - 100 + 1);
        expect(left).toBeGreaterThan(reissued - 100 - 10);
        // The canary, on B: neither phrase, nor the key, nor the passphrase.
        const sinks = [
          JSON.stringify(
            b.posted.filter(
              (o) => o.kind === 'reply' || o.kind === 'event' || o.kind === 'sub-reply',
            ),
          ),
          b.r.log.lines.map((l) => JSON.stringify(l)).join('\n'),
        ];
        for (const phrase of [phraseA, b.shown[0] ?? []]) {
          const words = wordsOf(phrase);
          const entropy = entropyHexOf(walletMod.recoveryPhrases.fromIndices(phrase));
          for (const sink of sinks) {
            expect(sink).not.toContain(entropy);
            for (let i = 0; i + 2 <= words.length; i++)
              expect(sink).not.toContain(words.slice(i, i + 2).join(' '));
            expect(sink).not.toContain(key);
            expect(sink).not.toContain(PASS);
          }
        }
      } finally {
        await b.close();
      }
    });
  },
);

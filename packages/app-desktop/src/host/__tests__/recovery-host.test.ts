/**
 * ADR 0016 through the WHOLE host, on CORE's real NUT-13 code (lane N1, wired at
 * `recovery/core.ts` `recoveryCore()`): the renderer names an action (`desktop.wallet.recovery.*`
 * over the IPC wire), "main" (this test) answers the prompt window and the native confirm, the
 * money plane reopens with the phrase (the worker restarts around it), the wallet's real balance
 * on the in-process TestMint (100 ppk input fee) is planned and reissued into seeded outputs at
 * that mint, and a restore reports per mint. Everything the renderer received and every log line
 * is checked for the phrase (the canary), and everything sent to main was a valid, clonable
 * HostOut. A second device of the same identity, whose relays lost the wallet's ecash events, gets
 * the balance back from the first device's relay copy.
 *
 * Integration fix 2: this suite drove the fake N1 seam (`support/fake-recovery.ts`); once the real
 * core was wired, the reopened plane refused the fake's seed (core did not make it), so the wallet
 * never came back and the status read `unavailable`. Core's real phrases, seeds and seeded wallet
 * run here now (`support/real-recovery.ts`: a pass-through spy records what the plane handed core).
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { MintUrl, NostrEvent, Sats } from '@sovit/core';
import { mocks, nostr, wallet as walletMod } from '@sovit/core';

import { isHostOut } from '../../ipc/guards.js';
import type { HostOut } from '../../ipc/protocol.js';
import { IPC_V } from '../../ipc/protocol.js';
import { readEnvelope, recoveryPath } from '../recovery/files.js';
import { WALLET_DIR } from '../wallet-journal.js';
import { entropyHexOf, wordsOf } from './support/fake-recovery.js';
import type { RecoveryProfile } from './support/real-recovery.js';
import { LOST_ECASH_KINDS, fundWallet, recoveryProfile } from './support/real-recovery.js';
import { eventually } from './support/rig.js';

const MINT = 'https://mint.recovery-host.test' as MintUrl;
const PASS = 'a long enough passphrase';
/** One identity on two devices (imported on each): a test key, never a real one. */
const KEY = 'c3'.repeat(32);

const open: RecoveryProfile[] = [];
afterEach(async () => {
  for (const p of open.splice(0)) await p.close();
});

async function profile(
  o: Omit<Parameters<typeof recoveryProfile>[0], 'passphrase' | 'mints'>,
): Promise<RecoveryProfile> {
  const p = await recoveryProfile({ ...o, passphrase: PASS, mints: [MINT] });
  open.push(p);
  return p;
}

/** Nothing of a phrase — entropy, indices, two words in a row — nor `secrets` in `sink`. */
function expectClean(sink: string, indices: readonly number[], secrets: readonly string[]): void {
  const entropy = walletMod.recoveryPhrases.fromIndices(indices);
  expect(sink).not.toContain(entropyHexOf(entropy));
  expect(sink).not.toContain(JSON.stringify(indices));
  const words = wordsOf(indices);
  for (let i = 0; i + 2 <= words.length; i++)
    expect(sink).not.toContain(words.slice(i, i + 2).join(' '));
  for (const s of secrets) expect(sink).not.toContain(s);
}

/** What the renderer received, and every log line. */
function sinks(p: RecoveryProfile): string[] {
  return [
    JSON.stringify(
      p.posted.filter((o) => o.kind === 'reply' || o.kind === 'event' || o.kind === 'sub-reply'),
    ),
    p.r.log.lines.map((l) => JSON.stringify(l)).join('\n'),
  ];
}

describe('the recovery phrase through the host (ADR 0016, core’s real NUT-13 code)', () => {
  it('setup → covered with the balance reissued after the native fee confirm; restore reports per mint; the canary holds', async () => {
    const mint = new mocks.TestMint({
      url: MINT,
      seed: new Uint8Array(32).fill(0x61),
      inputFeePpk: 100,
    });
    const p = await profile({ mintRequest: () => mint.request });
    const r = p.r;

    // Before any signer: unavailable, and the flows refuse.
    const st0 = await p.invoke('desktop.wallet.recovery.status');
    expect(st0.ok && st0.result).toEqual({
      state: 'unavailable',
      reissuePending: false,
      relayCopy: false,
    });
    const refused = await p.invoke('desktop.wallet.recovery.setup');
    expect(!refused.ok && refused.error.code).toBe('payments-unavailable');
    // The renderer can name the action only: any argument is refused at the gate's guard.
    const withArgs = await p.invoke('desktop.wallet.recovery.restore', [[1, 2, 3]]);
    expect(!withArgs.ok && withArgs.error.code).toBe('invalid-argument');

    const pubkey = await p.connect();
    // Fund the wallet (the user's own Lightning top-up): 2 000 sats in six proofs, before any
    // phrase — random outputs.
    await fundWallet(p, MINT, 2_000, (id) => {
      mint.payQuote(id);
    });

    const st1 = await p.invoke('desktop.wallet.recovery.status');
    expect(st1.ok && st1.result).toEqual({
      state: 'not-on-device',
      reissuePending: false,
      relayCopy: false,
    });

    // Core plans the reissue at the mint (six inputs at 100 ppk: a 1 sat fee), main's native
    // dialog shows it, and core swaps the balance into outputs derived from the new phrase.
    const setup = await p.invoke('desktop.wallet.recovery.setup');
    expect(setup.ok && setup.result).toEqual({
      status: { state: 'covered', reissuePending: false, relayCopy: true },
      reissuedSats: 1_999,
      feeSats: 1,
      reissueFailed: 0,
    });
    expect(p.confirms).toEqual(['recovery-reissue']);
    expect(await r.host.adapter.wallet.balance(MINT)).toBe(1_999);
    // The plane reopened with the phrase: the worker restarted around it, and the new plane's
    // connections got core's seed with the counters file — the old one's seed is none.
    await eventually(() => r.spawned.length === 3, 'the worker restart after the reopen');
    await r.ready();
    expect(p.spy.materials).toHaveLength(1);
    expect(p.spy.materials[0]?.counters).toMatchObject({
      path: join(r.userData, WALLET_DIR, `counters-${pubkey}.json`),
    });
    expect(p.spy.materials[0]?.seed.wiped).toBe(false);
    // The sealed file: 0600, NIP-44 to self; the relay copy on the user's write relay.
    const path = recoveryPath(join(r.userData, WALLET_DIR), pubkey);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    const env = await readEnvelope(path);
    expect(env).toMatchObject({ confirmed: true, reissued: true, relayCopy: true });
    expect(env?.reissuedMints).toEqual([MINT]);
    const copy = r.pool.published.find((x) => x.event.kind === walletMod.RECOVERY_RELAY_KIND);
    expect(copy?.event.content).toBe(env?.sealed);
    expect(copy?.relays).toEqual(['wss://a.test']);

    // Restore: progress events to a subscriber, one row per mint. This device's phrase and its
    // relay copy are one phrase; what it finds at the mint is the reissued balance, already held.
    r.host.handle({
      kind: 'sub',
      wc: 3,
      msg: { v: IPC_V, op: 'sub', subId: 77, topic: { t: 'recovery.progress' } },
    });
    const restored = await p.invoke('desktop.wallet.recovery.restore');
    expect(restored.ok && restored.result).toEqual({
      phrases: 1,
      reports: [{ mint: MINT, outcome: 'nothing', restoredSats: 0 }],
    });
    const progress = r.out.filter(
      (o): o is Extract<HostOut, { kind: 'event' }> => o.kind === 'event' && o.msg.subId === 77,
    );
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]?.msg.payload).toMatchObject({ phrase: 1, phrases: 1, mint: MINT });
    expect(await r.host.adapter.wallet.balance(MINT)).toBe(1_999);

    // Show again: the passphrase first, then the same indices.
    const shownAgain = await p.invoke('desktop.wallet.recovery.show');
    expect(shownAgain.ok).toBe(true);
    expect(p.shown).toHaveLength(2);
    const indices = p.shown[0] ?? [];
    expect(indices).toHaveLength(12);
    expect(p.shown[1]).toEqual(indices);

    // ---- the canary --------------------------------------------------------------------------
    for (const o of r.out) {
      expect(isHostOut(o), o.kind).toBe(true);
      expect(structuredClone(o)).toEqual(o);
    }
    for (const sink of sinks(p)) expectClean(sink, indices, [PASS]);
    // The words went to main ONLY as indices in prompt forms — never anywhere else.
    const withIndices = p.posted.filter((o) => JSON.stringify(o).includes(JSON.stringify(indices)));
    expect(withIndices.every((o) => o.kind === 'prompt' && o.form.kind === 'recovery-show')).toBe(
      true,
    );
    expect(withIndices).toHaveLength(2); // setup's show, and show again
    // …and the host zeroed its own copy of those indices once each question was answered.
    const hostCopies = r.out.filter(
      (o): o is Extract<HostOut, { kind: 'prompt' }> =>
        o.kind === 'prompt' && o.form.kind === 'recovery-show',
    );
    expect(hostCopies).toHaveLength(2);
    for (const o of hostCopies)
      expect(o.form.kind === 'recovery-show' && o.form.words.every((w) => w === 0)).toBe(true);
  }, 90_000);

  it('another device of the same identity, whose relays lost the ecash events, gets the reissued balance back from the relay copy', async () => {
    const mint = new mocks.TestMint({
      url: MINT,
      seed: new Uint8Array(32).fill(0x62),
      inputFeePpk: 100,
    });
    // Device A: the identity imported, a wallet created, 2 000 sats, the phrase set up.
    const a = await profile({ mintRequest: () => mint.request, secretKeyHex: KEY });
    await a.connect();
    await fundWallet(a, MINT, 2_000, (id) => {
      mint.payQuote(id);
    });
    const setupA = await a.invoke('desktop.wallet.recovery.setup');
    expect(setupA.ok && setupA.result).toMatchObject({
      status: { state: 'covered', relayCopy: true },
      reissuedSats: 1_999,
      feeSats: 1,
    });
    const phraseA = a.shown[0] ?? [];
    // What the relays keep: the wallet event (kind 17375), the relay copy (30078) and the rest —
    // not the tokens, the spending history or their deletions.
    const kept: NostrEvent[] = a.r.pool.events().filter((e) => !LOST_ECASH_KINDS.has(e.kind));
    expect(kept.some((e) => e.kind === walletMod.RECOVERY_RELAY_KIND)).toBe(true);
    expect(kept.some((e) => e.kind === 17375)).toBe(true);
    const pool = new nostr.FakeRelayPool();
    for (const e of kept) pool.store(e);
    await a.close();
    open.splice(open.indexOf(a), 1);

    // Device B: a fresh profile (no phrase file, no counters, no journal), the same identity.
    const b = await profile({ mintRequest: () => mint.request, secretKeyHex: KEY, pool });
    await b.connect();
    expect(await b.r.host.adapter.wallet.balance(MINT)).toBe(0);
    // A restore runs through the wallet this device's own phrase seeds (the seam): B sets one up
    // first — nothing to reissue, no fee dialog.
    const setupB = await b.invoke('desktop.wallet.recovery.setup');
    expect(setupB.ok && setupB.result).toEqual({
      status: { state: 'covered', reissuePending: false, relayCopy: true },
      reissuedSats: 0,
      feeSats: 0,
      reissueFailed: 0,
    });
    expect(b.confirms).toEqual([]);
    // Restore: B's phrase, and every relay copy the identity decrypts — A's among them.
    const restored = await b.invoke('desktop.wallet.recovery.restore');
    expect(restored.ok && restored.result).toEqual({
      phrases: 2,
      reports: [{ mint: MINT, outcome: 'restored', restoredSats: 1_999 }],
    });
    expect(await b.r.host.adapter.wallet.balance(MINT)).toBe(1_999);
    // A second restore finds the same proofs held: nothing is added twice.
    const again = await b.invoke('desktop.wallet.recovery.restore');
    expect(again.ok && again.result).toEqual({
      phrases: 2,
      reports: [{ mint: MINT, outcome: 'nothing', restoredSats: 0 }],
    });
    expect(await b.r.host.adapter.wallet.balance(MINT)).toBe(1_999);

    // The canary, on B: neither phrase, nor the key, nor the passphrase.
    const phraseB = b.shown[0] ?? [];
    expect(phraseB).toHaveLength(12);
    expect(phraseB).not.toEqual(phraseA);
    for (const sink of sinks(b)) {
      expectClean(sink, phraseA, [PASS, KEY]);
      expectClean(sink, phraseB, [PASS, KEY]);
    }
  }, 120_000);

  // W8a (final cross-lane review [medium] service.ts:736): a lost heavy-use device's phrase has
  // signed outputs from counter 0 to far past core's per-call cap (200 batches of 100 = 20 000);
  // its newest — unspent — ecash sits at the top. The restore stopped at 20 000 and said
  // "refused". It now follows core's resume, in one restore.
  // 101 real top-ups and ~260 NUT-09 batches of 100 derived outputs against the in-process mint:
  // well past vitest's default on a shared box, hence the explicit budget.
  it('a phrase whose outputs run past 20 000 counters is restored whole in one restore (core’s resume followed)', async () => {
    const mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x64) });
    // Device X, heavy use: one signature every 250 counters from 0 to 25 000 (never three empty
    // batches in a row), each a 1-sat top-up — unspent.
    const X = '3d'.repeat(16);
    const seedX = await walletMod.recoveryPhrases.toSeed(walletMod.entropyFromHex(X));
    const conns = new walletMod.CashuMintConnections({
      request: () => mint.request,
      seed: {
        seed: seedX,
        counters: new mocks.MemoryCounterStore({
          v: 1,
          next: { [mint.keysetId]: 0 },
          published: {},
        }),
      },
    });
    const x = new walletMod.CashuWallet({ mints: conns, store: new walletMod.MemoryProofStore() });
    let issued = 0;
    for (let c = 0; c <= 25_000; c += 250) {
      await conns.seeding!.counters.advanceToAtLeast(mint.keysetId, c);
      const q = await x.mintQuote(MINT, 1 as Sats);
      mint.payQuote(q.quoteId);
      await x.pollQuote(q);
      issued++;
    }
    await x.close();
    expect(issued).toBe(101);
    const words = walletMod.recoveryPhrases.toIndices(walletMod.entropyFromHex(X));

    // Device B: its own phrase, then a restore with X's words typed in.
    const b = await profile({
      mintRequest: () => mint.request,
      restoreAnswer: { kind: 'recovery-restore', words: [...words] },
    });
    await b.connect();
    const setup = await b.invoke('desktop.wallet.recovery.setup');
    expect(setup.ok && setup.result).toMatchObject({ status: { state: 'covered' } });
    const restored = await b.invoke('desktop.wallet.recovery.restore');
    expect(restored.ok && restored.result).toEqual({
      phrases: 2,
      reports: [{ mint: MINT, outcome: 'restored', restoredSats: 101 }],
    });
    expect(await b.r.host.adapter.wallet.balance(MINT)).toBe(101);
    // The top: the signature at counter 25 000 is past the first call's reach.
    expect(mint.calls.filter((c) => c === 'POST /v1/restore').length).toBeGreaterThan(250);
    for (const sink of sinks(b)) expectClean(sink, words, [PASS]);
  }, 240_000);
});

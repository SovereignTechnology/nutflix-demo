/**
 * The money path against a REAL Cashu mint (security review F6; execution plan §4 "real-mint
 * testing lane"). Opt-in: runs only when `NUTFLIX_REAL_MINT_URL` names a mint, never in plain
 * `npm test` — CI stays offline. `scripts/real-mint/nutshell.sh` starts a local Nutshell with the
 * FakeWallet Lightning backend (invoices settle at once, nothing real moves).
 *
 * What only a real mint can answer:
 *   - does it accept the `pay1` NUT-10 tag on a P2PK secret (ADR 0010 §6) — and still enforce the
 *     lock (no witness, or the wrong key, is refused)?
 *   - do its signatures carry DLEQ proofs our wallet verifies (NUT-12), with a v2 keyset id?
 *   - does the engine's whole pay/1 path — offline verify against the mint's keyset, redeem with
 *     the seeder's key, the creator redeeming its share — survive real input fees?
 *   - is a replayed set refused at the mint (double-spend → ban), and does NUT-07 return the
 *     witness `spentByUs` relies on?
 */
import { Mint, Wallet as CashuTsWallet } from '@cashu/cashu-ts';
import { getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { describe, expect, it, vi } from 'vitest';

import type {
  CashuP2pkPubkey,
  CoreKeyHex,
  LockedProofSet,
  MintUrl,
  NostrPubkey,
  PricePolicy,
  Sats,
} from '../contracts/index.js';
import { RealPaymentEngine } from '../payment/engine.js';
import { SeenSecrets } from '../payment/seen.js';
import { MemoryProofStore } from '../wallet/store.js';
import { toCashu } from '../wallet/spend.js';
import type { RawHttp } from '../wallet/transport.js';
import { cashuRequestFn } from '../wallet/transport.js';
import { CashuMintConnections, CashuWallet, memoryWalletKey } from '../wallet/wallet.js';

const MINT_URL = process.env['NUTFLIX_REAL_MINT_URL'] as MintUrl | undefined;
/** A second mint whose invoices the first one pays as EXTERNAL Lightning invoices (melt test). */
const MINT_URL_2 = process.env['NUTFLIX_REAL_MINT_URL_2'] as MintUrl | undefined;

vi.setConfig({ testTimeout: 120_000 });

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** A deterministic test key pair (a fixture scalar, never a real key). */
function keyOf(fill: number): { sk: Uint8Array; pub: CashuP2pkPubkey } {
  const sk = new Uint8Array(32).fill(fill);
  return { sk, pub: hex(getPubKeyFromPrivKey(sk)) as CashuP2pkPubkey };
}

const CORE = 'c0'.repeat(32) as CoreKeyHex;
const SEEDER = 'a1'.repeat(32) as NostrPubkey;
const VIEWER = 'b2'.repeat(32) as NostrPubkey;

function wallet(key?: Uint8Array): CashuWallet {
  return new CashuWallet({
    mints: new CashuMintConnections(),
    store: new MemoryProofStore(),
    ...(key === undefined ? {} : { key: memoryWalletKey(key) }),
  });
}

/** Mint `amount` sats into `w` (FakeWallet settles the invoice by itself). */
async function fund(w: CashuWallet, mint: MintUrl, amount: number): Promise<void> {
  const q = await w.mintQuote(mint, amount as Sats);
  for (let i = 0; i < 50; i++) {
    const r = await w.pollQuote(q);
    if (r.state === 'ISSUED') return;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('the mint never marked the quote paid');
}

/** The mint's input fee for `n` proofs, from its active keyset (NUT-02: ceil(n × ppk / 1000)). */
async function inputFee(mint: MintUrl, n: number): Promise<number> {
  const res = await fetch(`${mint}/v1/keysets`);
  const body = (await res.json()) as { keysets: { active: boolean; input_fee_ppk?: number }[] };
  const ppk = body.keysets.find((k) => k.active)?.input_fee_ppk ?? 0;
  return Math.ceil((n * ppk) / 1000);
}

const total = (s: { readonly proofs: readonly { amount: number }[] }): number =>
  s.proofs.reduce((a, p) => a + p.amount, 0);

describe.skipIf(MINT_URL === undefined)(
  `real mint (${MINT_URL ?? 'NUTFLIX_REAL_MINT_URL unset'})`,
  () => {
    const mint = MINT_URL!;
    const seederKey = keyOf(61);
    const creatorKey = keyOf(62);

    it('advertises NUT-10, NUT-11 and NUT-12 (the lock and DLEQ the protocol relies on)', async () => {
      const info = (await (await fetch(`${mint}/v1/info`)).json()) as {
        nuts: Record<string, { supported?: boolean }>;
      };
      for (const nut of ['10', '11', '12'])
        expect(info.nuts[nut]?.supported, `NUT-${nut}`).toBe(true);
    });

    it('F17: a NUT-20 locked quote mints only with the wallet key — the amended signature, first try', async () => {
      const info = (await (await fetch(`${mint}/v1/info`)).json()) as {
        nuts: Record<string, { supported?: boolean }>;
      };
      expect(info.nuts['20']?.supported, 'NUT-20').toBe(true);
      const mintPosts: number[] = [];
      const http: RawHttp = async (req) => {
        if (req.method === 'POST' && req.url.endsWith('/v1/mint/bolt11')) mintPosts.push(0);
        const res = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          ...(req.body === undefined ? {} : { body: req.body }),
        });
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k] = v;
        });
        return { status: res.status, headers, body: await res.text() };
      };
      const me = keyOf(0x41);
      const w = new CashuWallet({
        mints: new CashuMintConnections({ request: () => cashuRequestFn(http) }),
        store: new MemoryProofStore(),
        key: memoryWalletKey(me.sk),
      });
      const q = await w.mintQuote(mint, 16 as Sats);
      const state = async (): Promise<{ state: string; pubkey?: string }> =>
        (await (await fetch(`${mint}/v1/mint/quote/bolt11/${q.quoteId}`)).json()) as {
          state: string;
          pubkey?: string;
        };
      expect((await state()).pubkey).toBe(me.pub);
      for (let i = 0; i < 50 && (await state()).state !== 'PAID'; i++)
        await new Promise((r) => setTimeout(r, 100));
      expect((await state()).state).toBe('PAID');
      // Someone with only the quote id: an unsigned mint is refused BY THE MINT.
      const raw = new CashuTsWallet(new Mint(mint), { unit: 'sat' });
      await raw.loadMint();
      await expect(raw.mintProofsBolt11(16, q.quoteId)).rejects.toThrow();
      expect((await state()).state).toBe('PAID');
      // The owner mints, with one request: the mint took the amended NUT-20 signature (a legacy
      // fallback would have cost a refused first POST).
      expect(await w.pollQuote(q)).toEqual({ state: 'ISSUED', minted: 16 });
      expect(mintPosts).toHaveLength(1);
      expect(await w.balance(mint)).toBe(16);
    });

    it('F31 (ADR 0014): answers lost after the mint executed — the top-up is minted, the send completes, the receive is restored (NUT-09)', async () => {
      const info = (await (await fetch(`${mint}/v1/info`)).json()) as {
        nuts: Record<string, { supported?: boolean }>;
      };
      expect(info.nuts['9']?.supported, 'NUT-09').toBe(true);
      /** Real HTTP that runs the request, then loses the answer to the next POST on `drop`. */
      let drop: string | null = null;
      const http: RawHttp = async (req) => {
        const res = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          ...(req.body === undefined ? {} : { body: req.body }),
        });
        const body = await res.text();
        if (drop !== null && req.method === 'POST' && req.url.endsWith(drop)) {
          drop = null;
          throw new Error('socket hang up');
        }
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k] = v;
        });
        return { status: res.status, headers, body };
      };
      const lossyWallet = (key: Uint8Array): { w: CashuWallet; store: MemoryProofStore } => {
        const store = new MemoryProofStore();
        return {
          store,
          w: new CashuWallet({
            mints: new CashuMintConnections({ request: () => cashuRequestFn(http) }),
            store,
            key: memoryWalletKey(key),
          }),
        };
      };
      const a = lossyWallet(keyOf(0x51).sk);
      const q = await a.w.mintQuote(mint, 32 as Sats);
      for (let i = 0; i < 50; i++) {
        const st = (await (await fetch(`${mint}/v1/mint/quote/bolt11/${q.quoteId}`)).json()) as {
          state: string;
        };
        if (st.state === 'PAID') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      drop = '/v1/mint/bolt11';
      expect(await a.w.pollQuote(q)).toEqual({ state: 'ISSUED', minted: 32 });
      expect(drop).toBeNull(); // the answer really was lost
      expect(await a.w.balance(mint)).toBe(32);

      const b = keyOf(0x52);
      drop = '/v1/swap';
      const set = await a.w.send(5 as Sats, { p2pk: b.pub, mint });
      expect(drop).toBeNull();
      expect(total(set)).toBe(5);
      const [sent] = await a.w.history({ limit: 1 });
      expect(await a.w.balance(mint)).toBe(32 - (sent?.amount ?? 0));

      const bob = lossyWallet(b.sk);
      drop = '/v1/swap';
      expect(await bob.w.receive(set)).toBe(5 - (await inputFee(mint, set.proofs.length)));
      expect(drop).toBeNull();
      expect(await a.store.pending(mint)).toEqual([]);
      expect(await bob.store.pending(mint)).toEqual([]);
      // Nothing was double-counted: bob's proofs are unspent at the mint, the set is spent.
      expect(await bob.w.checkSpent({ mint, proofs: await bob.store.proofs(mint) })).not.toContain(
        true,
      );
      expect(await bob.w.checkSpent(set)).not.toContain(false);
    });

    it('F6: a pay1-tagged creator set is redeemable by the creator — the mint accepts the NUT-10 tag — and still enforces the lock', async () => {
      const viewer = wallet();
      await fund(viewer, mint, 64);
      // `send` post-checks every output: sum, DLEQ with r against the mint's keyset, lock policy.
      const set = await viewer.send(8 as Sats, {
        p2pk: creatorKey.pub,
        mint,
        tags: [['pay1', seederKey.pub]],
      });
      expect(total(set)).toBe(8);
      expect(set.proofs.every((p) => p.dleq?.r !== undefined)).toBe(true);
      expect(set.proofs.every((p) => p.secret.includes('"pay1"'))).toBe(true);

      // Without a witness the mint refuses (the tag did not weaken the P2PK lock).
      const raw = new CashuTsWallet(new Mint(mint), { unit: 'sat' });
      await raw.loadMint();
      await expect(raw.receive(set.proofs.map(toCashu))).rejects.toThrow();

      // With the creator's signature it accepts: that is the answer F6 needed.
      const creator = wallet(creatorKey.sk);
      const got = await creator.receive(set);
      expect(got).toBe(8 - (await inputFee(mint, set.proofs.length)));
      // The seeder's wallet refuses it before it ever reaches the mint.
      await expect(wallet(seederKey.sk).receive(set)).rejects.toMatchObject({ code: 'not-ours' });
    });

    it('the pay/1 money path end to end: offline verify against the mint keyset, redeem with the seeder key, the creator redeems its share, a replay is refused at the mint', async () => {
      const viewerWallet = wallet();
      await fund(viewerWallet, mint, 200);
      const seederWallet = wallet(seederKey.sk);
      const creatorWallet = wallet(creatorKey.sk);
      const zaps: LockedProofSet[] = [];
      const seederDeps = {
        config: {
          windowBlocks: 16,
          acceptedMints: [mint],
          ownP2pk: seederKey.pub,
          ownPubkey: SEEDER,
          flushEveryBlocks: 64,
          flushEveryMs: 60_000,
        },
        keyset: (m: MintUrl, id: string) => seederWallet.keyset(m, id),
        redeem: (s: { mint: MintUrl; proofs: readonly LockedProofSet['proofs'][number][] }) =>
          seederWallet.receive(s),
        nutzap: (s: LockedProofSet) => {
          zaps.push(s);
          return Promise.resolve();
        },
        checkSpent: (s: { mint: MintUrl; proofs: readonly LockedProofSet['proofs'][number][] }) =>
          seederWallet.checkSpent(s),
        spentByUs: (s: { mint: MintUrl; proofs: readonly LockedProofSet['proofs'][number][] }) =>
          seederWallet.spentByUs(s),
      };
      const seeder = new RealPaymentEngine({ ...seederDeps, seen: new SeenSecrets() });
      const viewer = new RealPaymentEngine({
        config: { ...seederDeps.config, acceptedMints: [], ownPubkey: VIEWER },
        wallet: viewerWallet,
      });
      const policy: PricePolicy = {
        satsPerBlock: 5 as Sats,
        blockSize: 65_536,
        mints: [mint],
        split: { seeder: 60, creator: 40 },
        creatorP2pk: creatorKey.pub,
        minPaySats: 1 as Sats,
      };
      for (let i = 0; i < 8; i++)
        seeder.recordUpload(VIEWER, { core: CORE, fromBlock: i, toBlock: i }, policy);

      const msg = await viewer.pay(
        { core: CORE, fromBlock: 0, toBlock: 3 },
        { pubkey: SEEDER, p2pk: seederKey.pub, mint },
        policy,
      );
      expect(total(msg.seederProofs)).toBe(12);
      expect(total(msg.creatorProofs)).toBe(8);
      // Offline: DLEQ against the keyset fetched from the mint, locks parsed from the secrets.
      expect(await seeder.verify(VIEWER, msg, policy)).toEqual({
        ok: true,
        credited: 20,
        blocks: 4,
      });

      const flushed = await seeder.flush();
      expect(flushed).toEqual({ swapped: 12, nutzapped: 8, failed: 0 });
      expect(await seederWallet.balance(mint)).toBe(
        12 - (await inputFee(mint, msg.seederProofs.proofs.length)),
      );
      expect(zaps).toHaveLength(1);
      expect(await creatorWallet.receive(zaps[0]!)).toBe(
        8 - (await inputFee(mint, zaps[0]!.proofs.length)),
      );

      // NUT-07 returns the witness: the seeder set reads as spent by the seeder's own key.
      expect(await seederWallet.spentByUs(msg.seederProofs)).toBe(true);
      expect(await seederWallet.checkSpent(msg.seederProofs)).toEqual(
        msg.seederProofs.proofs.map(() => true),
      );

      // A replay to a seeder that lost its seen set (a restart): accepted offline, refused by the
      // mint on its FIRST redeem → a double-spend ban, even though the witness is ours (F31).
      const restarted = new RealPaymentEngine({ ...seederDeps, seen: new SeenSecrets() });
      for (let i = 0; i < 8; i++)
        restarted.recordUpload(VIEWER, { core: CORE, fromBlock: i, toBlock: i }, policy);
      const replay = { ...msg, range: { core: CORE, fromBlock: 4, toBlock: 7 } };
      expect(await restarted.verify(VIEWER, replay, policy)).toMatchObject({ ok: true });
      expect(await restarted.flush()).toMatchObject({ swapped: 0, failed: 1 });
      expect(restarted.isBanned(VIEWER)).toBe(true);
    });

    // FakeWallet marks a mint's OWN invoices paid at once, so paying one of them internally is
    // refused ("mint quote already paid"); an invoice from a second mint is an external payment.
    it.skipIf(MINT_URL_2 === undefined)(
      'melt pays an external bolt11 invoice (from a second mint) and the unused fee reserve comes back as change',
      async () => {
        const payer = wallet();
        await fund(payer, mint, 100);
        const invoice = await wallet().mintQuote(MINT_URL_2!, 21 as Sats);
        const q = await payer.meltQuote(mint, invoice.bolt11);
        expect(q.amount).toBe(21);
        const r = await payer.melt(q);
        expect(r.paid).toBe(true);
        const spent = 100 - (await payer.balance(mint));
        // 21 plus at most the fee reserve and the input fee; the unused reserve came back.
        expect(spent).toBeGreaterThanOrEqual(21);
        expect(spent).toBeLessThanOrEqual(21 + q.feeReserve + (await inputFee(mint, 8)));
        expect(r.change).toBeGreaterThanOrEqual(0);
      },
    );
  },
);

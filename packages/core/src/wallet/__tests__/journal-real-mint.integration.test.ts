/**
 * Issue #8 (ADR 0014 amendment) against a REAL Cashu mint. Opt-in: runs only when
 * `NUTFLIX_REAL_MINT_URL` names a mint (and, for melts, `NUTFLIX_REAL_MINT_URL_2` a second one
 * whose invoices are external payments) — never in plain `npm test`. See `scripts/real-mint/`.
 *
 * What only a real mint answers:
 *   - melt change on NUT-08 blanks, restored by NUT-09 when the melt's answer is lost — does the
 *     mint remember the change signatures under the blanks' `B_`, with the amounts IT assigned?
 *   - the desktop's sealed journal (NIP-60 store + `SealedJournal`) holding a real mint's
 *     outputs (v2 keyset ids, real blinding factors) across a "crash", and recovering from it;
 *   - held inputs out of the balance while the mint's answer is unknown, and spent exactly once;
 *   - (issue #8 review) held inputs come back by themselves once the wait is over (`SettleLoop`,
 *     the mint's own NUT-07 answer), and a retry of a melt whose change an earlier settle restored
 *     answers "paid" from the mint's quote state, without a second melt request;
 *   - (issue #8 fix round 2) a swap that executed, its answer lost, then a 429 on the retry — the
 *     verifier's run on cdk-mintd lost the outputs: with a retrying stand-in transport and with
 *     cashu-ts's own fetch transport, nothing is lost now; and the Node transport every production
 *     wallet uses (`httpModuleRawHttp` under `cashuRequestFn`) sends a lost swap ONCE, even to a
 *     mint that advertises NUT-19.
 */
import * as nodeHttp from 'node:http';
import * as nodeHttps from 'node:https';

import { getPubKeyFromPrivKey, RateLimitError, type RequestFn } from '@cashu/cashu-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  CashuP2pkPubkey,
  MintUrl,
  NostrEvent,
  NostrFilter,
  Sats,
  UnixSeconds,
} from '../../contracts/index.js';
import { minimumCost } from '../../signer/keyfile.js';
import { LocalSigner } from '../../signer/local.js';
import { Nip60ProofStore, type Nip60Relays } from '../nip60.js';
import { httpModuleRawHttp } from '../http-module.js';
import { SealedJournal, type JournalFile } from '../nip60-journal.js';
import { SettleLoop } from '../settle-loop.js';
import { PENDING_SETTLE_AFTER_S } from '../spend.js';
import { MemoryProofStore, type ProofStore } from '../store.js';
import type { RawHttp } from '../transport.js';
import { cashuRequestFn } from '../transport.js';
import { CashuMintConnections, CashuWallet } from '../wallet.js';

const MINT_URL = process.env['NUTFLIX_REAL_MINT_URL'] as MintUrl | undefined;
const MINT_URL_2 = process.env['NUTFLIX_REAL_MINT_URL_2'] as MintUrl | undefined;

vi.setConfig({ testTimeout: 120_000 });

const TO = Buffer.from(getPubKeyFromPrivKey(new Uint8Array(32).fill(0x61))).toString(
  'hex',
) as CashuP2pkPubkey;

/**
 * Real HTTP that can lose the answer to the next POST on a path, refuse the next POST on a path
 * before it is sent (connection refused), or refuse restores.
 */
function lossy() {
  const st = { drop: null as string | null, refuse: null as string | null, restoreDown: false };
  const http: RawHttp = async (req) => {
    if (st.restoreDown && req.url.endsWith('/v1/restore')) throw new Error('connect ETIMEDOUT');
    if (st.refuse !== null && req.method === 'POST' && req.url.endsWith(st.refuse)) {
      st.refuse = null;
      throw new Error('connect ECONNREFUSED');
    }
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body === undefined ? {} : { body: req.body }),
    });
    const body = await res.text();
    if (st.drop !== null && req.method === 'POST' && req.url.endsWith(st.drop)) {
      st.drop = null;
      throw new Error('socket hang up');
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return { status: res.status, headers, body };
  };
  return { st, request: cashuRequestFn(http) };
}

function walletOver(
  store: ProofStore,
  request?: ReturnType<typeof cashuRequestFn>,
  now?: () => UnixSeconds,
): CashuWallet {
  return new CashuWallet({
    mints: new CashuMintConnections(request === undefined ? {} : { request: () => request }),
    store,
    ...(now === undefined ? {} : { now }),
  });
}

async function fund(w: CashuWallet, mint: MintUrl, amount: number): Promise<void> {
  const q = await w.mintQuote(mint, amount as Sats);
  for (let i = 0; i < 50; i++) {
    const r = await w.pollQuote(q);
    if (r.state === 'ISSUED') return;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('the mint never marked the quote paid');
}

function memFile(): JournalFile & { text: string | null } {
  const f = {
    text: null as string | null,
    read: () => Promise.resolve(f.text),
    write: (t: string) => {
      f.text = t;
      return Promise.resolve();
    },
  };
  return f;
}

function relay(): Nip60Relays & { events: NostrEvent[] } {
  const r = {
    events: [] as NostrEvent[],
    publish: (e: NostrEvent) => {
      r.events.push(e);
      return Promise.resolve();
    },
    query: (f: NostrFilter) =>
      Promise.resolve(
        r.events.filter(
          (e) =>
            (f.kinds === undefined || f.kinds.includes(e.kind)) &&
            (f.authors === undefined || f.authors.includes(e.pubkey)),
        ),
      ),
  };
  return r;
}

describe.skipIf(MINT_URL === undefined)(
  `issue #8 on a real mint (${MINT_URL ?? 'NUTFLIX_REAL_MINT_URL unset'})`,
  () => {
    const mint = MINT_URL!;

    it('held inputs: out of the balance while the answer is unknown, then spent once and the change restored', async () => {
      const net = lossy();
      const store = new MemoryProofStore();
      const w = walletOver(store, net.request);
      await fund(w, mint, 64);
      const before = await w.balance(mint);
      net.st.drop = '/v1/swap';
      net.st.restoreDown = true;
      await expect(w.send(5 as Sats, { p2pk: TO, mint })).rejects.toThrow(/mint-error/);
      const [op] = await store.pending(mint);
      expect(op?.kind).toBe('send');
      const held = op?.spends.reduce((a, p) => a + p.amount, 0) ?? 0;
      expect(held).toBeGreaterThan(0);
      expect(await w.balance(mint)).toBe(before - held);
      net.st.restoreDown = false;
      expect(await w.recoverPending()).toEqual({ recovered: 1, left: 0 });
      const [sent] = await w.history({ limit: 1, mint });
      expect(await w.balance(mint)).toBe(before - (sent?.amount ?? 0));
      // The inputs are spent at the mint (once: by the swap whose answer was lost); what the
      // wallet now holds is unspent.
      expect(await w.checkSpent({ mint, proofs: op?.spends ?? [] })).not.toContain(false);
      expect(await w.checkSpent({ mint, proofs: await store.proofs(mint) })).not.toContain(true);
    });

    it('the sealed NIP-60 journal holds a real mint’s outputs across a crash and recovers them', async () => {
      const net = lossy();
      const s = (
        await LocalSigner.create({
          passphrase: new TextEncoder().encode('real mint journal'),
          cost: minimumCost(),
        })
      ).signer;
      const me = await s.getPublicKey();
      const file = memFile();
      const r = relay();
      const open = async (): Promise<Nip60ProofStore> =>
        Nip60ProofStore.load({
          signer: s,
          relays: r,
          journal: await SealedJournal.open({ file, signer: s, pubkey: me }),
        });
      const w = walletOver(await open(), net.request);
      await fund(w, mint, 32);
      net.st.drop = '/v1/swap';
      net.st.restoreDown = true;
      await expect(w.send(4 as Sats, { p2pk: TO, mint })).rejects.toThrow(/mint-error/);
      // "Crash": a new store from the sealed journal and the relays; the mint answers again.
      net.st.restoreDown = false;
      const store = await open();
      expect((await store.pending(mint)).map((o) => o.kind)).toEqual(['send']);
      const after = walletOver(store, net.request);
      expect(await after.recoverPending()).toEqual({ recovered: 1, left: 0 });
      expect(await store.pending(mint)).toEqual([]);
      const [sent] = await after.history({ limit: 1, mint });
      expect(await after.balance(mint)).toBe(32 - (sent?.amount ?? 0));
      expect(await after.checkSpent({ mint, proofs: await store.proofs(mint) })).not.toContain(
        true,
      );
    });

    it('held inputs come back by themselves after the wait (SettleLoop; the mint’s NUT-07 answer)', async () => {
      const net = lossy();
      const store = new MemoryProofStore();
      let t = Math.floor(Date.now() / 1000);
      const now = (): UnixSeconds => t as UnixSeconds;
      const w = walletOver(store, net.request, now);
      await fund(w, mint, 32);
      const before = await w.balance(mint);
      const planned: (() => void)[] = [];
      const loop = new SettleLoop({
        wallet: w,
        now,
        timer: (fn) => {
          planned.push(fn);
          return () => undefined;
        },
      });
      loop.start();
      net.st.refuse = '/v1/swap'; // never reaches the mint
      await expect(w.send(4 as Sats, { p2pk: TO, mint })).rejects.toThrow(/mint-error/);
      expect(await w.balance(mint)).toBeLessThan(before);
      await loop.idle();
      expect(planned.length).toBeGreaterThan(0);
      t += PENDING_SETTLE_AFTER_S + 60;
      planned.at(-1)?.();
      await loop.idle();
      expect(await store.pending(mint)).toEqual([]);
      expect(await w.balance(mint)).toBe(before);
      expect(await w.checkSpent({ mint, proofs: await store.proofs(mint) })).not.toContain(true);
      loop.stop();
    });

    it.skipIf(MINT_URL_2 === undefined)(
      'a retry of a melt whose change the startup settle restored answers paid — from the mint’s quote state, no second request',
      async () => {
        const net = lossy();
        const store = new MemoryProofStore();
        const w = walletOver(store, net.request);
        await fund(w, mint, 100);
        const invoice = await walletOver(new MemoryProofStore()).mintQuote(MINT_URL_2!, 13 as Sats);
        const q = await w.meltQuote(mint, invoice.bolt11);
        net.st.drop = '/v1/melt/bolt11';
        net.st.restoreDown = true;
        await expect(w.melt(q)).rejects.toThrow(/mint-error/);
        net.st.restoreDown = false;
        // A restart: the startup settle restores the change.
        const after = walletOver(store, net.request);
        expect(await after.recoverPending()).toEqual({ recovered: 1, left: 0 });
        const balance = await after.balance(mint);
        const history = (await after.history({ mint })).length;
        const r = await after.melt(q);
        expect(r).toMatchObject({ paid: true, change: 0 });
        expect(await after.balance(mint)).toBe(balance); // nothing spent again
        expect((await after.history({ mint })).length).toBe(history); // no second line
        expect(await store.pending(mint)).toEqual([]);
      },
    );

    it.skipIf(MINT_URL_2 === undefined)(
      'melt change on NUT-08 blanks is restored by NUT-09 when the melt’s answer is lost',
      async () => {
        const net = lossy();
        const store = new MemoryProofStore();
        const w = walletOver(store, net.request);
        await fund(w, mint, 100);
        const invoice = await walletOver(new MemoryProofStore()).mintQuote(MINT_URL_2!, 21 as Sats);
        const q = await w.meltQuote(mint, invoice.bolt11);
        net.st.drop = '/v1/melt/bolt11';
        net.st.restoreDown = true;
        await expect(w.melt(q)).rejects.toThrow(/mint-error/);
        const [op] = await store.pending(mint);
        expect(op?.kind).toBe('melt');
        expect(op?.keep.length).toBeGreaterThan(0); // the blanks
        const held = op?.spends.reduce((a, p) => a + p.amount, 0) ?? 0;
        expect(await w.balance(mint)).toBe(100 - held);
        net.st.restoreDown = false;
        // A retry of the same quote settles first: the change comes back, nothing pays twice.
        const r = await w.melt(q);
        expect(r.paid).toBe(true);
        const spent = 100 - (await w.balance(mint));
        expect(spent).toBeGreaterThanOrEqual(21);
        expect(spent).toBeLessThanOrEqual(21 + q.feeReserve + 2); // + the input fee
        expect(r.change).toBe(held - spent); // exactly the restored change, counted once
        expect(await store.pending(mint)).toEqual([]);
        expect(await w.checkSpent({ mint, proofs: await store.proofs(mint) })).not.toContain(true);
      },
    );
  },
);

describe.skipIf(MINT_URL === undefined)(
  `issue #8 fix round 2 on a real mint (${MINT_URL ?? 'NUTFLIX_REAL_MINT_URL unset'}): a 429 after a retry`,
  () => {
    const mint = MINT_URL!;

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** Whether the mint lists POST /v1/swap as a NUT-19 cached endpoint (cdk-mintd does). */
    async function swapCached(): Promise<boolean> {
      const info = (await (await fetch(`${mint}/v1/info`)).json()) as {
        nuts?: Record<string, { cached_endpoints?: { method?: string; path?: string }[] }>;
      };
      return (info.nuts?.['19']?.cached_endpoints ?? []).some(
        (e) => e.method === 'POST' && e.path === '/v1/swap',
      );
    }

    async function settled(w: CashuWallet, store: MemoryProofStore): Promise<void> {
      expect(await store.pending(mint)).toEqual([]);
      const [sent] = await w.history({ limit: 1, mint });
      expect(sent).toMatchObject({ direction: 'out' });
      expect(await w.balance(mint)).toBe(64 - (sent?.amount ?? 0));
      expect(await w.checkSpent({ mint, proofs: await store.proofs(mint) })).not.toContain(true);
    }

    it('a retrying transport: the first swap executes and its answer is lost, the retry is answered 429 — the send completes from NUT-09', async () => {
      const inner = lossy().request; // plain real HTTP (nothing armed)
      let lose = false;
      let rateLimited = 0;
      const request: RequestFn = async <T>(args: Parameters<RequestFn>[0]): Promise<T> => {
        if (lose && args.method === 'POST' && args.endpoint.endsWith('/v1/swap')) {
          lose = false;
          await inner(args); // attempt 1: the mint executes it; the answer is thrown away
          rateLimited++;
          throw new RateLimitError('429 Too Many Requests', 1000); // the retry, answered 429
        }
        return inner<T>(args);
      };
      const store = new MemoryProofStore();
      const w = walletOver(store, request);
      await fund(w, mint, 64);
      lose = true;
      const set = await w.send(3 as Sats, { p2pk: TO, mint });
      expect(rateLimited).toBe(1);
      expect(set.proofs.reduce((a, p) => a + p.amount, 0)).toBe(3);
      await settled(w, store);
    });

    it('cashu-ts’s own fetch transport (the verifier’s run): the first POST /v1/swap is forwarded and its answer dropped, any retry answered 429 — nothing is lost', async () => {
      const cached = await swapCached();
      const real = globalThis.fetch;
      const st = { armed: false, swapPosts: 0 };
      vi.stubGlobal(
        'fetch',
        async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          const method = (init?.method ?? 'GET').toUpperCase();
          if (st.armed && method === 'POST' && new URL(url).pathname === '/v1/swap') {
            st.swapPosts++;
            if (st.swapPosts > 1)
              return new Response('', { status: 429, headers: { 'Retry-After': '1' } });
            const res = await real(input, init);
            await res.text(); // executed at the mint…
            throw new TypeError('fetch failed'); // …and the answer never arrives
          }
          return real(input, init);
        },
      );
      const store = new MemoryProofStore();
      const w = walletOver(store); // no request: cashu-ts's default transport
      await fund(w, mint, 64);
      st.armed = true;
      const set = await w.send(3 as Sats, { p2pk: TO, mint });
      // cdk-mintd advertises NUT-19: cashu-ts retried and met the 429. Nutshell does not: no retry.
      expect(st.swapPosts).toBe(cached ? 2 : 1);
      expect(set.proofs.reduce((a, p) => a + p.amount, 0)).toBe(3);
      await settled(w, store);
    });

    it('the production Node transport (httpModuleRawHttp + cashuRequestFn) sends a lost swap once, NUT-19 or not, and the send completes', async () => {
      const raw = httpModuleRawHttp({ http: nodeHttp, https: nodeHttps });
      const st = { armed: false, swapPosts: 0 };
      const http: RawHttp = async (req) => {
        const res = await raw(req);
        if (st.armed && req.method === 'POST' && req.url.endsWith('/v1/swap')) {
          st.swapPosts++;
          if (st.swapPosts === 1) throw new Error('socket hang up'); // executed; answer lost
        }
        return res;
      };
      const store = new MemoryProofStore();
      const w = walletOver(store, cashuRequestFn(http));
      await fund(w, mint, 64);
      st.armed = true;
      const set = await w.send(3 as Sats, { p2pk: TO, mint });
      await new Promise((r) => setTimeout(r, 500)); // a retry would have arrived by now
      expect(st.swapPosts).toBe(1);
      expect(set.proofs.reduce((a, p) => a + p.amount, 0)).toBe(3);
      await settled(w, store);
    });
  },
);

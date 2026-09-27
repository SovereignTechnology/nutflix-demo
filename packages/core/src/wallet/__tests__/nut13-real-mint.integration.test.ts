/**
 * ADR 0016 (issue #3, NUT-13) against a REAL Cashu mint. Opt-in: runs only when
 * `NUTFLIX_REAL_MINT_URL` names a mint (and, for the melt, `NUTFLIX_REAL_MINT_URL_2` a second one
 * whose invoices are external payments) — never in plain `npm test`. See `scripts/real-mint/`.
 * Every run uses a fresh random phrase, so earlier runs against the same mint never collide.
 *
 * What only a real mint answers:
 *   - its NUT-09 restore of NUT-13 outputs (v2 keyset ids, a 100 ppk input fee) from counter 0:
 *     what is unspent comes back, spent proofs are filtered (NUT-07), and a scan of the active
 *     keyset ends after exactly three empty batches of 100;
 *   - a restore answer with its DLEQs removed, or its amounts doubled, is refused;
 *   - how a real mint refuses a counter collision (10002 in the spec; 11003 at Nutshell 0.21; 20006
 *     on mint and melt, 11008 on a swap at cdk-mintd 0.18.1 — the wallet checks NUT-09, not the
 *     code), on a mint
 *     request, a swap and (with a second mint) a melt's NUT-08 blanks — refused before anything
 *     is spent or paid — and that the guard moves past it and completes once more;
 *   - reissuing unseeded proofs into seeded ones, with the real fee shown in the plan, and the
 *     words alone bringing them back.
 */
import { getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { describe, expect, it, vi } from 'vitest';

import type { CashuP2pkPubkey, MintUrl, Sats } from '../../contracts/index.js';
import { MemoryCounterStore } from '../../mocks/counter-store.js';
import type { RecoverySeed } from '../recovery-api.js';
import { recoveryPhrases } from '../seed.js';
import { MemoryProofStore, type ProofStore } from '../store.js';
import { cashuRequestFn, type RawHttp } from '../transport.js';
import { CashuMintConnections, CashuWallet } from '../wallet.js';

const MINT_URL = process.env['NUTFLIX_REAL_MINT_URL'] as MintUrl | undefined;
const MINT_URL_2 = process.env['NUTFLIX_REAL_MINT_URL_2'] as MintUrl | undefined;

vi.setConfig({ testTimeout: 180_000 });

const TO = Buffer.from(getPubKeyFromPrivKey(new Uint8Array(32).fill(0x62))).toString(
  'hex',
) as CashuP2pkPubkey;

interface Sig {
  amount: number;
  dleq?: unknown;
}

/**
 * How a real mint refuses outputs it already signed varies (the spec says 10002): Nutshell 0.21
 * answers 11003 "outputs already signed"; cdk-mintd 0.18.1 answers a mint or melt request 20006
 * "Invoice already paid or pending" and a swap 11008 "Duplicate outputs". So the wallet does not
 * trust the code (spend.ts `refused`): it asks NUT-09 whether its seeded outputs are signed. The
 * tests count refused requests to the path, whatever their code.
 */
const refusals = (st: { refused: string[] }, pathEnd: string): number =>
  st.refused.filter((p) => p.endsWith(pathEnd)).length;

/** Real HTTP that records coded refusals and restore requests (by keyset), and can rewrite answers. */
function observed() {
  const st = {
    codes: [] as number[],
    /** Paths answered 4xx/5xx, in order. */
    refused: [] as string[],
    restoresByKeyset: new Map<string, number>(),
    rewrite: null as null | ((path: string, res: Record<string, unknown>) => void),
  };
  const http: RawHttp = async (req) => {
    const path = new URL(req.url).pathname;
    if (path.endsWith('/v1/restore') && req.body !== undefined) {
      const outs = (JSON.parse(req.body) as { outputs?: { id?: string }[] }).outputs ?? [];
      const id = outs[0]?.id ?? '';
      st.restoresByKeyset.set(id, (st.restoresByKeyset.get(id) ?? 0) + 1);
    }
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body === undefined ? {} : { body: req.body }),
    });
    let body = await res.text();
    if (res.status >= 400) {
      st.refused.push(path);
      try {
        const code = (JSON.parse(body) as { code?: unknown }).code;
        if (typeof code === 'number') st.codes.push(code);
      } catch {
        // not JSON
      }
    } else if (st.rewrite !== null) {
      try {
        const json = JSON.parse(body) as Record<string, unknown>;
        st.rewrite(path, json);
        body = JSON.stringify(json);
      } catch {
        // not JSON
      }
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return { status: res.status, headers, body };
  };
  return { st, request: cashuRequestFn(http) };
}

function seededWallet(o: {
  seed?: RecoverySeed;
  counters?: MemoryCounterStore;
  store?: ProofStore;
  net?: ReturnType<typeof observed>;
}) {
  const net = o.net ?? observed();
  const counters = o.counters ?? new MemoryCounterStore(null);
  const store = o.store ?? new MemoryProofStore();
  const conns = new CashuMintConnections({
    request: () => net.request,
    ...(o.seed === undefined ? {} : { seed: { seed: o.seed, counters } }),
  });
  return { wallet: new CashuWallet({ mints: conns, store }), store, counters, conns, net };
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

const newSeed = async (): Promise<RecoverySeed> =>
  recoveryPhrases.toSeed(recoveryPhrases.generate());

async function activeKeyset(mint: MintUrl): Promise<string> {
  const res = (await (await fetch(`${mint}/v1/keysets`)).json()) as {
    keysets: { id: string; unit: string; active: boolean }[];
  };
  const k = res.keysets.find((x) => x.active && x.unit === 'sat');
  if (k === undefined) throw new Error('no active sat keyset');
  return k.id;
}

describe.skipIf(MINT_URL === undefined)(
  `NUT-13 on a real mint (${MINT_URL ?? 'NUTFLIX_REAL_MINT_URL unset'})`,
  () => {
    const mint = MINT_URL!;

    it('restore from the words: unspent proofs come back, spent ones do not; three empty batches end the scan', async () => {
      const phrase = await newSeed();
      const a = seededWallet({ seed: phrase });
      await fund(a.wallet, mint, 64);
      await a.wallet.send(5 as Sats, { p2pk: TO, mint }); // spends the 64 (and pays the fee)
      const held = await a.wallet.balance(mint);
      expect(held).toBeGreaterThan(50);

      const c = seededWallet({ seed: await newSeed() });
      const reports = await c.wallet.seeded!.restoreFromSeed(phrase, [mint]);
      expect(reports).toEqual([{ mint, outcome: 'restored', restoredSats: held }]);
      expect(await c.wallet.balance(mint)).toBe(held);
      expect(await c.wallet.checkSpent({ mint, proofs: await c.store.proofs(mint) })).not.toContain(
        true,
      );
      // Everything this phrase made sits in counters 0..99 of the active keyset: one batch with
      // signatures, then three empty ones.
      expect(c.net.st.restoresByKeyset.get(await activeKeyset(mint))).toBe(4);
      // A second run adds nothing.
      expect(await c.wallet.seeded!.restoreFromSeed(phrase, [mint])).toEqual([
        { mint, outcome: 'nothing', restoredSats: 0 },
      ]);
    });

    it('a restore answer without DLEQs, or with its amounts doubled, is refused', async () => {
      const phrase = await newSeed();
      await fund(seededWallet({ seed: phrase }).wallet, mint, 21);
      for (const lie of ['no-dleq', 'amount'] as const) {
        const c = seededWallet({ seed: await newSeed() });
        c.net.st.rewrite = (path, res) => {
          if (!path.endsWith('/v1/restore')) return;
          for (const sig of res['signatures'] as Sig[])
            if (lie === 'no-dleq') delete sig.dleq;
            else sig.amount = sig.amount * 2;
        };
        expect(await c.wallet.seeded!.restoreFromSeed(phrase, [mint])).toEqual([
          { mint, outcome: 'refused', restoredSats: 0 },
        ]);
        expect(await c.wallet.balance(mint)).toBe(0);
      }
    });

    it('a counter collision (whatever code the mint answers it with): the guard moves past it (mint and swap)', async () => {
      const phrase = await newSeed();
      const k = await activeKeyset(mint);
      const a = seededWallet({ seed: phrase });
      await fund(a.wallet, mint, 64); // a signs counters 0..
      await a.wallet.send(3 as Sats, { p2pk: TO, mint }); // and more
      const b = seededWallet({
        seed: phrase,
        counters: new MemoryCounterStore({ v: 1, next: { [k]: 0 }, published: {} }),
      });
      await fund(b.wallet, mint, 16);
      expect(refusals(b.net.st, '/v1/mint/bolt11')).toBe(1);
      expect(await b.wallet.balance(mint)).toBe(16);
      // A swap on b's counters from 0 again (another process that believes it starts at 0).
      const b2 = seededWallet({
        seed: phrase,
        counters: new MemoryCounterStore({ v: 1, next: { [k]: 0 }, published: {} }),
        store: b.store,
      });
      const set = await b2.wallet.send(4 as Sats, { p2pk: TO, mint });
      expect(set.proofs.reduce((n, p) => n + p.amount, 0)).toBe(4);
      expect(refusals(b2.net.st, '/v1/swap')).toBe(1);
      expect(await b2.store.pending!(mint)).toEqual([]);
      // Nothing b holds is spent; nothing of a's was touched.
      expect(
        await b2.wallet.checkSpent({ mint, proofs: await b.store.proofs(mint) }),
      ).not.toContain(true);
      expect(await a.wallet.checkSpent({ mint, proofs: await a.store.proofs(mint) })).not.toContain(
        true,
      );
    });

    it.skipIf(MINT_URL_2 === undefined)(
      'a melt whose NUT-08 blanks collide is refused BEFORE it pays, and completes once more',
      async () => {
        const phrase = await newSeed();
        const k = await activeKeyset(mint);
        const a = seededWallet({ seed: phrase });
        await fund(a.wallet, mint, 16); // signs the first counters
        const b = seededWallet({
          seed: phrase,
          counters: new MemoryCounterStore({ v: 1, next: { [k]: 100 }, published: {} }),
        });
        await fund(b.wallet, mint, 100); // b's own counters 100..
        const b2 = seededWallet({
          seed: phrase,
          counters: new MemoryCounterStore({ v: 1, next: { [k]: 0 }, published: {} }),
          store: b.store,
        });
        const invoice = await seededWallet({}).wallet.mintQuote(MINT_URL_2!, 13 as Sats);
        const q = await b2.wallet.meltQuote(mint, invoice.bolt11);
        const r = await b2.wallet.melt(q);
        expect(r.paid).toBe(true);
        expect(refusals(b2.net.st, '/v1/melt/bolt11')).toBe(1);
        expect(await b2.store.pending!(mint)).toEqual([]);
        // Paid exactly once: the balance fell by the invoice plus fees, not twice that.
        expect(await b2.wallet.balance(mint)).toBeGreaterThan(100 - 2 * 13);
      },
    );

    it('reissue: unseeded proofs swapped into seeded ones (the real fee in the plan), recovered by the words', async () => {
      const store = new MemoryProofStore();
      await fund(seededWallet({ store }).wallet, mint, 40); // unseeded: random outputs
      const phrase = await newSeed();
      const d = seededWallet({ seed: phrase, store });
      const plan = await d.wallet.seeded!.reissuePlan(mint);
      expect(plan.amount).toBe(40);
      expect(plan.feeSats).toBeGreaterThan(0); // the real mints charge 100 ppk
      const res = await d.wallet.seeded!.reissue(plan);
      expect(res).toEqual({ mint, reissued: 40 - plan.feeSats, feeSats: plan.feeSats });
      const c = seededWallet({ seed: await newSeed() });
      expect(await c.wallet.seeded!.restoreFromSeed(phrase, [mint])).toEqual([
        { mint, outcome: 'restored', restoredSats: 40 - plan.feeSats },
      ]);
    });
  },
);

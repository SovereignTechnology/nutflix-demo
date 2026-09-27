/**
 * CashuWallet — the contract's `Wallet` (NIP-60 ecash wallet, thin over `@cashu/cashu-ts`).
 *
 * The read side (mints, balances, history, keysets) and the NUT-04 quote flow live here; every
 * operation that moves proofs goes through `spend.ts`'s `Spender` (the locked audit surface).
 * Mint quotes the wallet created are remembered and can be listed (`pendingMintQuotes`, L5-Wallet
 * request 2) so a paid invoice is not forgotten when the fund sheet closes.
 *
 * NUT-13 (ADR 0016): connections given this device's `SeedMaterial` build every cashu-ts wallet
 * with the seed, the one shared `DurableCounterSource` and an EXPLICIT secrets policy; a wallet over
 * them exposes `seeded` (restore from a phrase, reissue), restores its own unpublished range at
 * startup (`restoreUnpublished`), moves the `published` watermark when nothing is in flight, and
 * `close()` wipes the seed only once no operation can derive from it.
 */
import {
  Mint,
  Wallet as CashuTsWallet,
  getPubKeyFromPrivKey,
  schnorrSignMessage,
  type RequestFn,
} from '@cashu/cashu-ts';

import type {
  CashuP2pkPubkey,
  CashuProof,
  LockedProofSet,
  MeltQuote,
  MintKeyset,
  MintQuote,
  MintUrl,
  Sats,
  Signer,
  UnixSeconds,
  Wallet,
  WalletChangeEvent,
  WalletHistoryEntry,
} from '../contracts/index.js';
import {
  PENDING_SETTLE_AFTER_S,
  seedGuardedOutputs,
  Spender,
  WalletError,
  type MintConnections,
  type RestoreDetail,
  type Seeding,
  type WalletKey,
} from './spend.js';
import { fetchRawHttp } from './fetch-http.js';
import type {
  CounterStore,
  RecoverySeed,
  ReissuePlan,
  ReissueResult,
  RestoreProgress,
  SeededWallet,
  SeedMaterial,
} from './recovery-api.js';
import { counterBinding, DurableCounterSource, markSeeded, seedBytes } from './seed.js';
import { heldSecrets, proofTotal, type ProofStore } from './store.js';
import { cashuRequestFn } from './transport.js';

// ---------------------------------------------------------------------------------------
// Mint connections
// ---------------------------------------------------------------------------------------

/**
 * Every mint of a `CashuMintConnections` not given a request function: `cashuRequestFn` (one
 * attempt per request, 30 s, 300 s for a melt, no redirects, a 4 MiB cap) over the platform's
 * `fetch` (`fetch-http.ts`). `fetch` is looked up per request, so building this loads nothing.
 */
const DEFAULT_REQUEST: RequestFn = cashuRequestFn(fetchRawHttp());

/**
 * ONE live counter source per counters store (ADR 0016 §3): two sources over one store would each
 * keep their own cursor and hand out the same counters. Connections built twice from the same
 * `SeedMaterial` (a reconnect) share it; one whose wallet was closed is replaced by a fresh source,
 * which starts from what is on disk — past every counter the closed one handed out (each lease is
 * written before its counters are). Reopen only after the old wallet's `close()` resolved.
 *
 * The source is bound to its phrase (`counterBinding`; independent review 2026-09-27, finding 3):
 * a store whose live source belongs to ANOTHER phrase is refused — close that wallet first — and a
 * file another phrase wrote reads as no state, so a rotated phrase starts at its own counter 0
 * instead of continuing the old phrase's counters past a gap no restore crosses.
 */
const SOURCES = new WeakMap<CounterStore, DurableCounterSource>();

function counterSourceFor(store: CounterStore, binding: string): DurableCounterSource {
  let src = SOURCES.get(store);
  if (src !== undefined && !src.closed && src.boundTo !== binding)
    throw new WalletError(
      'invalid-argument',
      'this counters store is in use by a wallet of another recovery phrase: close it first',
    );
  if (src === undefined || src.closed)
    SOURCES.set(store, (src = new DurableCounterSource(store, { binding })));
  return src;
}

/**
 * One loaded cashu-ts `Wallet` per mint, created on first use. `request` overrides the HTTP
 * transport per mint (the in-process `TestMint`, or a host transport with its own policy).
 * `requireSigDleq`: a mint that advertises NUT-12 must return DLEQ proofs on every signature.
 *
 * Every mint is reached through a SINGLE-ATTEMPT transport: `spend.ts` reads a coded answer as the
 * mint's answer to its one request (`isDefinitive`). Without `request`, or where it answers
 * `undefined`, that is `cashuRequestFn` over `fetch` (`fetch-http.ts`) — never cashu-ts's own
 * fetch transport, which RETRIES swaps, melts and mints at a mint advertising NUT-19; a coded
 * answer to such a retry dropped the journal entry of a request that had executed (issue #8 fix
 * round 3; before, only the callers kept it away). The Node wallets pass `cashuRequestFn` over
 * `node:http(s)` instead — the daemons run `--jitless`, where `fetch`'s parser (WebAssembly)
 * crashes: the desktop's `host/mint-transport.ts`, the daemons' `@sovit/seeder`
 * `runtime/mint-http.ts`. An injected `request` must not retry either.
 *
 * With `seed` (ADR 0016 §2): every wallet gets `bip39seed` (lent BY REFERENCE: `close` on the
 * `CashuWallet` wipes it only once nothing can derive from it, and `seedGuardedOutputs` refuses a
 * wiped one), the ONE `DurableCounterSource` over `seed.counters` (keyed by keyset id across every
 * mint, bound to this phrase), and the policy `'deterministic'` — `'random'` without a seed, never
 * cashu-ts's `'auto'`, which would half-switch the wallet. Throws for a wiped seed, or a counters
 * store a live wallet of another phrase is using.
 */
export class CashuMintConnections implements MintConnections {
  private readonly wallets = new Map<MintUrl, Promise<CashuTsWallet>>();
  readonly seeding?: Seeding;

  constructor(
    private readonly opts: {
      readonly request?: (mint: MintUrl) => RequestFn | undefined;
      readonly seed?: SeedMaterial;
    } = {},
  ) {
    if (opts.seed !== undefined) {
      let binding: string;
      try {
        binding = counterBinding(opts.seed.seed);
      } catch {
        throw new WalletError('invalid-argument', 'the recovery seed is wiped');
      }
      this.seeding = {
        seed: opts.seed.seed,
        counters: counterSourceFor(opts.seed.counters, binding),
      };
    }
  }

  wallet(mint: MintUrl): Promise<CashuTsWallet> {
    let w = this.wallets.get(mint);
    if (w === undefined) {
      const customRequest = this.opts.request?.(mint) ?? DEFAULT_REQUEST;
      const s = this.seeding;
      let bip39seed: Uint8Array | undefined;
      try {
        bip39seed = s === undefined ? undefined : seedBytes(s.seed);
      } catch {
        return Promise.reject(new WalletError('invalid-argument', 'the recovery seed is wiped'));
      }
      const cashu = new CashuTsWallet(new Mint(mint, { customRequest }), {
        unit: 'sat',
        requireSigDleq: true,
        ...(s === undefined || bip39seed === undefined
          ? { secretsPolicy: 'random' as const }
          : {
              bip39seed,
              secretsPolicy: 'deterministic' as const,
              counterSource: s.counters,
              outputDataCreator: seedGuardedOutputs(s.seed),
            }),
      });
      if (s !== undefined) markSeeded(cashu, s.seed);
      // No probe is registered here: the `Spender` probes a keyset at the mint an operation runs
      // at, and only there (independent review 2026-09-27, findings 2 and 6).
      w = cashu.loadMint().then(() => cashu);
      // A failed load is not cached: the next call retries.
      w.catch(() => this.wallets.delete(mint));
      this.wallets.set(mint, w);
    }
    return w;
  }
}

// ---------------------------------------------------------------------------------------
// Wallet keys
// ---------------------------------------------------------------------------------------

function hex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/**
 * A wallet key held in memory (the NIP-60 `privkey`, decrypted from kind 17375 by the signer's
 * NIP-44 — the fallback mode build-plan §3 says the UI must disclose). The buffer is NOT copied:
 * pass a secure buffer and wipe it when the wallet is closed.
 */
export function memoryWalletKey(secretKey: Uint8Array): WalletKey {
  const pubkey = hex(getPubKeyFromPrivKey(secretKey)) as CashuP2pkPubkey;
  return {
    pubkey,
    sign: (secret) => Promise.resolve(schnorrSignMessage(secret, secretKey)),
    // NUT-20: cashu-ts takes the key as a string for a locked mint (see `WalletKey`).
    withSecretHex: (use) => use(hex(secretKey)),
  };
}

/** A wallet key the signer holds (`Signer.signSecret`) — the key never enters this process. */
export function signerWalletKey(signer: Signer, pubkey: CashuP2pkPubkey): WalletKey {
  const sign = signer.signSecret;
  if (sign === undefined)
    throw new WalletError('invalid-argument', 'this signer cannot sign NUT-11 witnesses');
  return { pubkey, sign: (secret) => sign(secret) };
}

// ---------------------------------------------------------------------------------------
// The wallet
// ---------------------------------------------------------------------------------------

/** Where to continue restores a batch cap (or a failure) stopped early: mint → keyset id → counter. */
export interface RestoreOptions {
  readonly resume?: ReadonlyMap<MintUrl, Readonly<Record<string, number>>>;
}

/**
 * The seam's `SeededWallet` as core implements it: `restoreFromSeed` also takes where to resume,
 * and each report says whether its scan was complete (`RestoreDetail.resume`; independent review
 * 2026-09-27, finding 1). Host-only.
 */
export interface CoreSeededWallet extends SeededWallet {
  restoreFromSeed(
    seed: RecoverySeed,
    mints: readonly MintUrl[],
    onProgress?: (p: RestoreProgress) => void,
    opts?: RestoreOptions,
  ): Promise<readonly RestoreDetail[]>;
}

export interface CashuWalletOptions {
  readonly mints: MintConnections;
  readonly store: ProofStore;
  /** The NIP-60 wallet key (receiving P2PK ecash; the nutzap target). */
  readonly key?: WalletKey;
  /** Mints to list even with a zero balance (the user's defaults). */
  readonly configuredMints?: readonly MintUrl[];
  readonly now?: () => UnixSeconds;
  /** Tests: tighter NUT-13 restore bounds (`SpendContext.restoreLimits`; can only tighten). */
  readonly restoreLimits?: { readonly maxBatches?: number; readonly maxKeysets?: number };
}

export class CashuWallet implements Wallet {
  private readonly spender: Spender;
  private readonly listeners = new Set<(e: WalletChangeEvent) => void>();
  private readonly pending = new Map<string, MintQuote>();
  private readonly keysets = new Map<string, MintKeyset>();
  private readonly now: () => UnixSeconds;

  /**
   * ADR 0016: present when the connections carry this device's `SeedMaterial` — restore from a
   * phrase (this device's, another device's, or typed in) and reissue (D5). Host-only.
   */
  readonly seeded: CoreSeededWallet | undefined;

  /**
   * Keysets whose `[published, next)` range a startup restore has not finished (their mint was
   * unreachable, refused, or is not among this wallet's mints): their `published` watermark stays
   * where it is — the range was never scanned, so it is not known published, and moving the
   * watermark would make the next start skip it. Per keyset: a mint that stays down holds back only
   * its own keysets, not every startup restore's range everywhere.
   */
  private held: ReadonlySet<string> = new Set();

  constructor(private readonly o: CashuWalletOptions) {
    this.spender = new Spender({
      mints: o.mints,
      store: o.store,
      ...(o.key ? { key: o.key } : {}),
      ...(o.now ? { now: o.now } : {}),
      ...(o.restoreLimits ? { restoreLimits: o.restoreLimits } : {}),
    });
    this.now = o.now ?? ((): UnixSeconds => Math.floor(Date.now() / 1000) as UnixSeconds);
    this.seeded =
      o.mints.seeding === undefined
        ? undefined
        : {
            reissuePlan: (mint) => this.reissuePlan(mint),
            reissue: (plan) => this.reissue(plan),
            restoreFromSeed: (seed, mints, onProgress, opts) =>
              this.restoreFromSeed(seed, mints, onProgress, opts),
          };
  }

  // ---- NUT-13 (ADR 0016) ----------------------------------------------------------------

  private async reissuePlan(mint: MintUrl): Promise<ReissuePlan> {
    try {
      return await this.spender.reissuePlan(mint);
    } finally {
      await this.afterOperation(mint);
    }
  }

  private async reissue(plan: ReissuePlan): Promise<ReissueResult> {
    try {
      return await this.spender.reissue(plan);
    } finally {
      await this.afterOperation(plan.mint);
    }
  }

  private async restoreFromSeed(
    seed: RecoverySeed,
    mints: readonly MintUrl[],
    onProgress?: (p: RestoreProgress) => void,
    opts?: RestoreOptions,
  ): Promise<readonly RestoreDetail[]> {
    const reports: RestoreDetail[] = [];
    for (const mint of [...new Set(mints)]) {
      try {
        reports.push(
          await this.spender.restoreFromSeed(
            seed,
            mint,
            (keysetsDone, keysets) => {
              onProgress?.({ mint, keysetsDone, keysets });
            },
            opts?.resume?.get(mint),
          ),
        );
      } finally {
        await this.afterOperation(mint);
      }
    }
    return reports;
  }

  /**
   * ADR 0016 §3: at startup, restore this device's own `[published, next)` counter ranges at the
   * wallet's mints — what a crash may have cut off before it reached NIP-60 (an outbox or journal
   * held in memory). Nothing without a seed or with nothing unpublished. Per mint, never throws.
   * A keyset whose range no mint finished (`unreachable`, `refused`, a range not finished, or its
   * mint not among this wallet's) keeps its `published` watermark until a later call finishes it —
   * call this again later (the next start scans it again otherwise).
   */
  async restoreUnpublished(): Promise<readonly RestoreDetail[]> {
    const s = this.o.mints.seeding;
    if (s === undefined) return [];
    const ranges = await s.counters.unpublished();
    const open = new Set(ranges.map((r) => r.keysetId));
    // Held from the start: an operation finishing meanwhile must not move them either.
    this.held = new Set([...this.held, ...open]);
    const reports: RestoreDetail[] = [];
    try {
      if (ranges.length === 0) return [];
      for (const mint of await this.mints()) {
        try {
          const r = await this.spender.restoreUnpublished(mint, ranges, (done) => {
            for (const k of done) open.delete(k);
          });
          if (r.outcome !== 'nothing') reports.push(r);
        } catch {
          reports.push({ mint, outcome: 'unreachable', restoredSats: 0 as Sats });
        } finally {
          await this.emitBalanceSafe(mint);
        }
      }
    } finally {
      this.held = open;
    }
    await this.notePublishedSafe();
    return reports;
  }

  /**
   * ADR 0016 §3: move the `published` watermark to the counters handed out so far — only when
   * nothing is in flight: no operation running or queued, nothing journaled, and the store's
   * outbox empty (`ProofStore.unsynced`). Call it too after the store publishes by itself.
   */
  async notePublished(): Promise<void> {
    const s = this.o.mints.seeding;
    if (s === undefined || !this.spender.idle()) return;
    const store = this.o.store;
    if ((store.unsynced?.() ?? 0) > 0) return;
    if (store.pending !== undefined)
      for (const m of await store.mints()) if ((await store.pending(m)).length > 0) return;
    // Checked again with no await before the mark: the counter source orders the mark ahead of
    // any reservation made after this line.
    if (!this.spender.idle() || (store.unsynced?.() ?? 0) > 0) return;
    await s.counters.markPublished(this.held);
  }

  /**
   * Close the wallet (ADR 0016 §2): the counter source refuses every reservation, every running
   * or queued operation finishes (new ones are refused), the `published` watermark is written, and
   * only then is the seed wiped — cashu-ts holds it by reference. Idempotent.
   */
  async close(): Promise<void> {
    const s = this.o.mints.seeding;
    s?.counters.close();
    await this.spender.close();
    if (s === undefined) return;
    try {
      await s.counters.flush();
    } catch {
      // a stale watermark only restores more at the next start
    }
    s.seed.wipe();
  }

  /** Emit the balance and move the watermark after an operation (neither may throw). */
  private async afterOperation(mint: MintUrl): Promise<void> {
    await this.emitBalanceSafe(mint);
    try {
      await this.notePublished();
    } catch {
      // the next operation tries again
    }
  }

  /** The active keyset's `input_fee_ppk` (cashu-ts `Keyset.fee`; 0 when the mint sets none). */
  async inputFeePpk(mint: MintUrl): Promise<number> {
    const w = await this.o.mints.wallet(mint);
    const fee = w.getKeyset().fee;
    return Number.isSafeInteger(fee) && fee >= 0 ? fee : 0;
  }

  async mints(): Promise<readonly MintUrl[]> {
    const held = await this.o.store.mints();
    return [...new Set([...(this.o.configuredMints ?? []), ...held])];
  }

  /**
   * What can be spent at `mint`: the proofs held, less those an unresolved journaled send or melt
   * holds (ADR 0014 amendment, issue #8). Those come back when the mint says the operation never
   * executed, or leave with it when it did — never counted twice, never forgotten.
   */
  async balance(mint: MintUrl): Promise<Sats> {
    const proofs = await this.o.store.proofs(mint);
    const pending = this.o.store.pending === undefined ? [] : await this.o.store.pending(mint);
    if (pending.length === 0) return proofTotal(proofs) as Sats;
    const held = heldSecrets(pending);
    return proofTotal(proofs.filter((p) => !held.has(p.secret))) as Sats;
  }

  async balances(): Promise<ReadonlyMap<MintUrl, Sats>> {
    const out = new Map<MintUrl, Sats>();
    for (const m of await this.mints()) out.set(m, await this.balance(m));
    return out;
  }

  p2pkPubkey(): Promise<CashuP2pkPubkey> {
    if (this.o.key === undefined)
      return Promise.reject(new WalletError('invalid-argument', 'no NIP-60 wallet key is loaded'));
    return Promise.resolve(this.o.key.pubkey);
  }

  async mintQuote(mint: MintUrl, amount: Sats): Promise<MintQuote> {
    if (!Number.isSafeInteger(amount) || amount < 1)
      throw new WalletError('invalid-argument', 'amount must be a positive integer of sats');
    const w = await this.o.mints.wallet(mint);
    // Security review F17: a quote is bearer — whoever knows its id once the invoice is paid
    // mints the ecash. Where the mint supports NUT-20 and our key can sign, lock it to our key.
    const key = this.o.key;
    const lock = key?.withSecretHex !== undefined && supportsNut20(w) ? key.pubkey : undefined;
    const q =
      lock === undefined
        ? await w.createMintQuoteBolt11(amount)
        : await w.createLockedMintQuote(amount, lock);
    if (lock !== undefined && q.pubkey?.toLowerCase() !== lock.toLowerCase())
      throw new WalletError('bad-mint-response', 'the mint did not lock the quote to our key');
    const quote: MintQuote = {
      mint,
      quoteId: q.quote,
      amount: q.amount.toNumber(),
      bolt11: q.request,
      expiry: q.expiry ?? 0,
      state: q.state,
    };
    if (quote.amount !== amount)
      throw new WalletError('bad-mint-response', 'the mint quoted a different amount');
    this.pending.set(quote.quoteId, quote);
    this.emit({ type: 'quote', quote });
    return quote;
  }

  async pollQuote(quote: MintQuote): Promise<{ state: MintQuote['state']; minted?: Sats }> {
    const w = await this.o.mints.wallet(quote.mint);
    const q = await w.checkMintQuoteBolt11(quote.quoteId);
    if (q.state === 'UNPAID') return { state: 'UNPAID' };
    if (q.state === 'ISSUED') {
      // ADR 0014: issued by a mint request of ours whose answer was lost — restored, not gone.
      const minted = await this.spender.recoverMint(quote);
      this.pending.delete(quote.quoteId);
      if (minted === null) return { state: 'ISSUED' };
      this.emit({ type: 'quote', quote: { ...quote, state: 'ISSUED' } });
      await this.emitBalance(quote.mint);
      return { state: 'ISSUED', minted };
    }
    const minted = await this.spender.mint(quote, q.pubkey !== undefined ? q : undefined);
    this.pending.delete(quote.quoteId);
    const issued: MintQuote = { ...quote, state: 'ISSUED' };
    this.emit({ type: 'quote', quote: issued });
    await this.emitBalance(quote.mint);
    await this.notePublishedSafe();
    return { state: 'ISSUED', minted };
  }

  /** Quotes this wallet created and has not seen issued (L5-Wallet request 2). */
  pendingMintQuotes(): readonly MintQuote[] {
    const now = this.now();
    return [...this.pending.values()].filter((q) => q.expiry === 0 || q.expiry > now);
  }

  async send(
    amount: Sats,
    opts: {
      readonly p2pk: CashuP2pkPubkey;
      readonly mint: MintUrl;
      readonly tags?: readonly (readonly string[])[];
      readonly memo?: string;
    },
  ): Promise<LockedProofSet> {
    // A failed send may still move the balance (its inputs held while the mint's answer is
    // unknown, or reconciled away): the change event goes out either way.
    try {
      return await this.spender.send(amount, opts);
    } finally {
      await this.afterOperation(opts.mint);
    }
  }

  async receive(
    set: LockedProofSet | { readonly mint: MintUrl; readonly proofs: readonly CashuProof[] },
  ): Promise<Sats> {
    try {
      return await this.spender.receive(set);
    } finally {
      await this.afterOperation(set.mint);
    }
  }

  /** NUT-07 spent flags for a proof set (the seeder's creator-set check, security review F11). */
  checkSpent(set: {
    readonly mint: MintUrl;
    readonly proofs: readonly CashuProof[];
  }): Promise<readonly boolean[]> {
    return this.spender.checkSpent(set);
  }

  /** Whether every proof was spent with this wallet's own signature (a lost swap, F31). */
  spentByUs(set: {
    readonly mint: MintUrl;
    readonly proofs: readonly CashuProof[];
  }): Promise<boolean> {
    return this.spender.spentByUs(set);
  }

  /**
   * ADR 0014: settle the journal at every mint this wallet holds proofs or journaled operations
   * at — recover what a mint signed for an operation whose answer was lost. Run once at startup.
   * A mint that cannot be asked keeps its journal for the next operation there. Returns counts
   * of operations recovered and still journaled — `left` counts every entry still in the journal,
   * a skipped mint's too (one whose wallet does not load, or that no longer offers NUT-09): the
   * settle loop reads `left < before` as progress (issue #8 fix round 2).
   */
  async recoverPending(): Promise<{ recovered: number; left: number }> {
    let recovered = 0;
    let left = 0;
    const pendingAt = async (mint: MintUrl): Promise<number> =>
      (await this.o.store.pending?.(mint))?.length ?? 0;
    for (const mint of await this.o.store.mints()) {
      let before = 0;
      let counted = false;
      try {
        before = await pendingAt(mint);
        const r = await this.spender.recover(mint);
        recovered += r.recovered;
        const after = await pendingAt(mint);
        left += after;
        counted = true;
        // Held inputs come back (or leave) as entries settle: the balance moves either way.
        if (r.recovered > 0 || after !== before) await this.emitBalance(mint);
      } catch {
        // unreachable now (every operation at this mint settles it first): still journaled
        if (!counted) left += before;
      }
    }
    await this.notePublishedSafe();
    return { recovered, left };
  }

  /**
   * When the journal next needs a settle (issue #8 review: held inputs must come back without a
   * restart). `count`: operations journaled; `next`: the earliest time one that is still young can
   * be decided (`created + PENDING_SETTLE_AFTER_S`), `null` when none is; `overdue`: how many are
   * past that already — a melt the mint still reports PENDING, or a mint that could not be asked —
   * and are retried. `SettleLoop` (`settle-loop.ts`) plans `recoverPending` from this. Reads the
   * store only; never asks a mint.
   */
  async settleSchedule(): Promise<{
    readonly count: number;
    readonly overdue: number;
    readonly next: UnixSeconds | null;
  }> {
    const store = this.o.store;
    if (store.pending === undefined) return { count: 0, overdue: 0, next: null };
    const now = this.now();
    let count = 0;
    let overdue = 0;
    let next: number | null = null;
    for (const mint of await store.mints())
      for (const op of await store.pending(mint)) {
        count++;
        const at = op.created + PENDING_SETTLE_AFTER_S;
        if (at <= now) overdue++;
        else if (next === null || at < next) next = at;
      }
    return { count, overdue, next: next === null ? null : (next as UnixSeconds) };
  }

  async meltQuote(mint: MintUrl, bolt11: string): Promise<MeltQuote> {
    if (typeof bolt11 !== 'string' || !/^ln[a-z0-9]+$/i.test(bolt11.trim()))
      throw new WalletError('invalid-argument', 'expected a bolt11 invoice');
    const w = await this.o.mints.wallet(mint);
    const q = await w.createMeltQuoteBolt11(bolt11.trim());
    return {
      mint,
      quoteId: q.quote,
      amount: q.amount.toNumber(),
      feeReserve: q.fee_reserve.toNumber(),
      expiry: q.expiry,
      state: q.state,
    };
  }

  async melt(quote: MeltQuote): Promise<{ paid: boolean; preimage?: string; change: Sats }> {
    try {
      return await this.spender.melt(quote);
    } finally {
      await this.afterOperation(quote.mint);
    }
  }

  async keyset(mint: MintUrl, keysetId: string): Promise<MintKeyset> {
    const cacheKey = `${mint}|${keysetId}`;
    const hit = this.keysets.get(cacheKey);
    if (hit !== undefined) return hit;
    const w = await this.o.mints.wallet(mint);
    let ks: ReturnType<CashuTsWallet['getKeyset']>;
    try {
      ks = w.getKeyset(keysetId);
    } catch {
      await w.loadMint(true); // fetch on miss (a keyset rotated in since the wallet loaded)
      ks = w.getKeyset(keysetId);
    }
    const keys: Record<string, string> = {};
    for (const [amount, key] of Object.entries(ks.keys)) keys[amount] = key;
    const out: MintKeyset = {
      mint,
      id: ks.id,
      unit: ks.unit,
      active: ks.isActive,
      keys,
      ...(ks.fee > 0 ? { inputFeePpk: ks.fee } : {}),
      fetchedAt: this.now(),
    };
    this.keysets.set(cacheKey, out);
    return out;
  }

  history(opts?: {
    readonly limit?: number;
    readonly mint?: MintUrl;
  }): Promise<readonly WalletHistoryEntry[]> {
    return this.o.store.history(opts);
  }

  onChange(cb: (e: WalletChangeEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(e: WalletChangeEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(e);
      } catch {
        // a listener's failure is its own
      }
    }
  }

  private async notePublishedSafe(): Promise<void> {
    try {
      await this.notePublished();
    } catch {
      // the next operation tries again
    }
  }

  /** `emitBalance` for a `finally`: a failing read must not replace the operation's own error. */
  private async emitBalanceSafe(mint: MintUrl): Promise<void> {
    try {
      await this.emitBalance(mint);
    } catch {
      // the next change event carries the balance
    }
  }

  private async emitBalance(mint: MintUrl): Promise<void> {
    this.emit({ type: 'balance', mint, balance: await this.balance(mint) });
    const [latest] = await this.o.store.history({ limit: 1, mint });
    if (latest !== undefined) this.emit({ type: 'history', entry: latest });
  }
}

/** NUT-20 in the mint's info (loaded with the mint). Never throws. */
function supportsNut20(w: {
  getMintInfo(): { isSupported(n: 20): { supported: boolean } };
}): boolean {
  try {
    return w.getMintInfo().isSupported(20).supported;
  } catch {
    return false;
  }
}

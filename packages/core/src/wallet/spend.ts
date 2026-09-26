/**
 * The wallet's spend operations — NUT-11 P2PK send, NUT-03 receive, NUT-05 melt, NUT-04 mint —
 * thin over `@cashu/cashu-ts` (SECURITY.md §locked; build-plan §3 "wallet surface = mint quote,
 * P2PK send, swap, melt"; contract `Wallet`).
 *
 * Rules this file keeps (each has a test):
 *
 *   - **One operation per mint at a time.** Proof selection and the swap run under a per-mint
 *     lock, so two concurrent sends can never select the same proof.
 *   - **State before result.** Every swap's transition (inputs spent, change / received proofs
 *     added) is committed to the `ProofStore` before the caller sees the result — a crash can lose
 *     a result the caller never saw, never proofs the wallet forgot it holds.
 *   - **Never trust the mint's output shape.** A P2PK send's outputs must add up to exactly the
 *     amount, carry a DLEQ that verifies against the keyset (with the blinding factor, so the
 *     recipient can verify it too — threat T7), and be locked the way `payment/lock.ts` requires
 *     (plain lock to the recipient, the requested binding tags, nothing else).
 *   - **An ambiguous failure is reconciled, not guessed.** If a swap fails after it may have
 *     reached the mint, the inputs' state is asked (NUT-07): unspent inputs stay in the wallet,
 *     spent ones are dropped and the loss is reported by count and amount.
 *   - **A lost response loses nothing (ADR 0014, security review F31).** Where the store keeps a
 *     journal and the mint supports NUT-09, a send, receive, mint or melt writes its outputs to
 *     the store BEFORE the request goes out; if the answer never arrives, the outputs the mint
 *     signed are restored (NUT-09) and committed as if it had. A retry of the same receive or mint
 *     reuses the journaled outputs, so a mint that did execute answers "already signed", never
 *     twice. A melt's journaled outputs are its NUT-08 change blanks (ADR 0014 amendment).
 *   - **Held inputs are nobody's.** While a journaled send or melt is unresolved, its inputs stay
 *     out of every new selection (and out of the balance, `wallet.ts`) until the mint says what
 *     became of them — they are neither spent twice nor forgotten.
 *   - **Nothing secret in an error.** Messages carry a code and amounts, never a proof.
 *
 * No cryptography here: blinding, signatures, DLEQ and P2PK witnesses are cashu-ts calls, and a
 * witness is signed by the injected `WalletKey` (the signer's `signSecret`, or a wallet key held
 * in secure memory).
 */
import {
  Amount,
  getP2PKExpectedWitnessPubkeys,
  hasValidDleq,
  OutputData,
  schnorrVerifyMessage,
  StaleKeysetError,
  type MeltPreview,
  type MeltQuoteBolt11Response,
  type MintQuoteBolt11Response,
  type OutputConfig,
  type OutputDataLike,
  type OutputType,
  type P2PKTag,
  type Proof,
  type SerializedBlindedSignature,
  type Wallet as CashuTsWallet,
} from '@cashu/cashu-ts';

import type {
  CashuP2pkPubkey,
  CashuProof,
  LockedProofSet,
  MeltQuote,
  MintQuote,
  MintUrl,
  Sats,
  UnixSeconds,
} from '../contracts/index.js';
import { checkPayLock, PAY1_TAG } from '../payment/lock.js';
import {
  heldSecrets,
  proofTotal,
  type PendingOp,
  type PendingOutput,
  type ProofStore,
  type WalletTx,
} from './store.js';

// ---------------------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------------------

/** A loaded `@cashu/cashu-ts` wallet per mint (the host builds it with its HTTP / test transport). */
export interface MintConnections {
  wallet(mint: MintUrl): Promise<CashuTsWallet>;
}

/** The NIP-60 wallet key: its public half, and a NUT-11 witness signer for the private half. */
export interface WalletKey {
  readonly pubkey: CashuP2pkPubkey;
  /** BIP-340 over SHA-256(secret) — `Signer.signSecret`, or cashu-ts `schnorrSignMessage`. */
  sign(secret: string): Promise<string>;
  /**
   * Lend the key, hex-encoded, to ONE cashu-ts call that needs it as a string (NUT-20 locked mint
   * quotes: cashu-ts signs the domain-separated quote message itself and exports no way to sign it
   * elsewhere). Only a key held in this process has it; a JS string cannot be wiped, so it is
   * used for nothing else. A signer-held key (`signSecret`) has none: its wallet takes unlocked
   * quotes.
   */
  withSecretHex?<T>(use: (hex: string) => Promise<T>): Promise<T>;
}

export interface SpendContext {
  readonly mints: MintConnections;
  readonly store: ProofStore;
  readonly key?: WalletKey;
  /** Clock for journaled operations (ADR 0014). Default: the system clock. */
  readonly now?: () => UnixSeconds;
}

/**
 * A journaled operation the mint shows no trace of is dropped only after this many seconds: until
 * then its request may still be in flight (ADR 0014). A retry of the same receive or mint reuses
 * its outputs meanwhile; a send's inputs are kept out of new selections.
 */
export const PENDING_SETTLE_AFTER_S = 600;

export type WalletErrorCode =
  | 'invalid-argument'
  | 'insufficient-funds'
  | 'spent'
  | 'not-ours'
  | 'mint-error'
  | 'bad-mint-response';

export class WalletError extends Error {
  override readonly name = 'WalletError';
  constructor(
    readonly code: WalletErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

// ---------------------------------------------------------------------------------------
// Conversions between the contracts' wire shape and cashu-ts'
// ---------------------------------------------------------------------------------------

export function toCashu(p: CashuProof): Proof {
  return {
    id: p.id,
    amount: Amount.from(p.amount),
    secret: p.secret,
    C: p.C,
    ...(p.dleq === undefined ? {} : { dleq: { ...p.dleq } }),
    ...(p.witness === undefined ? {} : { witness: p.witness }),
  };
}

export function fromCashu(p: Proof): CashuProof {
  const amount = p.amount.toNumber();
  const witness =
    p.witness === undefined
      ? undefined
      : typeof p.witness === 'string'
        ? p.witness
        : JSON.stringify(p.witness);
  return {
    id: p.id,
    amount,
    secret: p.secret,
    C: p.C,
    ...(p.dleq === undefined
      ? {}
      : { dleq: { s: p.dleq.s, e: p.dleq.e, ...(p.dleq.r === undefined ? {} : { r: p.dleq.r }) } }),
    ...(witness === undefined ? {} : { witness }),
  };
}

const COMPRESSED = /^0[23][0-9a-f]{64}$/;
/** NUT-10/11 tag keys with spending semantics — never accepted as "extra" tags on a send. */
const RESERVED_TAGS = new Set([
  'locktime',
  'refund',
  'pubkeys',
  'n_sigs',
  'n_sigs_refund',
  'sigflag',
]);

function checkAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 1)
    throw new WalletError('invalid-argument', 'amount must be a positive integer of sats');
}

function checkTags(tags: readonly (readonly string[])[] | undefined): P2PKTag[] {
  if (tags === undefined) return [];
  const out: P2PKTag[] = [];
  for (const tag of tags as readonly unknown[]) {
    const t: readonly unknown[] = Array.isArray(tag) ? (tag as readonly unknown[]) : [];
    if (t.length < 2 || !t.every((v): v is string => typeof v === 'string' && v.length > 0))
      throw new WalletError(
        'invalid-argument',
        'tags must be [key, value, …] of non-empty strings',
      );
    const [key = '', ...rest] = t;
    if (RESERVED_TAGS.has(key))
      throw new WalletError(
        'invalid-argument',
        `tag "${key}" has spending semantics and is refused`,
      );
    out.push([key, ...rest]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// The operations
// ---------------------------------------------------------------------------------------

export class Spender {
  private readonly locks = new Map<MintUrl, Promise<unknown>>();

  constructor(private readonly ctx: SpendContext) {}

  /** Run `f` with `mint` locked (FIFO). */
  private exclusive<T>(mint: MintUrl, f: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(mint) ?? Promise.resolve();
    const run = prev.then(f, f);
    const settled = run.catch(() => undefined);
    this.locks.set(mint, settled);
    void settled.then(() => {
      if (this.locks.get(mint) === settled) this.locks.delete(mint);
    });
    return run;
  }

  /**
   * NUT-11 P2PK send of exactly `amount` sats at `mint`, locked to `p2pk`, every proof with a
   * DLEQ the recipient can verify. The swap fee is the SENDER's (the recipient receives exactly
   * `amount` in locked proofs). Change is committed before the set is returned.
   */
  send(
    amount: Sats,
    opts: {
      readonly p2pk: CashuP2pkPubkey;
      readonly mint: MintUrl;
      readonly tags?: readonly (readonly string[])[];
      readonly memo?: string;
    },
  ): Promise<LockedProofSet> {
    checkAmount(amount);
    if (typeof opts.p2pk !== 'string' || !COMPRESSED.test(opts.p2pk.toLowerCase()))
      return Promise.reject(
        new WalletError('invalid-argument', 'p2pk must be a 33-byte compressed key (hex)'),
      );
    let tags: P2PKTag[];
    try {
      tags = checkTags(opts.tags);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    return this.exclusive(opts.mint, async () => {
      const w = await this.ctx.mints.wallet(opts.mint);
      const journal = this.journaling(w);
      // Proofs a pending send or melt may have spent stay out of the selection until it is settled.
      const busy = journal
        ? heldSecrets((await this.settle(opts.mint, w)).left)
        : new Set<string>();
      const held = (await this.ctx.store.proofs(opts.mint))
        .filter((p) => !busy.has(p.secret))
        .map(toCashu);
      let selected: Proof[];
      try {
        selected = w.selectProofsToSend(held, amount, true).send;
      } catch {
        throw new WalletError('insufficient-funds', `cannot cover ${amount} sat at this mint`);
      }
      if (selected.length === 0 || proofTotal(selected.map(fromCashu)) < amount)
        throw new WalletError('insufficient-funds', `cannot cover ${amount} sat at this mint`);

      const outputs: OutputConfig = {
        send: {
          type: 'p2pk',
          options: { pubkey: opts.p2pk, ...(tags.length > 0 ? { additionalTags: tags } : {}) },
        },
        keep: { type: 'random' },
      };
      const memo = opts.memo ?? `P2PK send ${String(amount)} sat`;
      let result: { send: Proof[]; keep: Proof[] };
      if (!journal) {
        try {
          result = await w.send(amount, selected, { includeFees: false }, outputs);
        } catch (e) {
          await this.reconcile(opts.mint, w, selected);
          throw new WalletError('mint-error', `P2PK swap failed (${errorName(e)})`);
        }
        await this.ctx.store.commit(sendTx(opts.mint, selected, result, amount, memo));
      } else {
        let preview: Awaited<ReturnType<CashuTsWallet['prepareSwapToSend']>>;
        try {
          preview = await w.prepareSwapToSend(amount, selected, { includeFees: false }, outputs);
        } catch (e) {
          throw new WalletError('mint-error', `P2PK swap failed (${errorName(e)})`);
        }
        const op = this.newOp(
          'send',
          opts.mint,
          preview.inputs.map((p) => p.secret),
          preview.keepOutputs ?? [],
          preview.sendOutputs ?? [],
          preview.inputs.map(fromCashu),
        );
        await this.ctx.store.commit({ mint: opts.mint, spent: [], added: [], begin: op });
        let recovered = false;
        try {
          result = await w.completeSwap(preview);
        } catch (e) {
          if (isDefinitive(e) && !isAlreadySigned(e)) {
            await this.drop(op);
            await this.reconcile(opts.mint, w, selected);
            throw new WalletError('mint-error', `P2PK swap failed (${errorName(e)})`);
          }
          // Maybe executed with the answer lost: the change is ours, the locked outputs the
          // recipient's — restored, committed, and the send completes after all.
          const r = await this.resolveSafe(w, op, true, memo);
          if (r.state !== 'executed')
            throw new WalletError('mint-error', `P2PK swap failed (${errorName(e)})`);
          result = { send: r.send, keep: r.keep };
          recovered = true;
        }
        if (!recovered)
          await this.ctx.store.commit({
            ...sendTx(opts.mint, selected, result, amount, memo),
            settle: [op.id],
          });
      }

      const sent = result.send.map(fromCashu);

      // Post-conditions on what the mint handed back (the inputs are gone either way).
      const binding = tags.find((t) => t[0] === PAY1_TAG)?.[1];
      if (proofTotal(sent) !== amount)
        throw new WalletError('bad-mint-response', 'locked outputs do not add up to the amount');
      const keys = w.getKeyset(sent[0]?.id);
      for (const p of result.send) {
        if (p.dleq?.r === undefined || !hasValidDleq(p, keys))
          throw new WalletError('bad-mint-response', 'a locked output has no valid DLEQ');
        const lock = checkPayLock(p.secret, opts.p2pk, binding === undefined ? {} : { binding });
        if (!lock.ok)
          throw new WalletError(
            'bad-mint-response',
            `a locked output is not a plain lock (${lock.reason})`,
          );
      }
      return { mint: opts.mint, unit: 'sat', lockedTo: opts.p2pk, proofs: sent };
    });
  }

  /**
   * Receive proofs into fresh, unlocked ones (NUT-03 swap). Proofs P2PK-locked to the wallet key
   * are signed with it first. Returns the sats added (after the mint's input fee).
   * `spent` = the mint says a proof was already spent (a double-spend, T5).
   */
  receive(set: { readonly mint: MintUrl; readonly proofs: readonly CashuProof[] }): Promise<Sats> {
    if (!Array.isArray(set.proofs) || set.proofs.length === 0)
      return Promise.reject(new WalletError('invalid-argument', 'nothing to receive'));
    return this.exclusive(set.mint, async () => {
      const w = await this.ctx.mints.wallet(set.mint);
      const inputs: Proof[] = [];
      for (const p of set.proofs) {
        const proof = toCashu(p);
        if (p.secret.startsWith('[')) {
          let signers: string[];
          try {
            signers = getP2PKExpectedWitnessPubkeys(p.secret);
          } catch {
            throw new WalletError('not-ours', 'a proof has a malformed spending condition');
          }
          const key = this.ctx.key;
          if (key === undefined || !signers.some((k) => sameKey(k, key.pubkey)))
            throw new WalletError(
              'not-ours',
              'a proof is locked to a key this wallet does not hold',
            );
          const sig = await key.sign(p.secret);
          inputs.push({ ...proof, witness: JSON.stringify({ signatures: [sig] }) });
        } else inputs.push(proof);
      }
      const memo = 'received ecash';
      let fresh: Proof[];
      if (!this.journaling(w)) {
        try {
          fresh = await w.receive(inputs);
        } catch (e) {
          throw receiveError(e);
        }
        return this.commitIn(set.mint, fresh, memo);
      }
      // Journaled (ADR 0014): a retry of a receive whose answer was lost is recovered, or reuses
      // the same outputs.
      const key = inputs.map((p) => p.secret);
      const { left, recovered } = await this.settle(set.mint, w);
      const done = recovered.get(opKey('receive', key));
      if (done !== undefined) return done as Sats;
      const prior = left.find((o) => o.kind === 'receive' && keyOf(o.key) === keyOf(key));
      let preview: Awaited<ReturnType<CashuTsWallet['prepareSwapToReceive']>>;
      try {
        preview = await w.prepareSwapToReceive(inputs, undefined, reuse(prior));
      } catch (e) {
        throw receiveError(e);
      }
      const op = prior ?? this.newOp('receive', set.mint, key, preview.keepOutputs ?? [], [], []);
      if (prior === undefined)
        await this.ctx.store.commit({ mint: set.mint, spent: [], added: [], begin: op });
      try {
        fresh = (await w.completeSwap(preview)).keep;
      } catch (e) {
        const r = await this.afterFailure(w, op, e, memo);
        if (r !== null) return proofTotal(r.keep.map(fromCashu)) as Sats;
        throw receiveError(e);
      }
      return this.commitIn(set.mint, fresh, memo, op.id);
    });
  }

  /**
   * NUT-05 melt: pay `quote` from the wallet's proofs at its mint. Change (NUT-08) comes back as
   * fresh proofs. The quote is re-read from the mint, so the amount paid is the mint's own.
   *
   * Journaled (ADR 0014 amendment, issue #8) where the store keeps a journal, the mint supports
   * NUT-09 and there is change to come back: the inputs and the NUT-08 blanks are written before
   * the request. An answer that never arrives, or a melt the mint reports PENDING, leaves the
   * inputs held and the blanks journaled; a later settle restores the change the mint signed.
   */
  melt(quote: MeltQuote): Promise<{ paid: boolean; preimage?: string; change: Sats }> {
    return this.exclusive(quote.mint, async () => {
      const w = await this.ctx.mints.wallet(quote.mint);
      let q: MeltQuoteBolt11Response;
      try {
        q = await w.checkMeltQuoteBolt11(quote.quoteId);
      } catch (e) {
        throw new WalletError('mint-error', `melt quote lookup failed (${errorName(e)})`);
      }
      if (q.amount.toNumber() !== quote.amount)
        throw new WalletError(
          'bad-mint-response',
          'the mint changed the melt amount since the quote was shown',
        );
      // The confirm dialog (security review F8) shows `quote.feeReserve`; never let the mint's
      // reserve exceed what the user agreed to.
      if (q.fee_reserve.toNumber() > quote.feeReserve)
        throw new WalletError(
          'bad-mint-response',
          'the mint asks a larger fee reserve than the quote that was shown',
        );
      const need = q.amount.add(q.fee_reserve);
      const journal = this.journaling(w);
      const memo = 'melt to Lightning';
      let busy = new Set<string>();
      if (journal) {
        const { left, recovered } = await this.settle(quote.mint, w);
        // An earlier melt of this quote whose answer was lost, recovered by this settle (a melt
        // entry only: another kind's key never answers for a melt).
        const done = recovered.get(opKey('melt', [quote.quoteId]));
        if (done !== undefined) return { paid: true, change: done as Sats };
        if (left.some((o) => o.kind === 'melt' && keyOf(o.key) === keyOf([quote.quoteId])))
          throw new WalletError(
            'mint-error',
            'an earlier melt of this quote is still unresolved at the mint',
          );
        busy = heldSecrets(left);
      }
      // Already paid (by an earlier melt of ours whose change an earlier settle restored, e.g.
      // the startup one): the invoice IS paid — say so, never "melt failed", and send nothing.
      // Its change, if any, is already in the wallet; the history has its line.
      if (q.state === 'PAID') {
        const preimage = q.payment_preimage;
        return {
          paid: true,
          ...(typeof preimage === 'string' && preimage.length > 0 ? { preimage } : {}),
          change: 0 as Sats,
        };
      }
      const held = (await this.ctx.store.proofs(quote.mint))
        .filter((p) => !busy.has(p.secret))
        .map(toCashu);
      let selected: Proof[];
      try {
        selected = w.selectProofsToSend(held, need, true).send;
      } catch {
        throw new WalletError(
          'insufficient-funds',
          'not enough sats at this mint for amount + fee reserve',
        );
      }
      if (selected.length === 0)
        throw new WalletError('insufficient-funds', 'not enough sats at this mint');
      let res: Awaited<ReturnType<CashuTsWallet['meltProofsBolt11']>>;
      let op: PendingOp | undefined;
      if (!journal) {
        try {
          res = await w.meltProofsBolt11(q, selected);
        } catch (e) {
          await this.reconcile(quote.mint, w, selected);
          throw new WalletError('mint-error', `melt failed (${errorName(e)})`);
        }
      } else {
        let preview: MeltPreview<MeltQuoteBolt11Response>;
        try {
          preview = await w.prepareMelt('bolt11', q, selected);
        } catch (e) {
          throw new WalletError('mint-error', `melt failed (${errorName(e)})`);
        }
        // No blanks (no change can come back): nothing to restore, so nothing to journal.
        if (preview.outputData.length > 0) {
          op = this.newOp(
            'melt',
            quote.mint,
            [quote.quoteId],
            preview.outputData,
            [],
            preview.inputs.map(fromCashu),
          );
          await this.ctx.store.commit({ mint: quote.mint, spent: [], added: [], begin: op });
        }
        try {
          res = await w.completeMelt(preview);
        } catch (e) {
          if (op === undefined || (isDefinitive(e) && !isAlreadySigned(e))) {
            // Refused by the mint (or not journaled): what is still unspent stays.
            if (op !== undefined) await this.drop(op);
            await this.reconcile(quote.mint, w, selected);
            throw new WalletError('mint-error', `melt failed (${errorName(e)})`);
          }
          // Maybe executed with the answer lost: the change the mint signed is restored now; if
          // none is yet, the inputs stay held and a later settle finds out (ADR 0014 amendment).
          const r = await this.resolveSafe(w, op, true, memo);
          if (r.state === 'executed')
            return { paid: true, change: proofTotal(r.keep.map(fromCashu)) as Sats };
          throw new WalletError(
            'mint-error',
            `melt outcome unknown (${errorName(e)}): its inputs are held until the mint answers`,
          );
        }
      }
      const change = res.change.map(fromCashu);
      const paid = res.quote.state === 'PAID';
      if (!paid) {
        // In flight (PENDING): the inputs are the mint's until it settles; the change it will
        // sign then is journaled, so the entry stays and a later settle resolves it.
        if (op !== undefined && res.quote.state === 'PENDING')
          return { paid: false, change: 0 as Sats };
        // Not paid: the mint may or may not have invalidated the inputs (pending, failed).
        // Keep what is still unspent, drop what is gone, pay nothing out of the history.
        if (op !== undefined) await this.drop(op);
        await this.reconcile(quote.mint, w, selected);
        return { paid: false, change: 0 as Sats };
      }
      const spentTotal = proofTotal(selected.map(fromCashu)) - proofTotal(change);
      await this.ctx.store.commit({
        mint: quote.mint,
        spent: selected.map(fromCashu),
        added: change,
        history: { direction: 'out', amount: spentTotal as Sats, memo },
        ...(op === undefined ? {} : { settle: [op.id] }),
      });
      const preimage = res.quote.payment_preimage;
      return {
        paid,
        ...(typeof preimage === 'string' && preimage.length > 0 ? { preimage } : {}),
        change: proofTotal(change) as Sats,
      };
    });
  }

  /**
   * NUT-04: mint the proofs of a PAID quote into the wallet. Returns the sats minted. A NUT-20
   * locked quote (`locked`: the mint's quote answer, naming its `pubkey`) is signed with this
   * wallet's key; a quote locked to any other key is refused.
   */
  mint(quote: MintQuote, locked?: MintQuoteBolt11Response): Promise<Sats> {
    return this.exclusive(quote.mint, async () => {
      const w = await this.ctx.mints.wallet(quote.mint);
      // A real mint (Nutshell) answers an UNLOCKED quote with `"pubkey": null`, whatever the
      // cashu-ts type says: only a non-empty string is a lock.
      const pk: unknown = locked?.pubkey;
      const lockedTo = typeof pk === 'string' && pk !== '' ? pk : undefined;
      const key = this.ctx.key;
      if (lockedTo !== undefined) {
        if (key?.withSecretHex === undefined || lockedTo.toLowerCase() !== key.pubkey.toLowerCase())
          throw new WalletError(
            'invalid-argument',
            'the quote is locked to a key this wallet cannot sign with',
          );
      }
      const memo = 'top-up';
      const journal = this.journaling(w);
      let prior: PendingOp | undefined;
      if (journal) {
        // A quote whose mint answer was lost is recovered, or minted again with the same outputs.
        const { left, recovered } = await this.settle(quote.mint, w);
        const done = recovered.get(opKey('mint', [quote.quoteId]));
        if (done !== undefined) return done as Sats;
        prior = left.find((o) => o.kind === 'mint' && keyOf(o.key) === keyOf([quote.quoteId]));
      }
      let preview: Awaited<ReturnType<CashuTsWallet['prepareMint']>>;
      try {
        // The key is lent to the prepare step only: it computes the NUT-20 signatures.
        preview =
          lockedTo !== undefined && key?.withSecretHex !== undefined && locked !== undefined
            ? await key.withSecretHex((privkey) =>
                w.prepareMint('bolt11', quote.amount, locked, { privkey }, reuse(prior)),
              )
            : await w.prepareMint(
                'bolt11',
                quote.amount,
                { quote: quote.quoteId },
                undefined,
                reuse(prior),
              );
      } catch (e) {
        throw new WalletError('mint-error', `minting failed (${errorName(e)})`);
      }
      const op = !journal
        ? undefined
        : (prior ?? this.newOp('mint', quote.mint, [quote.quoteId], preview.outputData, [], []));
      if (op !== undefined && prior === undefined)
        await this.ctx.store.commit({ mint: quote.mint, spent: [], added: [], begin: op });
      let proofs: Proof[];
      try {
        proofs = await w.completeMint(preview);
      } catch (e) {
        const r = op === undefined ? null : await this.afterFailure(w, op, e, memo);
        if (r !== null) return proofTotal(r.keep.map(fromCashu)) as Sats;
        throw new WalletError('mint-error', `minting failed (${errorName(e)})`);
      }
      return this.commitIn(quote.mint, proofs, memo, op?.id);
    });
  }

  /**
   * NUT-07: which of `set`'s proofs the mint reports SPENT, in order. Needs no ownership — the
   * seeder uses it on the creator set it forwards (security review F11). Rejects if the mint
   * cannot be asked.
   */
  checkSpent(set: {
    readonly mint: MintUrl;
    readonly proofs: readonly CashuProof[];
  }): Promise<readonly boolean[]> {
    return this.exclusive(set.mint, async () => {
      const w = await this.ctx.mints.wallet(set.mint);
      const states = await w.checkProofsStates(
        set.proofs.map((p) => ({ secret: p.secret, id: p.id })),
      );
      if (states.length !== set.proofs.length)
        throw new WalletError('bad-mint-response', 'checkstate answered for the wrong proofs');
      return states.map((st) => st.state === 'SPENT');
    });
  }

  /**
   * Whether EVERY proof of `set` was spent with a witness signed by this wallet's key — i.e. by
   * us, in a swap whose response was lost (security review F31), not by a double-spender, who
   * cannot sign with our key. `false` when any proof is unspent, lacks a witness, or the mint
   * cannot be asked.
   */
  async spentByUs(set: {
    readonly mint: MintUrl;
    readonly proofs: readonly CashuProof[];
  }): Promise<boolean> {
    const key = this.ctx.key;
    if (key === undefined || set.proofs.length === 0) return false;
    try {
      return await this.exclusive(set.mint, async () => {
        const w = await this.ctx.mints.wallet(set.mint);
        const states = await w.checkProofsStates(
          set.proofs.map((p) => ({ secret: p.secret, id: p.id })),
        );
        if (states.length !== set.proofs.length) return false;
        return set.proofs.every((p, i) => {
          const st = states[i];
          if (st?.state !== 'SPENT' || typeof st.witness !== 'string') return false;
          let sigs: unknown;
          try {
            sigs = (JSON.parse(st.witness) as { signatures?: unknown }).signatures;
          } catch {
            return false;
          }
          return (
            Array.isArray(sigs) &&
            sigs.some(
              (sig) => typeof sig === 'string' && schnorrVerifyMessage(sig, p.secret, key.pubkey),
            )
          );
        });
      });
    } catch {
      return false;
    }
  }

  /**
   * Settle the journal at `mint` (ADR 0014): recover what the mint signed for operations whose
   * answer was lost, drop those it never executed. Run at startup; every operation at a mint also
   * settles it first. Never throws for a mint that cannot be asked (the journal stays).
   */
  recover(mint: MintUrl): Promise<{ recovered: number; left: number }> {
    return this.exclusive(mint, async () => {
      const w = await this.ctx.mints.wallet(mint);
      if (!this.journaling(w)) return { recovered: 0, left: 0 };
      const { left, recovered } = await this.settle(mint, w);
      return { recovered: recovered.size, left: left.length };
    });
  }

  /**
   * What a journaled mint of `quote` added, if its answer was lost and the mint signed it — for a
   * quote the mint already reports ISSUED. `null` when there is nothing to recover.
   */
  recoverMint(quote: MintQuote): Promise<Sats | null> {
    return this.exclusive(quote.mint, async () => {
      const w = await this.ctx.mints.wallet(quote.mint);
      if (!this.journaling(w)) return null;
      const got = (await this.settle(quote.mint, w)).recovered.get(opKey('mint', [quote.quoteId]));
      return got === undefined ? null : (got as Sats);
    });
  }

  // ---- the journal (ADR 0014) -----------------------------------------------------------

  /** Journal only where the store keeps one and the mint can restore (NUT-09). */
  private journaling(w: CashuTsWallet): boolean {
    return this.ctx.store.pending !== undefined && supports(w, 9);
  }

  private now(): UnixSeconds {
    return this.ctx.now?.() ?? (Math.floor(Date.now() / 1000) as UnixSeconds);
  }

  private newOp(
    kind: PendingOp['kind'],
    mint: MintUrl,
    key: readonly string[],
    keep: readonly OutputDataLike[],
    send: readonly OutputDataLike[],
    spends: readonly CashuProof[],
  ): PendingOp {
    const first = keep[0] ?? send[0];
    if (first === undefined)
      throw new WalletError('bad-mint-response', 'an operation without outputs');
    return {
      id: first.blindedMessage.B_,
      kind,
      mint,
      key: [...key].sort(),
      keep: keep.map((o) => OutputData.serialize(o)),
      send: send.map((o) => OutputData.serialize(o)),
      spends: [...spends],
      created: this.now(),
    };
  }

  private async drop(op: PendingOp): Promise<void> {
    await this.ctx.store.commit({ mint: op.mint, spent: [], added: [], settle: [op.id] });
  }

  /** Commit proofs that came in (receive, mint), settling `op` with them. */
  private async commitIn(mint: MintUrl, fresh: Proof[], memo: string, op?: string): Promise<Sats> {
    const added = fresh.map(fromCashu);
    const got = proofTotal(added) as Sats;
    await this.ctx.store.commit({
      mint,
      spent: [],
      added,
      history: { direction: 'in', amount: got, memo },
      ...(op === undefined ? {} : { settle: [op] }),
    });
    return got;
  }

  /**
   * A journaled request failed. Refused by the mint: nothing executed, the journal entry goes.
   * Otherwise (no answer, or "already signed"): recover what the mint signed; `null` when it
   * signed nothing (yet) — the entry stays, for a retry or a later settle.
   */
  private async afterFailure(
    w: CashuTsWallet,
    op: PendingOp,
    e: unknown,
    memo: string,
  ): Promise<Restored | null> {
    if (isDefinitive(e) && !isAlreadySigned(e)) {
      await this.drop(op);
      return null;
    }
    const r = await this.resolveSafe(w, op, true, memo);
    return r.state === 'executed' ? r : null;
  }

  private async settle(
    mint: MintUrl,
    w: CashuTsWallet,
  ): Promise<{ left: PendingOp[]; recovered: Map<string, number> }> {
    const left: PendingOp[] = [];
    const recovered = new Map<string, number>();
    const ops = this.ctx.store.pending === undefined ? [] : await this.ctx.store.pending(mint);
    for (const op of ops) {
      const r = await this.resolveSafe(w, op, false);
      if (r.state === 'executed')
        recovered.set(opKey(op.kind, op.key), proofTotal(r.keep.map(fromCashu)));
      else if (r.state !== 'absent') left.push(op);
    }
    return { left, recovered };
  }

  private async resolveSafe(
    w: CashuTsWallet,
    op: PendingOp,
    fresh: boolean,
    memo?: string,
  ): Promise<Resolution> {
    try {
      return await this.resolve(w, op, fresh, memo);
    } catch {
      return { state: 'unknown' };
    }
  }

  /**
   * One journaled operation: `executed` (what the mint signed is committed now), `waiting`
   * (no trace yet, too young to drop), `absent` (no trace after the wait: dropped, a send's
   * inputs reconciled by NUT-07) or `unknown` (the mint could not be asked).
   */
  private async resolve(
    w: CashuTsWallet,
    op: PendingOp,
    fresh: boolean,
    memo?: string,
  ): Promise<Resolution> {
    const got = await this.restoreOp(w, op);
    if (got === null) return { state: 'unknown' };
    if (got.keep.length > 0 || got.send.length > 0) {
      const keep = got.keep.map(fromCashu);
      const kept = proofTotal(keep);
      await this.ctx.store.commit({
        mint: op.mint,
        spent: [...op.spends],
        added: keep,
        settle: [op.id],
        history:
          op.kind === 'send' || op.kind === 'melt'
            ? {
                direction: 'out',
                amount: Math.max(0, proofTotal(op.spends) - kept) as Sats,
                memo:
                  memo ??
                  (op.kind === 'send'
                    ? 'P2PK send (answer lost, change recovered)'
                    : 'melt to Lightning (change recovered)'),
              }
            : {
                direction: 'in',
                amount: kept as Sats,
                memo: `${memo ?? (op.kind === 'mint' ? 'top-up' : 'received ecash')} (recovered)`,
              },
      });
      return { state: 'executed', keep: got.keep, send: got.send };
    }
    if (fresh) return { state: 'waiting' };
    const young = this.now() - op.created < PENDING_SETTLE_AFTER_S;
    if (op.kind === 'melt') return this.resolveMelt(w, op, young);
    if (young) return { state: 'waiting' };
    if (op.spends.length === 0) {
      await this.drop(op);
      return { state: 'absent' };
    }
    const states = await w.checkProofsStates(
      op.spends.map((p) => ({ secret: p.secret, id: p.id })),
    );
    if (states.length !== op.spends.length) return { state: 'unknown' };
    const gone = op.spends.filter((_p, i) => states[i]?.state === 'SPENT');
    await this.ctx.store.commit({
      mint: op.mint,
      spent: gone,
      added: [],
      settle: [op.id],
      ...(gone.length === 0
        ? {}
        : {
            history: {
              direction: 'out' as const,
              amount: proofTotal(gone) as Sats,
              memo: `lost in a failed mint operation (${String(gone.length)} proofs)`,
            },
          }),
    });
    return { state: 'absent' };
  }

  /**
   * A journaled melt of which the mint signed no change (yet): its inputs say what happened
   * (NUT-07). PENDING — the payment is in flight: wait, however long. All SPENT after the wait —
   * it paid and no change was signed (none was due): committed as paid. Otherwise, after the wait,
   * like a send the mint never saw: the entry goes, what is still unspent stays.
   */
  private async resolveMelt(w: CashuTsWallet, op: PendingOp, young: boolean): Promise<Resolution> {
    const states = await w.checkProofsStates(
      op.spends.map((p) => ({ secret: p.secret, id: p.id })),
    );
    if (states.length !== op.spends.length) return { state: 'unknown' };
    if (states.some((st) => st.state === 'PENDING') || young) return { state: 'waiting' };
    const gone = op.spends.filter((_p, i) => states[i]?.state === 'SPENT');
    const paid = gone.length === op.spends.length && gone.length > 0;
    await this.ctx.store.commit({
      mint: op.mint,
      spent: gone,
      added: [],
      settle: [op.id],
      ...(gone.length === 0
        ? {}
        : {
            history: {
              direction: 'out' as const,
              amount: proofTotal(gone) as Sats,
              memo: paid
                ? 'melt to Lightning (settled after the answer, no change)'
                : `lost in a failed mint operation (${String(gone.length)} proofs)`,
            },
          }),
    });
    return paid ? { state: 'executed', keep: [], send: [] } : { state: 'absent' };
  }

  /**
   * NUT-09: the proofs the mint signed of `op`'s outputs (cashu-ts unblinds them and checks the
   * DLEQ where the mint sent one). `null` when the mint cannot be asked. A melt's outputs are
   * NUT-08 blanks: the mint assigns their amounts, so a signature's amount is the mint's (its
   * key for that amount checks the DLEQ and unblinds it), where every other output's must match.
   */
  private async restoreOp(w: CashuTsWallet, op: PendingOp): Promise<Restored | null> {
    const outs = [...op.keep, ...op.send].map(fromPending);
    let res: { outputs: { B_: string }[]; signatures: SerializedBlindedSignature[] };
    try {
      res = await w.mint.restore({ outputs: outs.map((o) => o.blindedMessage) });
    } catch {
      return null;
    }
    if (
      !Array.isArray(res.outputs) ||
      !Array.isArray(res.signatures) ||
      res.outputs.length !== res.signatures.length
    )
      throw new WalletError('bad-mint-response', 'restore answered a malformed list');
    // The live answers' rule (cashu-ts `requireSigDleq`): a NUT-12 mint signs with a DLEQ.
    const dleq = supports(w, 12);
    const blanks = op.kind === 'melt';
    const byB = new Map<string, SerializedBlindedSignature>();
    res.outputs.forEach((o, i) => {
      const sig = res.signatures[i];
      if (sig !== undefined) byB.set(o.B_, sig);
    });
    const proofs = outs.map((o): Proof | null => {
      const sig = byB.get(o.blindedMessage.B_);
      if (sig === undefined) return null;
      if (
        sig.id !== o.blindedMessage.id ||
        (!blanks &&
          Amount.from(sig.amount).toNumber() !== Amount.from(o.blindedMessage.amount).toNumber()) ||
        (dleq && sig.dleq === undefined)
      )
        throw new WalletError('bad-mint-response', 'a restored signature does not match');
      return o.toProof(sig, w.getKeyset(sig.id));
    });
    const n = op.keep.length;
    return {
      keep: proofs.slice(0, n).filter((p): p is Proof => p !== null),
      send: proofs.slice(n).filter((p): p is Proof => p !== null),
    };
  }

  /**
   * After a swap/melt that failed ambiguously: ask the mint which inputs are spent (NUT-07).
   * Unspent inputs stay; spent ones are dropped from the store (they are gone), recorded as a
   * loss. If the state cannot be read either, nothing changes and the inputs are kept.
   */
  private async reconcile(mint: MintUrl, w: CashuTsWallet, inputs: Proof[]): Promise<void> {
    let states: { state: string }[];
    try {
      states = await w.checkProofsStates(inputs);
    } catch {
      return;
    }
    const gone = inputs.filter((_p, i) => states[i]?.state === 'SPENT').map(fromCashu);
    if (gone.length === 0) return;
    await this.ctx.store.commit({
      mint,
      spent: gone,
      added: [],
      history: {
        direction: 'out',
        amount: proofTotal(gone) as Sats,
        memo: `lost in a failed mint operation (${String(gone.length)} proofs)`,
      },
    });
  }
}

interface Restored {
  readonly keep: Proof[];
  readonly send: Proof[];
}

type Resolution =
  | ({ readonly state: 'executed' } & Restored)
  | { readonly state: 'waiting' | 'absent' | 'unknown' };

/** A retry's identity: its sorted keys, unambiguous. */
function keyOf(key: readonly string[]): string {
  return JSON.stringify([...key].sort());
}

/** A recovered operation's identity: its kind and its keys (a mint quote never answers a melt). */
function opKey(kind: PendingOp['kind'], key: readonly string[]): string {
  return `${kind}:${keyOf(key)}`;
}

function fromPending(o: PendingOutput): OutputData {
  return OutputData.deserialize({ ...o, blindedMessage: { ...o.blindedMessage } });
}

/** The journaled outputs of a prior attempt, reused by its retry. */
function reuse(prior: PendingOp | undefined): OutputType | undefined {
  return prior === undefined ? undefined : { type: 'custom', data: prior.keep.map(fromPending) };
}

function sendTx(
  mint: MintUrl,
  selected: Proof[],
  result: { send: Proof[]; keep: Proof[] },
  amount: Sats,
  memo: string,
): WalletTx {
  const sent = result.send.map(fromCashu);
  const keep = result.keep.map(fromCashu);
  const fee = proofTotal(selected.map(fromCashu)) - proofTotal(sent) - proofTotal(keep);
  return {
    mint,
    spent: selected.map(fromCashu),
    added: keep,
    history: { direction: 'out', amount: (amount + Math.max(0, fee)) as Sats, memo },
  };
}

function receiveError(e: unknown): WalletError {
  return isSpentError(e)
    ? new WalletError('spent', 'the mint reports a proof as already spent')
    : new WalletError('mint-error', `receive failed (${errorName(e)})`);
}

/** A NUT in the mint's info (loaded with the mint). Never throws. */
function supports(w: CashuTsWallet, nut: 9 | 12): boolean {
  try {
    return w.getMintInfo().isSupported(nut).supported;
  } catch {
    return false;
  }
}

/**
 * The mint refused the request; nothing executed: it answered with an error code; or cashu-ts
 * wrapped that coded answer — a keyset refusal (12xxx) comes back as a `StaleKeysetError` whose
 * `cause` is the coded error. Only that wrapper: a coded `cause` under any other error is NOT a
 * refusal (cashu-ts's `MeltChangeError` means the melt completed).
 *
 * A coded answer is the mint's answer to OUR request only when the transport sends each request
 * once. Every production transport does (issue #8, fix round 2): the desktop money plane's and the
 * daemons' are `cashuRequestFn` over Node http(s), which never retries, and cashu-ts itself sends a
 * swap, melt or mint once over a custom transport (`withStaleKeysetRepair` does not resend; the
 * NUT-20 legacy fallback resends only after a coded 20008 refusal). cashu-ts's OWN fetch transport
 * retries NUT-19 cached endpoints, and a retry's answer says nothing about the first attempt — it
 * is used by no production wallet.
 *
 * A 429 (`RateLimitError`) is NOT a refusal: a rate limiter may answer the retry of a request that
 * executed, its answer lost (fix round 2: funds lost on cdk-mintd, where a retrying transport met a
 * 429 after the swap had run). It is resolved like any lost answer — held, then NUT-09 / NUT-07.
 */
function isDefinitive(e: unknown): boolean {
  if (hasCode(e)) return true;
  return e instanceof StaleKeysetError && hasCode(e.cause);
}

function hasCode(e: unknown): boolean {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'number';
}

/** The mint already signed these outputs or issued this quote: maybe our own earlier attempt. */
function isAlreadySigned(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const code = (e as { code?: unknown }).code;
  const msg = e instanceof Error ? e.message : '';
  return (
    code === 10002 || code === 20002 || /already (been )?(signed|issued)|signed before/i.test(msg)
  );
}

function sameKey(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  // An x-only (32-byte) key matches either compressed form of itself (NIP-61 locks use 02…).
  const strip = (k: string): string => (k.length === 66 ? k.slice(2) : k);
  return strip(x) === strip(y);
}

function isSpentError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const code = (e as { code?: unknown }).code;
  const msg = e instanceof Error ? e.message : '';
  return code === 11001 || /already spent/i.test(msg);
}

/** A class name for an error message — never the error's own text, which may quote inputs. */
function errorName(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return typeof code === 'number' ? `${e.name} ${String(code)}` : e.name;
  }
  return 'unknown error';
}

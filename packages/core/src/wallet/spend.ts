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
  type MeltQuoteBolt11Response,
  type P2PKTag,
  type Proof,
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
} from '../contracts/index.js';
import { checkPayLock, PAY1_TAG } from '../payment/lock.js';
import { proofTotal, type ProofStore } from './store.js';

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
}

export interface SpendContext {
  readonly mints: MintConnections;
  readonly store: ProofStore;
  readonly key?: WalletKey;
}

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
      const held = (await this.ctx.store.proofs(opts.mint)).map(toCashu);
      let selected: Proof[];
      try {
        selected = w.selectProofsToSend(held, amount, true).send;
      } catch {
        throw new WalletError('insufficient-funds', `cannot cover ${amount} sat at this mint`);
      }
      if (selected.length === 0 || proofTotal(selected.map(fromCashu)) < amount)
        throw new WalletError('insufficient-funds', `cannot cover ${amount} sat at this mint`);

      let result: { send: Proof[]; keep: Proof[] };
      try {
        result = await w.send(
          amount,
          selected,
          { includeFees: false },
          {
            send: {
              type: 'p2pk',
              options: { pubkey: opts.p2pk, ...(tags.length > 0 ? { additionalTags: tags } : {}) },
            },
            keep: { type: 'random' },
          },
        );
      } catch (e) {
        await this.reconcile(opts.mint, w, selected);
        throw new WalletError('mint-error', `P2PK swap failed (${errorName(e)})`);
      }

      const sent = result.send.map(fromCashu);
      const keep = result.keep.map(fromCashu);
      const fee = proofTotal(selected.map(fromCashu)) - proofTotal(sent) - proofTotal(keep);
      await this.ctx.store.commit({
        mint: opts.mint,
        spent: selected.map(fromCashu),
        added: keep,
        history: {
          direction: 'out',
          amount: (amount + Math.max(0, fee)) as Sats,
          memo: opts.memo ?? `P2PK send ${String(amount)} sat`,
        },
      });

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
      let fresh: Proof[];
      try {
        fresh = await w.receive(inputs);
      } catch (e) {
        if (isSpentError(e))
          throw new WalletError('spent', 'the mint reports a proof as already spent');
        throw new WalletError('mint-error', `receive failed (${errorName(e)})`);
      }
      const added = fresh.map(fromCashu);
      const got = proofTotal(added);
      await this.ctx.store.commit({
        mint: set.mint,
        spent: [],
        added,
        history: { direction: 'in', amount: got as Sats, memo: 'received ecash' },
      });
      return got as Sats;
    });
  }

  /**
   * NUT-05 melt: pay `quote` from the wallet's proofs at its mint. Change (NUT-08) comes back as
   * fresh proofs. The quote is re-read from the mint, so the amount paid is the mint's own.
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
      const need = q.amount.add(q.fee_reserve);
      const held = (await this.ctx.store.proofs(quote.mint)).map(toCashu);
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
      try {
        res = await w.meltProofsBolt11(q, selected);
      } catch (e) {
        await this.reconcile(quote.mint, w, selected);
        throw new WalletError('mint-error', `melt failed (${errorName(e)})`);
      }
      const change = res.change.map(fromCashu);
      const paid = res.quote.state === 'PAID';
      if (!paid) {
        // Not paid: the mint may or may not have invalidated the inputs (pending, failed).
        // Keep what is still unspent, drop what is gone, pay nothing out of the history.
        await this.reconcile(quote.mint, w, selected);
        return { paid: false, change: 0 as Sats };
      }
      const spentTotal = proofTotal(selected.map(fromCashu)) - proofTotal(change);
      await this.ctx.store.commit({
        mint: quote.mint,
        spent: selected.map(fromCashu),
        added: change,
        history: { direction: 'out', amount: spentTotal as Sats, memo: 'melt to Lightning' },
      });
      const preimage = res.quote.payment_preimage;
      return {
        paid,
        ...(typeof preimage === 'string' && preimage.length > 0 ? { preimage } : {}),
        change: proofTotal(change) as Sats,
      };
    });
  }

  /** NUT-04: mint the proofs of a PAID quote into the wallet. Returns the sats minted. */
  mint(quote: MintQuote): Promise<Sats> {
    return this.exclusive(quote.mint, async () => {
      const w = await this.ctx.mints.wallet(quote.mint);
      let proofs: Proof[];
      try {
        proofs = await w.mintProofsBolt11(quote.amount, quote.quoteId);
      } catch (e) {
        throw new WalletError('mint-error', `minting failed (${errorName(e)})`);
      }
      const added = proofs.map(fromCashu);
      await this.ctx.store.commit({
        mint: quote.mint,
        spent: [],
        added,
        history: { direction: 'in', amount: proofTotal(added) as Sats, memo: 'top-up' },
      });
      return proofTotal(added) as Sats;
    });
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

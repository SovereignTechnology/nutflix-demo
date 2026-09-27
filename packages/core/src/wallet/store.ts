/**
 * ProofStore — the wallet's persistent state: which proofs are unspent, per mint, plus the
 * transaction history. `spend.ts` changes it ONLY through `commit()`, one atomic transition per
 * mint operation, recorded BEFORE the operation's result is handed back (contract `Wallet.send`:
 * "updates NIP-60 state … BEFORE returning").
 *
 * Two implementations: `MemoryProofStore` (tests, and the web shell's in-memory mode — build-plan
 * §5: nothing persisted in the browser) and `Nip60ProofStore` (`nip60.ts`, kind 7375/7376 on the
 * user's relays, NIP-44 encrypted to self).
 */
import type {
  CashuProof,
  MintUrl,
  NostrEventId,
  Sats,
  UnixSeconds,
  WalletHistoryEntry,
} from '../contracts/index.js';

/**
 * One output of a pending operation, in cashu-ts `OutputData.serialize` form: the blinded message,
 * its blinding factor and its secret. Bearer ecash once the mint has signed it — stored like proofs.
 */
export interface PendingOutput {
  readonly blindedMessage: { readonly amount: string; readonly B_: string; readonly id: string };
  readonly blindingFactor: string;
  readonly secret: string;
  readonly ephemeralE?: string;
}

/**
 * A mint operation journaled BEFORE its request is sent (ADR 0014, security review F31): if the
 * response is lost, the outputs the mint signed are recovered with NUT-09 restore instead of being
 * gone. Settled (dropped) atomically with the proofs it produced.
 *
 * While an operation that `spends` proofs (a send, a melt) is journaled, those proofs are held:
 * out of new selections and out of the balance (ADR 0014 amendment, issue #8), until the mint
 * says what became of them.
 */
export interface PendingOp {
  /**
   * The first output's `B_`: unique while outputs are random, or derived from counters that never
   * repeat (NUT-13, ADR 0016 §3 — the lease-ahead `DurableCounterSource`).
   */
  readonly id: string;
  /**
   * `melt` (ADR 0014 amendment, issue #8): a NUT-05 melt; `keep` holds its NUT-08 blank change
   * outputs, whose amounts the mint assigns when it signs them.
   */
  readonly kind: 'receive' | 'send' | 'mint' | 'melt';
  readonly mint: MintUrl;
  /**
   * What a retry of the same operation carries: the inputs' secrets, or the quote id (mint and
   * melt); sorted.
   */
  readonly key: readonly string[];
  /** Outputs that become this wallet's proofs (a melt's: its change blanks). */
  readonly keep: readonly PendingOutput[];
  /** Outputs locked to someone else (a P2PK send): restored only to account for them. */
  readonly send: readonly PendingOutput[];
  /** This wallet's proofs the operation consumes (a send, a melt); none for receive and mint. */
  readonly spends: readonly CashuProof[];
  readonly created: UnixSeconds;
}

/** The kinds a journal entry may have. */
export const PENDING_KINDS: readonly PendingOp['kind'][] = ['receive', 'send', 'mint', 'melt'];

const HEX = /^[0-9a-f]+$/;
const DECIMAL = /^[0-9]+$/;

/** A stored proof's shape (hex keyset id and `C`, a positive safe-integer amount, a secret). */
export function isStoredProof(x: unknown): x is CashuProof {
  if (typeof x !== 'object' || x === null) return false;
  const p = x as Record<string, unknown>;
  return (
    typeof p['id'] === 'string' &&
    HEX.test(p['id']) &&
    typeof p['amount'] === 'number' &&
    Number.isSafeInteger(p['amount']) &&
    p['amount'] > 0 &&
    typeof p['secret'] === 'string' &&
    p['secret'].length > 0 &&
    typeof p['C'] === 'string' &&
    HEX.test(p['C'])
  );
}

/** A journaled output's shape (`OutputData.serialize`). */
export function isPendingOutput(x: unknown): x is PendingOutput {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  const bm = o['blindedMessage'];
  if (typeof bm !== 'object' || bm === null) return false;
  const b = bm as Record<string, unknown>;
  return (
    typeof b['amount'] === 'string' &&
    DECIMAL.test(b['amount']) &&
    typeof b['B_'] === 'string' &&
    HEX.test(b['B_']) &&
    typeof b['id'] === 'string' &&
    HEX.test(b['id']) &&
    typeof o['blindingFactor'] === 'string' &&
    DECIMAL.test(o['blindingFactor']) &&
    typeof o['secret'] === 'string' &&
    HEX.test(o['secret']) &&
    (o['ephemeralE'] === undefined ||
      (typeof o['ephemeralE'] === 'string' && HEX.test(o['ephemeralE'])))
  );
}

/**
 * A journal entry read back from storage (a sealed file): the exact shape, or `false`. A store
 * that finds an entry failing this refuses to open rather than drop it — it may be money.
 */
export function isPendingOp(x: unknown): x is PendingOp {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o['id'] === 'string' &&
    HEX.test(o['id']) &&
    (PENDING_KINDS as readonly unknown[]).includes(o['kind']) &&
    typeof o['mint'] === 'string' &&
    /^https?:\/\//.test(o['mint']) &&
    Array.isArray(o['key']) &&
    o['key'].every((k) => typeof k === 'string') &&
    Array.isArray(o['keep']) &&
    o['keep'].every(isPendingOutput) &&
    Array.isArray(o['send']) &&
    o['send'].every(isPendingOutput) &&
    Array.isArray(o['spends']) &&
    o['spends'].every(isStoredProof) &&
    typeof o['created'] === 'number' &&
    Number.isSafeInteger(o['created'])
  );
}

/**
 * The secrets of proofs held by unresolved journaled operations (ADR 0014 amendment): out of new
 * selections, and out of the balance, until the mint says what became of them.
 */
export function heldSecrets(ops: readonly PendingOp[]): Set<string> {
  const held = new Set<string>();
  for (const op of ops) for (const p of op.spends) held.add(p.secret);
  return held;
}

/** One atomic wallet transition at one mint. */
export interface WalletTx {
  readonly mint: MintUrl;
  /** Proofs consumed by this operation (matched by `secret`). */
  readonly spent: readonly CashuProof[];
  /** New unspent proofs this operation leaves in the wallet (change, received, minted). */
  readonly added: readonly CashuProof[];
  /** The history line; omitted for bookkeeping-only transitions (e.g. dropping spent proofs). */
  readonly history?: {
    readonly direction: 'in' | 'out';
    readonly amount: Sats;
    readonly memo?: string;
  };
  /** Journal this operation (only on a store with `pending`). */
  readonly begin?: PendingOp;
  /** Drop these journaled operations (by id). */
  readonly settle?: readonly string[];
}

export interface ProofStore {
  mints(): Promise<readonly MintUrl[]>;
  proofs(mint: MintUrl): Promise<readonly CashuProof[]>;
  /** Apply `tx` atomically. Returns the history entry it recorded, if any. */
  commit(tx: WalletTx): Promise<WalletHistoryEntry | null>;
  /**
   * The journaled operations at `mint` (ADR 0014). A store that has this keeps `begin` / `settle`
   * as durably as its proofs; without it the wallet journals nothing, and an operation whose
   * response is lost cannot be recovered.
   */
  pending?(mint: MintUrl): Promise<readonly PendingOp[]>;
  /**
   * Transitions not yet published where they are durable (`Nip60ProofStore`: the relay outbox).
   * A seeded wallet moves its NUT-13 `published` watermark only while this is 0 (ADR 0016 §3); a
   * store without it counts as always published.
   */
  unsynced?(): number;
  history(opts?: {
    readonly limit?: number;
    readonly mint?: MintUrl;
  }): Promise<readonly WalletHistoryEntry[]>;
}

/** A deep copy (plain JSON data; `structuredClone` is not in every runtime core runs in). */
function cloneOp(o: PendingOp): PendingOp {
  return JSON.parse(JSON.stringify(o)) as PendingOp;
}

/** Sum of proof amounts. */
export function proofTotal(proofs: readonly Pick<CashuProof, 'amount'>[]): number {
  let n = 0;
  for (const p of proofs) n += p.amount;
  return n;
}

/**
 * In-memory store. Proofs are deduplicated by secret (a proof can only exist once). Copies go
 * in and out, so a caller cannot mutate the store's state by holding a reference.
 */
export class MemoryProofStore implements ProofStore {
  private readonly byMint = new Map<MintUrl, Map<string, CashuProof>>();
  private readonly ops = new Map<string, PendingOp>();
  private readonly hist: WalletHistoryEntry[] = [];
  private seq = 0;

  constructor(
    private readonly now: () => UnixSeconds = () => Math.floor(Date.now() / 1000) as UnixSeconds,
  ) {}

  mints(): Promise<readonly MintUrl[]> {
    return Promise.resolve([...this.byMint.keys()]);
  }

  proofs(mint: MintUrl): Promise<readonly CashuProof[]> {
    return Promise.resolve([...(this.byMint.get(mint)?.values() ?? [])].map((p) => ({ ...p })));
  }

  commit(tx: WalletTx): Promise<WalletHistoryEntry | null> {
    let m = this.byMint.get(tx.mint);
    if (!m) {
      m = new Map();
      this.byMint.set(tx.mint, m);
    }
    for (const p of tx.spent) m.delete(p.secret);
    for (const p of tx.added) m.set(p.secret, { ...p });
    for (const id of tx.settle ?? []) this.ops.delete(id);
    if (tx.begin !== undefined) this.ops.set(tx.begin.id, cloneOp(tx.begin));
    if (tx.history === undefined) return Promise.resolve(null);
    const id = `mem-${String(++this.seq).padStart(8, '0')}` as NostrEventId;
    const entry: WalletHistoryEntry = {
      id,
      direction: tx.history.direction,
      amount: tx.history.amount,
      mint: tx.mint,
      at: this.now(),
      ...(tx.history.memo === undefined ? {} : { memo: tx.history.memo }),
      created: [],
      destroyed: [],
    };
    this.hist.push(entry);
    return Promise.resolve(entry);
  }

  pending(mint: MintUrl): Promise<readonly PendingOp[]> {
    return Promise.resolve([...this.ops.values()].filter((o) => o.mint === mint).map(cloneOp));
  }

  history(opts?: {
    readonly limit?: number;
    readonly mint?: MintUrl;
  }): Promise<readonly WalletHistoryEntry[]> {
    let h = [...this.hist].reverse();
    if (opts?.mint !== undefined) h = h.filter((e) => e.mint === opts.mint);
    if (opts?.limit !== undefined) h = h.slice(0, opts.limit);
    return Promise.resolve(h);
  }
}

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
 */
export interface PendingOp {
  /** The first output's `B_` (random, so unique). */
  readonly id: string;
  readonly kind: 'receive' | 'send' | 'mint';
  readonly mint: MintUrl;
  /** What a retry of the same operation carries: the inputs' secrets, or the quote id; sorted. */
  readonly key: readonly string[];
  /** Outputs that become this wallet's proofs. */
  readonly keep: readonly PendingOutput[];
  /** Outputs locked to someone else (a P2PK send): restored only to account for them. */
  readonly send: readonly PendingOutput[];
  /** This wallet's proofs the operation consumes (a send); none for receive and mint. */
  readonly spends: readonly CashuProof[];
  readonly created: UnixSeconds;
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

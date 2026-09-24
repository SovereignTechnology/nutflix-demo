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
}

export interface ProofStore {
  mints(): Promise<readonly MintUrl[]>;
  proofs(mint: MintUrl): Promise<readonly CashuProof[]>;
  /** Apply `tx` atomically. Returns the history entry it recorded, if any. */
  commit(tx: WalletTx): Promise<WalletHistoryEntry | null>;
  history(opts?: {
    readonly limit?: number;
    readonly mint?: MintUrl;
  }): Promise<readonly WalletHistoryEntry[]>;
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

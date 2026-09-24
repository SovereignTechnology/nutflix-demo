/**
 * `FileProofStore` — the daemon wallet's `ProofStore` (`@sovit/core` wallet): the unspent proofs
 * per mint plus a bounded history, in one JSON file, 0600, rewritten atomically and fsynced on
 * every `commit()` (`files.ts`) before the wallet hands an operation's result back.
 *
 * The proofs are bearer ecash once the seeder has swapped them: whoever reads the file can spend
 * them. What protects them is the file mode, the unit's `StateDirectoryMode=0700`, the dedicated
 * service user and `ProtectHome=`/`ProtectSystem=` — the same boundary as the process memory that
 * holds them. ADR 0011 records this and the alternatives (NIP-60 on relays, encryption to self).
 *
 * A file that exists but does not parse is NOT treated as empty: the first commit would overwrite
 * it and destroy whatever it still held. `load()` throws and the daemon refuses to start.
 */
import type {
  CashuProof,
  MintUrl,
  NostrEventId,
  UnixSeconds,
  WalletHistoryEntry,
} from '@sovit/core';
import type { wallet as walletMod } from '@sovit/core';

import { RuntimeSetupError, assertPrivate, readTextIfExists, writeFileAtomic } from './files.js';

type ProofStore = walletMod.ProofStore;
type WalletTx = walletMod.WalletTx;

const FORMAT = 'nutflix-seeder-wallet';
const VERSION = 1;
/** History lines kept (newest first when read); the proofs themselves are never dropped. */
export const HISTORY_LIMIT = 1000;

interface WalletFile {
  readonly format: typeof FORMAT;
  readonly v: typeof VERSION;
  readonly seq: number;
  readonly mints: Record<string, CashuProof[]>;
  readonly history: WalletHistoryEntry[];
}

const HEX = /^[0-9a-f]+$/;

function isProof(x: unknown): x is CashuProof {
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

function isEntry(x: unknown): x is WalletHistoryEntry {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e['id'] === 'string' &&
    (e['direction'] === 'in' || e['direction'] === 'out') &&
    typeof e['amount'] === 'number' &&
    typeof e['mint'] === 'string' &&
    typeof e['at'] === 'number' &&
    Array.isArray(e['created']) &&
    Array.isArray(e['destroyed'])
  );
}

function parse(text: string): WalletFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o['format'] !== FORMAT || o['v'] !== VERSION) return null;
  const seq = o['seq'];
  const mints = o['mints'];
  const history = o['history'];
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return null;
  if (typeof mints !== 'object' || mints === null || Array.isArray(mints)) return null;
  if (!Array.isArray(history) || !history.every(isEntry)) return null;
  const out: Record<string, CashuProof[]> = {};
  for (const [mint, proofs] of Object.entries(mints as Record<string, unknown>)) {
    if (!/^https?:\/\//.test(mint) || !Array.isArray(proofs) || !proofs.every(isProof)) return null;
    out[mint] = proofs;
  }
  return { format: FORMAT, v: VERSION, seq, mints: out, history };
}

export class FileProofStore implements ProofStore {
  private byMint = new Map<MintUrl, Map<string, CashuProof>>();
  private hist: WalletHistoryEntry[] = [];
  private seq = 0;
  /** Commits run one at a time, in call order: each rewrites the whole file. */
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly path: string,
    private readonly now: () => UnixSeconds,
  ) {}

  /** Open (or start) the wallet file. Throws `RuntimeSetupError` on a file it cannot trust. */
  static async open(
    path: string,
    now: () => UnixSeconds = () => Math.floor(Date.now() / 1000) as UnixSeconds,
  ): Promise<FileProofStore> {
    const store = new FileProofStore(path, now);
    await assertPrivate(path, 'the wallet file');
    const text = await readTextIfExists(path);
    if (text === null) return store;
    const file = parse(text);
    if (file === null)
      throw new RuntimeSetupError(
        `the wallet file ${path} is unreadable — refusing to start rather than overwrite it; ` +
          'recover its proofs before moving it aside',
      );
    store.seq = file.seq;
    store.hist = file.history;
    for (const [mint, proofs] of Object.entries(file.mints))
      store.byMint.set(mint as MintUrl, new Map(proofs.map((p) => [p.secret, p])));
    return store;
  }

  mints(): Promise<readonly MintUrl[]> {
    return Promise.resolve([...this.byMint.keys()]);
  }

  proofs(mint: MintUrl): Promise<readonly CashuProof[]> {
    return Promise.resolve([...(this.byMint.get(mint)?.values() ?? [])].map((p) => ({ ...p })));
  }

  commit(tx: WalletTx): Promise<WalletHistoryEntry | null> {
    const run = this.chain.then(() => this.apply(tx));
    this.chain = run.catch(() => undefined);
    return run;
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

  /** Build the next state, write it durably, and only then make it the live one. */
  private async apply(tx: WalletTx): Promise<WalletHistoryEntry | null> {
    const next = new Map(this.byMint);
    const m = new Map(next.get(tx.mint) ?? []);
    for (const p of tx.spent) m.delete(p.secret);
    for (const p of tx.added) m.set(p.secret, { ...p });
    if (m.size === 0) next.delete(tx.mint);
    else next.set(tx.mint, m);

    let entry: WalletHistoryEntry | null = null;
    let seq = this.seq;
    let hist = this.hist;
    if (tx.history !== undefined) {
      seq += 1;
      entry = {
        id: `file-${String(seq).padStart(10, '0')}` as NostrEventId,
        direction: tx.history.direction,
        amount: tx.history.amount,
        mint: tx.mint,
        at: this.now(),
        ...(tx.history.memo === undefined ? {} : { memo: tx.history.memo }),
        created: [],
        destroyed: [],
      };
      hist = [...hist, entry].slice(-HISTORY_LIMIT);
    }
    const file: WalletFile = {
      format: FORMAT,
      v: VERSION,
      seq,
      mints: Object.fromEntries([...next].map(([mint, ps]) => [mint, [...ps.values()]])),
      history: hist,
    };
    await writeFileAtomic(this.path, JSON.stringify(file));
    this.byMint = next;
    this.hist = hist;
    this.seq = seq;
    return entry;
  }
}

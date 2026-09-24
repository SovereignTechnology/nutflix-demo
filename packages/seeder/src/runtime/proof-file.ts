/**
 * `FileProofStore` — the daemon wallet's `ProofStore` (`@sovit/core` wallet): the unspent proofs
 * per mint plus a bounded history, in one file, 0600, rewritten atomically and fsynced on every
 * `commit()` (`files.ts`) before the wallet hands an operation's result back.
 *
 * Encrypted at rest (ADR 0011 §2): the JSON is NIP-44 encrypted to the node's own Nostr key — the
 * scheme NIP-60 uses for wallet events — through the signer (`selfCipher`), so no key leaves it and
 * no cryptography is written here. NIP-44 takes at most 64 KiB per message, so the JSON is cut into
 * chunks that each carry `index/count` inside the ciphertext: a chunk swapped, dropped or
 * reordered does not decrypt to a wallet. This protects a stolen disk, a copied data directory or
 * a leaked backup; it does not protect a live compromise of the process, which holds the key.
 * The proofs inside are bearer ecash.
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
import type { NostrPubkey, Signer, wallet as walletMod } from '@sovit/core';

import { RuntimeSetupError, assertPrivate, readTextIfExists, writeFileAtomic } from './files.js';

type ProofStore = walletMod.ProofStore;
type WalletTx = walletMod.WalletTx;

const FORMAT = 'nutflix-seeder-wallet';
const VERSION = 1;
/** The encrypted envelope around a VERSION-1 wallet document. */
const ENCRYPTED_VERSION = 2;
const ENC = 'nip44-self';
/** Characters per chunk; the plaintext is ASCII (see `toAscii`), so also bytes. NIP-44 max: 65535. */
const CHUNK = 60_000;

/** How the file is sealed: NIP-44 to the node's own key (`selfCipher`), or a test double. */
export interface FileCipher {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

/** NIP-44 encryption to `pubkey` itself through the signer — the key never leaves it. */
export function selfCipher(
  signer: Pick<Signer, 'nip44Encrypt' | 'nip44Decrypt'>,
  pubkey: NostrPubkey,
): FileCipher {
  return {
    encrypt: (plaintext) => signer.nip44Encrypt(pubkey, plaintext),
    decrypt: (ciphertext) => signer.nip44Decrypt(pubkey, ciphertext),
  };
}

/** JSON with every non-ASCII character escaped (valid JSON; one byte per character). */
function toAscii(json: string): string {
  return json.replace(
    /[\u0080-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

async function seal(cipher: FileCipher, doc: WalletFile): Promise<string> {
  const text = toAscii(JSON.stringify(doc));
  const n = Math.max(1, Math.ceil(text.length / CHUNK));
  const chunks: string[] = [];
  for (let i = 0; i < n; i++)
    chunks.push(
      await cipher.encrypt(`${String(i)}/${String(n)}\n${text.slice(i * CHUNK, (i + 1) * CHUNK)}`),
    );
  return JSON.stringify({ format: FORMAT, v: ENCRYPTED_VERSION, enc: ENC, chunks });
}

/** The wallet document inside an encrypted envelope, or `null` when it does not open cleanly. */
async function unseal(cipher: FileCipher, raw: Record<string, unknown>): Promise<string | null> {
  const chunks = raw['chunks'];
  if (raw['enc'] !== ENC || !Array.isArray(chunks) || chunks.length === 0) return null;
  const n = chunks.length;
  let text = '';
  for (let i = 0; i < n; i++) {
    const c: unknown = chunks[i];
    if (typeof c !== 'string') return null;
    let pt: string;
    try {
      pt = await cipher.decrypt(c);
    } catch {
      return null;
    }
    const head = `${String(i)}/${String(n)}\n`;
    if (!pt.startsWith(head)) return null;
    text += pt.slice(head.length);
  }
  return text;
}
/**
 * History lines kept (newest first when read); the proofs themselves are never dropped. Small on
 * purpose: every commit reseals the whole file, and under the unit's `--jitless` NIP-44 costs
 * ~3.3 ms per KB on the event loop (measured: 200 ms per 60 KB chunk, Node 22). Flushes and payouts
 * are in the journal anyway.
 */
export const HISTORY_LIMIT = 100;

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

  /** True when `open()` found an unencrypted (version 1) file and rewrote it sealed. */
  migrated = false;

  private constructor(
    readonly path: string,
    private readonly cipher: FileCipher,
    private readonly now: () => UnixSeconds,
  ) {}

  /**
   * Open (or start) the wallet file. Throws `RuntimeSetupError` on a file it cannot trust: one
   * that does not parse, does not decrypt with this node's key, or whose chunks do not line up.
   * An unencrypted version-1 file (written before encryption at rest) is read and resealed at once.
   */
  static async open(
    path: string,
    cipher: FileCipher,
    now: () => UnixSeconds = () => Math.floor(Date.now() / 1000) as UnixSeconds,
  ): Promise<FileProofStore> {
    const store = new FileProofStore(path, cipher, now);
    await assertPrivate(path, 'the wallet file');
    const text = await readTextIfExists(path);
    if (text === null) return store;
    let raw: unknown = null;
    try {
      raw = JSON.parse(text);
    } catch {
      // handled below
    }
    const envelope =
      typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
    let inner: string | null = text;
    const sealed = envelope?.['format'] === FORMAT && envelope['v'] === ENCRYPTED_VERSION;
    if (sealed) inner = await unseal(cipher, envelope);
    const file = inner === null ? null : parse(inner);
    if (file === null)
      throw new RuntimeSetupError(
        `the wallet file ${path} is unreadable${sealed ? ' or not sealed to this node’s key' : ''} — ` +
          'refusing to start rather than overwrite it; recover its proofs before moving it aside',
      );
    store.seq = file.seq;
    store.hist = file.history;
    for (const [mint, proofs] of Object.entries(file.mints))
      store.byMint.set(mint as MintUrl, new Map(proofs.map((p) => [p.secret, p])));
    if (!sealed) {
      await writeFileAtomic(path, await seal(cipher, file));
      store.migrated = true;
    }
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
    await writeFileAtomic(this.path, await seal(this.cipher, file));
    this.byMint = next;
    this.hist = hist;
    this.seq = seq;
    return entry;
  }
}

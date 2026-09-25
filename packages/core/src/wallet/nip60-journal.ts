/**
 * The desktop wallet's journal at rest (ADR 0014 amendment, issue #8): the `Nip60ProofStore`'s
 * pending operations (their outputs' secrets and blinding factors: bearer ecash once the mint has
 * signed them) and its unpublished NIP-60 events (the proofs a relay outage has not let out yet),
 * in one sealed file that is replaced durably BEFORE the store lets a request reach the mint.
 *
 * Sealing, with libraries only (no construction of our own beyond "a random key, wrapped"):
 *
 *   - a random 32-byte journal key (sodium `randombytes_buf`), held in secure memory;
 *   - the key WRAPPED with NIP-44 to the user's own pubkey through the signer — exactly how the
 *     NIP-60 proofs themselves are protected, so the journal is as safe as the proofs and no
 *     weaker; the signer's key never leaves it, and a NIP-46 signer is asked once per open, never
 *     on the payment path;
 *   - every write sealed with XChaCha20-Poly1305 (sodium, the key file's AEAD) under a fresh
 *     random 24-byte nonce, the header (format, version, pubkey, wrapped key) as associated data.
 *
 * A file that exists but does not open — a bad header, another pubkey, a key the signer cannot
 * unwrap, a tag that does not verify, a body that is not exactly a journal — is NEVER treated as
 * empty: `open` throws `journal-unreadable` and writes nothing, so the file is kept for recovery
 * (it may be money). The caller fails loudly.
 *
 * Limits: the wrapped key passes through the signer's NIP-44 as a hex string, which cannot be
 * wiped (the same limit as the NIP-60 wallet key, `nip60-wallet.ts`); the journal's plaintext is
 * a JS string while it is sealed. This protects a stolen disk, a copied profile or a leaked
 * backup; it does not protect a live compromise of the host process, which holds the proofs too.
 * Nothing here logs; errors name the problem, never a key, a path or a proof.
 */
import sodium from 'sodium-universal';

import type { NostrEvent, NostrPubkey, Signer } from '../contracts/index.js';
import { NostrKind } from '../contracts/index.js';
import { verifyIncoming } from '../nostr/event.js';
import { randomFill, secureAlloc, wipe, type SecureBuffer } from '../signer/secure.js';
import type { Nip60Journal, Nip60JournalState } from './nip60.js';
import { isPendingOp } from './store.js';

export const JOURNAL_FORMAT = 'nutflix-wallet-journal';
export const JOURNAL_VERSION = 1;
/** The body's own version (inside the seal). */
const BODY_VERSION = 1;
/**
 * The largest journal this codec reads or writes. The store keeps it small (one entry per
 * operation in flight, superseded unpublished events compacted away); a file past this is refused
 * on read — loudly, and kept — and a write past it fails the commit before its request goes out.
 */
export const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;

/** Where the sealed text lives: the host's private file (fsync + atomic rename on `write`). */
export interface JournalFile {
  /** The file's text, or `null` when there is none. */
  read(): Promise<string | null>;
  /** Replace durably: resolves only once the new text is on disk. */
  write(text: string): Promise<void>;
}

export class JournalError extends Error {
  override readonly name = 'JournalError';
  constructor(message: string) {
    super(`journal-unreadable: ${message}`);
  }
}

const HEX = /^[0-9a-f]+$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** The event kinds a journal outbox may carry (the NIP-60 store's own). */
const OUTBOX_KINDS: readonly number[] = [
  NostrKind.WalletToken,
  NostrKind.Deletion,
  NostrKind.WalletHistory,
];

function hex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

function unhexInto(s: string, out: Uint8Array): boolean {
  if (s.length !== out.length * 2 || !HEX.test(s)) return false;
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return true;
}

/** The signer's own "I am not available" errors (`signer/remote.ts`), by their code prefix. */
function signerUnavailable(e: unknown): boolean {
  const m = e instanceof Error ? e.message : '';
  return /^(remote-signer|no-signer|signer-locked|cancelled):/.test(m);
}

function requireAead(): {
  seal: NonNullable<typeof sodium.crypto_aead_xchacha20poly1305_ietf_encrypt>;
  open: NonNullable<typeof sodium.crypto_aead_xchacha20poly1305_ietf_decrypt>;
} {
  const seal = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt;
  const open = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt;
  if (!seal || !open)
    throw new JournalError('this runtime has no XChaCha20-Poly1305 (sodium-native is required)');
  return { seal, open };
}

interface Envelope {
  readonly format: typeof JOURNAL_FORMAT;
  readonly v: typeof JOURNAL_VERSION;
  readonly pubkey: string;
  readonly wrap: string;
  readonly nonce: string;
  readonly box: string;
}

/** The associated data: every header field, in a fixed order. */
function associatedData(pubkey: string, wrap: string): Uint8Array {
  return new TextEncoder().encode(
    [`${JOURNAL_FORMAT}/v${String(JOURNAL_VERSION)}`, pubkey, wrap].join('\n'),
  );
}

function parseEnvelope(text: string): Envelope {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new JournalError('the journal file is not JSON');
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj))
    throw new JournalError('the journal file is not a JSON object');
  const o = obj as Record<string, unknown>;
  if (Object.keys(o).sort().join(',') !== 'box,format,nonce,pubkey,v,wrap')
    throw new JournalError('the journal file has unexpected fields');
  if (o['format'] !== JOURNAL_FORMAT || o['v'] !== JOURNAL_VERSION)
    throw new JournalError('not a wallet journal of a version this app reads');
  const { pubkey, wrap, nonce, box } = o;
  if (typeof pubkey !== 'string' || !HEX64.test(pubkey))
    throw new JournalError('the journal names no valid pubkey');
  if (typeof wrap !== 'string' || wrap.length === 0 || wrap.length > 4096)
    throw new JournalError('the journal key is missing');
  if (
    typeof nonce !== 'string' ||
    nonce.length !== sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES * 2 ||
    !HEX.test(nonce)
  )
    throw new JournalError('the journal nonce is malformed');
  if (
    typeof box !== 'string' ||
    box.length % 2 !== 0 ||
    box.length < sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES * 2 ||
    !HEX.test(box)
  )
    throw new JournalError('the journal body is malformed');
  return { format: JOURNAL_FORMAT, v: JOURNAL_VERSION, pubkey, wrap, nonce, box };
}

/** An outbox event read back: signature-verified, by `me`, of a NIP-60 store kind. */
function outboxEvent(x: unknown, me: NostrPubkey): NostrEvent | null {
  const ev = verifyIncoming(x);
  if (ev?.pubkey !== me || !OUTBOX_KINDS.includes(ev.kind)) return null;
  return ev;
}

function parseBody(text: string, me: NostrPubkey): Nip60JournalState {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new JournalError('the journal body is not JSON');
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj))
    throw new JournalError('the journal body is not an object');
  const o = obj as Record<string, unknown>;
  if (Object.keys(o).sort().join(',') !== 'ops,outbox,v' || o['v'] !== BODY_VERSION)
    throw new JournalError('the journal body has an unknown shape');
  const ops = o['ops'];
  const outbox = o['outbox'];
  if (!Array.isArray(ops) || !Array.isArray(outbox))
    throw new JournalError('the journal body has an unknown shape');
  // Every entry exactly, or nothing: an entry this build cannot read is refused, never dropped.
  if (!ops.every(isPendingOp)) throw new JournalError('a journaled operation is malformed');
  if (new Set(ops.map((op) => op.id)).size !== ops.length)
    throw new JournalError('a journaled operation appears twice');
  const events: NostrEvent[] = [];
  for (const raw of outbox) {
    const ev = outboxEvent(raw, me);
    if (ev === null) throw new JournalError('an unpublished wallet event does not verify');
    events.push(ev);
  }
  return { ops, outbox: events };
}

/**
 * A `Nip60Journal` sealed into one file. `open` reads the file (or starts one, paying the key
 * wrap at open rather than on the first payment); `save` replaces it durably; `close` wipes the
 * journal key, after which every `save` is refused (a commit that cannot be made durable fails
 * before its request, never silently in memory).
 */
export class SealedJournal implements Nip60Journal {
  readonly initial: Nip60JournalState;
  private readonly file: JournalFile;
  private readonly pubkey: NostrPubkey;
  private readonly wrap: string;
  private readonly key: SecureBuffer;
  private closed = false;

  private constructor(o: {
    file: JournalFile;
    pubkey: NostrPubkey;
    wrap: string;
    key: SecureBuffer;
    initial: Nip60JournalState;
  }) {
    this.file = o.file;
    this.pubkey = o.pubkey;
    this.wrap = o.wrap;
    this.key = o.key;
    this.initial = o.initial;
  }

  static async open(o: {
    readonly file: JournalFile;
    readonly signer: Pick<Signer, 'nip44Encrypt' | 'nip44Decrypt'>;
    readonly pubkey: NostrPubkey;
  }): Promise<SealedJournal> {
    const { open } = requireAead();
    const text = await o.file.read();
    const key = secureAlloc(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
    try {
      if (text === null) {
        randomFill(key);
        const wrap = await o.signer.nip44Encrypt(o.pubkey, hex(key));
        const j = new SealedJournal({
          file: o.file,
          pubkey: o.pubkey,
          wrap,
          key,
          initial: { ops: [], outbox: [] },
        });
        // The file exists from now on, so a first payment never waits on the signer.
        await j.save(j.initial);
        return j;
      }
      if (text.length > MAX_JOURNAL_BYTES) throw new JournalError('the journal file is too large');
      const env = parseEnvelope(text);
      if (env.pubkey !== o.pubkey)
        throw new JournalError('the journal is sealed to another identity');
      let unwrapped: string;
      try {
        unwrapped = await o.signer.nip44Decrypt(o.pubkey, env.wrap);
      } catch (e) {
        // A signer that is not there (a bunker that did not answer, a locked signer) says
        // nothing about the file: that error goes up as it is, and the next unlock tries again.
        if (signerUnavailable(e)) throw e;
        throw new JournalError('the journal key does not open with this identity');
      }
      if (!HEX64.test(unwrapped) || !unhexInto(unwrapped, key))
        throw new JournalError('the journal key is malformed');
      const nonce = new Uint8Array(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
      unhexInto(env.nonce, nonce);
      const box = new Uint8Array(env.box.length / 2);
      unhexInto(env.box, box);
      const plain = new Uint8Array(box.length - sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES);
      try {
        open(plain, null, box, associatedData(env.pubkey, env.wrap), nonce, key);
      } catch {
        throw new JournalError('the journal does not verify (damaged, or not this identity’s)');
      }
      let body: string;
      try {
        body = new TextDecoder('utf-8', { fatal: true }).decode(plain);
      } catch {
        throw new JournalError('the journal body is not UTF-8');
      } finally {
        wipe(plain);
      }
      return new SealedJournal({
        file: o.file,
        pubkey: o.pubkey,
        wrap: env.wrap,
        key,
        initial: parseBody(body, o.pubkey),
      });
    } catch (e) {
      wipe(key);
      throw e;
    }
  }

  async save(state: Nip60JournalState): Promise<void> {
    if (this.closed) throw new JournalError('the wallet is closed: nothing more is journaled');
    const { seal } = requireAead();
    const body = new TextEncoder().encode(
      JSON.stringify({ v: BODY_VERSION, ops: state.ops, outbox: state.outbox }),
    );
    const nonce = new Uint8Array(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    randomFill(nonce);
    const box = new Uint8Array(body.length + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES);
    try {
      seal(box, body, associatedData(this.pubkey, this.wrap), null, nonce, this.key);
    } finally {
      wipe(body);
    }
    const env: Envelope = {
      format: JOURNAL_FORMAT,
      v: JOURNAL_VERSION,
      pubkey: this.pubkey,
      wrap: this.wrap,
      nonce: hex(nonce),
      box: hex(box),
    };
    const text = JSON.stringify(env);
    if (text.length > MAX_JOURNAL_BYTES) throw new JournalError('the journal would be too large');
    await this.file.write(text);
  }

  /** Wipe the journal key. Idempotent; later saves are refused. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    wipe(this.key);
  }
}

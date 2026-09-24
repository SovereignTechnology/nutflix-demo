/**
 * LocalSigner — the Nostr key on this device, encrypted at rest (`keyfile.ts`), in secure
 * memory while unlocked, zeroed on `lock()` (contract `Signer`, build-plan §3–§4, §7).
 *
 * Signing, NIP-44 and the NUT-11 witness are `nostr-tools` / `@cashu/cashu-ts` calls; no
 * curve, hash or cipher is implemented here. Every event this signer returns has been checked
 * by `verifyIncoming` (the package's verification boundary) before it leaves.
 *
 * Nothing here logs. Errors carry a code prefix (`signer-locked:`, `invalid-argument:`) and
 * never a key, a passphrase or plaintext.
 */
import { schnorrSignMessage } from '@cashu/cashu-ts';
import { decode as nip19Decode } from 'nostr-tools/nip19';
import * as nip44 from 'nostr-tools/nip44';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';

import type { NostrEvent, NostrPubkey, Signer, UnsignedNostrEvent } from '../contracts/index.js';
import { verifyIncoming } from '../nostr/event.js';
import { openKeyFile, readKeyFileHeader, sealKeyFile, type KdfCost } from './keyfile.js';
import { randomFill, secureAlloc, secureCopy, wipe, type SecureBuffer } from './secure.js';

const PUBKEY = /^[0-9a-f]{64}$/;
const SECRET_HEX = /^[0-9a-f]{64}$/;

export type SignInput = Omit<UnsignedNostrEvent, 'pubkey'> & { pubkey?: NostrPubkey };

/**
 * Validates what a caller asks to sign — it may come across IPC, so it is `unknown` until
 * checked. Shared by every signer so none of them is laxer than another.
 */
export function checkSignInput(event: unknown, pubkey: NostrPubkey): asserts event is SignInput {
  if (typeof event !== 'object' || event === null)
    throw new Error('invalid-argument: event must be an object');
  const e = event as Record<string, unknown>;
  const kind = e['kind'];
  const createdAt = e['created_at'];
  const tags = e['tags'];
  if (!Number.isInteger(kind) || (kind as number) < 0 || (kind as number) > 65_535)
    throw new Error('invalid-argument: kind must be an integer in [0, 65535]');
  if (!Number.isSafeInteger(createdAt) || (createdAt as number) < 0)
    throw new Error('invalid-argument: created_at must be a non-negative integer');
  if (typeof e['content'] !== 'string')
    throw new Error('invalid-argument: content must be a string');
  if (
    !Array.isArray(tags) ||
    !tags.every(
      (t: unknown) =>
        Array.isArray(t) && t.length > 0 && t.every((v: unknown) => typeof v === 'string'),
    )
  )
    throw new Error('invalid-argument: tags must be non-empty string arrays');
  if (e['pubkey'] !== undefined && e['pubkey'] !== pubkey)
    throw new Error('invalid-argument: event pubkey is not this signer’s');
}

function template(event: SignInput): {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
} {
  return {
    kind: event.kind,
    created_at: event.created_at,
    tags: event.tags.map((t) => [...t]),
    content: event.content,
  };
}

function checkPeer(peer: string): void {
  if (typeof peer !== 'string' || !PUBKEY.test(peer))
    throw new Error('invalid-argument: peer pubkey must be 64 lower-case hex');
}

/**
 * Parse an `nsec1…` or 64-hex secret key held in `input` (UTF-8 bytes, ideally a secure buffer
 * the caller wipes) into a secure 32-byte buffer. Intermediate copies are wiped.
 */
export function parseSecretKey(input: Uint8Array): SecureBuffer {
  const text = new TextDecoder().decode(input).trim();
  if (text.startsWith('nsec1')) {
    let decoded: ReturnType<typeof nip19Decode>;
    try {
      decoded = nip19Decode(text);
    } catch {
      throw new Error('invalid-argument: not a valid nsec');
    }
    if (decoded.type !== 'nsec') throw new Error('invalid-argument: not an nsec');
    const out = secureCopy(decoded.data);
    wipe(decoded.data);
    return out;
  }
  if (SECRET_HEX.test(text.toLowerCase())) {
    const lower = text.toLowerCase();
    const out = secureAlloc(32);
    for (let i = 0; i < 32; i++) out[i] = parseInt(lower.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  throw new Error('invalid-argument: expected an nsec1… or 64-hex secret key');
}

/** Derive the x-only pubkey, refusing a secret that is not a valid secp256k1 scalar. */
function pubkeyOf(sk: Uint8Array): NostrPubkey {
  try {
    return getPublicKey(sk) as NostrPubkey;
  } catch {
    throw new Error('invalid-argument: not a valid secp256k1 secret key');
  }
}

/** A fresh random secret key in secure memory (retries the ~2^-128 invalid-scalar case). */
function generateSecretKey(): SecureBuffer {
  for (;;) {
    const sk = secureAlloc(32);
    randomFill(sk);
    try {
      getPublicKey(sk);
      return sk;
    } catch {
      wipe(sk);
    }
  }
}

export class LocalSigner implements Signer {
  readonly kind = 'local' as const;
  readonly signSecret?: (secret: string) => Promise<string>;

  private sk: SecureBuffer | null;
  private walletKey: SecureBuffer | null;
  private readonly pubkey: NostrPubkey;

  private constructor(sk: SecureBuffer, walletKey: SecureBuffer | null) {
    this.sk = sk;
    this.walletKey = walletKey;
    this.pubkey = pubkeyOf(sk);
    if (walletKey !== null) {
      pubkeyOf(walletKey); // refuse an invalid wallet scalar up front
      this.signSecret = (secret) => this.signWitness(secret);
    }
  }

  /** Unlock a key file. The passphrase buffer is the caller's to wipe. */
  static async unlock(file: Uint8Array, passphrase: Uint8Array): Promise<LocalSigner> {
    const { header, secretKey, walletKey } = await openKeyFile(file, passphrase);
    let signer: LocalSigner;
    try {
      signer = new LocalSigner(secretKey, walletKey ?? null);
    } catch (e) {
      wipe(secretKey);
      wipe(walletKey);
      throw e;
    }
    if (signer.pubkey !== header.pubkey) {
      await signer.lock();
      throw new Error('bad-key: the key file does not unlock the pubkey it names');
    }
    return signer;
  }

  /**
   * Create a signer from a new random key (or `secretKey`, e.g. an imported nsec — copied, the
   * caller wipes its own) and seal it under `passphrase`. Returns the signer and the file to
   * store (0600, never in a synced folder — the host's job).
   */
  static async create(opts: {
    readonly passphrase: Uint8Array;
    readonly secretKey?: Uint8Array;
    readonly walletKey?: Uint8Array;
    readonly cost?: KdfCost;
  }): Promise<{ readonly signer: LocalSigner; readonly file: Uint8Array }> {
    const sk = opts.secretKey === undefined ? generateSecretKey() : secureCopy(opts.secretKey);
    const wk = opts.walletKey === undefined ? null : secureCopy(opts.walletKey);
    let signer: LocalSigner;
    try {
      signer = new LocalSigner(sk, wk);
    } catch (e) {
      wipe(sk);
      wipe(wk);
      throw e;
    }
    const file = await sealKeyFile({
      secretKey: sk,
      ...(wk === null ? {} : { walletKey: wk }),
      pubkey: signer.pubkey,
      passphrase: opts.passphrase,
      ...(opts.cost === undefined ? {} : { cost: opts.cost }),
    });
    return { signer, file };
  }

  /** The pubkey a key file unlocks, without the passphrase (its header is public). */
  static pubkeyOf(file: Uint8Array): NostrPubkey {
    return readKeyFileHeader(file).pubkey as NostrPubkey;
  }

  private key(): SecureBuffer {
    if (this.sk === null) throw new Error('signer-locked: unlock the local key first');
    return this.sk;
  }

  getPublicKey(): Promise<NostrPubkey> {
    try {
      this.key();
      return Promise.resolve(this.pubkey);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error('signer: failed'));
    }
  }

  signEvent(event: SignInput): Promise<NostrEvent> {
    try {
      const sk = this.key();
      checkSignInput(event, this.pubkey);
      const signed = verifyIncoming(finalizeEvent(template(event), sk));
      if (signed?.pubkey !== this.pubkey)
        throw new Error('bad-key: produced an event that does not verify');
      return Promise.resolve(signed);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error('signer: failed'));
    }
  }

  nip44Encrypt(peerPubkey: NostrPubkey, plaintext: string): Promise<string> {
    return this.withConversationKey(peerPubkey, (ck) => {
      if (typeof plaintext !== 'string')
        throw new Error('invalid-argument: plaintext must be a string');
      return nip44.encrypt(plaintext, ck);
    });
  }

  nip44Decrypt(peerPubkey: NostrPubkey, ciphertext: string): Promise<string> {
    return this.withConversationKey(peerPubkey, (ck) => {
      if (typeof ciphertext !== 'string')
        throw new Error('invalid-argument: ciphertext must be a string');
      try {
        return nip44.decrypt(ciphertext, ck);
      } catch {
        throw new Error('nip44: could not decrypt');
      }
    });
  }

  private withConversationKey(peer: NostrPubkey, f: (ck: Uint8Array) => string): Promise<string> {
    let ck: Uint8Array | undefined;
    try {
      const sk = this.key();
      checkPeer(peer);
      ck = nip44.getConversationKey(sk, peer);
      return Promise.resolve(f(ck));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error('nip44: failed'));
    } finally {
      wipe(ck);
    }
  }

  /** NUT-11 witness: BIP-340 over SHA-256(secret) with the wallet key (cashu-ts `schnorrSignMessage`). */
  private signWitness(secret: string): Promise<string> {
    try {
      if (this.walletKey === null || this.sk === null)
        throw new Error('signer-locked: unlock the local key first');
      if (typeof secret !== 'string' || secret.length === 0)
        throw new Error('invalid-argument: secret must be a non-empty string');
      return Promise.resolve(schnorrSignMessage(secret, this.walletKey));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error('signer: failed'));
    }
  }

  lock(): Promise<void> {
    wipe(this.sk);
    wipe(this.walletKey);
    this.sk = null;
    this.walletKey = null;
    return Promise.resolve();
  }

  isLocked(): boolean {
    return this.sk === null;
  }
}

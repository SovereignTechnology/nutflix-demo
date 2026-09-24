/**
 * The local signer's key file: a Nostr private key (and optionally the NIP-60 wallet's P2PK
 * key) encrypted at rest under a passphrase (build-plan §7 "Keys at rest: argon2id-derived
 * passphrase key; never env vars"; SECURITY.md T14).
 *
 *   key  = argon2id13(passphrase, salt, ops, mem)            (libsodium `crypto_pwhash`)
 *   file = XChaCha20-Poly1305-IETF(key, nonce, ad = header)(secret key ‖ [wallet key])
 *
 * The header — format version, KDF parameters, salt, nonce and the public key — is the AEAD's
 * associated data, so a file whose parameters were lowered, whose salt or nonce was swapped, or
 * whose displayed pubkey was replaced does not decrypt. Parameters are bounded both ways: a
 * file asking for less than libsodium's INTERACTIVE cost is refused (no downgrade to a cheap
 * brute force), and one asking for more than `MAX_MEM_BYTES` / `MAX_OPS` is refused too (a
 * crafted file must not be able to exhaust memory at unlock).
 *
 * All cryptography is libsodium's. Nothing here logs; errors name the problem, never a value.
 */
import sodium from 'sodium-universal';

import { secureAlloc, wipe, type SecureBuffer } from './secure.js';

export const KEY_FILE_KIND = 'nutflix-local-signer' as const;
export const KEY_FILE_VERSION = 1 as const;
const KDF_ALG = 'argon2id13' as const;
const AEAD_ALG = 'xchacha20poly1305-ietf' as const;

/** Refused at unlock: a crafted file must not be able to exhaust memory (1 GiB). */
export const MAX_MEM_BYTES = 1024 * 1024 * 1024;
export const MAX_OPS = 16;

export interface KdfCost {
  readonly ops: number;
  readonly mem: number;
}

/** What a new key file costs to open: libsodium MODERATE (≈ 256 MiB, 3 passes). */
export function defaultCost(): KdfCost {
  return {
    ops: sodium.crypto_pwhash_OPSLIMIT_MODERATE,
    mem: sodium.crypto_pwhash_MEMLIMIT_MODERATE,
  };
}

/** The floor every key file must meet: libsodium INTERACTIVE (≈ 64 MiB, 2 passes). */
export function minimumCost(): KdfCost {
  return {
    ops: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    mem: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
  };
}

export class KeyFileError extends Error {
  override readonly name = 'KeyFileError';
  constructor(
    readonly code:
      | 'unsupported-runtime'
      | 'malformed'
      | 'unsupported-version'
      | 'weak-parameters'
      | 'excessive-parameters'
      | 'bad-passphrase'
      | 'bad-key',
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

/** The parsed, validated header of a key file (public data only). */
export interface KeyFileHeader {
  readonly v: typeof KEY_FILE_VERSION;
  readonly kind: typeof KEY_FILE_KIND;
  readonly kdf: {
    readonly alg: typeof KDF_ALG;
    readonly ops: number;
    readonly mem: number;
    readonly salt: string;
  };
  readonly aead: { readonly alg: typeof AEAD_ALG; readonly nonce: string };
  /** The Nostr public key the file unlocks (x-only hex) — shown before unlock, bound by the AEAD. */
  readonly pubkey: string;
  /** Whether the file also carries the NIP-60 wallet P2PK key. */
  readonly walletKey: boolean;
}

const HEX = /^[0-9a-f]*$/;
const PUBKEY = /^[0-9a-f]{64}$/;

function hex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

function unhex(s: string, bytes: number, what: string): Uint8Array {
  if (s.length !== bytes * 2 || !HEX.test(s))
    throw new KeyFileError('malformed', `${what} is not ${bytes} hex bytes`);
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function requireSodium(): {
  pwhash: NonNullable<typeof sodium.crypto_pwhash_async>;
  seal: NonNullable<typeof sodium.crypto_aead_xchacha20poly1305_ietf_encrypt>;
  open: NonNullable<typeof sodium.crypto_aead_xchacha20poly1305_ietf_decrypt>;
} {
  const pwhash = sodium.crypto_pwhash_async;
  const seal = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt;
  const open = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt;
  if (!pwhash || !seal || !open)
    throw new KeyFileError(
      'unsupported-runtime',
      'the local signer needs sodium-native (argon2id, XChaCha20-Poly1305); use NIP-07 or NIP-46 here',
    );
  return { pwhash, seal, open };
}

/** The associated data: every header field, in a fixed order. */
function associatedData(
  h: Omit<KeyFileHeader, 'walletKey'> & { readonly walletKey: boolean },
): Uint8Array {
  const text = [
    `${KEY_FILE_KIND}/v${String(h.v)}`,
    h.kdf.alg,
    String(h.kdf.ops),
    String(h.kdf.mem),
    h.kdf.salt,
    h.aead.alg,
    h.aead.nonce,
    h.pubkey,
    h.walletKey ? 'wallet' : 'nostr-only',
  ].join('|');
  return new TextEncoder().encode(text);
}

function checkCost(cost: KdfCost): void {
  const min = minimumCost();
  if (!Number.isSafeInteger(cost.ops) || !Number.isSafeInteger(cost.mem))
    throw new KeyFileError('malformed', 'KDF parameters must be integers');
  if (cost.ops < min.ops || cost.mem < min.mem)
    throw new KeyFileError('weak-parameters', 'KDF parameters are below the INTERACTIVE floor');
  if (cost.ops > MAX_OPS || cost.mem > MAX_MEM_BYTES)
    throw new KeyFileError('excessive-parameters', 'KDF parameters exceed the unlock limits');
}

function deriveKey(passphrase: Uint8Array, salt: Uint8Array, cost: KdfCost): Promise<SecureBuffer> {
  const { pwhash } = requireSodium();
  const key = secureAlloc(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
  return new Promise((resolve, reject) => {
    pwhash(
      key,
      passphrase,
      salt,
      cost.ops,
      cost.mem,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
      (err) => {
        if (err) {
          wipe(key);
          reject(new KeyFileError('unsupported-runtime', 'argon2id failed'));
        } else resolve(key);
      },
    );
  });
}

/**
 * Encrypt `secretKey` (32 bytes) and optionally `walletKey` (32 bytes) under `passphrase`.
 * The inputs are NOT wiped (the caller owns them). Returns the file as UTF-8 JSON bytes.
 */
export async function sealKeyFile(opts: {
  readonly secretKey: Uint8Array;
  readonly walletKey?: Uint8Array;
  readonly pubkey: string;
  readonly passphrase: Uint8Array;
  readonly cost?: KdfCost;
}): Promise<Uint8Array> {
  const { seal } = requireSodium();
  if (opts.secretKey.length !== 32)
    throw new KeyFileError('bad-key', 'secret key must be 32 bytes');
  if (opts.walletKey !== undefined && opts.walletKey.length !== 32)
    throw new KeyFileError('bad-key', 'wallet key must be 32 bytes');
  if (!PUBKEY.test(opts.pubkey))
    throw new KeyFileError('bad-key', 'pubkey must be 64 lower-case hex');
  if (opts.passphrase.length === 0) throw new KeyFileError('bad-passphrase', 'empty passphrase');
  const cost = opts.cost ?? defaultCost();
  checkCost(cost);

  const salt = new Uint8Array(sodium.crypto_pwhash_SALTBYTES);
  const nonce = new Uint8Array(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  sodium.randombytes_buf(salt);
  sodium.randombytes_buf(nonce);
  const header: KeyFileHeader = {
    v: KEY_FILE_VERSION,
    kind: KEY_FILE_KIND,
    kdf: { alg: KDF_ALG, ops: cost.ops, mem: cost.mem, salt: hex(salt) },
    aead: { alg: AEAD_ALG, nonce: hex(nonce) },
    pubkey: opts.pubkey,
    walletKey: opts.walletKey !== undefined,
  };

  const plain = secureAlloc(opts.walletKey === undefined ? 32 : 64);
  const key = await deriveKey(opts.passphrase, salt, cost);
  try {
    plain.set(opts.secretKey, 0);
    if (opts.walletKey !== undefined) plain.set(opts.walletKey, 32);
    const ct = new Uint8Array(plain.length + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES);
    seal(ct, plain, associatedData(header), null, nonce, key);
    const json = JSON.stringify({ ...header, ct: hex(ct) });
    return new TextEncoder().encode(json);
  } finally {
    wipe(plain);
    wipe(key);
  }
}

/** Parse and validate a key file's header without decrypting (for the "locked" status line). */
export function readKeyFileHeader(file: Uint8Array): KeyFileHeader & { readonly ct: string } {
  let obj: unknown;
  try {
    obj = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file));
  } catch {
    throw new KeyFileError('malformed', 'not UTF-8 JSON');
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj))
    throw new KeyFileError('malformed', 'not a JSON object');
  const o = obj as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(',');
  if (keys !== 'aead,ct,kdf,kind,pubkey,v,walletKey')
    throw new KeyFileError('malformed', 'unexpected or missing fields');
  if (o['kind'] !== KEY_FILE_KIND)
    throw new KeyFileError('malformed', 'not a local-signer key file');
  if (o['v'] !== KEY_FILE_VERSION)
    throw new KeyFileError('unsupported-version', 'unknown key file version');
  const kdf = o['kdf'] as Record<string, unknown> | null;
  const aead = o['aead'] as Record<string, unknown> | null;
  if (
    typeof kdf !== 'object' ||
    kdf === null ||
    Object.keys(kdf).sort().join(',') !== 'alg,mem,ops,salt'
  )
    throw new KeyFileError('malformed', 'bad kdf block');
  if (
    typeof aead !== 'object' ||
    aead === null ||
    Object.keys(aead).sort().join(',') !== 'alg,nonce'
  )
    throw new KeyFileError('malformed', 'bad aead block');
  if (kdf['alg'] !== KDF_ALG || aead['alg'] !== AEAD_ALG)
    throw new KeyFileError('unsupported-version', 'unknown KDF or cipher');
  const ops = kdf['ops'];
  const mem = kdf['mem'];
  const salt = kdf['salt'];
  const nonce = aead['nonce'];
  const pubkey = o['pubkey'];
  const ct = o['ct'];
  const walletKey = o['walletKey'];
  if (typeof ops !== 'number' || typeof mem !== 'number')
    throw new KeyFileError('malformed', 'bad KDF cost');
  checkCost({ ops, mem });
  if (typeof salt !== 'string' || typeof nonce !== 'string' || typeof ct !== 'string')
    throw new KeyFileError('malformed', 'bad salt, nonce or ciphertext');
  unhex(salt, sodium.crypto_pwhash_SALTBYTES, 'salt');
  unhex(nonce, sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES, 'nonce');
  if (typeof pubkey !== 'string' || !PUBKEY.test(pubkey))
    throw new KeyFileError('malformed', 'bad pubkey');
  if (typeof walletKey !== 'boolean') throw new KeyFileError('malformed', 'bad walletKey flag');
  const expectCt = ((walletKey ? 64 : 32) + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES) * 2;
  if (ct.length !== expectCt || !HEX.test(ct))
    throw new KeyFileError('malformed', 'bad ciphertext length');
  return {
    v: KEY_FILE_VERSION,
    kind: KEY_FILE_KIND,
    kdf: { alg: KDF_ALG, ops, mem, salt },
    aead: { alg: AEAD_ALG, nonce },
    pubkey,
    walletKey,
    ct,
  };
}

/**
 * Decrypt a key file. Returns the secret key (and the wallet key, if present) in SECURE
 * buffers the caller must `wipe()`. A wrong passphrase and a tampered file are the same
 * error (`bad-passphrase`): the AEAD cannot tell them apart, and neither should the caller.
 */
export async function openKeyFile(
  file: Uint8Array,
  passphrase: Uint8Array,
): Promise<{
  readonly header: KeyFileHeader;
  readonly secretKey: SecureBuffer;
  readonly walletKey?: SecureBuffer;
}> {
  const { open } = requireSodium();
  const h = readKeyFileHeader(file);
  const salt = unhex(h.kdf.salt, sodium.crypto_pwhash_SALTBYTES, 'salt');
  const nonce = unhex(h.aead.nonce, sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES, 'nonce');
  const ct = unhex(h.ct, h.ct.length / 2, 'ciphertext');
  const plain = secureAlloc(ct.length - sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES);
  const key = await deriveKey(passphrase, salt, { ops: h.kdf.ops, mem: h.kdf.mem });
  try {
    try {
      open(plain, null, ct, associatedData(h), nonce, key);
    } catch {
      throw new KeyFileError('bad-passphrase', 'wrong passphrase or damaged key file');
    }
    const secretKey = secureAlloc(32);
    secretKey.set(plain.subarray(0, 32));
    const header: KeyFileHeader = {
      v: h.v,
      kind: h.kind,
      kdf: h.kdf,
      aead: h.aead,
      pubkey: h.pubkey,
      walletKey: h.walletKey,
    };
    if (!h.walletKey) return { header, secretKey };
    const walletKey = secureAlloc(32);
    walletKey.set(plain.subarray(32, 64));
    return { header, secretKey, walletKey };
  } finally {
    wipe(plain);
    wipe(key);
  }
}

/**
 * Hashing and randomness for the worker, over `sodium-native` (libsodium). The worker never
 * implements a hash itself (SECURITY.md): SHA-256 is libsodium's `crypto_hash_sha256_*`,
 * randomness is `randombytes_buf`. sodium-native loads under both Bare (production) and
 * Node (tests), so this module is runtime-neutral and the tests exercise the production code.
 *
 * Two shapes of the same hasher: the seeder's `SeederCrypto` (`digestHex()`) and core
 * media's `Sha256Factory` (`digest()`).
 */
import type { Sha256Hex, media } from '@sovit/core';
import type { SeederCrypto } from '@sovit/seeder';
import { toHex } from '@sovit/seeder';
import sodium from 'sodium-native';

interface Sha256 {
  update(chunk: Uint8Array): void;
  digestHex(): string;
}

function sha256(): Sha256 {
  const state = new Uint8Array(sodium.crypto_hash_sha256_STATEBYTES);
  sodium.crypto_hash_sha256_init(state);
  let done = false;
  return {
    update(chunk) {
      if (done) throw new Error('sha256: update after digest');
      sodium.crypto_hash_sha256_update(state, chunk);
    },
    digestHex() {
      if (done) throw new Error('sha256: digest is single use');
      done = true;
      const out = new Uint8Array(sodium.crypto_hash_sha256_BYTES);
      sodium.crypto_hash_sha256_final(state, out);
      return toHex(out);
    },
  };
}

/** `n` cryptographically random bytes (libsodium). */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  sodium.randombytes_buf(out);
  return out;
}

/** `n` random bytes as lower-case hex (tokens, temp suffixes). */
export function randomHex(n: number): string {
  return toHex(randomBytes(n));
}

/** One-shot SHA-256 of `bytes` as lower-case hex. */
export function sha256Hex(bytes: Uint8Array): string {
  const h = sha256();
  h.update(bytes);
  return h.digestHex();
}

/** `@sovit/seeder`'s crypto adapter (CAS identity, temp-file suffixes). */
export const sodiumCrypto: SeederCrypto = {
  createSha256: sha256,
  randomHex,
};

/** `@sovit/core/media`'s incremental hasher factory. */
export const sodiumSha256: media.Sha256Factory = () => {
  const h = sha256();
  return {
    update: (chunk) => {
      h.update(chunk);
    },
    digest: () => h.digestHex() as Sha256Hex,
  };
};

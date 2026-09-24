/**
 * Ambient types for the untyped Holepunch modules the audit surface uses (Stage 2). Only the
 * members this package calls are declared, checked against the installed sources:
 * `sodium-universal@5.0.1` → `sodium-native@5.1.0` (`node_modules/sodium-native/index.js`),
 * `compact-encoding@3.4.0` (`node_modules/compact-encoding/index.js`, docs/vendor/compact-encoding.md).
 */

declare module 'sodium-universal' {
  interface SodiumUniversal {
    sodium_malloc(size: number): Uint8Array;
    sodium_memzero(buf: Uint8Array): void;
    /** Constant-time equality of two equal-length buffers. */
    sodium_memcmp(a: Uint8Array, b: Uint8Array): boolean;
    randombytes_buf(buf: Uint8Array): void;

    readonly crypto_pwhash_ALG_ARGON2ID13: number;
    readonly crypto_pwhash_SALTBYTES: number;
    readonly crypto_pwhash_OPSLIMIT_INTERACTIVE: number;
    readonly crypto_pwhash_MEMLIMIT_INTERACTIVE: number;
    readonly crypto_pwhash_OPSLIMIT_MODERATE: number;
    readonly crypto_pwhash_MEMLIMIT_MODERATE: number;
    readonly crypto_pwhash_OPSLIMIT_MAX: number;
    readonly crypto_pwhash_MEMLIMIT_MAX: number;
    /** Undefined under sodium-javascript (browser): the local signer refuses to run there. */
    readonly crypto_pwhash_async?: (
      out: Uint8Array,
      passwd: Uint8Array,
      salt: Uint8Array,
      opslimit: number,
      memlimit: number,
      alg: number,
      cb: (err: Error | null) => void,
    ) => void;

    readonly crypto_aead_xchacha20poly1305_ietf_KEYBYTES: number;
    readonly crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number;
    readonly crypto_aead_xchacha20poly1305_ietf_ABYTES: number;
    readonly crypto_aead_xchacha20poly1305_ietf_encrypt?: (
      c: Uint8Array,
      m: Uint8Array,
      ad: Uint8Array | null,
      nsec: null,
      npub: Uint8Array,
      k: Uint8Array,
    ) => number;
    /** Throws on authentication failure. */
    readonly crypto_aead_xchacha20poly1305_ietf_decrypt?: (
      m: Uint8Array,
      nsec: null,
      c: Uint8Array,
      ad: Uint8Array | null,
      npub: Uint8Array,
      k: Uint8Array,
    ) => number;
  }
  const sodium: SodiumUniversal;
  export default sodium;
}

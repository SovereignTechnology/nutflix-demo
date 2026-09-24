/**
 * Secure-memory helpers for key material (SECURITY.md T14; build-plan §7 "In memory:
 * `sodium-native` secure buffers, zeroed on logout").
 *
 * Every private key, passphrase and derived key the signer holds lives in a buffer from
 * `sodium_malloc` (guard pages, `mlock`ed, excluded from core dumps where the OS allows) and
 * is zeroed with `sodium_memzero` the moment it is no longer needed. JavaScript cannot promise
 * more: a library that takes a `Uint8Array` (noble's schnorr, NIP-44) may copy it into its own
 * memory, and those copies are the library's to clear. What this module guarantees is that the
 * signer's OWN copies are secure buffers and are wiped on lock.
 *
 * `sodium-universal` resolves to `sodium-native` on Node, Electron and Bare. In a browser it is
 * `sodium-javascript`, which has no secure allocator — `secureAlloc` then returns an ordinary
 * zeroed buffer, and the local signer (which also needs argon2id) refuses to run at all; the
 * web shell uses NIP-07 / NIP-46 only (build-plan §4).
 */
import sodium from 'sodium-universal';

/** A 32-byte (or other) key buffer in secure memory. */
export type SecureBuffer = Uint8Array;

/** Allocate `n` bytes of secure memory, zero-filled. */
export function secureAlloc(n: number): SecureBuffer {
  const b = sodium.sodium_malloc(n);
  sodium.sodium_memzero(b);
  return b;
}

/** Copy `src` into a fresh secure buffer. The caller wipes `src` if it held a secret. */
export function secureCopy(src: Uint8Array): SecureBuffer {
  const b = secureAlloc(src.length);
  b.set(src);
  return b;
}

/** Zero a buffer in place (secure or not). Safe to call twice. */
export function wipe(b: Uint8Array | null | undefined): void {
  if (b !== null && b !== undefined && b.length > 0) sodium.sodium_memzero(b);
}

/** Fill `b` with cryptographically secure random bytes. */
export function randomFill(b: Uint8Array): void {
  sodium.randombytes_buf(b);
}

/** True when the runtime provides a real secure allocator (sodium-native). */
export function hasSecureMemory(): boolean {
  const probe = sodium.sodium_malloc(1) as Uint8Array & { secure?: boolean };
  return probe.secure === true;
}

/** Constant-time comparison (libsodium `sodium_memcmp`); false for different lengths. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && sodium.sodium_memcmp(a, b);
}

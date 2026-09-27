/**
 * ADR 0016: main's re-check of a typed recovery phrase's BIP-39 checksum, from its word indices.
 *
 * The phrase is checked three times: in the prompt page (`@scure/bip39`'s `validateMnemonic`,
 * bundled there), here in main, and in the host (core's `RecoveryPhrases.fromIndices`, the
 * authoritative decode). Main's bundle may hold only src/main and src/ipc, so it has no BIP-39
 * library: this is a bit-layout check around a library hash, not cryptography of our own —
 * 12 indices × 11 bits = 128 bits of entropy followed by 4 checksum bits, which BIP-39 defines
 * as the first 4 bits of SHA-256(entropy). The hash is the caller's (main: `node:crypto`).
 *
 * Pure; never throws; never logs; wipes its copy of the entropy.
 */
import { BIP39_LIST_SIZE, RECOVERY_WORDS } from './protocol.js';

const ENTROPY_BYTES = 16;
const CHECKSUM_BITS = 4n;

/** `true` when `words` is a whole phrase whose checksum bits match `sha256` of its entropy. */
export function phraseChecksumOk(
  words: readonly unknown[],
  sha256: (data: Uint8Array) => Uint8Array,
): boolean {
  const entropy = new Uint8Array(ENTROPY_BYTES);
  try {
    if (!Array.isArray(words) || words.length !== RECOVERY_WORDS) return false;
    let bits = 0n;
    for (const w of words) {
      if (typeof w !== 'number' || !Number.isInteger(w) || w < 0 || w >= BIP39_LIST_SIZE)
        return false;
      bits = (bits << 11n) | BigInt(w);
    }
    const checksum = Number(bits & ((1n << CHECKSUM_BITS) - 1n));
    let rest = bits >> CHECKSUM_BITS;
    for (let i = ENTROPY_BYTES - 1; i >= 0; i--) {
      entropy[i] = Number(rest & 0xffn);
      rest >>= 8n;
    }
    const digest = sha256(entropy);
    const first = digest[0];
    return first !== undefined && first >> 4 === checksum;
  } catch {
    return false;
  } finally {
    entropy.fill(0);
  }
}

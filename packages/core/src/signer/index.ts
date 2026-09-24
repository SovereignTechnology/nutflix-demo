/**
 * The signer audit surface (SECURITY.md §locked; implemented in Stage 2): the only code in the
 * system that holds a Nostr private key.
 *
 *   - `LocalSigner` — encrypted key file (argon2id + XChaCha20-Poly1305), secure memory,
 *     zeroed on `lock()`; optional NIP-60 wallet key for `signSecret` (NUT-11 witnesses).
 *   - `Nip46Signer` / `Nip07Signer` — adapters that verify every event the remote signer or
 *     extension returns against the request and the pinned pubkey.
 *   - `SignerManager` — the host's `SignerControl` (connect / lock / sign out / status).
 */
export type {
  Signer,
  SignerStatus,
  SignerConnectRequest,
  SignerControl,
} from '../contracts/signer.js';
export {
  KeyFileError,
  MAX_MEM_BYTES,
  MAX_OPS,
  defaultCost,
  minimumCost,
  openKeyFile,
  readKeyFileHeader,
  sealKeyFile,
  type KdfCost,
  type KeyFileHeader,
} from './keyfile.js';
export { LocalSigner, checkSignInput, parseSecretKey, type SignInput } from './local.js';
export {
  Nip07Signer,
  Nip46Signer,
  checkRemoteSigned,
  type BunkerLike,
  type Nip07Provider,
} from './remote.js';
export { connectBunker, parseBunkerUri } from './nip46-connect.js';
export {
  SignerManager,
  type KeyStore,
  type SecretPrompt,
  type SignerManagerOptions,
} from './control.js';
export { equalBytes, hasSecureMemory, secureAlloc, secureCopy, wipe } from './secure.js';

/**
 * The NIP-60 wallet (contract `Wallet`), thin over `@cashu/cashu-ts`. `spend.ts` is the locked
 * audit surface (SECURITY.md §locked): every operation that moves proofs goes through it.
 */
export type { Wallet, WalletHistoryEntry, WalletChangeEvent } from '../contracts/wallet.js';
export {
  Spender,
  WalletError,
  fromCashu,
  toCashu,
  type MintConnections,
  type SpendContext,
  type WalletErrorCode,
  type WalletKey,
} from './spend.js';
export { MemoryProofStore, proofTotal, type ProofStore, type WalletTx } from './store.js';
export { Nip60ProofStore, type Nip60Relays } from './nip60.js';
export {
  cashuRequestFn,
  type CashuRequestOptions,
  type RawHttp,
  type RawHttpRequest,
  type RawHttpResponse,
} from './transport.js';
export {
  CashuMintConnections,
  CashuWallet,
  memoryWalletKey,
  signerWalletKey,
  type CashuWalletOptions,
} from './wallet.js';

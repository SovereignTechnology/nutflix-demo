/**
 * The NIP-60 wallet (contract `Wallet`), thin over `@cashu/cashu-ts`. `spend.ts` is the locked
 * audit surface (SECURITY.md §locked): every operation that moves proofs goes through it.
 */
export type { Wallet, WalletHistoryEntry, WalletChangeEvent } from '../contracts/wallet.js';
export {
  PENDING_SETTLE_AFTER_S,
  Spender,
  WalletError,
  fromCashu,
  toCashu,
  type MintConnections,
  type SpendContext,
  type WalletErrorCode,
  type WalletKey,
} from './spend.js';
export {
  MemoryProofStore,
  PENDING_KINDS,
  heldSecrets,
  isPendingOp,
  proofTotal,
  type PendingOp,
  type PendingOutput,
  type ProofStore,
  type WalletTx,
} from './store.js';
export {
  Nip60ProofStore,
  type Nip60Journal,
  type Nip60JournalState,
  type Nip60Relays,
} from './nip60.js';
export {
  JOURNAL_FORMAT,
  JOURNAL_VERSION,
  JournalError,
  MAX_JOURNAL_BYTES,
  SealedJournal,
  type JournalFile,
} from './nip60-journal.js';
export { guardedKeyset, type KeysetGuardOptions } from './keyset-guard.js';
export {
  SETTLE_MARGIN_S,
  SETTLE_RETRY_MAX_S,
  SETTLE_RETRY_MIN_S,
  SettleLoop,
  type SettleLoopOptions,
  type SettleLoopWallet,
  type SettleTimer,
} from './settle-loop.js';
export {
  openNip60Wallet,
  publishNutzapInfo,
  type Nip60Wallet,
  type OpenNip60WalletOptions,
} from './nip60-wallet.js';
export {
  httpModuleRawHttp,
  type HttpModule,
  type HttpModuleRequest,
  type HttpModuleResponse,
  type HttpModules,
} from './http-module.js';
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

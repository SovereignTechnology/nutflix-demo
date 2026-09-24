/**
 * The payment audit surface (SECURITY.md §locked; implemented in Stage 2). `split.ts` is the
 * per-PAY arithmetic both sides share (contracts v5, ADR 0010).
 */
export type {
  PaymentEngine,
  PaymentEngineViewer,
  PaymentEngineSeeder,
  PaymentEngineConfig,
  PayMessage,
  VerifyResult,
  RejectReason,
  PeerWindow,
  BlockRange,
} from '../contracts/payment.js';
export {
  CARRY_MODULUS,
  MAX_PAY_SATS,
  effectiveWindowBlocks,
  isValidCarry,
  isValidSplit,
  minPaySats,
  splitPay,
  splitSequence,
  type PaySplit,
} from './split.js';
export { PAY1_TAG, checkPayLock, type LockVerdict } from './lock.js';

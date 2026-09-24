/**
 * `pay/1` (SECURITY.md §locked; implemented in Stage 2): the compact-encoding codec, the
 * connection-bound HELLO, and the protomux state machine.
 */
export type {
  PayProtocol,
  PayProtocolCodec,
  PayProtocolMessage,
  HelloMessage,
  PayWireMessage,
  AckMessage,
  PriceMessage,
  PayProtocolState,
  PayProtocolEvents,
  MuxLike,
} from '../contracts/pay-protocol.js';
export { PAY_PROTOCOL_NAME, PAY_PROTOCOL_VERSION } from '../contracts/pay-protocol.js';
export {
  MAX_FRAME_BYTES,
  MAX_MINTS,
  MAX_PROOFS,
  MAX_STRING_BYTES,
  REJECT_REASON_CODES,
  payCodec,
} from './codec.js';
export {
  MAX_HELLO_MINTS,
  bindingFromMux,
  buildHello,
  helloChallenge,
  verifyHello,
  type ConnectionBinding,
  type HelloTerms,
  type HelloVerdict,
} from './hello.js';
export { PayChannel, type PayChannelOptions } from './channel.js';

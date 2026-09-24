/**
 * Wires a `PayProtocol` instance (contracts/pay-protocol.ts, `core/src/pay-protocol/`) to a
 * `PeerSession`:
 *
 *   HELLO (open)  → `session.bindPubkey()`      (banned pubkey → cut)
 *   PAY           → `session.verifyPay(msg, policy(range.core))` → `sendAck()` (naming the
 *                   core, v5); accepted blocks feed the scheduler
 *   close(reason) → mirror a remote/protocol cut on the session
 *
 * `PayMessage.range.core` selects the `PricePolicy` the PAY is verified against. v5 (ADR
 * 0010) makes `core` REQUIRED: the codec refuses a core-less PAY on the wire and the engine
 * refuses one as `malformed`, so the v3 "core-less on a multi-core stream" branch that lived
 * here is gone.
 *
 * The seeder never calls `protocol.cut()`: the session owns the ban+destroy so the ban
 * list and the swarm `PeerInfo` are always updated together.
 */
import type { CoreKeyHex, PayProtocol, PricePolicy } from '@sovit/core';

import type { Logger } from '../log/logger.js';
import type { PeerSession } from '../net/peer-session.js';
import type { FlushScheduler } from './flush-scheduler.js';

export interface PayBridgeOptions {
  readonly session: PeerSession;
  readonly protocol: PayProtocol;
  /**
   * Price policy to verify this peer's `PAY` messages against, resolved per `range.core`.
   * A `() => PricePolicy` (the v2 shape) is still accepted and simply ignores the core.
   */
  readonly policy: (core: CoreKeyHex) => PricePolicy;
  readonly scheduler: Pick<FlushScheduler, 'notePaidBlocks'>;
  readonly logger: Logger;
}

export function attachPayBridge(opts: PayBridgeOptions): () => void {
  const { session, protocol, scheduler } = opts;
  const log = opts.logger.child({ noiseKey: session.noiseKeyHex });
  const offs: (() => void)[] = [];

  offs.push(
    protocol.on('open', (hello) => {
      session.bindPubkey(hello.pubkey);
    }),
  );

  offs.push(
    protocol.on('pay', (msg) => {
      void (async () => {
        const core = msg.range.core;
        const r = await session.verifyPay(msg, opts.policy(core));
        if (session.closed) return;
        const at = { core, fromBlock: msg.range.fromBlock, toBlock: msg.range.toBlock };
        protocol.sendAck(r.ok ? { ...at, ok: true } : { ...at, ok: false, reason: r.reason });
        if (r.ok) scheduler.notePaidBlocks(r.blocks);
        // v5: a reused proof secret bans at verify; cut here too, so a bridge used without the
        // seeder's `onDoubleSpend` subscription still drops the double-spender.
        else if (r.reason === 'peer-banned' || r.reason === 'double-spend') session.cut('banned');
      })().catch((err: unknown) => {
        log.error('pay handling failed', { error: err });
        session.cut('protocol-error');
      });
    }),
  );

  offs.push(
    protocol.on('close', (reason) => {
      if (reason === 'window-exceeded' || reason === 'banned') session.cut(reason);
      else if (reason === 'protocol-error') session.cut('protocol-error');
    }),
  );

  return () => {
    for (const off of offs) off();
  };
}

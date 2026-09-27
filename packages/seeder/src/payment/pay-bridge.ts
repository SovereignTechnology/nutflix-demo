/**
 * Wires a `PayProtocol` instance (contracts/pay-protocol.ts, `core/src/pay-protocol/`) to a
 * `PeerSession`:
 *
 *   HELLO (open)  → `session.bindPubkey()`      (banned pubkey → cut); bound → `onOpen()`
 *                   (the seeder's `OWED` report, contracts v6 amendment)
 *   PAY           → `session.verifyPay(msg, policy(range.core))` → `sendAck()` (naming the
 *                   core, v5; with `outstanding` on that core, v6 amendment); accepted blocks
 *                   feed the scheduler
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
import type { AckMessage, BlockRange, CoreKeyHex, PayProtocol, PricePolicy } from '@sovit/core';

import type { Logger } from '../log/logger.js';
import type { PeerSession } from '../net/peer-session.js';
import type { FlushScheduler } from './flush-scheduler.js';

export interface PayBridgeOptions {
  readonly session: PeerSession;
  readonly protocol: PayProtocol;
  /**
   * Price policy to verify this peer's `PAY` messages against, resolved per `range.core`.
   * A `() => PricePolicy` (the v2 shape) is still accepted and simply ignores the core. The
   * PAY's range is passed too: blocks sent before a `PRICE` change are priced at the policy in
   * force when they were sent (security review F9).
   */
  readonly policy: (core: CoreKeyHex, range: BlockRange) => PricePolicy;
  readonly scheduler: Pick<FlushScheduler, 'notePaidBlocks'>;
  readonly logger: Logger;
  /**
   * Contracts v6 amendment: the blocks of `core` this peer still owes, read when the ACK is sent
   * (after the PAY was applied). Put in every ACK as `outstanding`; left out when absent or not a
   * safe count (the codec would refuse the frame).
   */
  readonly outstanding?: (core: CoreKeyHex) => number;
  /** Runs once the channel opened and the pubkey bound (not after a refused bind). */
  readonly onOpen?: () => void;
}

export function attachPayBridge(opts: PayBridgeOptions): () => void {
  const { session, protocol, scheduler } = opts;
  const log = opts.logger.child({ noiseKey: session.noiseKeyHex });
  const offs: (() => void)[] = [];

  offs.push(
    protocol.on('open', (hello) => {
      if (!session.bindPubkey(hello.pubkey)) return;
      try {
        opts.onOpen?.();
      } catch (err) {
        log.error('open hook failed', { error: err });
      }
    }),
  );

  offs.push(
    protocol.on('pay', (msg) => {
      void (async () => {
        const core = msg.range.core;
        const r = await session.verifyPay(msg, opts.policy(core, msg.range));
        if (session.closed) return;
        const at = { core, fromBlock: msg.range.fromBlock, toBlock: msg.range.toBlock };
        const ack: Omit<AckMessage, 'type'> = r.ok
          ? { ...at, ok: true }
          : { ...at, ok: false, reason: r.reason };
        const outstanding = opts.outstanding?.(core);
        protocol.sendAck(
          outstanding !== undefined && Number.isSafeInteger(outstanding) && outstanding >= 0
            ? { ...ack, outstanding }
            : ack,
        );
        if (r.ok) scheduler.notePaidBlocks(r.blocks);
        // v5: a reused proof secret bans at verify, and so does a DLEQ forged against a known
        // keyset (answered `bad-dleq`). Any engine ban ends the session here, after the ACK, so it
        // reaches the persisted ban list now rather than at the window cut.
        else if (r.reason === 'peer-banned' || r.reason === 'double-spend' || session.engineBanned)
          session.cut('banned');
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

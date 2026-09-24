/**
 * `pay/1` on every session the daemon's seeder admits: a `PayChannel` on the connection's own
 * Protomux, bridged to the seeder (`Seeder.attachPayProtocol`), and this node's HELLO — its price,
 * mints, split, P2PK key and window, signed as a NIP-01 event bound to THIS connection's Noise
 * handshake (contracts v5, ADR 0010). It hooks `Seeder.onSessionReady`, not `session-open`: a
 * swarm connection's Protomux exists only once replication runs on it.
 *
 * A peer that never speaks `pay/1` is still served `windowBlocks` unpaid blocks and then cut, by
 * the seeder's upload gate — the protocol adds payment, it removes no limit.
 */
import { payProtocol } from '@sovit/core';
import type { CashuP2pkPubkey, PayProtocol, Signer, UnixSeconds } from '@sovit/core';

import type { Logger } from '../log/logger.js';
import type { PeerSession } from '../net/peer-session.js';
import type { Seeder } from '../seeder.js';

export interface PayWiringOptions {
  readonly signer: Pick<Signer, 'signEvent'>;
  /** The wallet key's P2PK pubkey: where viewers lock the seeder's share. */
  readonly p2pk: CashuP2pkPubkey;
  readonly windowBlocks: number;
  readonly logger: Logger;
  readonly now?: () => UnixSeconds;
}

/** Attach `pay/1` to every session `seeder` admits from now on. Returns the unsubscribe. */
export function wirePay(seeder: Seeder, o: PayWiringOptions): () => void {
  const log = o.logger.child({ component: 'pay-wiring' });
  const now = o.now ?? ((): UnixSeconds => Math.floor(Date.now() / 1000) as UnixSeconds);

  const onReady = (session: PeerSession): void => {
    const noiseKey = session.noiseKeyHex;
    const mux = session.mux;
    const binding = mux === null ? null : payProtocol.bindingFromMux(mux);
    if (mux === null || binding === null) {
      log.error('session has no Protomux or Noise handshake — cannot attach pay/1', { noiseKey });
      return;
    }
    const channel = new payProtocol.PayChannel({
      binding,
      onProtocolError: (why) => {
        log.info('pay/1 protocol error', { noiseKey, why });
      },
    });
    channel.attach(mux);
    const detach = seeder.attachPayProtocol(session, channel);
    session.stream.once('close', detach);
    void sendHello(session, channel, binding);
  };

  const sendHello = async (
    session: PeerSession,
    channel: PayProtocol,
    binding: payProtocol.ConnectionBinding,
  ): Promise<void> => {
    const noiseKey = session.noiseKeyHex;
    let hello: Awaited<ReturnType<typeof payProtocol.buildHello>>;
    try {
      const policy = seeder.policy();
      hello = await payProtocol.buildHello(
        o.signer,
        binding,
        {
          acceptedMints: [...policy.mints],
          satsPerBlock: policy.satsPerBlock,
          split: policy.split,
          p2pk: o.p2pk,
          windowBlocks: o.windowBlocks,
        },
        now,
      );
    } catch (err) {
      log.error('HELLO could not be built', { noiseKey, error: err });
      return;
    }
    if (channel.state === 'closed' || session.closed) return;
    channel.sendHello(hello);
    log.debug('HELLO sent', { noiseKey });
  };

  return seeder.onSessionReady(onReady);
}

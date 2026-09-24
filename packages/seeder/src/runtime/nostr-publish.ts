/**
 * The daemon's Nostr side: the nutzap / kind 10019 builders are `@sovit/core`'s
 * (`nostr.nutzapPublisher`, `nostr.announceNutzapInfo`, portable); what is Node-only is the relay
 * pool — nostr-tools' `AbstractSimplePool` with the `ws` package as its WebSocket, since the unit
 * runs Node with `--no-experimental-websocket` (MDWE-RESULTS.md §6) and so has no global one.
 * Passing the implementation per pool mutates nothing global.
 */
import { nostr } from '@sovit/core';
import { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import { verifyEvent } from 'nostr-tools/pure';
import WebSocket from 'ws';

type PoolLike = nostr.PoolLike;

/**
 * `ws` with an 'error' listener from birth. nostr-tools clears a socket's `onerror` before it
 * closes it, and `ws` reports the abort of a still-connecting handshake as an 'error' event; with
 * no listener left, Node throws it as an uncaught exception — a daemon stopping while a relay is
 * still connecting died with it. The extra listener hides nothing from nostr-tools: its own
 * `onerror` is a separate listener and fires while it is set.
 */
class RelaySocket extends WebSocket {
  constructor(...args: ConstructorParameters<typeof WebSocket>) {
    super(...args);
    this.on('error', () => undefined);
  }
}

/** A relay pool for a Node daemon without a global WebSocket. `close()` it at shutdown. */
export function createRelayPool(): PoolLike {
  const backend = new AbstractSimplePool({
    verifyEvent,
    websocketImplementation: RelaySocket as unknown as typeof globalThis.WebSocket,
    maxWaitForConnection: 5000,
  });
  return new nostr.SimplePoolAdapter(backend);
}

export const nutzapPublisher = nostr.nutzapPublisher;
export const announceNutzapInfo = nostr.announceNutzapInfo;
export type NutzapPublisherOptions = nostr.NutzapPublisherOptions;

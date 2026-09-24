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

/** A relay pool for a Node daemon without a global WebSocket. `close()` it at shutdown. */
export function createRelayPool(): PoolLike {
  const backend = new AbstractSimplePool({
    verifyEvent,
    websocketImplementation: WebSocket as unknown as typeof globalThis.WebSocket,
    maxWaitForConnection: 5000,
  });
  return new nostr.SimplePoolAdapter(backend);
}

export const nutzapPublisher = nostr.nutzapPublisher;
export const announceNutzapInfo = nostr.announceNutzapInfo;
export type NutzapPublisherOptions = nostr.NutzapPublisherOptions;

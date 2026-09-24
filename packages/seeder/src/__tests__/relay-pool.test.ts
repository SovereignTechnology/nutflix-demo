/**
 * The daemon's relay pool at shutdown. nostr-tools clears a socket's `onerror` before closing it,
 * and `ws` reports the abort of a still-connecting handshake as an 'error' event; with no listener
 * left, Node throws it as an uncaught exception — a daemon stopping while a relay is still
 * connecting would die with it (seen as a CI flake in the gateway's CLI test).
 */
import { createServer, type Server, type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { RelayUrl } from '@sovit/core';

import { createRelayPool } from '../runtime/nostr-publish.js';

let server: Server | undefined;
const sockets = new Set<Socket>();
afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets.clear();
  const s = server;
  server = undefined;
  if (s !== undefined)
    await new Promise<void>((ok) => {
      s.close(() => {
        ok();
      });
    });
});

/** A "relay" that accepts TCP and never answers the upgrade: its sockets stay CONNECTING. */
async function silentRelay(): Promise<RelayUrl> {
  const s = createServer((c) => {
    sockets.add(c);
    c.on('error', () => undefined);
  });
  server = s;
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  const addr = s.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return `ws://127.0.0.1:${String(addr.port)}` as RelayUrl;
}

describe('createRelayPool', () => {
  it('closes while a relay is still connecting without an uncaught exception', async () => {
    const url = await silentRelay();
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown): void => {
      uncaught.push(e);
    };
    process.on('uncaughtException', onUncaught);
    try {
      const pool = createRelayPool();
      void pool.query([url], { kinds: [1] }).catch(() => []); // settles on its own wait
      await new Promise((ok) => setTimeout(ok, 100)); // the socket is open, the upgrade unanswered
      expect(sockets.size).toBe(1);
      pool.close();
      await new Promise((ok) => setTimeout(ok, 100));
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    expect(uncaught.map((e) => (e instanceof Error ? e.message : String(e)))).toEqual([]);
  });
});

/**
 * `WsBridge` hardening (docs/lanes/L3-flake.md, F1 + F2): what happens to a WebSocket after its
 * replication stream has ended — a seeder cut, a handshake timeout, a remote Noise close.
 *
 *   - F1: the socket stays in the bridge's `sockets` — counted against `maxConnections`,
 *     terminated by `close()` — until the WebSocket's OWN `close`, and a socket that has not
 *     closed `closeGraceMs` after its stream ended is terminated;
 *   - F2: the closing handshake starts at the cut even while a write is stalled on a peer that
 *     stopped reading (`WsDuplex._predestroy`), so the frames already handed over go first.
 *
 * Deterministic without load: a fake seeder hands the bridge a streamx `Duplex` as the
 * "replication stream", so the test ends the stream (the cut) and puts bytes on the wire itself.
 * A real `http` server routes upgrades into a `WsBridge` with an injected close grace; the
 * server-side TCP sockets are observed directly.
 */
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import type { Seeder } from '@sovit/seeder';
import { silentLogger } from '@sovit/seeder';
import { Duplex } from 'streamx';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { DEFAULT_WS_LIMITS } from '../config.js';
import { WsBridge } from '../ws/bridge.js';

/** Short injected grace so the tests run in well under a second each. */
const GRACE = 300;

/** Stand-in for `seeder.replicate(false)`: a streamx Duplex that is its own Noise stream. */
class FakeStream extends Duplex {
  readonly noiseStream: FakeStream = this;
  /** Non-null = "Noise handshake done", so the bridge's handshake deadline never fires. */
  readonly remotePublicKey: Uint8Array = new Uint8Array(32);

  override _write(_data: unknown, cb: (err: Error | null) => void): void {
    cb(null);
  }
}

interface Harness {
  readonly bridge: WsBridge;
  readonly url: string;
  /** One per accepted connection, in order. */
  readonly streams: FakeStream[];
  /** Server-side TCP socket of each accepted connection, in order. */
  readonly accepted: Socket[];
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function harness(
  o: { closeGraceMs?: number; maxConnections?: number } = {},
): Promise<Harness> {
  const streams: FakeStream[] = [];
  const accepted: Socket[] = [];
  const all: Socket[] = [];
  const seeder = {
    replicate: () => {
      const s = new FakeStream();
      streams.push(s);
      return s;
    },
  } as unknown as Seeder;
  const bridge = new WsBridge({
    seeder,
    limits: {
      ...DEFAULT_WS_LIMITS,
      maxConnections: o.maxConnections ?? 16,
      handshakeTimeoutMs: 10_000,
      pingIntervalMs: 60_000,
    },
    logger: silentLogger,
    ...(o.closeGraceMs !== undefined ? { closeGraceMs: o.closeGraceMs } : {}),
  });
  const http = createServer();
  http.on('upgrade', (req, socket, head) => {
    all.push(socket as Socket);
    if (bridge.handleUpgrade(req, socket, head) === null) accepted.push(socket as Socket);
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as AddressInfo).port;
  cleanups.push(async () => {
    await bridge.close();
    for (const s of all) s.destroy();
    await new Promise<void>((r) =>
      http.close(() => {
        r();
      }),
    );
  });
  return { bridge, url: `ws://127.0.0.1:${port}${DEFAULT_WS_LIMITS.path}`, streams, accepted };
}

const clients: WebSocket[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.terminate();
});

/** Open a client; resolves `'open'`, or the upgrade error's message (e.g. a 503). */
function dial(h: Harness): { ws: WebSocket; outcome: Promise<string> } {
  const ws = new WebSocket(h.url);
  clients.push(ws);
  ws.on('error', () => undefined);
  const outcome = new Promise<string>((resolve) => {
    ws.once('open', () => {
      resolve('open');
    });
    ws.once('error', (err) => {
      resolve(err.message);
    });
  });
  return { ws, outcome };
}

async function connect(h: Harness): Promise<WebSocket> {
  const { ws, outcome } = dial(h);
  expect(await within(outcome, 2_000, 'client never connected')).toBe('open');
  return ws;
}

/** `p`, or a failure naming what stalled once `ms` have passed. */
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} (waited ${ms} ms)`));
    }, ms);
  });
  try {
    return await Promise.race([p, expired]);
  } finally {
    clearTimeout(timer);
  }
}

const onceClosed = (s: {
  readonly destroyed: boolean;
  once: (e: 'close', cb: () => void) => unknown;
}): Promise<void> =>
  new Promise((resolve) => {
    if (s.destroyed) resolve();
    else
      s.once('close', () => {
        resolve();
      });
  });

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** End the replication stream (the cut) and wait until the bridge has seen it. */
async function cut(stream: FakeStream): Promise<number> {
  const t0 = Date.now();
  stream.destroy();
  await onceClosed(stream);
  return t0;
}

describe('WsBridge after the stream ends (F1: tracked until the socket closes, 5 s grace)', () => {
  it('a peer that never answers the close frame stays counted until the grace, then is terminated', async () => {
    const h = await harness({ closeGraceMs: GRACE });
    const client = await connect(h);
    const socket = h.accepted[0]!;
    client.pause(); // never reads, so never answers our close frame
    const t0 = await cut(h.streams[0]!);

    // Still counted: the socket is open, so it holds a connection slot and close() owns it.
    expect(h.bridge.connections).toBe(1);
    await within(onceClosed(socket), GRACE + 2_000, 'the cut socket was never terminated');
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(GRACE - 5); // by the grace, not earlier …
    expect(elapsed).toBeLessThan(GRACE + 2_000); // … and not by ws's 30 s closeTimeout
    await within(
      (async () => {
        while (h.bridge.connections !== 0) await pause(10);
      })(),
      1_000,
      'the terminated socket stayed counted',
    );
    expect(h.bridge.stats().graceTerminations).toBe(1);
  });

  it('close() terminates a cut socket that is still closing — no wait for the grace or the 30 s closeTimeout', async () => {
    const h = await harness(); // the DEFAULT grace (WS_CLOSE_GRACE_MS, 5 s)
    const client = await connect(h);
    const socket = h.accepted[0]!;
    client.pause();
    await cut(h.streams[0]!);
    expect(h.bridge.connections).toBe(1);

    const t0 = Date.now();
    await within(h.bridge.close(), 2_000, 'bridge.close() did not resolve');
    await within(onceClosed(socket), 2_000, 'bridge.close() left the cut socket open');
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('a cut during a stalled write (peer stopped reading, send buffer full) is still gone by the grace', async () => {
    const h = await harness({ closeGraceMs: GRACE });
    const client = await connect(h);
    const socket = h.accepted[0]!;
    const stream = h.streams[0]!;
    client.pause(); // the peer stops reading
    // Put bytes on the wire until the server's TCP socket holds some in userland: the kernel
    // buffers are full and a `WsDuplex._write` is waiting on `ws.send`'s callback.
    const chunk = Buffer.alloc(256 * 1024, 7);
    for (let i = 0; i < 400 && socket.writableLength === 0; i++) {
      stream.push(chunk);
      await pause(5);
    }
    expect(socket.writableLength).toBeGreaterThan(0);

    const t0 = await cut(stream);
    expect(h.bridge.connections).toBe(1);
    await within(
      onceClosed(socket),
      GRACE + 2_000,
      'a cut during a stalled write left the socket open (no close started, no grace)',
    );
    expect(Date.now() - t0).toBeGreaterThanOrEqual(GRACE - 5);
  });

  it('maxConnections: a cut-but-not-closed socket still holds its slot until it closes', async () => {
    // The DEFAULT grace (5 s): the slot must be held for as long as the socket is open, however
    // slowly the extra upgrade arrives. (Termination by the grace itself: the first test.)
    const h = await harness({ maxConnections: 1 });
    const first = await connect(h);
    first.pause(); // does not answer the close frame (yet)
    await cut(h.streams[0]!);

    // The only slot is still taken: an extra connection is refused …
    const extra = dial(h);
    expect(await within(extra.outcome, 2_000, 'the extra connection hung')).toContain('503');
    expect(h.bridge.stats().refused).toBe(1);

    // … until the cut socket has actually closed (here: the peer answers after all).
    first.resume();
    await within(onceClosed(h.accepted[0]!), 2_000, 'the cut socket did not close');
    await within(
      (async () => {
        while (h.bridge.connections !== 0) await pause(10);
      })(),
      1_000,
      'the closed socket stayed counted',
    );
    await connect(h);
    expect(h.bridge.connections).toBe(1);
    expect(h.bridge.stats().graceTerminations).toBe(0);
  });

  it('an honest peer still closes cleanly with 1000 in milliseconds, and the grace never fires', async () => {
    const HONEST_GRACE = 1_000; // generous: under load the close must still beat it by far
    const h = await harness({ closeGraceMs: HONEST_GRACE });
    const client = await connect(h);
    const code = new Promise<number>((r) =>
      client.once('close', (c) => {
        r(c);
      }),
    );
    const t0 = await cut(h.streams[0]!);
    expect(await within(code, 1_000, 'the honest peer did not close')).toBe(1000);
    expect(Date.now() - t0).toBeLessThan(HONEST_GRACE);
    await pause(HONEST_GRACE + 100);
    expect(h.bridge.connections).toBe(0);
    expect(h.bridge.stats().graceTerminations).toBe(0);
  });
});

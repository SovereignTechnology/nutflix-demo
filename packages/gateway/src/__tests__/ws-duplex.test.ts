/**
 * `WsDuplex` against a real `ws` server + client on a loopback port.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { WsDuplex } from '../ws/ws-duplex.js';

interface Pair {
  readonly server: WsDuplex;
  /** The server-side `ws` socket the duplex wraps. */
  readonly serverWs: WebSocket;
  readonly client: WebSocket;
  readonly close: () => Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function pair(opts?: { highWaterMark?: number }): Promise<Pair> {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as AddressInfo).port;
  const serverSide = new Promise<{ server: WsDuplex; serverWs: WebSocket }>((resolve) => {
    wss.once('connection', (ws) => {
      resolve({ server: new WsDuplex(ws, opts), serverWs: ws });
    });
  });
  const client = new WebSocket(`ws://127.0.0.1:${port}/`);
  await new Promise<void>((r) => client.once('open', r));
  const { server, serverWs } = await serverSide;
  const close = async (): Promise<void> => {
    client.terminate();
    if (!server.destroyed) server.destroy();
    // A server socket stuck mid-close would otherwise hold `http.close()` for ws's 30 s
    // closeTimeout.
    serverWs.terminate();
    wss.close();
    await new Promise<void>((r) =>
      http.close(() => {
        r();
      }),
    );
  };
  cleanups.push(close);
  return { server, serverWs, client, close };
}

const onceClose = (s: {
  once: (e: 'close', cb: () => void) => unknown;
  destroyed: boolean;
}): Promise<void> =>
  new Promise((r) => {
    if (s.destroyed) r();
    else s.once('close', r);
  });

describe('WsDuplex', () => {
  it('binary frames flow both ways as bytes (client → duplex readable, duplex write → client)', async () => {
    const { server, client } = await pair();
    const got: Buffer[] = [];
    server.on('data', (d: unknown) => got.push(d as Buffer));
    client.send(Buffer.from([1, 2, 3]));
    client.send(new Uint8Array([4, 5]));
    await new Promise((r) => setTimeout(r, 50));
    expect(Buffer.concat(got)).toEqual(Buffer.from([1, 2, 3, 4, 5]));

    const fromServer = new Promise<Buffer>((r) =>
      client.once('message', (d) => {
        r(d as Buffer);
      }),
    );
    server.write(Buffer.from('hello'));
    expect((await fromServer).toString()).toBe('hello');
    const asU8 = new Promise<Buffer>((r) =>
      client.once('message', (d) => {
        r(d as Buffer);
      }),
    );
    server.write(new Uint8Array([9, 9]));
    expect([...(await asU8)]).toEqual([9, 9]);
  });

  it('a text frame is a protocol violation: the duplex destroys and the socket closes', async () => {
    const { server, client } = await pair();
    server.on('error', () => undefined);
    const closed = onceClose(server);
    client.send('not binary');
    await closed;
    expect(server.destroyed).toBe(true);
    await new Promise<void>((r) => {
      if (client.readyState === WebSocket.CLOSED) r();
      else
        client.once('close', () => {
          r();
        });
    });
  });

  it('remote close destroys the duplex; destroying the duplex closes the socket gracefully', async () => {
    const a = await pair();
    const closedA = onceClose(a.server);
    a.client.close(1000);
    await closedA;
    expect(a.server.destroyed).toBe(true);

    const b = await pair();
    const clientClosed = new Promise<number>((r) =>
      b.client.once('close', (code) => {
        r(code);
      }),
    );
    b.server.destroy();
    expect(await clientClosed).toBe(1000); // close frame, not a TCP reset
  });

  it('bytes written before a destroy still reach the client (graceful close, spike S-A cut semantics)', async () => {
    const { server, client } = await pair();
    const received: Buffer[] = [];
    client.on('message', (d) => received.push(d as Buffer));
    const clientClosed = new Promise<void>((r) =>
      client.once('close', () => {
        r();
      }),
    );
    for (let i = 0; i < 5; i++) server.write(Buffer.alloc(1024, i));
    // streamx `destroy()` after `write()`: pending writes are dropped by streamx itself, so
    // give the queue one turn to drain into `ws.send` before destroying — that is exactly
    // what happens when Hypercore has already handed blocks to the Noise stream.
    await new Promise((r) => setImmediate(r));
    server.destroy();
    await clientClosed;
    expect(received.length).toBe(5);
  });

  it('a frame that crosses our close frame is dropped and does not stall the closing handshake', async () => {
    // Spike S-A cut over a real socket: the seeder destroys the duplex while the viewer still
    // has requests in flight, so frames keep arriving until the viewer reads our close frame.
    // They must not pause the socket — a paused socket never reads the viewer's close reply,
    // and the handshake then waits out ws's closeTimeout (30 s). docs/lanes/L3-flake.md.
    const { server, serverWs, client } = await pair();
    const clientClosed = new Promise<number>((r) =>
      client.once('close', (code) => {
        r(code);
      }),
    );
    const lateFrameSeen = new Promise<void>((r) =>
      serverWs.once('message', () => {
        r();
      }),
    );
    // Order the race with events, not timing: the client has not read the close frame yet …
    client.pause();
    server.destroy(); // … when the cut closes the socket …
    client.send(Buffer.from([1, 2, 3])); // … so its next request crosses the close frame …
    await lateFrameSeen; // … and the server handles it on its own, not coalesced with the reply.
    expect(serverWs.isPaused).toBe(false);
    client.resume(); // The client now reads the close frame and replies.
    const outcome = await Promise.race([
      clientClosed,
      new Promise<'stalled'>((r) => {
        setTimeout(() => {
          r('stalled');
        }, 5000); // ≪ ws's 30 s closeTimeout
      }),
    ]);
    expect(outcome).toBe(1000);
  });

  it('a destroy during a stalled write still starts the closing handshake, and stays graceful', async () => {
    // F2 (docs/lanes/L3-flake.md): streamx defers `_destroy` until an in-flight `_write` calls
    // back, and ours calls back only once `ws` has flushed the frame — never, while the peer
    // does not read. The close must start at the destroy anyway (`_predestroy`).
    const { server, serverWs, client } = await pair({ highWaterMark: 4096 });
    server.on('error', () => undefined);
    let bytes = 0;
    client.on('message', (d) => {
      bytes += (d as Buffer).byteLength;
    });
    const clientClosed = new Promise<number>((r) =>
      client.once('close', (code) => {
        r(code);
      }),
    );
    client.pause(); // the peer stops reading
    const chunk = Buffer.alloc(256 * 1024, 7);
    // Queue until ws holds bytes in userland: the kernel buffers are full and a `_write` is
    // waiting on `ws.send`'s callback.
    for (let i = 0; i < 400 && serverWs.bufferedAmount === 0; i++) {
      server.write(chunk);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(serverWs.bufferedAmount).toBeGreaterThan(0);

    server.destroy(); // the cut, mid-write
    expect(serverWs.readyState).toBe(WebSocket.CLOSING); // the close frame is queued NOW …
    client.resume();
    const code = await Promise.race([
      clientClosed,
      new Promise<'stalled'>((r) => {
        setTimeout(() => {
          r('stalled');
        }, 5000);
      }),
    ]);
    expect(code).toBe(1000); // … behind the frames already handed to the socket
    expect(bytes).toBeGreaterThan(0);
  });

  it('write backpressure: `write()` returns false once the socket buffer is full and drains later', async () => {
    const { server, client } = await pair({ highWaterMark: 4096 });
    const chunk = Buffer.alloc(64 * 1024, 7);
    // Client does not read → server socket buffers fill; ws.send callbacks wait on flush.
    client.pause();
    let falseSeen = false;
    for (let i = 0; i < 64 && !falseSeen; i++) if (!server.write(chunk)) falseSeen = true;
    expect(falseSeen).toBe(true);
    const drained = new Promise<void>((r) =>
      server.once('drain', () => {
        r();
      }),
    );
    client.resume();
    await drained;
  });

  it('read backpressure: frames that arrive while nobody reads are paused, not lost, and drain in order', async () => {
    const { server, client } = await pair({ highWaterMark: 1024 });
    const N = 32;
    for (let i = 0; i < N; i++) client.send(Buffer.alloc(8 * 1024, i));
    await new Promise((r) => setTimeout(r, 100));
    const got: Buffer[] = [];
    await new Promise<void>((resolve) => {
      server.on('data', (d: unknown) => {
        got.push(d as Buffer);
        if (Buffer.concat(got).byteLength === N * 8 * 1024) resolve();
      });
    });
    const all = Buffer.concat(got);
    for (let i = 0; i < N; i++) expect(all[i * 8 * 1024]).toBe(i);
  });
});

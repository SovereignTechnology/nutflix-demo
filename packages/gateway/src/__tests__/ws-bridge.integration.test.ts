/**
 * The WS bridge end to end: a client-side Hypercore (a second `Seeder` acting as the
 * viewer, `replicate(true)` = Noise initiator exactly as the browser in spike S-B) over a
 * REAL `ws` loopback socket replicates a fixture blob from the gateway's seeder.
 *
 *   - accounting: the gateway's `upload` events, the `PeerSession` and the PaymentEngine
 *     window all agree with the viewer's `download` count;
 *   - the cut: a non-paying WS client is cut by the seeder's window logic exactly as over
 *     hyperswarm (S-A finding 3) — window+1 uploads recorded, `session-cut{window-exceeded}`,
 *     Noise key banned, viewer holds ≤ window blocks, socket closed;
 *   - `HELLO` on the socket discloses the gateway's OWN price = base marked up by
 *     `markupPercent` (ADR 0005 Q4, ceil);
 *   - the `pay/1` instance is attached to the connection's protomux.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { mocks, payProtocol, payment } from '@sovit/core';
import type { Sats } from '@sovit/core';
import { Seeder, toHex } from '@sovit/seeder';
import type { SeederEvent } from '@sovit/seeder';

import { WsDuplex } from '../ws/ws-duplex.js';
import {
  BLOCK,
  capturedLogger,
  cleanupRigs,
  fixtureBytes,
  rig,
  settle,
  tmpDir,
  until,
} from './helpers.js';
import type { Rig } from './helpers.js';

afterEach(cleanupRigs);

interface Viewer {
  readonly seeder: Seeder;
  readonly events: SeederEvent[];
  readonly close: () => Promise<void>;
}

const viewers: Viewer[] = [];
afterEach(async () => {
  for (const v of viewers.splice(0)) await v.close();
});

async function viewer(): Promise<Viewer> {
  const t = await tmpDir('nutflix-l3-viewer-');
  const engine = new mocks.MockPaymentEngine({ mode: 'honest', config: { windowBlocks: 1000 } });
  const log = capturedLogger();
  const seeder = await Seeder.create(
    {
      dataDir: t.dir,
      diskCapBytes: 1024 * 1024,
      blockSize: BLOCK,
      swarm: null,
      flushEveryBlocks: 1000,
      flushEveryMs: 60_000,
    },
    {
      engine,
      logger: log.logger,
      fs: (await import('@sovit/seeder')).nodeFs,
      crypto: (await import('@sovit/seeder')).nodeCrypto,
    },
  );
  const events: SeederEvent[] = [];
  seeder.on((e) => events.push(e));
  seeder.start();
  const v: Viewer = {
    seeder,
    events,
    close: async () => {
      await seeder.close();
      await t.rm();
    },
  };
  viewers.push(v);
  return v;
}

/** Browser-side wiring from S-B: WebSocket → Duplex → `replicate(true)`. */
function connectViewer(
  v: Viewer,
  r: Rig,
  keyPair?: { publicKey: Uint8Array; secretKey: Uint8Array },
) {
  const ws = new WebSocket(`ws://127.0.0.1:${r.port}${r.config.ws.path}`);
  const duplex = new WsDuplex(ws);
  const raw = v.seeder.replicate(true, keyPair ? { keyPair } : {});
  raw.on('error', () => undefined);
  duplex.on('error', () => undefined);
  ws.once('open', () => {
    raw.pipe(duplex).pipe(raw);
  });
  const closed = new Promise<void>((resolve) => {
    ws.once('close', () => {
      resolve();
    });
  });
  return { ws, raw, closed };
}

async function countBlocks(v: Viewer, coreKeyHex: string): Promise<number> {
  const sc = v.seeder.blobs.coreByKey(coreKeyHex);
  if (!sc) throw new Error('viewer has no such core');
  let have = 0;
  for (let i = 0; i < sc.core.length; i++) if (await sc.core.has(i)) have++;
  return have;
}

type CutEvent = Extract<SeederEvent, { type: 'session-cut' }>;

/**
 * Bounds for the cut tests' waits. Every wait there is on an EVENT, bounded well inside the
 * 20 s test timeout so that a stall fails with a message naming it. Under load the events
 * simply arrive later; nothing races a timer. (docs/lanes/L3-flake.md)
 */
const CUT_WITHIN_MS = 8_000;
/** Far below `ws`'s 30 s closeTimeout, so a stalled closing handshake is reported as one. */
const CLOSE_WITHIN_MS = 5_000;
const CLOSE_STALL =
  'the WebSocket did not close after the cut — closing handshake stalled (ws closeTimeout is ' +
  '30 s; a late viewer frame must never pause the gateway socket, see ws/ws-duplex.ts)';

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

/** The gateway seeder's next `session-cut`. Subscribe BEFORE the viewer connects. */
function nextCut(r: Rig): Promise<CutEvent> {
  return new Promise((resolve) => {
    const off = r.gateway.seeder.on((e) => {
      if (e.type === 'session-cut') {
        off();
        resolve(e);
      }
    });
  });
}

const onceClosed = (s: {
  readonly destroyed: boolean;
  once: (e: 'close', cb: () => void) => unknown;
}): Promise<void> =>
  new Promise((resolve) => {
    if (s.destroyed) resolve();
    else s.once('close', resolve);
  });

interface BackgroundFetch {
  /** `'complete'`, the error it ended with, or `null` while it is still outstanding. */
  readonly outcome: () => 'complete' | Error | null;
  /** Cancel it (destroy the read stream) and wait for how it ended. */
  readonly cancel: () => Promise<'complete' | Error>;
}

/**
 * Fetch a blob in the background with NO request timeout. The cut tests used to wait for the
 * viewer's `get` to fail with `REQUEST_TIMEOUT`, but Hypercore arms that timer when the
 * request is created, before the WebSocket is even open: under load a short timeout could
 * expire before the gateway had uploaded `window + 1` blocks, leaving nothing to cut. Here the
 * requests stay outstanding until the test has seen the cut, and the test cancels them.
 */
function fetchInBackground(
  stream: AsyncIterable<Uint8Array> & { destroy: (err?: Error) => void },
): BackgroundFetch {
  let outcome: 'complete' | Error | null = null;
  const done = (async (): Promise<'complete' | Error> => {
    try {
      // Drain it: what matters is whether the fetch completes, not the bytes.
      const it = stream[Symbol.asyncIterator]();
      while (!(await it.next()).done);
      return (outcome = 'complete');
    } catch (err) {
      return (outcome = err instanceof Error ? err : new Error(String(err)));
    }
  })();
  return {
    outcome: () => outcome,
    cancel: () => {
      stream.destroy();
      return done;
    },
  };
}

/**
 * The viewer's block count once it has stopped changing: non-zero and unchanged for `quietMs`.
 * Call it after the viewer's replication stream has closed, so no new data can arrive; this
 * only lets blocks already received finish verifying and landing in storage. The old test got
 * that quiet period from its 2.5 s `REQUEST_TIMEOUT` wait.
 */
async function settledBlockCount(
  v: Viewer,
  coreKeyHex: string,
  quietMs = 500,
  withinMs = 4_000,
): Promise<number> {
  const t0 = Date.now();
  let last = await countBlocks(v, coreKeyHex);
  let since = Date.now();
  for (;;) {
    await settle(50);
    const now = await countBlocks(v, coreKeyHex);
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (now > 0 && Date.now() - since >= quietMs) {
      return now;
    }
    if (Date.now() - t0 > withinMs)
      throw new Error(
        last === 0
          ? `the viewer stored no block at all (waited ${withinMs} ms)`
          : `the viewer's block count kept changing (last ${last}, waited ${withinMs} ms)`,
      );
  }
}

async function putFixture(r: Rig, blocks: number) {
  const data = fixtureBytes(blocks);
  const res = await r.gateway.seeder.putBytes(data, { mime: 'video/mp4' });
  if (!res.ok) throw new Error(res.error.code);
  return { data, entry: res.entry };
}

describe('WS bridge: one WebSocket = one replication stream + pay/1', () => {
  it('a client Hypercore over a real ws socket replicates a fixture blob and the accounting matches', async () => {
    const BLOCKS = 12;
    const r = await rig({ windowBlocks: 100 });
    const { data, entry } = await putFixture(r, BLOCKS);
    const v = await viewer();
    const vcore = await v.seeder.blobs.openCoreByKey(Buffer.from(entry.coreKey, 'hex'));

    let uploads = 0;
    r.gateway.seeder.blobs.coreByKey(entry.coreKey)!.core.on('upload', () => uploads++);
    let downloads = 0;
    vcore.core.on('download', () => downloads++);

    const { raw } = connectViewer(v, r);
    const got = await vcore.blobs.get(entry.blob, { wait: true, timeout: 8000 });
    expect(got).not.toBeNull();
    expect(Buffer.from(got!).equals(Buffer.from(data))).toBe(true);
    await settle(150);

    expect(uploads).toBe(BLOCKS);
    expect(downloads).toBe(BLOCKS);
    expect(await countBlocks(v, entry.coreKey)).toBe(BLOCKS);

    // Gateway side: the session for the viewer's Noise key saw every upload …
    const viewerNoise = toHex(raw.noiseStream.publicKey!);
    const session = r.gateway.seeder.session(viewerNoise);
    expect(session).toBeDefined();
    expect(session!.uploadedBlocks).toBe(BLOCKS);
    expect(session!.info().uploadedBytes).toBe(BLOCKS * BLOCK);
    // … and so did the PaymentEngine under the provisional (Noise-key) identity.
    const w = r.engine.window(session!.accountId())!;
    expect(w).toMatchObject({ uploaded: BLOCKS, paid: 0, outstanding: BLOCKS, banned: false });
    expect(session!.cutReason).toBeNull();
    expect(r.gateway.stats().wsConnections).toBe(1);
    expect(r.sessions.map((s) => s.noiseKeyHex)).toContain(viewerNoise);
  });

  it('a non-paying WS client is cut by the seeder window exactly as over hyperswarm (S-A finding 3)', async () => {
    const WINDOW = 4;
    const BLOCKS = 20;
    const r = await rig({ windowBlocks: WINDOW });
    // v5 (ADR 0007/0010): the engine's window for a peer is the EFFECTIVE window — large
    // enough for one minimum PAY at this video's price (2 sat/block, default 10 → 5 blocks).
    const EFFECTIVE = payment.effectiveWindowBlocks(WINDOW, r.gateway.seeder.policy());
    expect(EFFECTIVE).toBe(5);
    const { entry } = await putFixture(r, BLOCKS);
    const v = await viewer();
    const vcore = await v.seeder.blobs.openCoreByKey(Buffer.from(entry.coreKey, 'hex'));
    const uploadEvents: number[] = [];
    r.gateway.seeder.blobs.coreByKey(entry.coreKey)!.core.on('upload', (i) => uploadEvents.push(i));

    const cut = nextCut(r);
    const { raw, closed } = connectViewer(v, r);
    const fetch = fetchInBackground(vcore.blobs.createReadStream(entry.blob, { wait: true }));
    const e = await within(cut, CUT_WITHIN_MS, 'the gateway never cut the non-paying viewer');
    await within(closed, CLOSE_WITHIN_MS, CLOSE_STALL); // the gateway closed the WebSocket
    await within(onceClosed(raw), 2_000, "the viewer's replication stream outlived its socket");

    const viewerNoise = toHex(raw.noiseStream.publicKey!);
    // The cut was this viewer's session, for the window …
    expect(e.session.noiseKeyHex).toBe(viewerNoise);
    expect(e.reason).toBe('window-exceeded');
    // … and it never obtained the blob: its fetch is still waiting for blocks that will not come.
    expect(fetch.outcome()).toBeNull();
    // Hypercore fired `upload` at least window+1 times (the crossing block was counted, S-A
    // finding + L2's wire-rig note that one more queued request can pop after destroy) …
    expect(uploadEvents.length).toBeGreaterThanOrEqual(EFFECTIVE + 1);
    // … the engine recorded exactly window+1 and banned the provisional identity …
    const w = r.engine.window(viewerNoise as never)!;
    expect(w).toMatchObject({
      uploaded: EFFECTIVE + 1,
      paid: 0,
      outstanding: EFFECTIVE + 1,
      windowBlocks: EFFECTIVE,
      banned: true,
    });
    // … the session was cut for that reason and left the registry …
    expect(r.gateway.seeder.session(viewerNoise)).toBeUndefined();
    const logged = r.log.records.find((rec) => rec.msg === 'session cut');
    expect(logged?.fields['reason']).toBe('window-exceeded');
    // … the Noise key is on the persisted ban list …
    expect(
      r.gateway.seeder
        .bans()
        .some((b) => b.noiseKey === viewerNoise && b.reason === 'window-exceeded'),
    ).toBe(true);
    // … and the viewer holds at most `window` blocks (never the crossing one), counted once
    // everything it received has landed.
    const have = await settledBlockCount(v, entry.coreKey);
    expect(have).toBeGreaterThan(0);
    expect(have).toBeLessThanOrEqual(EFFECTIVE);
    expect(await fetch.cancel()).toBeInstanceOf(Error);
    await until(() => r.gateway.stats().wsConnections === 0, 3000);
  });

  it('a cut viewer that never answers the close frame stays counted, and gateway.close() does not wait for it (F1)', async () => {
    const r = await rig({ windowBlocks: 4 });
    const { entry } = await putFixture(r, 20);
    const v = await viewer();
    const vcore = await v.seeder.blobs.openCoreByKey(Buffer.from(entry.coreKey, 'hex'));
    // The gateway-side Noise stream of the session: once it has closed, the bridge has seen the
    // cut (its own close listener was registered first, at the upgrade).
    let noise: { readonly destroyed: boolean; once: (e: 'close', cb: () => void) => unknown };
    const opened = new Promise<void>((resolve) => {
      const off = r.gateway.seeder.on((e) => {
        if (e.type === 'session-open') {
          noise = r.gateway.seeder.session(e.session.noiseKeyHex)!.stream.noiseStream;
          off();
          resolve();
        }
      });
    });
    const { ws } = connectViewer(v, r);
    const cutSeen = new Promise<void>((resolve) => {
      const off = r.gateway.seeder.on((e) => {
        if (e.type === 'session-cut') {
          ws.pause(); // a viewer that never reads, so never answers the close frame
          off();
          resolve();
        }
      });
    });
    const fetch = fetchInBackground(vcore.blobs.createReadStream(entry.blob, { wait: true }));
    await within(opened, CUT_WITHIN_MS, 'no session opened');
    await within(cutSeen, CUT_WITHIN_MS, 'the gateway never cut the viewer');
    await within(onceClosed(noise!), 2_000, "the session's Noise stream did not close");

    // The socket is still open, so it is still counted (maxConnections) and owned by close() …
    expect(r.gateway.stats().wsConnections).toBe(1);
    // … which therefore terminates it: no wait for the 5 s grace, nor ws's 30 s closeTimeout.
    const t0 = Date.now();
    await within(r.gateway.close(), 3_000, 'gateway.close() waited on the cut socket');
    expect(Date.now() - t0).toBeLessThan(3_000);
    ws.resume();
    await fetch.cancel();
  });

  it('HELLO discloses the gateway price = ceil(base × (100 + markupPercent) / 100), and pay/1 is attached to the protomux', async () => {
    // Base policy is 2 sats/block (helpers.basePolicy); 150 % markup → ceil(2 × 2.5) = 5.
    const r = await rig({ windowBlocks: 100, raw: { markupPercent: 150 } });
    const { entry } = await putFixture(r, 2);
    const v = await viewer();
    const vcore = await v.seeder.blobs.openCoreByKey(Buffer.from(entry.coreKey, 'hex'));
    connectViewer(v, r);
    await vcore.blobs.get(entry.blob, { wait: true, timeout: 8000 });
    await until(() => r.protocols.length === 1 && r.protocols[0]!.hellos.length === 1);

    const p = r.protocols[0]!;
    const hello = p.hellos[0]!;
    expect(r.config.policy.satsPerBlock).toBe(2);
    expect(hello.satsPerBlock).toBe(Math.ceil((2 * (100 + 150)) / 100) as Sats);
    expect(hello.satsPerBlock).toBe(5 as Sats);
    expect(r.gateway.price()).toBe(5);
    expect(hello.pubkey).toBe(r.config.identity.pubkey);
    expect(hello.p2pk).toBe(r.config.identity.p2pk);
    expect(hello.acceptedMints).toEqual(r.config.acceptedMints);
    expect(hello.split).toEqual({ seeder: 50, creator: 50 });
    expect(hello.version).toBe(1);
    // v5 (ADR 0010): the HELLO is bound to THIS connection and verifies from the viewer's end.
    expect(hello.challenge).toMatch(/^pay\/1:[0-9a-f]{64,128}:[0-9a-f]{64}$/); // Noise hash: 64 bytes
    // Attached to the connection's protomux (what Hypercore parks on the Noise stream).
    expect(p.attachedTo).not.toBeNull();
    const gw = payProtocol.bindingFromMux(p.attachedTo)!;
    const fromViewer = {
      handshakeHash: gw.handshakeHash,
      localNoiseKey: gw.remoteNoiseKey,
      remoteNoiseKey: gw.localNoiseKey,
    };
    expect(payProtocol.verifyHello({ type: 'HELLO', ...hello }, fromViewer)).toBeNull();
    expect(payProtocol.verifyHello({ type: 'HELLO', ...hello }, gw)).not.toBeNull(); // not reflectable
    expect(typeof p.attachedTo!.createChannel).toBe('function');
    // The seeder verifies downstream PAYs against the MARKED-UP policy.
    expect(r.gateway.seeder.policy().satsPerBlock).toBe(5);
  });

  it('a downstream PAY at the gateway price is verified and ACKed through the seeder pay bridge', async () => {
    // 25 % on 2 sats/block → ceil(2.5) = 3: the ceil case, end to end through verify.
    const r = await rig({ windowBlocks: 100, raw: { markupPercent: 25 } });
    const { entry } = await putFixture(r, 6);
    const v = await viewer();
    const vcore = await v.seeder.blobs.openCoreByKey(Buffer.from(entry.coreKey, 'hex'));
    const { raw } = connectViewer(v, r);
    await vcore.blobs.get(entry.blob, { wait: true, timeout: 8000 });
    await until(() => r.protocols.length === 1 && r.protocols[0]!.hellos.length === 1);
    await settle(100);
    const p = r.protocols[0]!;
    const viewerNoise = toHex(raw.noiseStream.publicKey!);
    const before = r.engine.window(viewerNoise as never)!;
    expect(before.outstanding).toBe(6);

    // The viewer pays through ITS engine at the disclosed price, naming the core (v3).
    const viewerEngine = new mocks.MockPaymentEngine({ mode: 'honest' });
    const policy = r.gateway.seeder.policy();
    expect(policy.satsPerBlock).toBe(3);
    expect(r.gateway.price()).toBe(3);
    const msg = await viewerEngine.pay(
      { core: entry.coreKey, fromBlock: 0, toBlock: 5 },
      { pubkey: r.config.identity.pubkey, p2pk: r.config.identity.p2pk, mint: policy.mints[0]! },
      policy,
    );
    p.remotePay(msg);
    await until(() => p.acks.length === 1);
    expect(p.acks[0]).toMatchObject({ ok: true, fromBlock: 0, toBlock: 5 });
    expect(r.engine.window(viewerNoise as never)!.outstanding).toBe(0);
  });

  it('refuses upgrades on the wrong path (404) and above the connection cap (503)', async () => {
    const r = await rig({ raw: { ws: { maxConnections: 1, handshakeTimeoutMs: 5000 } } });
    const wrong = new WebSocket(`http://127.0.0.1:${r.port}/nope`);
    const wrongErr = await new Promise<Error>((resolve) => wrong.once('error', resolve));
    expect(wrongErr.message).toContain('404');

    const first = new WebSocket(`ws://127.0.0.1:${r.port}/ws`);
    await new Promise<void>((resolve) => first.once('open', resolve));
    const second = new WebSocket(`ws://127.0.0.1:${r.port}/ws`);
    const secondErr = await new Promise<Error>((resolve) => second.once('error', resolve));
    expect(secondErr.message).toContain('503');
    expect(r.gateway.bridge.stats().refused).toBe(1);
    first.terminate();
    await until(() => r.gateway.stats().wsConnections === 0);
  });

  it('drops a socket that never completes the Noise handshake', async () => {
    const r = await rig({ raw: { ws: { handshakeTimeoutMs: 200 } } });
    const ws = new WebSocket(`ws://127.0.0.1:${r.port}/ws`);
    await new Promise<void>((resolve) => ws.once('open', resolve));
    ws.send(Buffer.from('garbage that is not a noise handshake'));
    await new Promise<void>((resolve) =>
      ws.once('close', () => {
        resolve();
      }),
    );
    await until(
      () =>
        r.gateway.bridge.stats().handshakeTimeouts + r.gateway.seeder.stats().sessions >= 1 &&
        r.gateway.stats().wsConnections === 0,
    );
    expect(r.gateway.seeder.stats().sessions).toBe(0);
  });

  it('sessions without a pay/1 factory still replicate and are still cut (no factory = no HELLO)', async () => {
    const r = await rig({ windowBlocks: 2, payProtocol: false });
    const { entry } = await putFixture(r, 10);
    const v = await viewer();
    const vcore = await v.seeder.blobs.openCoreByKey(Buffer.from(entry.coreKey, 'hex'));
    const cut = nextCut(r);
    const { closed } = connectViewer(v, r);
    const fetch = fetchInBackground(vcore.blobs.createReadStream(entry.blob, { wait: true }));
    const e = await within(cut, CUT_WITHIN_MS, 'the gateway never cut the viewer');
    expect(e.reason).toBe('window-exceeded');
    await within(closed, CLOSE_WITHIN_MS, CLOSE_STALL);
    expect(fetch.outcome()).toBeNull();
    await fetch.cancel();
    expect(r.log.records.some((rec) => rec.msg.includes('session without pay/1'))).toBe(true);
    expect(
      r.log.records.some(
        (rec) => rec.msg === 'session cut' && rec.fields['reason'] === 'window-exceeded',
      ),
    ).toBe(true);
  });
});

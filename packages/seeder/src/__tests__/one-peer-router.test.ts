/**
 * `OnePeerRouter` (security review F33, issue #8) on real Corestores over directly piped
 * replication streams — no swarm, nothing leaves the process.
 *
 * The first block PINS the hypercore internals the router reaches into (it was written against
 * hypercore 11.35.3): the version, the objects and fields, and the lines of `lib/replicator.js`
 * whose order the router depends on. If any of it moves, these fail loudly — re-verify
 * `net/one-peer.ts` against the new release before touching the pin.
 *
 * The rest proves the behaviour: three full seeders racing for the same blocks deliver each block
 * ONCE; per-peer budgets hold whatever hypercore picks; a stalled request moves to ONE other peer
 * after `stallMs` (never two at once); a seeder that disconnects mid-range has its blocks
 * re-requested from the others, each block still delivered once.
 */
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';

import Corestore from 'corestore';
import { afterEach, describe, expect, it } from 'vitest';

import { silentLogger } from '../log/logger.js';
import {
  OnePeerRouter,
  ROUTED_HYPERCORE_VERSION,
  RoutingUnsupported,
  isRoutablePeer,
  routableReplicator,
} from '../net/one-peer.js';
import type { PeerBudget, RoutableCore } from '../net/one-peer.js';
import { toHex } from '../util/hex.js';
import { tmpDir } from './helpers.js';

const require = createRequire(import.meta.url);
const BLOCK = 1024;

/** The parts of a hypercore session (and its internals) these tests touch. */
interface RawPeer {
  readonly remotePublicKey: Uint8Array;
  readonly inflight: number;
  readonly dataProcessing: number;
  readonly stats: { readonly wireCancel: { readonly tx: number }; readonly hotswaps: number };
  getMaxInflight(): number;
}
interface RawCore extends RoutableCore {
  readonly length: number;
  readonly peers: readonly RawPeer[];
  readonly replicator: { readonly stats: { readonly hotswaps: number } };
  ready(): Promise<void>;
  append(blocks: Uint8Array[]): Promise<unknown>;
  get(index: number, opts?: { timeout?: number }): Promise<Uint8Array | null>;
  update(opts: { wait: boolean }): Promise<boolean>;
  download(range: { start: number; end: number }): { done(): Promise<void> };
  on(event: 'download' | 'upload', cb: (index: number, bytes: number, peer: RawPeer) => void): this;
  on(event: 'peer-add' | 'peer-remove', cb: (peer: never) => void): this;
  off(event: 'peer-add' | 'peer-remove', cb: (peer: never) => void): this;
  off(event: 'download', cb: (index: number, bytes: number, peer: RawPeer) => void): this;
}
interface RawStream {
  readonly noiseStream: { readonly opened: Promise<boolean>; readonly remotePublicKey: Uint8Array };
  pipe<T>(dest: T): T;
  on(event: 'error', cb: () => void): unknown;
  destroy(): void;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_r, reject) => {
      setTimeout(() => {
        reject(new Error(`still pending after ${String(ms)} ms`));
      }, ms);
    }),
  ]);
}

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

async function store(): Promise<Corestore> {
  const t = await tmpDir('nutflix-one-peer-');
  const s = new Corestore(t.dir);
  cleanups.push(async () => {
    await s.close();
    await t.rm();
  });
  return s;
}

function coreOf(s: Corestore, opts: { name?: string; key?: Uint8Array }): RawCore {
  return s.get(opts) as unknown as RawCore;
}

/**
 * Pipe `seeder` → `viewer`. `hold()` withholds everything the seeder sends from then on (a peer
 * that took our requests and answers none of them), `release()` lets it through.
 */
function connect(seeder: Corestore, viewer: Corestore) {
  const a = seeder.replicate(true) as unknown as RawStream;
  const b = viewer.replicate(false) as unknown as RawStream;
  a.on('error', () => undefined);
  b.on('error', () => undefined);
  let held = false;
  const queued: Buffer[] = [];
  const gate = new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      if (held) {
        queued.push(chunk);
        cb();
      } else cb(null, chunk);
    },
  });
  a.pipe(gate).pipe(b as unknown as NodeJS.WritableStream);
  b.pipe(a);
  return {
    remote: async (): Promise<string> => {
      await b.noiseStream.opened;
      return toHex(b.noiseStream.remotePublicKey);
    },
    hold: (): void => {
      held = true;
    },
    release: (): void => {
      held = false;
      for (const c of queued.splice(0)) gate.push(c);
    },
    destroy: (): void => {
      a.destroy();
      b.destroy();
    },
  };
}

interface World {
  readonly viewer: RawCore;
  readonly remotes: string[];
  readonly links: ReturnType<typeof connect>[];
  /** Blocks each seeder sent the viewer (its `upload` events), by seeder index. */
  readonly uploads: number[];
  /** Every `download` the viewer saw: block index and the remote it came from. */
  readonly downloads: { readonly index: number; readonly from: string }[];
}

/**
 * An origin with `n` blocks, `seeders − 1` full mirrors, a viewer connected to all of them and
 * synced (it knows the length; nothing downloaded yet). Tests route the viewer afterwards.
 */
async function world(n: number, seeders: number, blockSize = BLOCK): Promise<World> {
  const origin = await store();
  const oc = coreOf(origin, { name: 'video' });
  await oc.ready();
  await oc.append(Array.from({ length: n }, (_, i) => new Uint8Array(blockSize).fill(i % 251)));
  const stores = [origin];
  for (let i = 1; i < seeders; i++) {
    const s = await store();
    const c = coreOf(s, { key: oc.key });
    await c.ready();
    const l = connect(origin, s);
    await c.download({ start: 0, end: n }).done();
    l.destroy();
    stores.push(s);
  }
  const vs = await store();
  const viewer = coreOf(vs, { key: oc.key });
  await viewer.ready();
  const uploads = stores.map(() => 0);
  const downloads: { index: number; from: string }[] = [];
  viewer.on('download', (index, _b, peer) => {
    downloads.push({ index, from: toHex(peer.remotePublicKey) });
  });
  const links: ReturnType<typeof connect>[] = [];
  const remotes: string[] = [];
  for (const [i, s] of stores.entries()) {
    const c = coreOf(s, { key: oc.key });
    await c.ready();
    c.on('upload', () => {
      uploads[i] = (uploads[i] ?? 0) + 1;
    });
    const l = connect(s, vs);
    links.push(l);
    remotes.push(await l.remote());
  }
  await until(() => viewer.peers.length === seeders, 10_000, 'every seeder to join the core');
  await viewer.update({ wait: true });
  return { viewer, remotes, links, uploads, downloads };
}

function perIndex(downloads: readonly { index: number }[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const d of downloads) m.set(d.index, (m.get(d.index) ?? 0) + 1);
  return m;
}

const unlimited: PeerBudget = () => Number.POSITIVE_INFINITY;

function routed(
  viewer: RawCore,
  o: Omit<ConstructorParameters<typeof OnePeerRouter>[0], 'logger'>,
): OnePeerRouter {
  const router = new OnePeerRouter({ ...o, logger: silentLogger });
  cleanups.push(() => {
    router.close();
    return Promise.resolve();
  });
  router.attachCore(viewer);
  return router;
}

describe('hypercore internals the router relies on (pinned)', () => {
  it(`is hypercore ${ROUTED_HYPERCORE_VERSION} — re-verify net/one-peer.ts before moving this pin`, () => {
    const pkg = require('hypercore/package.json') as { version: string };
    expect(pkg.version).toBe(ROUTED_HYPERCORE_VERSION);
  });

  it('the replicator, its hotswap queue and its Peer have the members the router uses', async () => {
    const w = await world(4, 2);
    const rep = routableReplicator(w.viewer); // throws RoutingUnsupported otherwise
    expect(rep.peers).toHaveLength(2);
    for (const p of w.viewer.peers) {
      expect(isRoutablePeer(p)).toBe(true);
      expect(w.remotes).toContain(toHex(p.remotePublicKey));
    }
  });

  it('lib/replicator.js still does, in this order, what the router depends on', () => {
    const Replicator = require('hypercore/lib/replicator.js') as {
      prototype: Record<string, (...a: unknown[]) => unknown>;
      Peer: { prototype: Record<string, (...a: unknown[]) => unknown> };
    };
    const src = (f: unknown): string => String(f).replace(/\s+/g, ' ');
    const R = Replicator.prototype;
    const P = Replicator.Peer.prototype;
    // (1) The ONLY second-peer path: the hotswap step iterates `hotswaps.pick(peer)`.
    expect(src(R['_updateHotswap'])).toContain('for (const b of this.hotswaps.pick(peer))');
    // … and runs only from `updatePeer`, the method the failover ticker calls.
    expect(src(R['updatePeer'])).toContain('this._updateHotswap(peer)');
    expect(src(R['updateAll'])).not.toContain('_updateHotswap');
    // (2) A block request is pushed to `inflight`, THEN the queue's `add` runs, THEN it is sent:
    // `NoRaceQueue.add` sees the replacement request and cancels the stalled one before it goes.
    expect(src(P['_sendBlockRequest'])).toMatch(
      /b\.inflight\.push\(req\) this\.replicator\.hotswaps\.add\(b\) this\._send\(req\)/,
    );
    // (3) Every request is gated on `inflight >= getMaxInflight()` (the per-peer credit cap).
    for (const m of ['_updatePeer', '_updatePeerNonPrimary'])
      expect(src(R[m])).toContain('peer.inflight >= peer.getMaxInflight()');
    // … and a queued `get` is taken by one peer; a range block is skipped while one is in flight.
    expect(src(R['_updatePeer'])).toContain('b.queued === false || peer._requestBlock(b) === true');
    expect(src(P['_requestRangeBlock'])).toContain('if (b.inflight.length > 0)');
    // The one other path that sends a block request without that check is off by default.
    expect(src(P['_includeLastBlock'])).toContain(
      'if (this.replicator._alwaysLatestBlock === 0) return null',
    );
    // (4) `inflight` rises before the wire send; `dataProcessing` spans the verify; the download
    // event (where the payer counts the block as owed) runs after it drops, before `updatePeer`.
    expect(src(P['_send'])).toMatch(/this\.inflight\+\+ this\.replicator\._inflight\.add\(req\)/);
    expect(src(P['_handleData'])).toMatch(
      /this\.dataProcessing\+\+[\s\S]*this\.dataProcessing--[\s\S]*this\.replicator\._ondata\(this, req, data\)/,
    );
    expect(src(R['_ondata'])).toMatch(/this\._ondownload\([\s\S]*this\.updatePeer\(peer\)/);
    // (5) A cancel is counted per peer, and cancelled/answered requests carry priority 255.
    expect(src(P['_cancelRequest'])).toContain('incrementTx(this.stats.wireCancel');
    expect(src(P['_cancelRequest'])).toContain('req.priority = PRIORITY.CANCELLED');
    // (6) A new peer is announced (`peer-add`) in the same call that makes it schedulable, and a
    // removed one after its requests are cleared (their count still on `inflight`).
    expect(src(R['_addPeer'])).toMatch(
      /this\.peers\.push\(peer\)[\s\S]*this\._onpeerupdate\(true, peer\)/,
    );
    expect(src(R['_removePeer'])).toMatch(
      /this\._clearRequest\(peer, req\)[\s\S]*this\._onpeerupdate\(false, peer\)/,
    );
  });

  it('PRIORITY.CANCELLED is 255', async () => {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(require.resolve('hypercore/lib/replicator.js'), 'utf8');
    expect(text).toMatch(/CANCELLED: 255/);
  });
});

describe('OnePeerRouter', () => {
  it('F33: three full seeders racing for 48 blocks deliver each block ONCE (plain hypercore races them)', async () => {
    const N = 48;
    // Video-sized blocks: small ones are answered before a raced duplicate can leave the seeder.
    const SIZE = 65_536;
    // Before: plain hypercore. Its hotswap asks idle peers for blocks in flight elsewhere.
    const legacy = await world(N, 3, SIZE);
    await Promise.all(Array.from({ length: N }, (_, i) => legacy.viewer.get(i)));
    await sleep(200);
    // After: routed (no budget: this is about racing alone).
    const after = await world(N, 3, SIZE);
    const r = routed(after.viewer, { budget: unlimited });
    await Promise.all(Array.from({ length: N }, (_, i) => after.viewer.get(i)));
    await sleep(200);
    expect(after.viewer.replicator.stats.hotswaps).toBe(0);
    expect(r.stats()).toMatchObject({ failovers: 0, raced: 0 });
    expect(after.downloads).toHaveLength(N);
    expect([...perIndex(after.downloads).values()].every((c) => c === 1)).toBe(true);
    // What the seeders count is what the viewer received: nothing sent twice.
    expect(after.uploads.reduce((a, b) => a + b, 0)).toBe(N);
    // The same setup DOES race without the router (hypercore 11.35.3 races dozens of requests on
    // every run; how many duplicates get delivered depends on timing, 7–19 of 48 measured).
    expect(
      legacy.viewer.replicator.stats.hotswaps,
      'plain hypercore raced nothing',
    ).toBeGreaterThan(0);
    expect(legacy.uploads.reduce((a, b) => a + b, 0)).toBe(legacy.downloads.length);
  });

  it('issue #8: no peer ever holds more unpaid blocks than its budget, whatever hypercore picks', async () => {
    const N = 40;
    const windows = [1, 3, 6];
    const owed = new Map<string, number>();
    const w = await world(N, 3);
    const r = routed(w.viewer, {
      // Its credit: its window less what it delivered that is not "paid" yet.
      budget: (remote) => {
        const i = w.remotes.indexOf(remote);
        return i === -1 ? 0 : (windows[i] ?? 0) - (owed.get(remote) ?? 0);
      },
    });
    // "Pay" every block 15 ms after it lands; the seeder side counts sent − paid.
    const paid = w.remotes.map(() => 0);
    const worst = w.remotes.map(() => 0);
    w.viewer.on('download', (_i, _b, peer) => {
      const remote = toHex(peer.remotePublicKey);
      owed.set(remote, (owed.get(remote) ?? 0) + 1);
      setTimeout(() => {
        owed.set(remote, (owed.get(remote) ?? 1) - 1);
        const k = w.remotes.indexOf(remote);
        paid[k] = (paid[k] ?? 0) + 1;
        r.refresh();
      }, 15);
    });
    const sample = setInterval(() => {
      for (let k = 0; k < worst.length; k++)
        worst[k] = Math.max(worst[k] ?? 0, (w.uploads[k] ?? 0) - (paid[k] ?? 0));
    }, 1);
    try {
      await Promise.all(Array.from({ length: N }, (_, i) => w.viewer.get(i)));
    } finally {
      clearInterval(sample);
    }
    expect(w.downloads).toHaveLength(N);
    expect([...perIndex(w.downloads).values()].every((c) => c === 1)).toBe(true);
    for (let k = 0; k < windows.length; k++)
      expect(worst[k], `seeder ${String(k)} (window ${String(windows[k])})`).toBeLessThanOrEqual(
        windows[k] ?? 0,
      );
    // Every seeder took part (a budget of 1 is slow, not starved).
    for (const u of w.uploads) expect(u).toBeGreaterThan(0);
  });

  it('a stalled request moves to ONE other seeder after stallMs — never raced, the stalled one cancelled', async () => {
    const STALL = 400;
    let open = new Set<string>();
    const failovers: string[] = [];
    const w = await world(4, 3);
    const r = routed(w.viewer, {
      budget: (remote) => (open.has(remote) ? 4 : 0),
      stallMs: STALL,
      onFailover: (remote) => failovers.push(remote),
    });
    const [stalledRemote] = w.remotes;
    const stalledLink = w.links[0]!;
    // Only seeder 0 may be asked; it takes the request and never answers.
    stalledLink.hold();
    open = new Set([stalledRemote!]);
    r.refresh();
    const got = w.viewer.get(2);
    await until(() => w.uploads[0] === 1, 5000, 'seeder 0 to send block 2 into the void');
    // Everyone may be asked now — hypercore alone would race block 2 at once.
    open = new Set(w.remotes);
    r.refresh();
    await sleep(STALL / 4);
    expect(w.uploads[1]! + w.uploads[2]!, 'raced before stallMs').toBe(0);
    expect(r.used(stalledRemote!)).toBe(1); // the stalled request counts against seeder 0
    // After stallMs: moved to one other seeder, and the stalled request cancelled.
    expect(await got).not.toBeNull();
    expect(w.uploads[1]! + w.uploads[2]!).toBe(1);
    expect(failovers).toEqual([stalledRemote]);
    expect(r.stats().failovers).toBe(1);
    expect(w.downloads).toHaveLength(1);
    expect(w.downloads[0]!.from).not.toBe(stalledRemote);
    // Seeder 0 did send it: it counts it as ours for good, and so do we.
    expect(r.debt(stalledRemote!)).toBe(1);
    expect(r.used(stalledRemote!)).toBe(1);
    // Until it delivers again, a stalled seeder gets ONE request at a time (its budget would allow
    // three more): a withholding peer cannot take a fresh batch after every failover.
    expect(r.isStalled(stalledRemote!)).toBe(true);
    open = new Set([stalledRemote!]);
    r.refresh();
    const more = [w.viewer.get(0), w.viewer.get(3)];
    await until(() => w.uploads[0] === 2, 5000, 'one more request to seeder 0');
    await sleep(100);
    expect(w.uploads[0]).toBe(2);
    expect(r.inflight(stalledRemote!)).toBe(1);
    // It answers at last: its late block 2 is dropped (still one delivery of it), the new one
    // lands, and the limit lifts.
    stalledLink.release();
    await Promise.all(more);
    expect(r.isStalled(stalledRemote!)).toBe(false);
    expect(w.downloads.filter((d) => d.index === 2)).toHaveLength(1);
    expect(w.downloads).toHaveLength(3);
  });

  it('after a failover the replacement seeder vanishes too: the block goes to a third one, never stuck', async () => {
    const STALL = 300;
    let open = new Set<string>();
    const w = await world(4, 3);
    const r = routed(w.viewer, {
      budget: (remote) => (open.has(remote) ? 4 : 0),
      stallMs: STALL,
    });
    const [s0, s1, s2] = w.remotes as [string, string, string];
    w.links[0]!.hold();
    w.links[1]!.hold();
    open = new Set([s0]);
    r.refresh();
    const got = w.viewer.get(1);
    await until(() => w.uploads[0] === 1, 5000, 'seeder 0 to take block 1');
    open = new Set([s1]);
    r.refresh();
    await until(() => w.uploads[1] === 1, 5000, 'the failover to seeder 1');
    expect(r.stats().failovers).toBe(1);
    // Seeder 1 goes away with the replacement request in flight.
    open = new Set([s2]);
    w.links[1]!.destroy();
    r.refresh();
    expect(await within(got, 5000)).not.toBeNull();
    expect(w.downloads).toEqual([{ index: 1, from: s2 }]);
  });

  it('a seeder that disconnects mid-range: its blocks are re-requested from the others, each delivered once', async () => {
    const N = 48;
    const w = await world(N, 3);
    // Small budgets keep requests in flight at every seeder when the link drops.
    const r = routed(w.viewer, { budget: () => 3 });
    // Each block leaves its budget once it lands (the "PAY" is instant here).
    const all = Promise.all(Array.from({ length: N }, (_, i) => w.viewer.get(i)));
    await until(() => w.downloads.length >= N / 3, 10_000, 'a third of the blocks');
    const gone = w.remotes[1]!;
    w.links[1]!.destroy();
    await all;
    await sleep(200);
    expect(w.downloads).toHaveLength(N);
    expect([...perIndex(w.downloads).values()].every((c) => c === 1)).toBe(true);
    const fromGone = w.downloads.filter((d) => d.from === gone).length;
    // Whatever it sent that never arrived stays counted against it (it may be owed, never paid).
    expect(r.debt(gone)).toBeGreaterThanOrEqual(w.uploads[1]! - fromGone);
    // The survivors sent exactly what arrived from them.
    for (const k of [0, 2])
      expect(w.uploads[k]).toBe(w.downloads.filter((d) => d.from === w.remotes[k]).length);
  });

  it('refuses a core without the pinned internals, and a second router on a routed core (fail closed)', async () => {
    const bare = Object.assign(new EventEmitter(), { key: new Uint8Array(32), opened: true });
    const router = new OnePeerRouter({ budget: unlimited, logger: silentLogger });
    expect(() => router.attachCore(bare as unknown as RoutableCore)).toThrow(RoutingUnsupported);
    const closed = Object.assign(new EventEmitter(), { key: new Uint8Array(32), opened: false });
    expect(() => router.attachCore(closed as unknown as RoutableCore)).toThrow(/not open/);
    const w = await world(2, 1);
    const detach = router.attachCore(w.viewer);
    const other = new OnePeerRouter({ budget: unlimited, logger: silentLogger });
    expect(() => other.attachCore(w.viewer)).toThrow(/another router/);
    // The same router again is reference counted; the last detach restores hypercore.
    const again = router.attachCore(w.viewer);
    detach();
    expect(router.stats().cores).toBe(1);
    again();
    expect(router.stats().cores).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(w.viewer.peers[0], 'getMaxInflight')).toBe(false);
    expect(() => other.attachCore(w.viewer)).not.toThrow();
    other.close();
    router.close();
    expect(() => router.attachCore(w.viewer)).toThrow(RoutingUnsupported);
  });

  it('refuses a replicator missing ANY member it relies on', () => {
    const complete = (): Record<string, unknown> => {
      class Peer {
        getMaxInflight(): number {
          return 16;
        }
        getMaxHotswapInflight(): number {
          return 16;
        }
        _cancelRequest(): void {
          // no wire
        }
        _requestBlock(): boolean {
          return false;
        }
      }
      class Replicator {
        static Peer: unknown = Peer;
        hotswaps: Record<string, unknown> = { add: noop, remove: noop, pick: noop };
        peers: unknown[] = [];
        updateAll = noop;
        updatePeer = noop;
        _updateHotswap = noop;
      }
      return new Replicator() as unknown as Record<string, unknown>;
    };
    const noop = (): void => undefined;
    const coreWith = (replicator: unknown): RoutableCore =>
      Object.assign(new EventEmitter(), {
        key: new Uint8Array(32),
        opened: true,
        replicator,
      }) as unknown as RoutableCore;
    expect(() => routableReplicator(coreWith(complete()))).not.toThrow();
    for (const m of ['hotswaps', 'peers', 'updateAll', 'updatePeer', '_updateHotswap']) {
      const r = complete();
      r[m] = undefined;
      expect(() => routableReplicator(coreWith(r)), m).toThrow(RoutingUnsupported);
    }
    for (const m of ['add', 'remove', 'pick']) {
      const r = complete();
      (r['hotswaps'] as Record<string, unknown>)[m] = undefined;
      expect(() => routableReplicator(coreWith(r)), `hotswaps.${m}`).toThrow(RoutingUnsupported);
    }
    for (const m of [
      'getMaxInflight',
      'getMaxHotswapInflight',
      '_cancelRequest',
      '_requestBlock',
    ]) {
      const r = complete();
      const Peer = (r.constructor as unknown as { Peer: { prototype: Record<string, unknown> } })
        .Peer;
      const saved = Peer.prototype[m];
      Peer.prototype[m] = undefined;
      expect(() => routableReplicator(coreWith(r)), `Peer#${m}`).toThrow(RoutingUnsupported);
      Peer.prototype[m] = saved;
    }
  });

  it('a block found in flight at two peers without a failover is counted and logged (an unknown path)', async () => {
    const w = await world(2, 2);
    const r = routed(w.viewer, { budget: unlimited });
    const [p0, p1] = w.viewer.peers;
    const queue = (w.viewer as unknown as { replicator: { hotswaps: { add(b: unknown): void } } })
      .replicator.hotswaps;
    const now = Date.now();
    queue.add({
      index: 0,
      hotswap: null,
      inflight: [
        { peer: p0, timestamp: now, priority: 1 },
        { peer: p1, timestamp: now, priority: 1 },
      ],
    });
    expect(r.stats().raced).toBe(1);
    // A cancelled or answered request is not "in flight".
    queue.add({
      index: 1,
      hotswap: null,
      inflight: [
        { peer: p0, timestamp: now, priority: 255 },
        { peer: p1, timestamp: now, priority: 1 },
      ],
    });
    expect(r.stats().raced).toBe(1);
  });

  it('the cap: Infinity keeps hypercore’s own, a finite budget caps it, NaN / negative / a throw ask nothing', async () => {
    let budget: () => number = () => Number.POSITIVE_INFINITY;
    const w = await world(2, 1);
    const r = routed(w.viewer, { budget: () => budget() });
    const peer = w.viewer.peers[0]!;
    const base = (Object.getPrototypeOf(peer) as RawPeer).getMaxInflight.call(peer);
    expect(peer.getMaxInflight()).toBe(base);
    budget = () => 3;
    expect(peer.getMaxInflight()).toBe(peer.inflight + 3 - r.used(w.remotes[0]!));
    for (const bad of [Number.NaN, -1, 0, Number.NEGATIVE_INFINITY]) {
      budget = () => bad;
      expect(peer.getMaxInflight(), String(bad)).toBe(peer.inflight);
    }
    budget = () => {
      throw new Error('ledger bug');
    };
    expect(peer.getMaxInflight()).toBe(peer.inflight);
    // Nothing can be fetched while the budget is 0…
    budget = () => 0;
    const p = w.viewer.get(1);
    await sleep(150);
    expect(w.downloads).toHaveLength(0);
    // …and refresh() lets hypercore ask once it grows.
    budget = () => 1;
    r.refresh();
    expect(await p).not.toBeNull();
    expect(w.downloads).toHaveLength(1);
  });
});

import { EventEmitter } from 'node:events';

import type Hypercore from 'hypercore';
import { silentLogger } from '@sovit/seeder';
import { describe, expect, it } from 'vitest';

import { CreditPool } from '../playback/credit.js';
import type { GateClock } from '../playback/gate.js';
import {
  DEFAULT_BITRATE_KBPS,
  PACE_HEADROOM,
  PlaybackGate,
  SessionClosedError,
  bytesPerSecondOf,
  prefetchBlocksFor,
} from '../playback/gate.js';

const BS = 1000;

/** A hypercore stand-in: blocks become local when `deliver(i)` is called. */
class FakeCore extends EventEmitter {
  readonly key = new Uint8Array(32).fill(7);
  readonly opened = true;
  readonly local = new Set<number>();
  readonly gets: number[] = [];
  readonly downloads: { start: number; end: number }[] = [];
  closed = 0;
  private readonly waiting = new Map<number, (() => void)[]>();

  has(i: number): Promise<boolean> {
    return Promise.resolve(this.local.has(i));
  }
  ready(): Promise<void> {
    return Promise.resolve();
  }
  seek(bytes: number): Promise<[number, number]> {
    return Promise.resolve([Math.floor(bytes / BS), bytes % BS]);
  }
  get(i: number): Promise<Uint8Array> {
    this.gets.push(i);
    return this.when(i).then(() => new Uint8Array(BS).fill(i));
  }
  download(r: { start: number; end: number }): { done(): Promise<void>; destroy(): void } {
    this.downloads.push(r);
    return { done: () => this.when(r.start), destroy: () => undefined };
  }
  close(): Promise<void> {
    this.closed++;
    return Promise.resolve();
  }
  deliver(i: number): void {
    if (this.local.has(i)) return;
    this.local.add(i);
    this.emit('download', i, BS, { remotePublicKey: new Uint8Array(32) });
    for (const cb of this.waiting.get(i) ?? []) cb();
    this.waiting.delete(i);
  }
  private when(i: number): Promise<void> {
    if (this.local.has(i)) return Promise.resolve();
    return new Promise((r) => {
      const list = this.waiting.get(i) ?? [];
      list.push(r);
      this.waiting.set(i, list);
    });
  }
}

class FakeClock implements GateClock {
  t = 0;
  private timers: { at: number; cb: () => void; id: number }[] = [];
  private seq = 0;
  now(): number {
    return this.t;
  }
  setTimeout(cb: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.push({ at: this.t + ms, cb, id });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== h);
  }
  advance(ms: number): void {
    this.t += ms;
    const due = this.timers.filter((x) => x.at <= this.t);
    this.timers = this.timers.filter((x) => x.at > this.t);
    for (const d of due) d.cb();
  }
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function rig(
  o: { blocks?: number; prefetchSeconds?: number; credit?: number; bytesPerSec?: number } = {},
) {
  const core = new FakeCore();
  const clock = new FakeClock();
  const credit = new CreditPool(o.credit ?? 4);
  const gate = new PlaybackGate({
    core: core as unknown as Hypercore,
    blob: {
      blockOffset: 0,
      blockLength: o.blocks ?? 10,
      byteOffset: 0,
      byteLength: (o.blocks ?? 10) * BS,
    },
    blockSize: BS,
    bytesPerSec: o.bytesPerSec ?? BS, // one block per second of playback
    prefetchSeconds: o.prefetchSeconds ?? 2,
    credit,
    logger: silentLogger,
    clock,
  });
  return { core, clock, credit, gate };
}

describe('prefetch arithmetic (design §1)', () => {
  it('prefetchBlocks = ceil(seconds × rate / blockSize), at least 1', () => {
    expect(prefetchBlocksFor(30, (2500 * 1000) / 8, 65_536)).toBe(144);
    expect(prefetchBlocksFor(8, 32_000, 65_536)).toBe(4);
    expect(prefetchBlocksFor(0, 32_000, 65_536)).toBe(1);
    expect(prefetchBlocksFor(Number.NaN, 32_000, 65_536)).toBe(1);
  });
  it('rate: bitrate, else size / duration, else the default', () => {
    expect(bytesPerSecondOf({ bitrateKbps: 800, size: 1 })).toBe(100_000);
    expect(bytesPerSecondOf({ size: 1_000_000, durationSec: 10 })).toBe(100_000);
    expect(bytesPerSecondOf({ size: 1_000_000 })).toBe((DEFAULT_BITRATE_KBPS * 1000) / 8);
  });
});

describe('PlaybackGate', () => {
  it('hands the blob server an adapter WITHOUT `.core` (no ByteStream bulk prefetch) that never closes the core', async () => {
    const { core, gate } = rig();
    const a = gate.adapter();
    expect('core' in a).toBe(false);
    expect(a.opened).toBe(true);
    await a.ready();
    expect(await a.seek(2500)).toEqual([2, 500]);
    await a.close();
    expect(core.closed).toBe(0);
  });

  it('only the window travels: get(0) + lookahead up to anchor + prefetchBlocks', async () => {
    const { core, gate } = rig({ prefetchSeconds: 3 });
    expect(gate.prefetchBlocks).toBe(3);
    const a = gate.adapter();
    const p0 = a.get(0);
    await tick();
    expect(core.gets).toEqual([0]);
    expect(core.downloads).toEqual([
      { start: 1, end: 2 },
      { start: 2, end: 3 },
    ]);
    core.deliver(0);
    expect((await p0)?.[0]).toBe(0);
    expect(gate.requestedTotal).toBe(3);
  });

  it('a reader past the window waits for the paced allowance (playing time × rate × headroom)', async () => {
    const { core, clock, credit, gate } = rig({ prefetchSeconds: 2, credit: 10 });
    const a = gate.adapter();
    const p0 = a.get(0);
    await tick();
    core.deliver(0);
    core.deliver(1);
    await p0;
    await a.get(1);
    let got2 = false;
    const p2 = a.get(2).then(() => (got2 = true));
    await tick();
    expect(core.gets).not.toContain(2);
    // One more block is allowed after blockSize / (rate × headroom) seconds of playing.
    clock.advance(Math.ceil(1000 / PACE_HEADROOM) - 5);
    await tick();
    expect(core.gets).not.toContain(2);
    clock.advance(10);
    await tick();
    expect(core.gets).toContain(2);
    core.deliver(2);
    await p2;
    expect(got2).toBe(true);
    expect(credit.size).toBe(3); // nothing settled them: the payer does that
  });

  it('local blocks cost nothing: no credit, no request', async () => {
    const { core, credit, gate } = rig();
    core.deliver(0);
    core.deliver(1);
    const a = gate.adapter();
    await a.get(0);
    expect(credit.holds(gate.keyHex, 0)).toBe(false);
    expect(gate.requestedTotal).toBe(0);
  });

  it('never requests past the credit window; a settle lets the player continue', async () => {
    const { core, credit, gate } = rig({ prefetchSeconds: 10, credit: 1 });
    const a = gate.adapter();
    const p0 = a.get(0);
    await tick();
    expect(core.downloads).toEqual([]); // the only unit went to the player
    core.deliver(0);
    await p0;
    const p1 = a.get(1);
    await tick();
    expect(core.gets).toEqual([0]);
    credit.settle(gate.keyHex, 0); // block 0's PAY was acknowledged
    await tick();
    expect(core.gets).toEqual([0, 1]);
    core.deliver(1);
    await p1;
  });

  it('pause: get() waits even for local blocks and nothing new is requested; resume continues', async () => {
    const { core, gate } = rig({ prefetchSeconds: 1 });
    core.deliver(0);
    const a = gate.adapter();
    await a.get(0);
    gate.pause();
    gate.setPrefetchSeconds(600);
    core.deliver(1);
    let served = false;
    const p1 = a.get(1).then(() => (served = true));
    await tick();
    expect(served).toBe(false);
    expect(core.downloads).toEqual([]);
    expect(core.gets).toEqual([0]);
    gate.resume();
    await p1;
    expect(served).toBe(true);
    await tick();
    expect(core.downloads.length).toBeGreaterThan(0);
  });

  it('close: waiting reads fail session-closed, credit waits are cancelled, no new adapters', async () => {
    const { credit, gate } = rig({ credit: 1 });
    credit.tryAcquire('ff'.repeat(32), 0); // the pool is full
    const a = gate.adapter();
    const p0 = a.get(0);
    await tick();
    expect(credit.waiting).toBe(1);
    gate.close();
    await expect(p0).rejects.toBeInstanceOf(SessionClosedError);
    expect(credit.waiting).toBe(0);
    expect(() => gate.adapter()).toThrow(SessionClosedError);
    gate.close(); // idempotent
  });

  it('refuses blocks outside the session blob', async () => {
    const { gate } = rig({ blocks: 4 });
    await expect(gate.adapter().get(4)).rejects.toThrow(RangeError);
  });

  it('idle() resolves once everything requested has landed', async () => {
    const { core, gate } = rig({ prefetchSeconds: 3 });
    const a = gate.adapter();
    const p0 = a.get(0);
    await tick();
    let idle = false;
    const done = gate.idle().then(() => (idle = true));
    core.deliver(0);
    core.deliver(1);
    await tick();
    expect(idle).toBe(false);
    expect(gate.pendingRequests).toBe(1);
    core.deliver(2);
    await done;
    await p0;
    expect(gate.pendingRequests).toBe(0);
  });
});

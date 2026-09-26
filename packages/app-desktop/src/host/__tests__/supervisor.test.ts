/**
 * Worker supervision over the real framing + guards, with a FakeWorker behind the same
 * `WorkerProcess` surface bare-sidecar provides. Timers (back-off, start and call timeouts)
 * run on a manual clock; message delivery is the fake's own asynchronous pipe.
 */
import { describe, expect, it } from 'vitest';

import type { IpcError } from '../../ipc/errors.js';
import { encodeFrame } from '../../ipc/framing.js';
import type { SessionId } from '../../ipc/protocol.js';
import type { PublishDraft, WorkerEvent, WorkerInit } from '../../ipc/worker-protocol.js';
import { WORKER_V } from '../../ipc/worker-protocol.js';
import { memoryLogger } from '../log.js';
import type { RestartPolicy, Timers, WorkerState } from '../worker/supervisor.js';
import { WorkerRuntimeError, WorkerSupervisor } from '../worker/supervisor.js';
import type { FakeWorkerOptions } from './support/fake-worker.js';
import { FakeWorker, fakeSpawner } from './support/fake-worker.js';
import { eventually } from './support/rig.js';

class ManualClock implements Timers {
  now = 0;
  private seq = 0;
  private readonly due = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.due.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.due.delete(h as number);
  }
  /** Runs every timer due within `ms`, in order. */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.due.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.due.delete(next[0]);
      this.now = next[1].at;
      next[1].fn();
    }
    this.now = end;
  }
  pending(): number {
    return this.due.size;
  }
}

const SID = '0123456789abcdef0123456789abcdef' as SessionId;
const INIT: WorkerInit = {
  v: WORKER_V,
  storage: '/tmp/nf-worker',
  seeding: { enabled: false, diskCapBytes: 1024 },
  prefetchSeconds: 30,
};
const DRAFT: PublishDraft = {
  uploadId: 'f'.repeat(32) as PublishDraft['uploadId'],
  meta: {
    title: 't',
    description: '',
    tags: [],
    kind: 21,
    mints: ['https://m.example' as never],
    satsPerBlock: 1 as never,
    split: { seeder: 50, creator: 50 },
  },
  durationSec: 6,
  blockSize: 65536,
  renditions: [
    {
      label: '360p',
      mime: 'video/mp4',
      sha256: 'd'.repeat(64) as never,
      size: 100,
      hyper: {
        core: 'b'.repeat(64) as never,
        blob: { byteOffset: 0, blockOffset: 0, blockLength: 1, byteLength: 100 },
      },
      hyperUrl: `hyper://${'b'.repeat(64)}/0-1`,
      fallbacks: [],
    },
  ],
  thumbnail: { kind: 'custom', sha256: 'e'.repeat(64) as never, type: 'image/jpeg' },
  codec: 'h264',
};
const POLICY: RestartPolicy = { baseMs: 100, maxMs: 1000, maxRestarts: 3, windowMs: 60_000 };

function setup(
  opts: {
    worker?: FakeWorkerOptions;
    publish?: (d: PublishDraft) => Promise<never>;
    callTimeoutMs?: number;
  } = {},
) {
  const clock = new ManualClock();
  const spawner = fakeSpawner(() => new FakeWorker(opts.worker));
  const events: WorkerEvent[] = [];
  const states: WorkerState[] = [];
  const log = memoryLogger('debug');
  const sup = new WorkerSupervisor({
    spawn: spawner.spawn,
    entry: '/w.js',
    args: ['--x'],
    init: () => INIT,
    log,
    onEvent: (e) => events.push(e),
    onState: (s) => states.push(s),
    handlers: {
      'studio.publish':
        opts.publish ?? (() => Promise.reject(new Error('no-signer: no signer connected'))),
    },
    restart: POLICY,
    timers: clock,
    now: () => clock.now,
    startTimeoutMs: 5000,
    ...(opts.callTimeoutMs === undefined
      ? {}
      : { callTimeoutMs: { 'play.pause': opts.callTimeoutMs } }),
    stdioLinesPerSecond: 3,
  });
  const ready = (): Promise<unknown> => eventually(() => sup.state === 'ready', 'ready');
  return { sup, clock, spawner, events, states, log, ready };
}

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return (e as IpcError).code;
  }
};

describe('WorkerSupervisor', () => {
  it('spawns, sends init, becomes ready on init-ack + ready, then serves requests', async () => {
    const { sup, spawner, states, ready } = setup();
    expect(await codeOf(sup.request('play.pause', { sid: SID }))).toBe('backend-down'); // idle
    sup.start();
    expect(sup.state).toBe('starting');
    // A call made while starting is queued, then flushed once ready.
    const queued = sup.request('seeder.status', {});
    await ready();
    expect(await queued).toMatchObject({ enabled: false });
    expect(spawner.last().received.map((r) => r.m)).toEqual(['init', 'seeder.status']);
    expect(spawner.last().received[0]!.a).toEqual(INIT);
    expect(
      await sup.request('seeder.melt', { mint: 'https://m.example' as never, bolt11: 'lnbc1' }),
    ).toEqual({
      paid: true,
    });
    expect(sup.readyPort).toBe(45_000);
    expect(states).toEqual(['starting', 'ready']);
    sup.stop();
  });

  it('a worker error arrives as a coded error; bad args never reach the worker', async () => {
    const { sup, spawner, ready } = setup({
      worker: {
        handlers: {
          'play.open': () => {
            throw new Error('no-seeders: nobody is seeding this video right now');
          },
        },
      },
    });
    sup.start();
    await ready();
    const err = await sup
      .request('play.open', {
        sid: SID,
        videoId: 'a'.repeat(64) as never,
        rendition: {
          label: '720p',
          hyper: {
            core: 'b'.repeat(64) as never,
            blob: { byteOffset: 0, blockOffset: 0, blockLength: 1, byteLength: 1 },
          },
          size: 1,
        },
        policy: {
          satsPerBlock: 1 as never,
          blockSize: 65536,
          mints: ['https://m.example' as never],
          split: { seeder: 50, creator: 50 },
          creatorP2pk: `02${'c'.repeat(64)}` as never,
        },
        prefetchSeconds: 30,
      })
      .catch((e: unknown) => e as IpcError);
    expect(err).toMatchObject({ code: 'no-seeders' });
    expect((err as IpcError).message).toMatch(/^no-seeders: /);
    expect(await codeOf(sup.request('play.pause', { sid: 'nope' as SessionId }))).toBe(
      'invalid-argument',
    );
    expect(spawner.last().calls('play.pause')).toEqual([]);
    sup.stop();
  });

  it('a malformed result is refused (internal), an invalid event is dropped and logged', async () => {
    const { sup, spawner, events, log, ready } = setup({
      worker: { handlers: { 'seeder.status': () => ({ enabled: 'yes' }) as never } },
    });
    sup.start();
    await ready();
    expect(await codeOf(sup.request('seeder.status', {}))).toBe('internal');
    const w = spawner.last();
    w.event({ e: 'spend', sid: SID, mint: 'http://not-https', amount: 1, total: 1, ratePerMin: 1 });
    w.event({ e: 'peers', sid: SID, peers: [] });
    await eventually(() => events.length === 1, 'the valid event');
    expect(events[0]).toMatchObject({ e: 'peers' });
    expect(
      log.lines.some((l) => l.msg === 'dropped an invalid message from the media worker'),
    ).toBe(true);
    sup.stop();
  });

  it('answers the worker’s studio.publish request through the handler, errors as WireErrors', async () => {
    const drafts: PublishDraft[] = [];
    const { sup, spawner, ready } = setup({
      publish: (d) => {
        drafts.push(d);
        return Promise.reject(new Error('no-signer: no signer connected'));
      },
    });
    sup.start();
    await ready();
    await expect(spawner.last().request('studio.publish', DRAFT)).rejects.toMatchObject({
      code: 'no-signer',
    });
    expect(drafts).toEqual([DRAFT]);
    // Invalid args are refused by the guard (answered, never handled).
    const bad = { uploadId: 'f'.repeat(32) } as unknown as PublishDraft;
    await expect(spawner.last().request('studio.publish', bad)).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(drafts).toHaveLength(1);
    sup.stop();
  });

  it('crash → pending calls fail backend-down → back-off restart → ready again', async () => {
    const { sup, spawner, clock, states, ready } = setup({
      worker: { handlers: { 'play.pause': () => new Promise(() => undefined) } },
    });
    sup.start();
    await ready();
    const hanging = sup.request('play.pause', { sid: SID });
    await eventually(() => spawner.last().calls('play.pause').length === 1, 'the call to land');
    spawner.last().crash(9);
    expect(await codeOf(hanging)).toBe('backend-down');
    expect(sup.state).toBe('down');
    // While down, calls fail fast.
    expect(await codeOf(sup.request('seeder.status', {}))).toBe('backend-down');
    expect(spawner.spawned).toHaveLength(1);
    clock.advance(99);
    expect(spawner.spawned).toHaveLength(1);
    clock.advance(1); // baseMs
    expect(spawner.spawned).toHaveLength(2);
    await ready();
    expect(states).toEqual(['starting', 'ready', 'down', 'starting', 'ready']);
    expect(spawner.spawned[0]!.destroyed).toBe(true);
    sup.stop();
  });

  it('backs off exponentially and gives up (failed) after maxRestarts inside the window', async () => {
    const { sup, spawner, clock, states } = setup({ worker: { silent: true } });
    sup.start();
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      spawner.last().crash(1);
      await eventually(() => sup.state === 'down', `down #${String(i)}`);
      const before = spawner.spawned.length;
      let waited = 0;
      while (spawner.spawned.length === before) {
        clock.advance(10);
        waited += 10;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([100, 200, 400]);
    spawner.last().crash(1);
    await eventually(() => sup.state === 'failed', 'failed');
    clock.advance(60_000);
    expect(spawner.spawned).toHaveLength(4);
    expect(await codeOf(sup.request('seeder.status', {}))).toBe('backend-down');
    expect(states.at(-1)).toBe('failed');
  });

  it('a worker that never becomes ready is killed at the start timeout; queued calls fail', async () => {
    const { sup, spawner, clock } = setup({ worker: { silent: true } });
    sup.start();
    const queued = sup.request('seeder.status', {});
    await eventually(() => spawner.last().received.length === 1, 'init sent');
    clock.advance(5000);
    expect(await codeOf(queued)).toBe('backend-down');
    expect(spawner.last().destroyed).toBe(true);
    expect(sup.state).toBe('down');
    sup.stop();
  });

  it('a call the worker never answers times out as backend-down', async () => {
    const { sup, clock, ready } = setup({
      callTimeoutMs: 1000,
      worker: { handlers: { 'play.pause': () => new Promise(() => undefined) } },
    });
    sup.start();
    await ready();
    const p = sup.request('play.pause', { sid: SID });
    clock.advance(1000);
    expect(await codeOf(p)).toBe('backend-down');
    sup.stop();
  });

  it('a corrupt frame kills the worker (no resync) and restarts it', async () => {
    const { sup, spawner, clock, ready } = setup();
    sup.start();
    await ready();
    spawner.last().sendBytes(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0x7b));
    await eventually(() => sup.state === 'down', 'down after a corrupt frame');
    expect(spawner.spawned[0]!.destroyed).toBe(true);
    clock.advance(100);
    await ready();
    sup.stop();
  });

  it('drains stdout/stderr through the redacting logger, rate-limited', async () => {
    const { sup, spawner, log, clock, ready } = setup();
    sup.start();
    await ready();
    const w = spawner.last();
    expect(w.stdout.resumed && w.stderr.resumed).toBe(true);
    const secret = 'f'.repeat(64);
    w.stderr.emit('data', Buffer.from(`boom at /home/alice/x.js key ${secret}\npartial`));
    w.stderr.emit('data', Buffer.from(' line\n'));
    for (let i = 0; i < 10; i++) w.stdout.emit('data', Buffer.from(`line ${String(i)}\n`));
    const out = log.lines.filter((l) => l.msg === 'worker stderr' || l.msg === 'worker stdout');
    // 3 lines per second PER STREAM: both stderr lines, the first 3 stdout lines.
    expect(out.map((l) => l.msg)).toEqual([
      'worker stderr',
      'worker stderr',
      'worker stdout',
      'worker stdout',
      'worker stdout',
    ]);
    expect(out[0]).toMatchObject({ level: 'warn', line: 'boom at <path> key <hex>' });
    expect(out[1]).toMatchObject({ line: 'partial line' });
    expect(out[2]).toMatchObject({ level: 'debug', line: 'line 0' });
    expect(JSON.stringify(log.lines)).not.toContain(secret);
    clock.advance(1000);
    w.stdout.emit('data', Buffer.from('after\n'));
    expect(
      log.lines.some(
        (l) =>
          l.msg === 'worker output lines dropped' && l['stream'] === 'stdout' && l['dropped'] === 7,
      ),
    ).toBe(true);
    // 64 KiB+ of output without newlines never blocks or grows unbounded.
    w.stdout.emit('data', new Uint8Array(200_000).fill(0x61));
    sup.stop();
  });

  it('worker log events are re-redacted and logged at their level', async () => {
    const { sup, spawner, log, ready } = setup();
    sup.start();
    await ready();
    spawner
      .last()
      .event({ e: 'log', level: 'error', msg: `peer ${'a'.repeat(64)} at 203.0.113.5` });
    await eventually(() => log.lines.find((l) => l.msg === 'worker log'), 'worker log line');
    expect(log.lines.find((l) => l.msg === 'worker log')).toMatchObject({
      level: 'error',
      line: 'peer <hex> at <ip>',
    });
    sup.stop();
  });

  it('an init that fails the guard (a dev fence) is a configuration error: failed, no crash loop', () => {
    const spawner = fakeSpawner();
    const clock = new ManualClock();
    const sup = new WorkerSupervisor({
      spawn: spawner.spawn,
      entry: '/w.js',
      init: () => ({
        ...INIT,
        dev: { mocks: false, fixtures: false, bootstrap: [{ host: '127.0.0.1', port: 5 }] },
      }),
      log: memoryLogger(),
      onEvent: () => undefined,
      handlers: { 'studio.publish': () => Promise.reject(new Error('no-signer: x')) },
      restart: POLICY,
      timers: clock,
      now: () => clock.now,
    });
    sup.start();
    expect(sup.state).toBe('failed');
    clock.advance(60_000);
    expect(spawner.spawned).toHaveLength(1);
    expect(spawner.spawned[0]!.received).toEqual([]);
    expect(spawner.spawned[0]!.destroyed).toBe(true);
  });

  it('stop() fails everything outstanding and never restarts', async () => {
    const { sup, spawner, clock, ready } = setup({
      worker: { handlers: { 'play.pause': () => new Promise(() => undefined) } },
    });
    sup.start();
    await ready();
    const p = sup.request('play.pause', { sid: SID });
    sup.stop();
    expect(await codeOf(p)).toBe('backend-down');
    clock.advance(100_000);
    expect(spawner.spawned).toHaveLength(1);
    expect(sup.state).toBe('stopped');
  });

  it('ignores anything a replaced child still says', async () => {
    const { sup, spawner, clock, events, ready } = setup();
    sup.start();
    await ready();
    const old = spawner.last();
    old.crash(1);
    await eventually(() => sup.state === 'down', 'down');
    clock.advance(100);
    await ready();
    old.emit('data', encodeFrame({ op: 'ev', e: 'peers', sid: SID, peers: [] }));
    expect(events).toEqual([]);
    sup.stop();
  });

  it('ADR 0013: restart(between) stops the worker, runs `between` with none alive, then starts a fresh one', async () => {
    const { sup, spawner, states, ready } = setup({
      worker: { handlers: { 'play.pause': () => new Promise(() => undefined) } },
    });
    sup.start();
    await ready();
    const hanging = sup.request('play.pause', { sid: SID });
    await eventually(() => spawner.last().calls('play.pause').length === 1, 'the call to land');
    let during: { state: string; alive: boolean } | undefined;
    await sup.restart(() => {
      during = { state: sup.state, alive: !spawner.spawned[0]!.destroyed };
      return Promise.resolve();
    });
    expect(during).toEqual({ state: 'down', alive: false });
    expect(await codeOf(hanging)).toBe('backend-down');
    expect(spawner.spawned).toHaveLength(2);
    await ready();
    expect(spawner.last().received[0]?.m).toBe('init');
    expect(states).toEqual(['starting', 'ready', 'down', 'starting', 'ready']);
    sup.stop();
  });

  it('ADR 0013: deliberate restarts never exhaust the crash budget, and revive a failed worker', async () => {
    const { sup, spawner, clock } = setup({ worker: { silent: true } });
    sup.start();
    for (let i = 0; i < 6; i++) await sup.restart(() => Promise.resolve());
    expect(sup.state).toBe('starting');
    expect(spawner.spawned).toHaveLength(7);
    // Now crash it into `failed`…
    for (let i = 0; i < 4; i++) {
      spawner.last().crash(1);
      await eventually(() => sup.state === 'down' || sup.state === 'failed', `down #${String(i)}`);
      clock.advance(10_000);
    }
    await eventually(() => sup.state === 'failed', 'failed');
    // …and a new signer is a reason to try again.
    await sup.restart(() => Promise.resolve());
    expect(sup.state).toBe('starting');
    sup.stop();
  });

  it('ADR 0013: restart on a stopped (or never started) supervisor only runs `between`', async () => {
    const { sup, spawner } = setup();
    let ran = 0;
    await sup.restart(() => {
      ran++;
      return Promise.resolve();
    });
    expect(spawner.spawned).toHaveLength(0);
    sup.start();
    sup.stop();
    await sup.restart(() => {
      ran++;
      return Promise.resolve();
    });
    expect(ran).toBe(2);
    expect(spawner.spawned).toHaveLength(1);
    expect(sup.state).toBe('stopped');
  });

  it('ADR 0013: a failing `between` still restarts the worker, then rethrows', async () => {
    const { sup, spawner, ready } = setup();
    sup.start();
    await ready();
    await expect(sup.restart(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(spawner.spawned).toHaveLength(2);
    await ready();
    sup.stop();
  });

  it('ADR 0013: handlers given as a function are read per request', async () => {
    let table: 'a' | 'b' = 'a';
    const clock = new ManualClock();
    const spawner = fakeSpawner(() => new FakeWorker());
    const sup = new WorkerSupervisor({
      spawn: spawner.spawn,
      entry: '/w.js',
      init: () => INIT,
      log: memoryLogger('debug'),
      onEvent: () => undefined,
      handlers: () => ({
        'studio.publish': () =>
          Promise.reject(new Error(table === 'a' ? 'no-signer: a' : 'relay-down: b')),
      }),
      timers: clock,
      now: () => clock.now,
    });
    sup.start();
    await eventually(() => sup.state === 'ready', 'ready');
    await expect(spawner.last().request('studio.publish', DRAFT)).rejects.toMatchObject({
      code: 'no-signer',
    });
    table = 'b';
    await expect(spawner.last().request('studio.publish', DRAFT)).rejects.toMatchObject({
      code: 'relay-down',
    });
    sup.stop();
  });
  it('issue #6: a spawn refused as a WorkerRuntimeError logs its reason; any other error text is dropped', () => {
    const run = (err: Error): ReturnType<typeof memoryLogger> => {
      const clock = new ManualClock();
      const log = memoryLogger('debug');
      const sup = new WorkerSupervisor({
        spawn: () => {
          throw err;
        },
        entry: '/w.js',
        init: () => INIT,
        log,
        onEvent: () => undefined,
        handlers: { 'studio.publish': () => Promise.reject(new Error('no-signer: none')) },
        restart: POLICY,
        timers: clock,
        now: () => clock.now,
      });
      sup.start();
      sup.stop();
      return log;
    };
    // What loadSidecar throws on a read-only install whose runtime is not executable.
    const refused = run(
      new WorkerRuntimeError('the bundled Bare runtime is not executable; reinstall the app'),
    );
    expect(refused.lines.find((l) => l.msg === 'could not spawn the media worker')).toMatchObject({
      level: 'error',
      error: 'WorkerRuntimeError',
      reason: 'the bundled Bare runtime is not executable; reinstall the app',
    });
    // Anything else (an fs error names paths) keeps the generic line only.
    const other = run(new Error('EACCES: permission denied, open /home/alice/secret/bare'));
    const line = other.lines.find((l) => l.msg === 'could not spawn the media worker');
    expect(line).toBeDefined();
    expect(line).not.toHaveProperty('reason');
    expect(line).not.toHaveProperty('error');
    expect(JSON.stringify(other.lines)).not.toMatch(/alice|EACCES/);
  });
});

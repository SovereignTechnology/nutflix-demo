/**
 * The worker's side of the wire (`WorkerRpc`): dispatch, error envelopes, `ready` after
 * `init`, result/event validation, worker → host requests, the corrupt-stream rule — and a
 * fast-check fuzz of everything a host (or an attacker on the pipe) can send: `push()` never
 * throws, junk never reaches the handler, and every byte the worker writes back is a valid
 * `WorkerToHost` frame.
 */
import * as fc from 'fast-check';
import { mocks } from '@sovit/core';
import { describe, expect, it, vi } from 'vitest';

import { WORKER_HOST_REQUEST_TIMEOUT_MS } from '../../ipc/deadlines.js';
import { IpcError } from '../../ipc/errors.js';
import { FrameDecoder, encodeFrame } from '../../ipc/framing.js';
import type { Guard } from '../../ipc/protocol.js';
import { isHostToWorker, isWorkerToHost, validateWorkerArgs } from '../../ipc/worker-guards.js';
import type {
  PublishDraft,
  WorkerEvent,
  WorkerMethod,
  WorkerToHost,
} from '../../ipc/worker-protocol.js';
import type { WorkerRequest } from '../host.js';
import { WorkerRpc } from '../rpc.js';

const SID = '0123456789abcdef0123456789abcdef';
const R0 = mocks.VIDEOS[0]!.renditions[0]!;
const DRAFT: PublishDraft = {
  uploadId: 'fedcba9876543210fedcba9876543210' as PublishDraft['uploadId'],
  meta: {
    title: 'My video',
    description: '',
    tags: ['space'],
    kind: 21,
    mints: [mocks.MINTS.a],
    satsPerBlock: mocks.sats(2),
    split: { seeder: 50, creator: 50 },
  },
  durationSec: 6,
  blockSize: 65_536,
  renditions: [
    {
      label: R0.label,
      mime: R0.mime,
      sha256: R0.sha256,
      size: R0.size,
      hyper: R0.hyper,
      hyperUrl: R0.hyperUrl,
      fallbacks: [],
    },
  ],
  thumbnail: { kind: 'candidate', path: '/tmp/thumb-0.jpg', sha256: R0.sha256 },
  codec: 'h264',
};
const METHODS = Object.keys(validateWorkerArgs) as WorkerMethod[];
const INIT = {
  v: 1,
  storage: '/tmp/w',
  seeding: { enabled: false, diskCapBytes: 1 },
  prefetchSeconds: 30,
};

interface Rig {
  readonly rpc: WorkerRpc;
  readonly out: WorkerToHost[];
  readonly bad: unknown[];
  readonly calls: WorkerRequest[];
  fatal: number;
  send(msg: object): void;
  settle(): Promise<void>;
}

function rig(
  handle: (r: WorkerRequest) => Promise<unknown> = () => Promise.resolve(undefined),
  opts: { maxInflight?: number; requestTimeoutMs?: number } = {},
): Rig {
  const out: WorkerToHost[] = [];
  const bad: unknown[] = [];
  const calls: WorkerRequest[] = [];
  const dec = new FrameDecoder((m) => {
    if (isWorkerToHost(m)) out.push(m);
    else bad.push(m);
  });
  const r: Rig = {
    rpc: new WorkerRpc({
      write: (b) => {
        dec.push(b);
      },
      handler: {
        handle: (req) => {
          calls.push(req);
          return handle(req);
        },
        readyEvent: (): WorkerEvent => ({ op: 'ev', e: 'ready', v: 1, port: 4242 }),
      },
      onFatal: () => {
        r.fatal++;
      },
      ...opts,
    }),
    out,
    bad,
    calls,
    fatal: 0,
    send: (msg) => {
      r.rpc.push(encodeFrame(msg));
    },
    settle: async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
  };
  return r;
}

describe('WorkerRpc', () => {
  // Lane P2-owed-viewer: `play.close` now answers `{ unpaid }` (the session's unpaid tail), so the
  // void-result case uses `play.pause`, which still answers nothing; play.close's result is below.
  it('dispatches a valid request and answers; a void result has no `r`', async () => {
    const r = rig();
    r.send({ op: 'req', id: 7, m: 'play.pause', a: { sid: SID } });
    await r.settle();
    expect(r.calls).toEqual([{ op: 'req', id: 7, m: 'play.pause', a: { sid: SID } }]);
    expect(r.out).toEqual([{ op: 'res', id: 7, ok: true }]);
  });

  it('play.close answers the unpaid tail; a result outside its shape is an internal error', async () => {
    const good = rig(() => Promise.resolve({ unpaid: 3 }));
    good.send({ op: 'req', id: 8, m: 'play.close', a: { sid: SID } });
    await good.settle();
    expect(good.out).toEqual([{ op: 'res', id: 8, ok: true, r: { unpaid: 3 } }]);
    const bad = rig(() => Promise.resolve(undefined));
    bad.send({ op: 'req', id: 9, m: 'play.close', a: { sid: SID } });
    await bad.settle();
    expect(bad.out).toMatchObject([{ op: 'res', id: 9, ok: false, e: { code: 'internal' } }]);
  });

  it('`ready` follows a successful `init` response, never precedes it', async () => {
    const r = rig();
    r.send({ op: 'req', id: 1, m: 'init', a: INIT });
    await r.settle();
    expect(r.out).toEqual([
      { op: 'res', id: 1, ok: true },
      { op: 'ev', e: 'ready', v: 1, port: 4242 },
    ]);
  });

  it('coded failures keep their code; anything else is a constant `internal`', async () => {
    const r = rig((req) =>
      req.m === 'play.pause'
        ? Promise.reject(new IpcError('session-closed', 'session-closed: no such session'))
        : Promise.reject(new Error('boom /home/u/secret/path')),
    );
    r.send({ op: 'req', id: 1, m: 'play.pause', a: { sid: SID } });
    r.send({ op: 'req', id: 2, m: 'play.resume', a: { sid: SID } });
    await r.settle();
    expect(r.out).toEqual([
      {
        op: 'res',
        id: 1,
        ok: false,
        e: { code: 'session-closed', message: 'session-closed: no such session' },
      },
      { op: 'res', id: 2, ok: false, e: { code: 'internal', message: 'internal: internal error' } },
    ]);
  });

  it('a result that would fail the host guard is replaced by `internal`', async () => {
    const r = rig(() => Promise.resolve({ not: 'a status' }));
    r.send({ op: 'req', id: 3, m: 'seeder.status', a: {} });
    await r.settle();
    expect(r.out).toEqual([
      { op: 'res', id: 3, ok: false, e: { code: 'internal', message: 'internal: internal error' } },
    ]);
  });

  it('junk is refused without reaching the handler', async () => {
    const r = rig();
    r.send({ op: 'req', id: 9, m: 'play.open', a: { sid: 'nope' } });
    r.send({ op: 'req', id: 10, m: 'toString', a: {} });
    r.send({ op: 'req', m: 'play.close', a: { sid: SID } }); // no id: nothing to answer
    r.send({ hello: 'world' });
    await r.settle();
    expect(r.calls).toEqual([]);
    expect(r.out.map((m) => (m.op === 'res' && !m.ok ? [m.id, m.e.code] : m))).toEqual([
      [9, 'invalid-argument'],
      [10, 'invalid-argument'],
    ]);
    expect(r.rpc.stats()).toMatchObject({ refused: 4, droppedFrames: 2 });
  });

  it('caps requests in flight (`rate-limited`)', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => (release = res));
    const r = rig(() => gate.then(() => undefined), { maxInflight: 2 });
    for (let id = 1; id <= 3; id++) r.send({ op: 'req', id, m: 'play.close', a: { sid: SID } });
    await r.settle();
    expect(r.out).toEqual([
      {
        op: 'res',
        id: 3,
        ok: false,
        e: { code: 'rate-limited', message: 'rate-limited: too many requests in flight' },
      },
    ]);
    release();
    await r.settle();
    expect(r.out).toHaveLength(3);
  });

  it('drops events the host guard would refuse', () => {
    const r = rig();
    r.rpc.emit({ op: 'ev', e: 'log', level: 'info', msg: 'ok' });
    r.rpc.emit({ op: 'ev', e: 'log', level: 'info', msg: 'bell \u0007' });
    r.rpc.emit({ op: 'ev', e: 'ready', v: 1, port: 0 });
    expect(r.out).toEqual([{ op: 'ev', e: 'log', level: 'info', msg: 'ok' }]);
    expect(r.rpc.stats().droppedEvents).toBe(2);
  });

  it('worker → host requests: checked, numbered, results checked, errors rebuilt, bounded, failed on EOF', async () => {
    const r = rig(undefined, { requestTimeoutMs: 50 });
    await expect(r.rpc.request('studio.publish', {} as never)).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    const draft = DRAFT;
    const p1 = r.rpc.request('studio.publish', draft);
    const p2 = r.rpc.request('studio.publish', draft);
    const p3 = r.rpc.request('studio.publish', draft);
    const p4 = r.rpc.request('studio.publish', draft);
    for (const p of [p1, p2, p3, p4]) p.catch(() => undefined);
    const ids = r.out.map((m) => (m.op === 'req' ? m.id : -1));
    expect(ids).toEqual([1, 2, 3, 4]);
    r.send({ op: 'res', id: 1, ok: true, r: mocks.VIDEOS[0] });
    r.send({ op: 'res', id: 2, ok: true, r: { forged: true } });
    r.send({ op: 'res', id: 3, ok: false, e: { code: 'no-signer', message: 'no-signer: none' } });
    await expect(p1).resolves.toEqual(mocks.VIDEOS[0]);
    await expect(p2).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(p3).rejects.toMatchObject({ code: 'no-signer' });
    await expect(p4).rejects.toMatchObject({ code: 'backend-down' });
    const p5 = r.rpc.request('studio.publish', draft);
    r.rpc.end();
    await expect(p5).rejects.toMatchObject({ code: 'backend-down' });
  });

  it('the default worker → host deadline is WORKER_HOST_REQUEST_TIMEOUT_MS, pay.build included (ADR 0012 amendment)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const r = rig();
      const pay = r.rpc.request('pay.build', {
        sid: SID as never,
        range: { core: 'c0'.repeat(32) as never, fromBlock: 0, toBlock: 1 },
        seeder: {
          pubkey: 'd1'.repeat(32) as never,
          p2pk: `02${'11'.repeat(32)}` as never,
          mint: 'https://mint.rpc.test' as never,
        },
        policy: mocks.VIDEOS[0]!.price,
        carryIn: 0,
      });
      const out: { done: boolean; err?: unknown } = { done: false };
      pay.catch((e: unknown) => {
        out.done = true;
        out.err = e;
      });
      expect(r.out.filter((m) => m.op === 'req')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(WORKER_HOST_REQUEST_TIMEOUT_MS - 1);
      expect(out.done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(out.err).toMatchObject({ code: 'backend-down' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a corrupt stream is terminal: onFatal once, no resync, push never throws', async () => {
    const r = rig();
    r.rpc.push(Uint8Array.of(0, 0, 0, 2, 0x7b, 0x7b)); // "{{" is not JSON
    r.send({ op: 'req', id: 1, m: 'play.close', a: { sid: SID } });
    r.rpc.push(Uint8Array.of(1, 2, 3));
    await r.settle();
    expect(r.fatal).toBe(1);
    expect(r.calls).toEqual([]);
    await expect(r.rpc.request('studio.publish', {} as never)).rejects.toMatchObject({
      code: 'backend-down',
    });
  });
});

describe('WorkerRpc fuzz (fast-check)', () => {
  it('arbitrary bytes: push never throws; the handler only sees guarded requests', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uint8Array({ maxLength: 64 }), { maxLength: 8 }),
        async (chunks) => {
          const r = rig();
          for (const c of chunks) r.rpc.push(c);
          await r.settle();
          expect(r.fatal).toBeLessThanOrEqual(1);
          for (const c of r.calls) expect(isHostToWorker(c)).toBe(true);
          expect(r.bad).toEqual([]);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('request-shaped junk: dispatched iff the guard accepts; every reply is a valid frame', async () => {
    const reqArb = fc.record({
      op: fc.constant('req'),
      id: fc.oneof(fc.nat(0x7fffffff), fc.integer(), fc.double(), fc.string()),
      m: fc.oneof(
        fc.constantFrom(...METHODS),
        fc.constantFrom('__proto__', 'constructor', 'nope'),
        fc.string(),
      ),
      a: fc.oneof(
        fc.anything(),
        fc.constant({ sid: SID }),
        fc.constant({}),
        fc.constant(INIT),
        fc.record({ sid: fc.string(), seconds: fc.double() }),
      ),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(reqArb, { maxLength: 6 }), async (msgs) => {
        const r = rig();
        let framed = 0;
        let accepted = 0;
        for (const m of msgs) {
          let bytes: Uint8Array;
          try {
            bytes = encodeFrame(m);
          } catch {
            continue; // not representable as a frame at all
          }
          framed++;
          const parsed: unknown = JSON.parse(JSON.stringify(m));
          if (isHostToWorker(parsed)) accepted++;
          r.rpc.push(bytes);
        }
        await r.settle();
        expect(r.fatal).toBe(0);
        expect(r.calls.length).toBe(accepted);
        for (const c of r.calls)
          expect((validateWorkerArgs[c.m] as Guard<unknown>)(c.a)).toBe(true);
        expect(r.bad).toEqual([]);
        expect(r.out.filter((o) => o.op === 'res').length).toBeLessThanOrEqual(framed);
      }),
      { numRuns: 300 },
    );
  });

  it('any JSON value as a frame: never throws, never dispatches a non-request', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.jsonValue(), { maxLength: 6 }), async (vals) => {
        const r = rig();
        for (const v of vals) {
          try {
            r.rpc.push(encodeFrame(v as object));
          } catch {
            // non-objects cannot be framed
          }
        }
        await r.settle();
        expect(r.fatal).toBe(0);
        for (const c of r.calls) expect(isHostToWorker(c)).toBe(true);
        expect(r.bad).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });
});

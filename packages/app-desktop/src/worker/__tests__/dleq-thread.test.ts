/**
 * Issue #8 (d): the worker's DLEQ checks off its event loop (security review F5, desktop half),
 * under Node with `node:worker_threads` standing in for `Bare.Thread` (the mailbox protocol is
 * the same SharedArrayBuffer + Atomics either way; the real Bare run is `bare-dleq-thread.test.ts`).
 *
 *   parity    valid proofs pass, a bad DLEQ fails, the answers are exactly core's `proofDleqOk`,
 *             in order — through the thread and through the chunked fallback;
 *   liveness  the event loop keeps turning while a PAY's worth of proofs is checked on the thread,
 *             and the chunked fallback yields between chunks;
 *   failure   is never acceptance: a thread that never starts, answers FAIL, answers the wrong
 *             count, hangs, or cannot be spawned at all leaves the verdicts to the chunked path;
 *             a hung thread is replaced, and two failed starts turn the thread off for good;
 *   retiring  never blocks (issue #8 review, finding 2): a thread given up on mid-job or mid-start
 *             sees QUIT (never overwritten) and leaves; it is joined only once it says so, and
 *             one that never says so is let go unjoined.
 *   visible   (lane I1) the verifier counts what each path answered and says, once, which one is
 *             in use; the `--dev-fixtures` self-check reports it in one line, and the worker's
 *             close stops the self-check's thread before it exits.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { randomBytes } from 'node:crypto';

import { getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import type {
  CashuP2pkPubkey,
  CoreKeyHex,
  MintUrl,
  NostrPubkey,
  PricePolicy,
  Sats,
} from '@sovit/core';
import { DEFAULT_BLOCK_SIZE, mocks, payment, wallet as walletMod } from '@sovit/core';
import { silentLogger } from '@sovit/seeder';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  DleqThread,
  MAILBOX,
  MAILBOX_HEADER_BYTES,
  MAILBOX_WORDS,
  WORD,
  chunkedDleq,
  dleqVerifier,
  serveDleqMailbox,
  timeoutOption,
  type DleqThreadHandle,
  type SpawnDleqThread,
} from '../pay/dleq-thread.js';
import { realProviders } from '../pay/real-providers.js';
import { DLEQ_SELFCHECK_MSG, selfCheckChecks, startDleqSelfCheck } from '../dev/dleq-selfcheck.js';
import type { LogRecord } from '@sovit/seeder';
import { createLogger } from '@sovit/seeder';
import type { WorkerEvent } from '../../ipc/worker-protocol.js';
import { nodeRuntime, nodeStateFs, startWorker, tempDir } from './helpers/harness.js';

// Real curve work (issuing and checking a PAY's worth of proofs) on a shared, loaded box.
vi.setConfig({ testTimeout: 60_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..', '..', '..');
const MINT = 'https://mint.dleq-thread.test' as MintUrl;
const P2PK = `02${'3c'.repeat(32)}`;

type Check = payment.DleqCheck;

function checks(n: number): Check[] {
  const mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x5d) });
  const ks = mint.keyset();
  const out: Check[] = [];
  while (out.length < n)
    for (const proof of mint.issue(255, { p2pk: P2PK })) {
      const key = ks.keys[proof.amount];
      out.push({
        proof,
        keyset: { ...ks, keys: key === undefined ? {} : { [proof.amount]: key } },
      });
    }
  return out.slice(0, n);
}

/** Every other check with a forged DLEQ `s`. */
function mixed(good: Check[]): Check[] {
  return good.map((c, i) =>
    i % 2 === 0
      ? c
      : {
          ...c,
          proof: {
            ...c.proof,
            dleq: { ...(c.proof.dleq ?? { s: '', e: '' }), s: 'ab'.repeat(32) },
          },
        },
  );
}

const inline = (cs: readonly Check[]): boolean[] =>
  cs.map((c) => payment.proofDleqOk(c.proof, c.keyset));
const verify = (p: Check['proof'], k: Check['keyset']): boolean => payment.proofDleqOk(p, k);

/** The longest gap between event-loop turns while `work` runs. */
async function maxStall<T>(work: () => Promise<T> | T): Promise<{ stall: number; value: T }> {
  let last = performance.now();
  let stall = 0;
  const iv = setInterval(() => {
    const now = performance.now();
    stall = Math.max(stall, now - last);
    last = now;
  }, 1);
  try {
    const value = await work();
    stall = Math.max(stall, performance.now() - last);
    return { stall, value };
  } finally {
    clearInterval(iv);
  }
}

// ---- a Node thread entry, bundled once (the serve loop is the one the Bare thread runs) ----

let dir = '';
const entries: Record<string, string> = {};
const SERVE = `
import { workerData } from 'node:worker_threads';
import { payment } from '@sovit/core';
import { serveDleqMailbox } from '${join(HERE, '..', 'pay', 'dleq-thread.ts').replaceAll('\\', '/')}';
serveDleqMailbox(workerData, (p, k) => payment.proofDleqOk(p, k));
`;
/** The real serve loop with a verifier that throws on every check. */
const THROWING = `
import { workerData } from 'node:worker_threads';
import { serveDleqMailbox } from '${join(HERE, '..', 'pay', 'dleq-thread.ts').replaceAll('\\', '/')}';
serveDleqMailbox(workerData, () => { throw new Error('boom'); });
`;
/** Says FAIL at start, then that it is leaving (as the Bare entry does when core does not load). */
const FAIL_AT_START = `
import { workerData } from 'node:worker_threads';
const ctl = new Int32Array(workerData, 0, 3);
Atomics.store(ctl, 0, ${String(MAILBOX.FAIL)});
Atomics.notify(ctl, 0);
Atomics.store(ctl, 2, 1);
Atomics.notify(ctl, 2);
`;
/** Ready, then answers every job with one boolean too few. */
const WRONG_COUNT = `
import { workerData } from 'node:worker_threads';
const ctl = new Int32Array(workerData, 0, 2);
const data = new Uint8Array(workerData, 16);
Atomics.store(ctl, 0, ${String(MAILBOX.IDLE)}); Atomics.notify(ctl, 0);
let last = ${String(MAILBOX.IDLE)};
for (;;) {
  Atomics.wait(ctl, 0, last);
  const st = Atomics.load(ctl, 0);
  if (st === ${String(MAILBOX.QUIT)}) break;
  if (st !== ${String(MAILBOX.REQ)}) { last = st; continue; }
  const n = JSON.parse(new TextDecoder().decode(data.slice(0, Atomics.load(ctl, 1)))).length;
  const out = new TextEncoder().encode(JSON.stringify(Array(Math.max(0, n - 1)).fill(true)));
  data.set(out, 0); Atomics.store(ctl, 1, out.length);
  last = ${String(MAILBOX.RES)}; Atomics.store(ctl, 0, last); Atomics.notify(ctl, 0);
}
`;
/** Ready, then never answers. */
const HANG = `
import { workerData } from 'node:worker_threads';
const ctl = new Int32Array(workerData, 0, 2);
Atomics.store(ctl, 0, ${String(MAILBOX.IDLE)}); Atomics.notify(ctl, 0);
setInterval(() => {}, 1000);
`;
/** Never says anything. */
const SILENT = `setInterval(() => {}, 1000);`;
/** The real serve loop with a verifier that takes 800 ms a check (a job outlives `jobMs`). */
const SLOW_JOB = `
import { workerData } from 'node:worker_threads';
import { serveDleqMailbox } from '${join(HERE, '..', 'pay', 'dleq-thread.ts').replaceAll('\\', '/')}';
serveDleqMailbox(workerData, () => { const t = Date.now(); while (Date.now() - t < 800) {} return true; });
`;
/** 800 ms of work before the real serve loop (a slow start: a cold disk, a starved CPU). */
const SLOW_START = `
import { workerData } from 'node:worker_threads';
import { serveDleqMailbox } from '${join(HERE, '..', 'pay', 'dleq-thread.ts').replaceAll('\\', '/')}';
const t = Date.now(); while (Date.now() - t < 800) {}
serveDleqMailbox(workerData, () => true);
`;

beforeAll(async () => {
  dir = join(ROOT, 'node_modules', '.cache', `nf-s3res-dleq-${randomBytes(6).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  const sources = {
    SERVE,
    THROWING,
    FAIL_AT_START,
    WRONG_COUNT,
    HANG,
    SILENT,
    SLOW_JOB,
    SLOW_START,
  };
  for (const [name, contents] of Object.entries(sources)) {
    const outfile = join(dir, `${name}.mjs`);
    await build({
      stdin: { contents, resolveDir: HERE, loader: 'ts', sourcefile: `${name}.ts` },
      outfile,
      bundle: true,
      packages: 'external',
      format: 'esm',
      platform: 'node',
      target: 'node22',
      logLevel: 'silent',
    });
    entries[name] = outfile;
  }
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * A spawner over node:worker_threads, recording what it did. `joins` holds, for each `join()`,
 * the thread's `exited` word at that moment: under Bare a join before the thread has said it is
 * leaving blocks the event loop (issue #8 review, finding 2), so every entry must be 1.
 */
function nodeSpawner(name: string): SpawnDleqThread & {
  spawned: number;
  terminated: number;
  joins: number[];
  boxes: SharedArrayBuffer[];
} {
  const s = Object.assign(
    (box: SharedArrayBuffer): DleqThreadHandle => {
      s.spawned++;
      s.boxes.push(box);
      const file = entries[name];
      if (file === undefined) throw new Error(`no entry ${name}`);
      const w = new Worker(file, { workerData: box });
      w.unref();
      return {
        terminate: () => {
          s.terminated++;
          void w.terminate();
        },
        join: () => {
          s.joins.push(Atomics.load(new Int32Array(box, 0, MAILBOX_WORDS), WORD.EXITED));
        },
      };
    },
    { spawned: 0, terminated: 0, joins: [] as number[], boxes: [] as SharedArrayBuffer[] },
  );
  return s;
}

/** Poll until `f()` holds (a thread's mailbox, seen from here), or fail after `ms`. */
async function until(f: () => boolean, ms = 5000): Promise<void> {
  const t0 = performance.now();
  while (!f()) {
    if (performance.now() - t0 > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('DleqThread (the mailbox) — parity and liveness', () => {
  it('answers exactly what proofDleqOk answers, in order: valid pass, a bad DLEQ fails', async () => {
    const t = new DleqThread({ spawn: nodeSpawner('SERVE') });
    try {
      const cs = mixed(checks(9));
      const want = inline(cs);
      expect(want).toEqual([true, false, true, false, true, false, true, false, true]);
      expect(await t.verify(cs)).toEqual(want);
      expect(await t.verify([])).toEqual([]);
      // Concurrent jobs are queued and answered in their own order.
      const [a, b] = await Promise.all([t.verify(cs.slice(0, 3)), t.verify(cs.slice(3))]);
      expect([...a, ...b]).toEqual(want);
    } finally {
      await t.close();
    }
  });

  it('keeps the event loop turning while a PAY’s worth (128 proofs) is checked', async () => {
    const cs = checks(128);
    const t = new DleqThread({ spawn: nodeSpawner('SERVE') });
    try {
      await t.verify(cs.slice(0, 1)); // started (the isolate's load is not the PAY's cost)
      const off = await maxStall(() => t.verify(cs));
      const on = await maxStall(() => inline(cs));
      expect(off.value).toEqual(on.value);
      expect(off.value.every(Boolean)).toBe(true);
      // On the loop, one pass over 128 proofs; off it, the loop only waits.
      expect(off.stall).toBeLessThan(on.stall / 4);
    } finally {
      await t.close();
    }
  });

  it('on the thread, a check that throws, or is not a check at all, is a failed check — never a pass', async () => {
    const t = new DleqThread({ spawn: nodeSpawner('THROWING') });
    try {
      expect(await t.verify(checks(3))).toEqual([false, false, false]);
    } finally {
      await t.close();
    }
    const real = new DleqThread({ spawn: nodeSpawner('SERVE') });
    try {
      const junk = [null, { proof: 1 }, {}] as unknown as Check[];
      expect(await real.verify([...junk, ...checks(1)])).toEqual([false, false, false, true]);
    } finally {
      await real.close();
    }
  });

  it('splits a batch too large for the data area; refuses a single check that cannot fit', async () => {
    const t = new DleqThread({ spawn: nodeSpawner('SERVE'), dataBytes: 3000 });
    try {
      const cs = mixed(checks(12));
      expect(await t.verify(cs)).toEqual(inline(cs));
    } finally {
      await t.close();
    }
    const tiny = new DleqThread({ spawn: nodeSpawner('SERVE'), dataBytes: 64 });
    try {
      await expect(tiny.verify(checks(1))).rejects.toThrow(/too large/);
    } finally {
      await tiny.close();
    }
  });
});

describe('dleqVerifier — failure is never acceptance', () => {
  const cs = mixed(checks(6));
  const want = inline(cs);

  it('no thread at all (no spawner, or one that cannot): the chunked path answers', async () => {
    expect(await dleqVerifier({ spawn: undefined, verify }).verify(cs)).toEqual(want);
    const none: SpawnDleqThread = () => null;
    const v = dleqVerifier({ spawn: none, verify });
    expect(await v.verify(cs)).toEqual(want);
    expect(await v.verify(cs)).toEqual(want);
  });

  for (const [name, what] of [
    ['FAIL_AT_START', 'says FAIL at start (core did not load)'],
    ['SILENT', 'never starts'],
    ['WRONG_COUNT', 'answers the wrong count'],
    ['HANG', 'never answers a job'],
  ] as const)
    it(`a thread that ${what}: the verdicts come from the chunked path`, async () => {
      const spawn = nodeSpawner(name);
      // reapMs: these stand-in threads never say they are leaving, so they are let go after it.
      const v = dleqVerifier({ spawn, verify, startMs: 300, jobMs: 300, reapMs: 300 });
      try {
        // Three PAYs, each after the start that the one before began is over — and after a
        // retired thread is gone: no new thread starts beside one still leaving (issue #8
        // review, finding 2 follow-up), and these stand-ins are let go after reapMs.
        for (let i = 0; i < 3; i++) {
          expect(await v.verify(cs)).toEqual(want);
          await v.ready();
          await new Promise((r) => setTimeout(r, 400));
        }
      } finally {
        // Awaited since the issue #8 review (finding 2): a retired thread is stopped in the
        // background, never by a blocking join on the event loop.
        await v.close();
      }
      // Never joined before it said it was leaving (only the FAIL_AT_START stand-in says so).
      expect(spawn.joins.filter((x) => x !== 1)).toEqual([]);
      if (name === 'FAIL_AT_START') expect(spawn.joins).toEqual([1, 1]);
      if (name === 'FAIL_AT_START' || name === 'SILENT') expect(spawn.spawned).toBe(2); // two failed starts: off for good
      if (name === 'HANG') expect(spawn.terminated).toBeGreaterThanOrEqual(1); // replaced
    });

  it('a thread that fails its first start is tried once more, then left off', async () => {
    const spawn = nodeSpawner('SILENT');
    // reapMs: a stand-in that never says it is leaving is let go after it (finding 2).
    const t = new DleqThread({ spawn, startMs: 200, reapMs: 200 });
    await expect(t.verify(cs)).rejects.toThrow(/did not start/);
    expect(t.usable).toBe(true);
    // Fix round 2 (LOW 1): no second start while the first thread is still leaving — this test
    // used to try again at once, beside it. The job goes to the chunked path instead; the second
    // start comes once the first thread is let go (this stand-in never says it is leaving).
    await expect(t.verify(cs)).rejects.toThrow(/still leaving/);
    expect(spawn.spawned).toBe(1);
    await until(() => t.reaps.abandoned === 1);
    await expect(t.verify(cs)).rejects.toThrow(/did not start/);
    expect(t.usable).toBe(false);
    await expect(t.verify(cs)).rejects.toThrow(/unavailable/);
    expect(spawn.spawned).toBe(2);
    await t.close();
  });

  it('never waits for a start: the first PAY is checked inline while the thread comes up', async () => {
    const spawn = nodeSpawner('SILENT'); // a start that would take the whole start timeout
    const v = dleqVerifier({ spawn, verify, startMs: 5000, reapMs: 200 });
    const t0 = performance.now();
    expect(await v.verify(cs)).toEqual(want);
    expect(performance.now() - t0).toBeLessThan(4000);
    expect(spawn.spawned).toBe(1); // …but the start was begun
    await v.close();
  });

  it('close stops the thread; later checks still get verdicts (chunked)', async () => {
    const spawn = nodeSpawner('SERVE');
    const v = dleqVerifier({ spawn, verify });
    expect(await v.verify(cs)).toEqual(want); // inline; the thread starts meanwhile
    expect(await v.ready()).toBe(true);
    expect(await v.verify(cs)).toEqual(want); // on the thread
    // Awaited since the issue #8 review (finding 2): close never blocks; it resolves once the
    // thread has said it is leaving and was joined.
    await v.close();
    expect(spawn.terminated).toBe(1);
    expect(spawn.joins).toEqual([1]); // joined only after it said it was leaving
    expect(await v.verify(cs)).toEqual(want);
    expect(spawn.spawned).toBe(1);
  });
});

describe('retiring a thread never blocks the event loop (issue #8 review, finding 2)', () => {
  const cs = checks(2);

  it('a thread given up on mid-job leaves after the job — QUIT is not overwritten — and is joined only then', async () => {
    const spawn = nodeSpawner('SLOW_JOB');
    const t = new DleqThread({ spawn, jobMs: 200, reapMs: 10_000 });
    await expect(t.verify(cs)).rejects.toThrow(/timed out/);
    const [box] = spawn.boxes;
    if (box === undefined) throw new Error('no thread');
    const ctl = new Int32Array(box, 0, MAILBOX_WORDS);
    // The thread is still checking: not joined yet, and the worker moved on.
    expect(spawn.joins).toEqual([]);
    expect(Atomics.load(ctl, WORD.STATE)).toBe(MAILBOX.QUIT);
    await t.close();
    // Its job over, the thread kept QUIT (no RES over it) and said it was leaving.
    expect(Atomics.load(ctl, WORD.STATE)).toBe(MAILBOX.QUIT);
    expect(Atomics.load(ctl, WORD.EXITED)).toBe(1);
    expect(spawn.joins).toEqual([1]);
    expect(t.reaps).toEqual({ joined: 1, abandoned: 0 });
  });

  it('a slow start given up on: the thread finds QUIT instead of parking on IDLE, and leaves', async () => {
    const spawn = nodeSpawner('SLOW_START');
    const t = new DleqThread({ spawn, startMs: 200, reapMs: 10_000 });
    await expect(t.verify(cs)).rejects.toThrow(/did not start/);
    const [box] = spawn.boxes;
    if (box === undefined) throw new Error('no thread');
    const ctl = new Int32Array(box, 0, MAILBOX_WORDS);
    await until(() => Atomics.load(ctl, WORD.EXITED) === 1);
    expect(Atomics.load(ctl, WORD.STATE)).toBe(MAILBOX.QUIT); // never IDLE over it
    await t.close();
    expect(spawn.joins).toEqual([1]);
    expect(t.reaps).toEqual({ joined: 1, abandoned: 0 });
  });

  it('a thread that never says it is leaving is let go without a join (it would block under Bare)', async () => {
    const spawn = nodeSpawner('HANG');
    const t = new DleqThread({ spawn, jobMs: 100, reapMs: 200 });
    await expect(t.verify(cs)).rejects.toThrow(/timed out/);
    await t.close();
    expect(spawn.joins).toEqual([]);
    expect(spawn.terminated).toBe(1); // asked to stop (never blocks), then let go
    expect(t.reaps).toEqual({ joined: 0, abandoned: 1 });
  });

  it('while a retired thread is still leaving, no second thread starts: the checks run chunked', async () => {
    const spawn = nodeSpawner('SLOW_JOB');
    const t = new DleqThread({ spawn, jobMs: 200, reapMs: 10_000 });
    expect(t.tryVerify(cs)).toBeNull(); // begins the start
    expect(await t.ready()).toBe(true);
    const onThread = t.tryVerify(cs);
    expect(onThread).not.toBeNull();
    await expect(onThread).rejects.toThrow(/timed out/); // the job outlives jobMs
    // The retired thread is still checking: nothing starts beside it (on a starved CPU new
    // threads would only pile up).
    expect(t.tryVerify(cs)).toBeNull();
    expect(t.tryVerify(cs)).toBeNull();
    expect(spawn.spawned).toBe(1);
    await until(() => t.reaps.joined === 1);
    // Gone: the next PAY begins a new start.
    expect(t.tryVerify(cs)).toBeNull();
    expect(spawn.spawned).toBe(2);
    await t.close();
  });

  it('jobs queued while the thread was up do not start threads beside a leaving one: they fail at once, to the chunked path (fix round 2)', async () => {
    // Fix round 2 (independent verifier, LOW 1): the guard was only in `tryVerify`. Three PAYs
    // queued on a thread that boots but never answers each reached `run()` → `ensureStarted()`
    // after the one before timed out, and spawned a new thread while the retired one was still
    // leaving: three threads.
    const spawn = nodeSpawner('HANG');
    const t = new DleqThread({ spawn, jobMs: 200, reapMs: 1000 });
    expect(t.tryVerify(cs)).toBeNull(); // begins the start
    expect(await t.ready()).toBe(true);
    const queued = [t.tryVerify(cs), t.tryVerify(cs), t.tryVerify(cs)];
    expect(queued.every((p) => p !== null)).toBe(true);
    const outcomes = await Promise.allSettled(queued as Promise<boolean[]>[]);
    const reasons = outcomes.map((o) => (o.status === 'rejected' ? String(o.reason) : 'answered'));
    expect(reasons[0]).toMatch(/timed out/);
    expect(reasons[1]).toMatch(/still leaving/);
    expect(reasons[2]).toMatch(/still leaving/);
    expect(spawn.spawned).toBe(1);
    // Through the verifier: the verdicts come from the chunked path, still one thread.
    const v = dleqVerifier({ spawn, verify, jobMs: 200, reapMs: 1000 });
    expect(await v.verify(cs)).toEqual(inline(cs)); // begins its own start
    expect(await v.ready()).toBe(true);
    const spawned = spawn.spawned;
    const many = await Promise.all([v.verify(cs), v.verify(cs), v.verify(cs)]);
    expect(many).toEqual([inline(cs), inline(cs), inline(cs)]);
    expect(spawn.spawned).toBe(spawned);
    await v.close();
    await t.close();
    expect(t.reaps).toEqual({ joined: 0, abandoned: 1 });
  });

  it('a timeout option that is not a finite number ≥ 0 means the default (NaN would wait for ever)', async () => {
    expect(timeoutOption(undefined, 7)).toBe(7);
    expect(timeoutOption(Number.NaN, 7)).toBe(7);
    expect(timeoutOption(Number.POSITIVE_INFINITY, 7)).toBe(7);
    expect(timeoutOption(-1, 7)).toBe(7);
    expect(timeoutOption(0, 7)).toBe(0);
    expect(timeoutOption(250, 7)).toBe(250);
    // A data area that is not a positive integer means the default one, and checks still work.
    const t = new DleqThread({ spawn: nodeSpawner('SERVE'), dataBytes: Number.NaN });
    try {
      expect(await t.verify(cs)).toEqual(inline(cs));
    } finally {
      await t.close();
    }
  });

  it('serveDleqMailbox: a QUIT set before it boots returns at once, keeps QUIT, and says it is leaving', () => {
    const box = new SharedArrayBuffer(MAILBOX_HEADER_BYTES + 64);
    const ctl = new Int32Array(box, 0, MAILBOX_WORDS);
    Atomics.store(ctl, WORD.STATE, MAILBOX.QUIT);
    let called = 0;
    serveDleqMailbox(box, () => {
      called++;
      return true;
    }); // on this thread: it would never return if it parked
    expect(Atomics.load(ctl, WORD.STATE)).toBe(MAILBOX.QUIT);
    expect(Atomics.load(ctl, WORD.EXITED)).toBe(1);
    expect(called).toBe(0);
  });
});

describe('chunkedDleq — bounded work per turn', () => {
  it('yields to the event loop between chunks, with the same answers', async () => {
    const cs = mixed(checks(8));
    let turns = 0;
    const iv = setInterval(() => {
      turns++;
    }, 0);
    try {
      expect(await chunkedDleq(cs, verify, 1)).toEqual(inline(cs));
    } finally {
      clearInterval(iv);
    }
    expect(turns).toBeGreaterThan(0);
    // A chunk size that is not a positive integer still checks every proof.
    for (const bad of [0, -1, Number.NaN, 1.5])
      expect(await chunkedDleq(cs, verify, bad), String(bad)).toEqual(inline(cs));
    // A verifier that throws counts as a failed check, never as a pass.
    expect(
      await chunkedDleq(cs.slice(0, 2), () => {
        throw new Error('boom');
      }),
    ).toEqual([false, false]);
  });
});

describe('realProviders: a PAY’s DLEQ checks go to the thread (the wiring)', () => {
  const pub = (fill: number): CashuP2pkPubkey =>
    Buffer.from(getPubKeyFromPrivKey(new Uint8Array(32).fill(fill))).toString(
      'hex',
    ) as CashuP2pkPubkey;
  const SELLER_P2PK = pub(0x51);
  const VIEWER = 'ef'.repeat(32) as NostrPubkey;
  const CORE = 'a1'.repeat(32) as CoreKeyHex;
  const POLICY: PricePolicy = {
    satsPerBlock: 2 as Sats,
    blockSize: DEFAULT_BLOCK_SIZE,
    mints: [MINT],
    split: { seeder: 50, creator: 50 },
    creatorP2pk: pub(0x52),
    minPaySats: 1 as Sats,
  };

  it('a real PAY verifies on the thread; a forged DLEQ is refused and bans, as inline', async () => {
    const mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x5e) });
    // The viewer: the real engine over a real wallet at the test mint.
    const wallet = new walletMod.CashuWallet({
      mints: new walletMod.CashuMintConnections({ request: () => mint.request }),
      store: new walletMod.MemoryProofStore(),
    });
    const q = await wallet.mintQuote(MINT, 256 as Sats);
    mint.payQuote(q.quoteId);
    await wallet.pollQuote(q);
    const viewer = new payment.RealPaymentEngine({
      config: {
        windowBlocks: 4,
        ownP2pk: pub(0x53),
        ownPubkey: VIEWER,
        acceptedMints: [],
        flushEveryBlocks: 64,
        flushEveryMs: 60_000,
      },
      wallet,
    });
    // The worker's seller side, every host call answered here; DLEQ through the thread.
    const root = await mkdtemp(join(tmpdir(), 'nf-dleq-providers-'));
    const spawn = nodeSpawner('SERVE');
    const p = realProviders({
      payments: { pubkey: 'ab'.repeat(32) as NostrPubkey, p2pk: SELLER_P2PK, mints: [MINT] },
      dir: join(root, 'payments'),
      join,
      state: nodeStateFs,
      request: (m: string) =>
        m === 'seller.keyset'
          ? Promise.resolve(mint.keyset())
          : Promise.reject(new Error(`not in this test: ${m}`)),
      sidFor: () => undefined,
      priceCeiling: () => 2 as Sats,
      logger: silentLogger,
      dleqThread: spawn,
    });
    try {
      const range = (a: number, b: number) => ({ core: CORE, fromBlock: a, toBlock: b });
      for (let i = 0; i < 4; i++) p.engine.recordUpload(VIEWER, range(i, i), POLICY);
      const seller = { pubkey: 'ab'.repeat(32) as NostrPubkey, p2pk: SELLER_P2PK, mint: MINT };
      // The first PAY is checked inline while the thread starts (it is started by that PAY).
      const first = await viewer.pay(range(0, 1), seller, POLICY);
      expect(await p.engine.verify(VIEWER, first, POLICY)).toMatchObject({ ok: true });
      expect(spawn.spawned).toBe(1);
      expect(await p.dleq.ready()).toBe(true);
      // From now on the checks go to the thread.
      const honest = await viewer.pay(range(2, 3), seller, POLICY);
      expect(await p.engine.verify(VIEWER, honest, POLICY)).toMatchObject({ ok: true });
      for (let i = 4; i < 8; i++) p.engine.recordUpload(VIEWER, range(i, i), POLICY);
      const next = await viewer.pay(range(4, 7), seller, POLICY);
      const forged = {
        ...next,
        seederProofs: {
          ...next.seederProofs,
          proofs: next.seederProofs.proofs.map((x, i) =>
            i === 0 ? { ...x, dleq: { ...x.dleq!, s: 'ab'.repeat(32) } } : x,
          ),
        },
      };
      expect(await p.engine.verify(VIEWER, forged, POLICY)).toMatchObject({
        ok: false,
        reason: 'bad-dleq',
      });
      expect(p.engine.isBanned(VIEWER)).toBe(true);
      expect(spawn.spawned).toBe(1); // one thread, reused
    } finally {
      p.close?.();
      // The providers' close never blocks (issue #8 review, finding 2); this waits for the
      // background join, so the count below is not a race.
      await p.dleq.close();
      await rm(root, { recursive: true, force: true });
    }
    expect(spawn.terminated).toBe(1); // closing the providers stops it
    expect(spawn.joins).toEqual([1]);
  });
});

/** A logger that keeps its records (level, msg, fields). */
function recording(): { logger: ReturnType<typeof createLogger>; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const logger = createLogger({
    level: 'debug',
    sink: (_line, rec) => {
      records.push(rec);
    },
  });
  return { logger, records };
}

describe('which path answered, and saying so (lane I1, ADR 0017)', () => {
  it('answered() counts each path; the thread coming up is said once, at info', async () => {
    const cs = mixed(checks(4));
    const want = inline(cs);
    const { logger, records } = recording();
    const v = dleqVerifier({ spawn: nodeSpawner('SERVE'), verify, logger });
    try {
      expect(v.answered()).toEqual({ thread: 0, inline: 0 });
      expect(await v.verify(cs)).toEqual(want); // inline while the thread starts
      expect(v.answered()).toEqual({ thread: 0, inline: 4 });
      expect(await v.ready()).toBe(true);
      expect(await v.verify(cs)).toEqual(want);
      expect(await v.verify(cs.slice(0, 1))).toEqual(want.slice(0, 1));
      expect(v.answered()).toEqual({ thread: 5, inline: 4 });
    } finally {
      await v.close();
    }
    expect(records.map((r) => [r.level, r.msg])).toEqual([
      ['info', 'DLEQ checks run on their own thread'],
    ]);
  });

  it('a runtime with threads whose spawner says no (no entry file) is said once, at warn — never after close', async () => {
    const cs = checks(2);
    const { logger, records } = recording();
    const v = dleqVerifier({ spawn: () => null, verify, logger });
    for (let i = 0; i < 3; i++) expect(await v.verify(cs)).toEqual(inline(cs));
    expect(v.answered()).toEqual({ thread: 0, inline: 6 });
    expect(records.map((r) => [r.level, r.msg])).toEqual([
      ['warn', 'no DLEQ thread could start: checks run inline, in small chunks'],
    ]);
    // A runtime without threads (Node, tests) says nothing; nor does a verifier after close.
    const q = recording();
    const none = dleqVerifier({ spawn: undefined, verify, logger: q.logger });
    await none.verify(cs);
    const closed = dleqVerifier({ spawn: nodeSpawner('SERVE'), verify, logger: q.logger });
    await closed.close();
    expect(await closed.verify(cs)).toEqual(inline(cs));
    expect(q.records).toEqual([]);
    await v.close();
  });
});

describe('the --dev-fixtures DLEQ self-check (lane I1)', () => {
  it('its vectors are what core says they are: three valid, one forged', () => {
    const { checks: cs, want } = selfCheckChecks();
    expect(cs).toHaveLength(4);
    expect(inline(cs)).toEqual(want);
    expect(want).toEqual([true, true, true, false]);
    // Each keyset holds only the key for its proof's amount (the DleqCheck shape).
    for (const c of cs) expect(Object.keys(c.keyset.keys)).toEqual([String(c.proof.amount)]);
    // The mint exists nowhere (RFC 2606 `.invalid`).
    expect(new Set(cs.map((c) => new URL(c.keyset.mint).hostname.endsWith('.invalid')))).toEqual(
      new Set([true]),
    );
  });

  it('on a working thread: ONE info line, where=thread, verdicts right, counts only; the thread is joined', async () => {
    const spawn = nodeSpawner('SERVE');
    const { logger, records } = recording();
    const sc = startDleqSelfCheck({ spawn, logger });
    const report = await sc.done;
    expect(report).toEqual({ where: 'thread', answered: { thread: 4, inline: 4 }, right: true });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 'info',
      msg: DLEQ_SELFCHECK_MSG,
      fields: { where: 'thread', onThread: 4, inline: 4, checks: 4, verdicts: 'right' },
    });
    // Counts and two words: no proof, key or secret in the line.
    expect(Object.keys(records[0]!.fields).sort()).toEqual(
      ['checks', 'inline', 'onThread', 'verdicts', 'where'].sort(),
    );
    await sc.close();
    expect(spawn.spawned).toBe(1);
    expect(spawn.joins).toEqual([1]); // stopped, and joined only once it said it was leaving
  });

  it('with no thread (the spawner says no): a warn line, where=inline, verdicts still right', async () => {
    const { logger, records } = recording();
    const report = await startDleqSelfCheck({ spawn: () => null, logger }).done;
    expect(report).toEqual({ where: 'inline', answered: { thread: 0, inline: 4 }, right: true });
    expect(records.map((r) => [r.level, r.msg, r.fields['where']])).toEqual([
      ['warn', DLEQ_SELFCHECK_MSG, 'inline'],
    ]);
  });

  it('a thread that fails to start (FAIL, as when core does not load): where=inline, warn', async () => {
    const spawn = nodeSpawner('FAIL_AT_START');
    const { logger, records } = recording();
    const sc = startDleqSelfCheck({ spawn, logger, startMs: 2000 });
    expect(await sc.done).toMatchObject({ where: 'inline', right: true });
    expect(records.map((r) => r.level)).toEqual(['warn']);
    await sc.close();
  });

  it('wrong verdicts are an error line', async () => {
    const { logger, records } = recording();
    const report = await startDleqSelfCheck({ spawn: () => null, logger, verify: () => true }).done;
    expect(report).toMatchObject({ right: false });
    expect(records.map((r) => [r.level, r.fields['verdicts']])).toEqual([['error', 'wrong']]);
  });

  it('stopped before it is over: no line, and its thread is still stopped and joined', async () => {
    const spawn = nodeSpawner('SERVE');
    const { logger, records } = recording();
    const sc = startDleqSelfCheck({ spawn, logger });
    await sc.close();
    expect(await sc.done).toBeNull();
    expect(records).toEqual([]);
    expect(spawn.joins.filter((x) => x !== 1)).toEqual([]);
  });

  it('WorkerHost with --dev-fixtures and a thread: the line is emitted, and close() stops the thread', async () => {
    const d = await tempDir('nf-dleq-selfcheck-host-');
    const spawn = nodeSpawner('SERVE');
    const w = startWorker({ runtime: { ...nodeRuntime(), dleqThread: spawn } });
    try {
      await w.call('init', {
        v: 1,
        storage: join(d.dir, 'worker'),
        seeding: { enabled: false, diskCapBytes: 1024 ** 3 },
        prefetchSeconds: 30,
        dev: { mocks: true, fixtures: true },
      });
      const line = await w.event(
        (e): e is Extract<WorkerEvent, { e: 'log' }> =>
          e.e === 'log' && e.msg.includes(DLEQ_SELFCHECK_MSG),
        30_000,
        'the DLEQ self-check line',
      );
      expect(line.level).toBe('info');
      expect(JSON.parse(line.msg)).toMatchObject({
        fields: { where: 'thread', verdicts: 'right', onThread: 4 },
      });
    } finally {
      await w.close();
      await d.rm();
    }
    expect(spawn.spawned).toBe(1);
    expect(spawn.terminated).toBe(1);
    expect(spawn.joins).toEqual([1]);
  });

  it('WorkerHost closed while the self-check’s thread starts: close() stops and joins it first', async () => {
    const d = await tempDir('nf-dleq-selfcheck-mid-');
    // 800 ms of work before the serve loop: the check is certainly mid-flight at close().
    const spawn = nodeSpawner('SLOW_START');
    const w = startWorker({ runtime: { ...nodeRuntime(), dleqThread: spawn } });
    try {
      await w.call('init', {
        v: 1,
        storage: join(d.dir, 'worker'),
        seeding: { enabled: false, diskCapBytes: 1024 ** 3 },
        prefetchSeconds: 30,
        dev: { mocks: true, fixtures: true },
      });
      await until(() => spawn.spawned === 1, 20_000);
      await w.close();
      // A worker that exited here with the thread still up would hang in Bare.exit.
      expect(spawn.terminated).toBe(1);
      expect(spawn.joins).toEqual([1]);
    } finally {
      await w.close();
      await d.rm();
    }
    expect(w.events.some((e) => e.e === 'log' && e.msg.includes(DLEQ_SELFCHECK_MSG))).toBe(false);
  });

  it('WorkerHost closed right after init: the self-check never leaves a thread behind', async () => {
    const d = await tempDir('nf-dleq-selfcheck-early-');
    const spawn = nodeSpawner('SERVE');
    const w = startWorker({ runtime: { ...nodeRuntime(), dleqThread: spawn } });
    try {
      await w.call('init', {
        v: 1,
        storage: join(d.dir, 'worker'),
        seeding: { enabled: false, diskCapBytes: 1024 ** 3 },
        prefetchSeconds: 30,
        dev: { mocks: true, fixtures: true },
      });
      await w.close();
    } finally {
      await d.rm();
    }
    // Either it never started one, or the one it started was stopped and joined.
    expect(spawn.terminated).toBe(spawn.spawned);
    expect(spawn.joins).toHaveLength(spawn.spawned);
    expect(spawn.joins.filter((x) => x !== 1)).toEqual([]);
    expect(w.events.some((e) => e.e === 'log' && e.msg.includes(DLEQ_SELFCHECK_MSG))).toBe(false);
  });
});

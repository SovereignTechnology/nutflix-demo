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
 *             a hung thread is replaced, and two failed starts turn the thread off for good.
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
  chunkedDleq,
  dleqVerifier,
  type DleqThreadHandle,
  type SpawnDleqThread,
} from '../pay/dleq-thread.js';
import { realProviders } from '../pay/real-providers.js';
import { nodeStateFs } from './helpers/harness.js';

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
/** Says FAIL at start (as the Bare entry does when core does not load). */
const FAIL_AT_START = `
import { workerData } from 'node:worker_threads';
const ctl = new Int32Array(workerData, 0, 2);
Atomics.store(ctl, 0, ${String(MAILBOX.FAIL)});
Atomics.notify(ctl, 0);
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

beforeAll(async () => {
  dir = join(ROOT, 'node_modules', '.cache', `nf-s3res-dleq-${randomBytes(6).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  const sources = { SERVE, FAIL_AT_START, WRONG_COUNT, HANG, SILENT };
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

/** A spawner over node:worker_threads, recording what it did. */
function nodeSpawner(name: string): SpawnDleqThread & { spawned: number; terminated: number } {
  const s = Object.assign(
    (box: SharedArrayBuffer): DleqThreadHandle => {
      s.spawned++;
      const file = entries[name];
      if (file === undefined) throw new Error(`no entry ${name}`);
      const w = new Worker(file, { workerData: box });
      w.unref();
      return {
        terminate: () => {
          s.terminated++;
          void w.terminate();
        },
        join: () => undefined,
      };
    },
    { spawned: 0, terminated: 0 },
  );
  return s;
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
      t.close();
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
      t.close();
    }
  });

  it('splits a batch too large for the data area; refuses a single check that cannot fit', async () => {
    const t = new DleqThread({ spawn: nodeSpawner('SERVE'), dataBytes: 3000 });
    try {
      const cs = mixed(checks(12));
      expect(await t.verify(cs)).toEqual(inline(cs));
    } finally {
      t.close();
    }
    const tiny = new DleqThread({ spawn: nodeSpawner('SERVE'), dataBytes: 64 });
    try {
      await expect(tiny.verify(checks(1))).rejects.toThrow(/too large/);
    } finally {
      tiny.close();
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
      const v = dleqVerifier({ spawn, verify, startMs: 300, jobMs: 300 });
      try {
        expect(await v.verify(cs)).toEqual(want);
        expect(await v.verify(cs)).toEqual(want);
      } finally {
        v.close();
      }
      if (name === 'FAIL_AT_START' || name === 'SILENT') expect(spawn.spawned).toBe(2); // two failed starts: off for good
      if (name === 'HANG') expect(spawn.terminated).toBeGreaterThanOrEqual(1); // replaced
    });

  it('a thread that fails its first start is tried once more, then left off', async () => {
    const spawn = nodeSpawner('SILENT');
    const t = new DleqThread({ spawn, startMs: 200 });
    await expect(t.verify(cs)).rejects.toThrow(/did not start/);
    expect(t.usable).toBe(true);
    await expect(t.verify(cs)).rejects.toThrow(/did not start/);
    expect(t.usable).toBe(false);
    await expect(t.verify(cs)).rejects.toThrow(/unavailable/);
    expect(spawn.spawned).toBe(2);
    t.close();
  });

  it('close stops the thread; later checks still get verdicts (chunked)', async () => {
    const spawn = nodeSpawner('SERVE');
    const v = dleqVerifier({ spawn, verify });
    expect(await v.verify(cs)).toEqual(want);
    v.close();
    expect(spawn.terminated).toBe(1);
    expect(await v.verify(cs)).toEqual(want);
    expect(spawn.spawned).toBe(1);
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
      const honest = await viewer.pay(range(0, 3), seller, POLICY);
      expect(await p.engine.verify(VIEWER, honest, POLICY)).toMatchObject({ ok: true });
      expect(spawn.spawned).toBe(1); // the checks went to the thread
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
      await rm(root, { recursive: true, force: true });
    }
    expect(spawn.terminated).toBe(1); // closing the providers stops it
  });
});

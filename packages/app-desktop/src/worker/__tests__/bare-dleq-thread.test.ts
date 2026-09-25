/**
 * Issue #8 (d) under the REAL Bare runtime the desktop ships (bare-sidecar's prebuilt `bare`),
 * against the BUILT worker modules (`dist/worker/…`, the unbundled tsc output the host runs;
 * skipped when `dist/` predates them — `npm run build` first, as CI does): `bareDleqThread` starts
 * `dist/worker/pay/dleq-thread-entry.mjs` on a `Bare.Thread`, and the worker's event loop is
 * measured while a maximal PAY (2 sets × 64 proofs) is checked — inline on the loop (the engine's
 * behaviour before), on the thread, and on the chunked fallback — with the same verdicts each way
 * (valid accepted, a bad DLEQ refused). It also proves the process survives a thread that cannot
 * load core, and a missing entry file (an exception escaping a Bare thread aborts the process).
 */
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { MintUrl } from '@sovit/core';
import { mocks, payment } from '@sovit/core';
import Sidecar from 'bare-sidecar';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..', '..', '..');
const ROOT = resolve(PKG, '..', '..');
const DIST = join(PKG, 'dist', 'worker');
const ENTRY = join(DIST, 'pay', 'dleq-thread-entry.mjs');
const built =
  existsSync(ENTRY) &&
  existsSync(join(DIST, 'pay', 'dleq-thread.js')) &&
  existsSync(join(DIST, 'adapters', 'bare.js'));
const MINT = 'https://mint.bare-dleq.test' as MintUrl;

/** The program Bare runs: measure, compare, report one JSON line over IPC. */
const PROGRAM = (dist: string, broken: string): string => `
const { payment } = await import('@sovit/core');
const { bareDleqThread } = await import(${JSON.stringify(pathToFileURL(join(dist, 'adapters', 'bare.js')).href)});
const { DleqThread, chunkedDleq } = await import(${JSON.stringify(pathToFileURL(join(dist, 'pay', 'dleq-thread.js')).href)});
const ipc = Bare.IPC;
async function stall(work) {
  let last = Date.now(), gap = 0;
  const iv = setInterval(() => { const n = Date.now(); gap = Math.max(gap, n - last); last = n; }, 1);
  const t0 = Date.now();
  const value = await work();
  const total = Date.now() - t0;
  gap = Math.max(gap, Date.now() - last);
  clearInterval(iv);
  return { value, total, stall: gap };
}
let buf = '';
ipc.on('data', async (c) => {
  buf += Buffer.from(c).toString();
  if (!buf.endsWith('\\n')) return;
  const checks = JSON.parse(buf); buf = '';
  const verify = (p, k) => payment.proofDleqOk(p, k);
  const inline = await stall(() => checks.map((c) => verify(c.proof, c.keyset)));
  const spawn = bareDleqThread();
  const t = new DleqThread({ spawn });
  const t0 = Date.now();
  await t.verify(checks.slice(0, 1));
  const startMs = Date.now() - t0;
  const thread = await stall(() => t.verify(checks));
  t.close();
  const chunked = await stall(() => chunkedDleq(checks, verify, 2));
  // A missing entry: no thread is started (a start from a missing file would abort Bare).
  const missing = bareDleqThread(new URL('file:///nonexistent/dleq-thread-entry.mjs'))(new SharedArrayBuffer(64));
  // An entry that cannot load core: it answers FAIL through the mailbox; the process lives on.
  let brokenOutcome = 'accepted?';
  const b = new DleqThread({ spawn: bareDleqThread(new URL(${JSON.stringify(pathToFileURL(broken).href)})), startMs: 5000 });
  const tb = Date.now();
  try { await b.verify(checks.slice(0, 1)); } catch (e) { brokenOutcome = String(e.message); }
  const brokenMs = Date.now() - tb;
  b.close();
  ipc.write(Buffer.from(JSON.stringify({
    inline: { total: inline.total, stall: inline.stall, verdicts: inline.value },
    thread: { startMs, total: thread.total, stall: thread.stall, verdicts: thread.value },
    chunked: { total: chunked.total, stall: chunked.stall, verdicts: chunked.value },
    missing: missing === null ? 'no-thread' : 'started',
    broken: brokenOutcome,
    brokenMs,
    alive: true,
  }) + '\\n'));
  setTimeout(() => Bare.exit(0), 50);
});
`;

let work = '';
let brokenDir = '';

beforeAll(async () => {
  if (!built) return;
  // Under the repo's node_modules, so Bare resolves @sovit/core and bare-* from the program.
  work = join(
    ROOT,
    'node_modules',
    '.cache',
    `nf-s3res-bare-dleq-${randomBytes(6).toString('hex')}`,
  );
  await mkdir(work, { recursive: true });
  // The broken entry: the real one, copied where neither ../bare-globals.js nor @sovit/core exist.
  brokenDir = await mkdtemp(join(tmpdir(), 'nf-bare-dleq-broken-'));
  await mkdir(join(brokenDir, 'pay'));
  const broken = join(brokenDir, 'pay', 'dleq-thread-entry.mjs');
  await copyFile(ENTRY, broken);
  await writeFile(
    join(work, 'boot.mjs'),
    "import 'bare-encoding/global'\nimport('./main.mjs').catch((e) => { throw e })\n",
  );
  await writeFile(join(work, 'main.mjs'), PROGRAM(DIST, broken));
});

afterAll(async () => {
  if (work !== '') await rm(work, { recursive: true, force: true });
  if (brokenDir !== '') await rm(brokenDir, { recursive: true, force: true });
});

function checks(n: number): payment.DleqCheck[] {
  const mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x6d) });
  const ks = mint.keyset();
  const out: payment.DleqCheck[] = [];
  while (out.length < n)
    for (const proof of mint.issue(255, { p2pk: `02${'3c'.repeat(32)}` })) {
      const key = ks.keys[proof.amount];
      out.push({
        proof,
        keyset: { ...ks, keys: key === undefined ? {} : { [proof.amount]: key } },
      });
    }
  // One in eight forged: a bad DLEQ must be refused on every path.
  return out
    .slice(0, n)
    .map((c, i) =>
      i % 8 === 3
        ? { ...c, proof: { ...c.proof, dleq: { ...c.proof.dleq!, s: 'ab'.repeat(32) } } }
        : c,
    );
}

interface Report {
  readonly inline: { total: number; stall: number; verdicts: boolean[] };
  readonly thread: { startMs: number; total: number; stall: number; verdicts: boolean[] };
  readonly chunked: { total: number; stall: number; verdicts: boolean[] };
  readonly missing: string;
  readonly broken: string;
  readonly brokenMs: number;
  readonly alive: boolean;
}

describe('DLEQ off the Bare worker’s event loop (issue #8 d, F5)', () => {
  it.skipIf(!built)(
    'a maximal PAY (128 proofs) is checked on a Bare.Thread with the same verdicts, and the loop keeps turning',
    { timeout: 120_000 },
    async () => {
      const cs = checks(payment.MAX_PROOFS_PER_SET * 2);
      const want = cs.map((c) => payment.proofDleqOk(c.proof, c.keyset));
      expect(want.filter((x) => !x)).toHaveLength(16);
      const sc = new Sidecar(join(work, 'boot.mjs'), []);
      let stderr = '';
      sc.stderr?.on('data', (d: unknown) => {
        if (d instanceof Uint8Array) stderr += Buffer.from(d).toString('utf8');
      });
      sc.stdout?.resume();
      const report = await new Promise<Report>((done, fail) => {
        let buf = '';
        const t = setTimeout(() => {
          fail(new Error(`no report from bare in 100 s; stderr: ${stderr.slice(0, 2000)}`));
        }, 100_000);
        sc.on('data', (d: unknown) => {
          if (!(d instanceof Uint8Array)) return;
          buf += Buffer.from(d).toString('utf8');
          const i = buf.indexOf('\n');
          if (i < 0) return;
          clearTimeout(t);
          done(JSON.parse(buf.slice(0, i)) as Report);
        });
        sc.once('exit', (code: number | null) => {
          clearTimeout(t);
          if (!buf.includes('\n'))
            fail(
              new Error(`bare exited (${String(code)}) without a report: ${stderr.slice(0, 2000)}`),
            );
        });
        sc.write(Buffer.from(`${JSON.stringify(cs)}\n`));
      });
      const exited = await new Promise<number | null>((r) => {
        sc.once('exit', (code: number | null) => {
          r(code);
        });
        setTimeout(() => {
          r(-1);
        }, 10_000);
      });

      // Parity: every path answers exactly what core's proofDleqOk answers under Node.
      expect(report.inline.verdicts).toEqual(want);
      expect(report.thread.verdicts).toEqual(want);
      expect(report.chunked.verdicts).toEqual(want);
      // Before: one long stall (the whole PAY on the loop). After: the loop only waits on the
      // thread; the chunked fallback is bounded to a couple of proofs per turn.
      expect(report.thread.stall).toBeLessThan(report.inline.stall / 4);
      expect(report.chunked.stall).toBeLessThan(report.inline.stall / 4);
      // Failure is never acceptance, and never an abort.
      expect(report.missing).toBe('no-thread');
      expect(report.broken).toMatch(/did not start/);
      // …answered through the mailbox (FAIL) at once, not found out by the 5 s start timeout.
      expect(report.brokenMs).toBeLessThan(4000);
      expect(report.alive).toBe(true);
      expect(exited).toBe(0);
      // The numbers themselves, for the lane report: NUTFLIX_DLEQ_MEASURE=<file> writes them.
      const out = process.env['NUTFLIX_DLEQ_MEASURE'];
      if (out !== undefined && out !== '')
        await writeFile(
          out,
          JSON.stringify({
            proofs: cs.length,
            inline: { totalMs: report.inline.total, maxStallMs: report.inline.stall },
            thread: {
              startMs: report.thread.startMs,
              totalMs: report.thread.total,
              maxStallMs: report.thread.stall,
            },
            chunked: { totalMs: report.chunked.total, maxStallMs: report.chunked.stall },
          }),
        );
    },
  );
});

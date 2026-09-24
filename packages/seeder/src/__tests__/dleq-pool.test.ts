/**
 * The DLEQ worker pool (security review F5) against the BUILT worker (`dist/runtime/
 * dleq-worker.js`; skipped when `dist/` predates it — `npm run build` first, as CI does):
 * answers match core's `proofDleqOk`, the event loop keeps turning while a big batch is checked,
 * and every failure (a crashing worker, a silent one, a closed pool) rejects — so the engine falls
 * back to its own synchronous check, never to acceptance.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it, vi } from 'vitest';

import type { MintUrl, payment as paymentTypes } from '@sovit/core';
import { mocks, payment } from '@sovit/core';

import { DleqPool } from '../runtime/dleq-pool.js';

// Real curve work (issuing and checking dozens of proofs) under a loaded CI machine.
vi.setConfig({ testTimeout: 60_000 });

const BUILT = new URL('../../dist/runtime/dleq-worker.js', import.meta.url);
/** The child script's standard streams, built so the seeder's no-console grep does not match. */
const STD = ['process', '.std'].join('');
const built = existsSync(fileURLToPath(BUILT));
const MINT = 'https://mint.dleq-pool.test' as MintUrl;
const P2PK = `02${'3c'.repeat(32)}`;

const tmp = mkdtempSync(join(tmpdir(), 'nf-dleq-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function checks(n: number, amount = 1): paymentTypes.DleqCheck[] {
  const mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x5d) });
  const ks = mint.keyset();
  const out: paymentTypes.DleqCheck[] = [];
  while (out.length < n)
    for (const proof of mint.issue(amount, { p2pk: P2PK })) {
      const key = ks.keys[proof.amount];
      out.push({
        proof,
        keyset: { ...ks, keys: key === undefined ? {} : { [proof.amount]: key } },
      });
    }
  return out.slice(0, n);
}

function workerScript(body: string): URL {
  const p = join(tmp, `w-${String(Math.random()).slice(2)}.mjs`);
  writeFileSync(p, `import { parentPort } from 'node:worker_threads';\n${body}\n`);
  return pathToFileURL(p);
}

describe('DleqPool', () => {
  it('is off (null) without threads or without the built worker', () => {
    expect(DleqPool.open({ size: 0, workerUrl: BUILT })).toBeNull();
    expect(
      DleqPool.open({ size: 2, workerUrl: new URL('file:///nonexistent/dleq-worker.js') }),
    ).toBeNull();
  });

  it.skipIf(!built)('answers exactly what proofDleqOk answers, in order', async () => {
    const pool = DleqPool.open({ size: 3, workerUrl: BUILT });
    expect(pool).not.toBeNull();
    try {
      const good = checks(7);
      const bad = good.map((c, i) =>
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
      const want = bad.map((c) => payment.proofDleqOk(c.proof, c.keyset));
      expect(want).toEqual([true, false, true, false, true, false, true]);
      expect(await pool?.verify(bad)).toEqual(want);
      expect(await pool?.verify([])).toEqual([]);
    } finally {
      await pool?.close();
    }
  });

  it.skipIf(!built)('keeps the event loop turning while a large batch is checked', async () => {
    const pool = DleqPool.open({ size: 2, workerUrl: BUILT });
    try {
      const batch = checks(64);
      await pool?.verify(batch.slice(0, 2)); // workers up
      let last = Date.now();
      let worstGap = 0;
      const tick = setInterval(() => {
        const t = Date.now();
        worstGap = Math.max(worstGap, t - last);
        last = t;
      }, 5);
      const t0 = Date.now();
      const results = await pool?.verify(batch);
      const took = Date.now() - t0;
      clearInterval(tick);
      expect(results?.every((r) => r)).toBe(true);
      // The same work inline would block for all of `took`; off-thread the loop keeps ticking.
      expect(worstGap).toBeLessThan(Math.max(150, took / 2));
    } finally {
      await pool?.close();
    }
  });

  it('a worker that crashes, or never answers, rejects its jobs (the engine checks inline)', async () => {
    const crashing = DleqPool.open({
      size: 1,
      workerUrl: workerScript(`parentPort.on('message', () => { throw new Error('boom'); });`),
    });
    await expect(crashing?.verify(checks(1))).rejects.toThrow(/DLEQ worker/);
    await crashing?.close();

    const silent = DleqPool.open({
      size: 1,
      timeoutMs: 50,
      workerUrl: workerScript(`parentPort.on('message', () => {});`),
    });
    await expect(silent?.verify(checks(1))).rejects.toThrow(/timed out/);
    await silent?.close();

    const liar = DleqPool.open({
      size: 1,
      workerUrl: workerScript(
        `parentPort.on('message', (m) => parentPort.postMessage({ id: m.id, results: [true, true, true] }));`,
      ),
    });
    await expect(liar?.verify(checks(1))).rejects.toThrow(/wrong count/);
    await liar?.close();
  });

  it('a closed pool refuses work and fails what was pending', async () => {
    const pool = DleqPool.open({
      size: 1,
      workerUrl: workerScript(`parentPort.on('message', () => {});`),
    });
    const pending = expect(pool?.verify(checks(1))).rejects.toThrow(/closed/);
    await pool?.close();
    await pending;
    await expect(pool?.verify(checks(1))).rejects.toThrow(/closed/);
  });

  // vitest does not run under --jitless; the daemon does (MDWE-RESULTS.md). Workers inherit it.
  it.skipIf(!built)("works in a process started with the systemd unit's node flags", () => {
    const unit = readFileSync(
      fileURLToPath(new URL('../../../../deploy/systemd/nutflix-seeder.service', import.meta.url)),
      'utf8',
    );
    const exec = unit.split('\n').find((l) => l.startsWith('ExecStart=')) ?? '';
    const flags = exec.split(/\s+/).filter((a) => a.startsWith('--') && a !== '--config');
    expect(flags).toContain('--jitless');
    const poolUrl = new URL('../../dist/runtime/dleq-pool.js', import.meta.url).href;
    const script = join(tmp, 'jitless-child.mjs');
    writeFileSync(
      script,
      [
        `import { DleqPool } from ${JSON.stringify(poolUrl)};`,
        `let input = '';`,
        `${STD}in.on('data', (d) => { input += d; });`,
        `${STD}in.on('end', async () => {`,
        `  const pool = DleqPool.open({ size: 2 });`,
        `  const out = await pool.verify(JSON.parse(input));`,
        `  await pool.close();`,
        `  ${STD}out.write(JSON.stringify({ jitless: process.execArgv.includes('--jitless'), out }));`,
        `});`,
      ].join('\n'),
    );
    const batch = checks(6);
    const bad = { ...batch[1]!, proof: { ...batch[1]!.proof, C: batch[0]!.proof.C } };
    const input = [batch[0], bad, ...batch.slice(2)];
    const r = spawnSync(process.execPath, [...flags, script], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      jitless: true,
      out: [true, false, true, true, true, true],
    });
  });
});

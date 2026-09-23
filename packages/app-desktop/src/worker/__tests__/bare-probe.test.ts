/**
 * The day-1 probe under the REAL Bare runtime (design §6 L6-C "Day 1", risk 4): bare-sidecar's
 * prebuilt `bare` loads `@sovit/seeder` through its `bare` export condition, `@sovit/core`
 * and `@sovit/gateway/upstream` after D6's globals; a Seeder with the `bare-fs` + libsodium
 * adapters round-trips a blob; the gated blob server (on `bare-http1`) answers ranges.
 * Same steps as `scripts/bare-probe.ts`; the Node twin of the checks runs in `probe.test.ts`.
 */
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WorkerToHost } from '../../ipc/worker-protocol.js';
import type { ProbeReport } from '../probe.js';
import { WORKER_SRC, bundleForBare, spawnBare } from './helpers/bare.js';

let bundle: { readonly file: string; cleanup(): Promise<void> };

beforeAll(async () => {
  bundle = await bundleForBare(join(WORKER_SRC, 'probe-entry.ts'));
});
afterAll(async () => {
  await bundle.cleanup();
});

describe('day-1 probe under the real bare', () => {
  it('every step passes', { timeout: 30_000 }, async () => {
    const w = spawnBare(bundle.file);
    const log = await w.next(
      (m): m is Extract<WorkerToHost, { e: 'log' }> => m.op === 'ev' && m.e === 'log',
      20_000,
      'the probe report',
    );
    const report = JSON.parse(log.msg) as ProbeReport;
    const failed = report.steps.filter((s) => !s.ok);
    expect(failed).toEqual([]);
    expect(report.ok).toBe(true);
    // Under Bare the seeder resolved its runtime-portable entry (no Node adapters).
    expect(report.steps.find((s) => s.name === 'imports: @sovit/seeder')?.detail).toBe('portable');
    expect(report.steps.length).toBeGreaterThanOrEqual(20);
    expect(await w.exited).toBe(0);
    expect(w.invalid).toEqual([]);
  });
});

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const repoRoot = resolve(import.meta.dirname, '..', '..');
export const scriptsDir = resolve(import.meta.dirname, '..');
export const fixtures = join(scriptsDir, '__fixtures__');

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** The signal that ended the child: `SIGTERM` when `timeout` killed it, else null. */
  signal?: NodeJS.Signals | null;
}

/**
 * Run a script in scripts/ black-box, the way `npm run ci` and CI do. `timeout` (ms) bounds a
 * child that could block: spawnSync holds the event loop, so vitest's own timeout cannot fire.
 */
export function runNode(
  script: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): RunResult {
  const r = spawnSync(process.execPath, [join(scriptsDir, script), ...args], {
    cwd: opts.cwd ?? repoRoot,
    env: { ...process.env, ...opts.env },
    encoding: 'utf8',
    ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, signal: r.signal };
}

export function runBash(
  script: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): RunResult {
  const r = spawnSync('bash', [join(scriptsDir, script), ...args], {
    cwd: opts.cwd ?? repoRoot,
    env: { ...process.env, ...opts.env },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `nutflix-${prefix}-`));
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

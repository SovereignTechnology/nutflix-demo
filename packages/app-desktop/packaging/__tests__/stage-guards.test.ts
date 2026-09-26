/**
 * Issue #6 (ADR 0017), independent review of the packaging lane: the staging step's own
 * fail-closed checks, each driven by a small synthetic repo (a lockfile, a few installed
 * packages, and tiny main/host/worker sources) so a single rule can be broken at a time:
 *
 *   - main's bundle may hold only src/main and src/ipc;
 *   - the worker's bundle only src/worker and src/ipc;
 *   - the DLEQ thread entry's bundle only src/worker/pay and src/ipc, and it must exist (lane I1);
 *   - the host's bundle no worker/main/renderer code and no native package inlined;
 *   - every lockfile closure package must be installed;
 *   - every package a bundle imports must be shipped;
 *   - bare-sidecar (loaded at runtime, invisible to the bundler) must be shipped.
 *
 * (stage.test.ts stages the REAL app; this file breaks one rule per case.)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NOT_SHIPPED, PRELOAD_FILES, PROMPT_FILES, RENDERER_FILES } from '../identity.ts';
import { StageError, stageApp } from '../stage.ts';

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nf-stage-guards-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

interface Fixture {
  /** Extra `packages/app` dependencies, and their lockfile entries. */
  deps?: Record<string, { installed: boolean }>;
  /** Leave bare-sidecar out of the app's dependencies. */
  noSidecar?: boolean;
  /** Source overrides, relative to packages/app/src. */
  src?: Record<string, string>;
  /** Sources left out, relative to packages/app/src. */
  omit?: readonly string[];
}

/** A synthetic repo whose app stages cleanly unless a case breaks one thing. */
function fixture(f: Fixture = {}): { pkg: string; root: string } {
  const pkg = join(root, 'packages', 'app');
  put(join(pkg, 'package.json'), JSON.stringify({ name: '@s/app', version: '0.1.0' }));
  for (const t of ['tsconfig.main.json', 'tsconfig.host.json', 'tsconfig.worker.json'])
    put(join(pkg, t), '{}');
  for (const n of RENDERER_FILES) put(join(pkg, 'dist', 'renderer', n), n);
  for (const n of PROMPT_FILES) put(join(pkg, 'dist', 'prompt', n), n);
  for (const n of PRELOAD_FILES) put(join(pkg, 'dist', n), n);
  const src: Record<string, string> = {
    'main/main.ts': "import { x } from '../ipc/x.ts';\nexport const m = x;\n",
    'ipc/x.ts': 'export const x = 1;\n',
    'host/main.ts': "import { x } from '../ipc/x.ts';\nexport const h = x;\n",
    'worker/entry.ts': "import 'bare-encoding/global';\nexport const w = 1;\n",
    'worker/other.ts': 'export const o = 1;\n',
    // The DLEQ thread entry's shape (lane I1): every import dynamic, inside the try.
    'worker/pay/dleq-thread-entry.mts':
      "async function main() {\n  try {\n    await import('../bare-globals.js');\n    const { serve } = await import('./serve.ts');\n    serve();\n  } catch {\n    // FAIL\n  }\n}\nvoid main();\n",
    'worker/pay/serve.ts':
      "import { x } from '../../ipc/x.ts';\nexport const serve = (): number => x;\n",
    'renderer/r.ts': 'export const r = 1;\n',
    ...f.src,
  };
  for (const [p, c] of Object.entries(src))
    if (!(f.omit ?? []).includes(p)) put(join(pkg, 'src', p), c);

  put(join(root, 'node_modules', 'electron', 'package.json'), '{"version":"44.2.0"}');
  const deps: Record<string, string> = {};
  // The excluded roots must be real dependencies of the app (runtimeClosure checks).
  for (const n of Object.keys(NOT_SHIPPED)) deps[n] = '1';
  const packages: Record<string, unknown> = {
    '': { name: 'repo' },
    'node_modules/electron': { version: '44.2.0', dev: true },
    'node_modules/bare-encoding': { version: '1.0.0' },
  };
  deps['bare-encoding'] = '1';
  put(join(root, 'node_modules', 'bare-encoding', 'package.json'), '{"name":"bare-encoding"}');
  put(join(root, 'node_modules', 'bare-encoding', 'global.js'), 'globalThis.x = 1\n');
  if (f.noSidecar !== true) {
    deps['bare-sidecar'] = '1';
    packages['node_modules/bare-sidecar'] = { version: '0.5.4' };
    const sc = join(root, 'node_modules', 'bare-sidecar');
    put(join(sc, 'package.json'), '{"name":"bare-sidecar","main":"index.js"}');
    put(join(sc, 'index.js'), 'module.exports = class Sidecar {}\n');
    put(join(sc, 'prebuilds', 'linux-x64', 'bare'), '#!/bin/sh\n');
  }
  for (const [n, d] of Object.entries(f.deps ?? {})) {
    deps[n] = '1';
    packages[`node_modules/${n}`] = { version: '1.0.0' };
    if (d.installed) put(join(root, 'node_modules', n, 'package.json'), `{"name":"${n}"}`);
  }
  packages['packages/app'] = { name: '@s/app', version: '0.1.0', dependencies: deps };
  put(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
  return { pkg, root };
}

let runs = 0;
/** Stages the fixture into a fresh `out-<n>` (a failed stage leaves a partial tree behind). */
const stage = (f: Fixture = {}): Promise<unknown> => {
  const { pkg, root: repoRoot } = fixture(f);
  const out = join(root, `out-${String(++runs)}`);
  return stageApp({ out, platform: 'linux', arch: 'x64', pkgDir: pkg, repoRoot });
};

// Each case runs up to three esbuild builds. Alone the slowest takes under 1 s, but in a full
// parallel run beside stage.test.ts (which gives the real staging 120 s) and the
// packaged-worker integration test's own staging, the first case was measured at 6.8 s, over
// vitest's 5 s default. 30 s bounds a hang without flaking under that load.
describe('stageApp guards (synthetic repo)', { timeout: 30_000 }, () => {
  it('the unbroken fixture stages (so each case below fails for its own reason)', async () => {
    const r = (await stage()) as {
      packages: { name: string }[];
      externals: { worker: string[]; dleqThread: string[] };
    };
    expect(r.packages.map((p) => p.name).sort()).toEqual(['bare-encoding', 'bare-sidecar']);
    expect(r.externals.worker).toEqual(['bare-encoding']);
    // bare-globals.js became `bare-encoding/global` (D6), as in the worker bundle.
    expect(r.externals.dleqThread).toEqual(['bare-encoding']);
  });

  it('the DLEQ thread entry must exist (lane I1: without it every check runs on the loop)', async () => {
    await expect(stage({ omit: ['worker/pay/dleq-thread-entry.mts'] })).rejects.toThrow(
      /src\/worker\/pay\/dleq-thread-entry\.mts is missing/,
    );
  });

  it('the DLEQ thread entry may bundle only src/worker/pay and src/ipc', async () => {
    await expect(
      stage({
        src: {
          'worker/pay/dleq-thread-entry.mts':
            "async function main() {\n  try {\n    await import('../other.ts');\n  } catch {}\n}\nvoid main();\n",
        },
      }),
    ).rejects.toThrow(
      /DLEQ thread bundle may only contain src\/worker\/pay and src\/ipc:[\s\S]*worker[\\/]other\.ts/,
    );
  });

  it('a package the DLEQ thread entry imports must be shipped', async () => {
    await expect(
      stage({
        src: {
          'worker/pay/dleq-thread-entry.mts':
            "async function main() {\n  try {\n    await import('left-pad');\n  } catch {}\n}\nvoid main();\n",
        },
      }),
    ).rejects.toThrow(/bundles import packages the closure does not ship: left-pad/);
  });

  it('main may bundle only src/main and src/ipc', async () => {
    await expect(
      stage({
        src: { 'main/main.ts': "import { r } from '../renderer/r.ts';\nexport const m = r;\n" },
      }),
    ).rejects.toThrow(
      /main bundle may only contain src\/main and src\/ipc:[\s\S]*renderer[\\/]r\.ts/,
    );
  });

  it('the worker may bundle only src/worker and src/ipc', async () => {
    await expect(
      stage({
        src: {
          'worker/entry.ts':
            "import 'bare-encoding/global';\nimport { h } from '../host/main.ts';\nexport const w = h;\n",
        },
      }),
    ).rejects.toThrow(
      /worker bundle may only contain src\/worker and src\/ipc:[\s\S]*host[\\/]main\.ts/,
    );
  });

  it('the host may not bundle worker, main or renderer code', async () => {
    for (const dir of ['worker/other.ts', 'main/main.ts', 'renderer/r.ts'])
      await expect(
        stage({
          src: { 'host/main.ts': `import * as z from '../${dir}';\nexport const h = z;\n` },
        }),
        dir,
      ).rejects.toThrow(
        /host bundle may not contain worker\/main\/renderer code or native packages/,
      );
  });

  it('the host may not inline a native package (reached by a relative path, past `external`)', async () => {
    await expect(
      stage({
        src: {
          'host/main.ts':
            "import S from '../../../../node_modules/bare-sidecar/index.js';\nexport const h = S;\n",
        },
      }),
    ).rejects.toThrow(/host bundle may not contain[\s\S]*node_modules[\\/]bare-sidecar/);
  });

  it('a closure package the lockfile lists but that is not installed', async () => {
    await expect(stage({ deps: { ghost: { installed: false } } })).rejects.toThrow(
      /node_modules\/ghost is in the lockfile but not installed/,
    );
  });

  it('a package a bundle imports that the closure does not ship', async () => {
    await expect(
      stage({
        src: {
          'worker/entry.ts':
            "import 'bare-encoding/global';\nimport pad from 'left-pad';\nexport const w = pad;\n",
        },
      }),
    ).rejects.toThrow(/bundles import packages the closure does not ship: left-pad/);
  });

  it('bare-sidecar must be shipped (the host loads it at runtime, unseen by the bundler)', async () => {
    const err = await stage({ noSidecar: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StageError);
    expect(String(err)).toMatch(/bare-sidecar is not shipped/);
  });
});

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
 *   - bare-sidecar (loaded at runtime, invisible to the bundler) must be shipped;
 *   - the build the stage copies must be current (cross-lane review, round 4): no workspace
 *     package tsc would rebuild, no UI stylesheet older than its sources, no bundle output
 *     older than what the bundles read (round 5: that includes @sovit/ui's dist/).
 *
 * (stage.test.ts stages the REAL app; this file breaks one rule per case.)
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NOT_SHIPPED, PRELOAD_FILES, PROMPT_FILES, RENDERER_FILES } from '../identity.ts';
import { BUNDLE_SOURCES, StageError, stageApp, testDoubleStub } from '../stage.ts';

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
  /** Round 4: a shipped workspace dependency `@s/lib` (a tsc project at packages/lib). */
  lib?: boolean;
  /** Round 4: `@sovit/ui` as a workspace link at packages/ui (a tsc project + dist/ui.css). */
  ui?: boolean;
  /** Round 4: `@sovit/core` as a shipped workspace, with test doubles like the real one's. */
  core?: boolean;
}

/** A tiny composite tsc project at `dir` (its sources are written by the caller). */
function tscProject(dir: string): void {
  put(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        composite: true,
        rootDir: 'src',
        outDir: 'dist',
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2022'],
        types: [],
        skipLibCheck: true,
      },
      include: ['src'],
    }),
  );
}

/** `tsc -b` on one project through TypeScript's API; fails the test on any diagnostic. */
function tscBuild(dir: string): void {
  const errors: string[] = [];
  const host = ts.createSolutionBuilderHost(ts.sys, undefined, (d) => {
    errors.push(ts.flattenDiagnosticMessageText(d.messageText, ' '));
  });
  const status = ts.createSolutionBuilder(host, [join(dir, 'tsconfig.json')], {}).build();
  expect(errors).toEqual([]);
  expect(status).toBe(ts.ExitStatus.Success);
}

/** Sets a file's mtime `seconds` from now (a future mtime = "edited after the build"). */
function touch(path: string, seconds: number): void {
  const t = Date.now() / 1000 + seconds;
  utimesSync(path, t, t);
}

/** A synthetic repo whose app stages cleanly unless a case breaks one thing. */
function fixture(f: Fixture = {}): { pkg: string; root: string } {
  const pkg = join(root, 'packages', 'app');
  put(join(pkg, 'package.json'), JSON.stringify({ name: '@s/app', version: '0.1.0' }));
  for (const t of ['tsconfig.main.json', 'tsconfig.host.json', 'tsconfig.worker.json'])
    put(join(pkg, t), '{}');
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
  // The bundle outputs are written AFTER the sources, as `npm run build` leaves them (round 4:
  // staging refuses a bundle output older than the bundles' sources).
  for (const n of RENDERER_FILES) put(join(pkg, 'dist', 'renderer', n), n);
  for (const n of PROMPT_FILES) put(join(pkg, 'dist', 'prompt', n), n);
  for (const n of PRELOAD_FILES) put(join(pkg, 'dist', n), n);

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
  if (f.lib === true) {
    const lib = join(root, 'packages', 'lib');
    deps['@s/lib'] = '0.1.0';
    packages['node_modules/@s/lib'] = { resolved: 'packages/lib', link: true };
    packages['packages/lib'] = { name: '@s/lib', version: '0.1.0' };
    put(
      join(lib, 'package.json'),
      JSON.stringify({
        name: '@s/lib',
        version: '0.1.0',
        type: 'module',
        files: ['dist'],
        exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      }),
    );
    tscProject(lib);
    put(join(lib, 'src', 'index.ts'), 'export const meltTimeoutMs = 300_000;\n');
    tscBuild(lib);
  }
  if (f.ui === true) {
    // Already an app dependency (NOT_SHIPPED); here it also resolves to a workspace directory.
    const ui = join(root, 'packages', 'ui');
    packages['node_modules/@sovit/ui'] = { resolved: 'packages/ui', link: true };
    packages['packages/ui'] = { name: '@sovit/ui', version: '0.0.0' };
    put(join(ui, 'package.json'), JSON.stringify({ name: '@sovit/ui', version: '0.0.0' }));
    tscProject(ui);
    put(join(ui, 'src', 'index.ts'), 'export const Button = 1;\n');
    put(join(ui, 'src', 'ui.css'), '.button{}\n');
    tscBuild(ui);
    put(join(ui, 'dist', 'ui.css'), '.button{}\n'); // its build:css
    // …then scripts/bundle.ts, which inlines it: the app's bundle outputs come last.
    for (const n of RENDERER_FILES) put(join(pkg, 'dist', 'renderer', n), n);
    for (const n of PROMPT_FILES) put(join(pkg, 'dist', 'prompt', n), n);
    for (const n of PRELOAD_FILES) put(join(pkg, 'dist', n), n);
  }
  if (f.core === true) {
    // The real core's shape: its barrel re-exports the test doubles (`mocks`, and FakeRelayPool
    // through `nostr`), and the host imports the barrel.
    const core = join(root, 'packages', 'core');
    deps['@sovit/core'] = '0.0.0';
    packages['node_modules/@sovit/core'] = { resolved: 'packages/core', link: true };
    packages['packages/core'] = { name: '@sovit/core', version: '0.0.0' };
    put(
      join(core, 'package.json'),
      JSON.stringify({
        name: '@sovit/core',
        version: '0.0.0',
        type: 'module',
        files: ['dist'],
        exports: { '.': './dist/index.js' },
      }),
    );
    tscProject(core);
    const coreSrc: Record<string, string> = {
      'index.ts':
        "export * as mocks from './mocks/index.js';\nexport * as nostr from './nostr/index.js';\nexport const real = 'REAL-CORE';\n",
      'mocks/index.ts': "export * from './test-mint.js';\nexport const ME = 'fixture-me';\n",
      'mocks/test-mint.ts': "export class TestMint {\n  readonly marker = 'TEST-MINT-BODY';\n}\n",
      'nostr/index.ts':
        "export { FakeRelayPool } from './fake-relay.js';\nexport const live = 1;\n",
      'nostr/fake-relay.ts':
        "export class FakeRelayPool {\n  readonly marker = 'FAKE-RELAY-BODY';\n}\n",
    };
    for (const [p, c] of Object.entries(coreSrc)) put(join(core, 'src', p), c);
    tscBuild(core);
    mkdirSync(join(root, 'node_modules', '@sovit'), { recursive: true });
    if (!existsSync(join(root, 'node_modules', '@sovit', 'core')))
      symlinkSync(
        join('..', '..', 'packages', 'core'),
        join(root, 'node_modules', '@sovit', 'core'),
      );
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

describe(
  'stageApp refuses a build older than its sources (cross-lane review, round 4)',
  {
    timeout: 30_000,
  },
  () => {
    /** Stages the SAME fixture again into `out` (the fixture is not rewritten). */
    const restage = (pkg: string, repoRoot: string, out: string): Promise<unknown> =>
      stageApp({ out, platform: 'linux', arch: 'x64', pkgDir: pkg, repoRoot });

    it('a shipped workspace package whose dist/ is not built from its current sources', async () => {
      const { pkg, root: repoRoot } = fixture({ lib: true });
      const out = join(root, 'out-lib');
      const staged = join(out, 'node_modules', '@s', 'lib', 'dist', 'index.js');
      await restage(pkg, repoRoot, out);
      expect(readFileSync(staged, 'utf8')).toMatch(/300_000/);
      // The reviewer's case: a source changed after the build, and nobody rebuilt.
      const src = join(repoRoot, 'packages', 'lib', 'src', 'index.ts');
      writeFileSync(src, 'export const meltTimeoutMs = 123_456;\n');
      touch(src, 5);
      const err = await restage(pkg, repoRoot, out).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StageError);
      expect(String(err)).toMatch(
        /a workspace build is older than its sources \(A non-dry build would build project '[^']*packages[\\/]lib[\\/]tsconfig\.json'\): run `npm run build`/,
      );
      // Refused before `out` was touched: the previous stage is still there, unchanged.
      expect(readFileSync(staged, 'utf8')).toMatch(/300_000/);
      // Rebuilt, it stages — and ships the new value.
      tscBuild(join(repoRoot, 'packages', 'lib'));
      await restage(pkg, repoRoot, out);
      expect(readFileSync(staged, 'utf8')).toMatch(/123_456/);
      // A source only touched (content as built) is current: tsc would just update timestamps.
      touch(src, 10);
      await expect(restage(pkg, repoRoot, out)).resolves.toBeDefined();
    });

    it('a shipped workspace package whose entry point was deleted (tsc still calls it up to date)', async () => {
      const { pkg, root: repoRoot } = fixture({ lib: true });
      rmSync(join(repoRoot, 'packages', 'lib', 'dist', 'index.js'));
      await expect(restage(pkg, repoRoot, join(root, 'out-noentry'))).rejects.toThrow(
        /packages\/lib\/dist\/index\.js is missing: run `npx tsc -b --force`, then `npm run build`/,
      );
    });

    it('a workspace package without a tsconfig.json cannot be checked, so it is refused', async () => {
      const { pkg, root: repoRoot } = fixture({ lib: true });
      rmSync(join(repoRoot, 'packages', 'lib', 'tsconfig.json'));
      await expect(restage(pkg, repoRoot, join(root, 'out-nocfg'))).rejects.toThrow(
        /packages\/lib has no tsconfig\.json: cannot tell whether its dist\/ is current/,
      );
    });

    it.each(BUNDLE_SOURCES)(
      'a bundle output older than a file under %s is refused; tests and stories are not inputs',
      async (dir) => {
        const { pkg, root: repoRoot } = fixture();
        const out = join(root, 'out-bundle');
        await restage(pkg, repoRoot, out);
        // Not bundle inputs: a test, a snapshot directory, a story.
        for (const f of ['__tests__/late.test.ts', 'late.test.ts', 'late.stories.tsx']) {
          put(join(pkg, dir, f), 'x\n');
          touch(join(pkg, dir, f), 60);
        }
        await expect(restage(pkg, repoRoot, out)).resolves.toBeDefined();
        put(join(pkg, dir, 'late.ts'), 'x\n');
        touch(join(pkg, dir, 'late.ts'), 60);
        await expect(restage(pkg, repoRoot, out)).rejects.toThrow(
          new RegExp(
            `dist/\\S+ is older than packages/app/${dir}/late\\.ts: run \`npm run build\``,
          ),
        );
        expect(existsSync(join(out, 'package.json'))).toBe(true);
      },
    );

    it('@sovit/ui (bundled into the renderer): its tsc build, its stylesheet, then the bundles', async () => {
      const { pkg, root: repoRoot } = fixture({ ui: true });
      const out = join(root, 'out-ui');
      const ui = join(repoRoot, 'packages', 'ui');
      await restage(pkg, repoRoot, out);
      // build:css not rerun after a stylesheet edit.
      touch(join(ui, 'src', 'ui.css'), 60);
      await expect(restage(pkg, repoRoot, out)).rejects.toThrow(
        /packages\/ui\/dist\/ui\.css is older than packages\/ui\/src\/ui\.css: run `npm run build`/,
      );
      touch(join(ui, 'dist', 'ui.css'), 61);
      // The UI's css rebuilt, but scripts/bundle.ts (which copies it into renderer/) not rerun.
      // Round 5: the newest input named is now the file the bundle actually copies, ui's
      // dist/ui.css (61), not the src stylesheet it is built from (60): rule (3) compares the
      // bundle outputs against ui's dist/ too (cross-lane review round 5, `bundleInputDirs`).
      await expect(restage(pkg, repoRoot, out)).rejects.toThrow(
        /dist\/\S+ is older than packages\/ui\/dist\/ui\.css: run `npm run build`/,
      );
      for (const f of [
        ...RENDERER_FILES.map((n) => join('renderer', n)),
        ...PROMPT_FILES.map((n) => join('prompt', n)),
        ...PRELOAD_FILES,
      ])
        touch(join(pkg, 'dist', f), 62);
      await expect(restage(pkg, repoRoot, out)).resolves.toBeDefined();
      // A UI source edited and not rebuilt: tsc would rebuild the UI package.
      writeFileSync(join(ui, 'src', 'index.ts'), 'export const Button = 2;\n');
      touch(join(ui, 'src', 'index.ts'), 70);
      await expect(restage(pkg, repoRoot, out)).rejects.toThrow(
        /would build project '[^']*packages[\\/]ui[\\/]tsconfig\.json'/,
      );
    });

    /** The fixture's scripts/bundle.ts: writes every output at `at`, app.js inlining ui's dist. */
    const bundleAt = (pkg: string, ui: string, at: number): void => {
      for (const f of [
        ...RENDERER_FILES.map((n) => join('renderer', n)),
        ...PROMPT_FILES.map((n) => join('prompt', n)),
        ...PRELOAD_FILES,
      ]) {
        const p = join(pkg, 'dist', f);
        if (f === join('renderer', 'app.js'))
          writeFileSync(p, readFileSync(join(ui, 'dist', 'index.js')));
        if (f === join('renderer', 'ui.css'))
          writeFileSync(p, readFileSync(join(ui, 'dist', 'ui.css')));
        touch(p, at);
      }
    };

    // Cross-lane review round 5, the verifier's probe: the bundle reads @sovit/ui's dist/, not
    // its src/. (1) edit a ui source, (2) bundle (`npm start` bundles before any tsc: it inlines
    // the OLD ui/dist), (3) tsc the ui (`npm run typecheck`), (4) stage. Every other rule passes:
    // tsc's dry run is clean, the css is current, and the bundle is newer than ui/src. Before
    // round 5 this staged the old renderer.
    it('a bundle made from an old @sovit/ui dist/ (ui rebuilt after the bundle) is refused', async () => {
      const { pkg, root: repoRoot } = fixture({ ui: true });
      const out = join(root, 'out-ui-dist');
      const ui = join(repoRoot, 'packages', 'ui');
      await restage(pkg, repoRoot, out);
      writeFileSync(join(ui, 'src', 'index.ts'), 'export const Button = 2;\n'); // (1)
      touch(join(ui, 'src', 'index.ts'), 60);
      bundleAt(pkg, ui, 61); // (2)
      expect(readFileSync(join(pkg, 'dist', 'renderer', 'app.js'), 'utf8')).toMatch(/Button = 1/);
      tscBuild(ui); // (3)
      touch(join(ui, 'dist', 'index.js'), 62); // …after the bundle (the fixture's clock is ahead)
      expect(readFileSync(join(ui, 'dist', 'index.js'), 'utf8')).toMatch(/Button = 2/);
      await expect(restage(pkg, repoRoot, out)).rejects.toThrow(
        /dist\/\S+ is older than packages\/ui\/dist\/index\.js: run `npm run build`/,
      );
      // Bundled again from the current ui/dist, it stages, and ships the new value.
      bundleAt(pkg, ui, 63);
      await restage(pkg, repoRoot, out);
      expect(readFileSync(join(out, 'renderer', 'app.js'), 'utf8')).toMatch(/Button = 2/);
    });

    it("the same with ui's stylesheet: bundled (copying the old dist/ui.css), then build:css", async () => {
      const { pkg, root: repoRoot } = fixture({ ui: true });
      const out = join(root, 'out-ui-css');
      const ui = join(repoRoot, 'packages', 'ui');
      await restage(pkg, repoRoot, out);
      writeFileSync(join(ui, 'src', 'ui.css'), '.button{color:red}\n');
      touch(join(ui, 'src', 'ui.css'), 60);
      bundleAt(pkg, ui, 61);
      writeFileSync(join(ui, 'dist', 'ui.css'), '.button{color:red}\n'); // build:css
      touch(join(ui, 'dist', 'ui.css'), 62);
      await expect(restage(pkg, repoRoot, out)).rejects.toThrow(
        /dist\/\S+ is older than packages\/ui\/dist\/ui\.css: run `npm run build`/,
      );
      bundleAt(pkg, ui, 63);
      await restage(pkg, repoRoot, out);
      expect(readFileSync(join(out, 'renderer', 'ui.css'), 'utf8')).toMatch(/color:red/);
    });
  },
);

/** Runs `script` as an ES module in a plain Node child (no vitest transform); its stdout. */
function nodeModule(script: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe(
  "core's test doubles stay out of the packaged host bundle (cross-lane review, round 4)",
  {
    timeout: 30_000,
  },
  () => {
    const HOST =
      "import { mocks, nostr, real } from '@sovit/core';\n" +
      'export const h = real;\n' +
      'export const dev = (): unknown => new mocks.TestMint();\n' +
      'export const pool = (): unknown => new nostr.FakeRelayPool();\n' +
      'export const me = (): unknown => mocks.ME;\n';

    it('the barrel stays, its test-double modules are stubs that throw when touched; the worker copy is unchanged', async () => {
      const { pkg, root: repoRoot } = fixture({ core: true, src: { 'host/main.ts': HOST } });
      const out = join(root, 'out-core');
      await stageApp({ out, platform: 'linux', arch: 'x64', pkgDir: pkg, repoRoot });
      const host = readFileSync(join(out, 'host', 'main.js'), 'utf8');
      expect(host).toContain('REAL-CORE');
      expect(host).not.toMatch(/TEST-MINT-BODY|FAKE-RELAY-BODY|class TestMint|class FakeRelayPool/);
      expect(host).toContain('// nutflix-packaged-test-double:mocks/index.js');
      expect(host).toContain('// nutflix-packaged-test-double:nostr/fake-relay.js');
      expect(host).not.toContain(repoRoot); // no build-machine path in the stub's module name
      // The bundle loads; the real export works; each test double throws only when touched.
      const url = JSON.stringify(pathToFileURL(join(out, 'host', 'main.js')).href);
      const r = nodeModule(
        `const m = await import(${url});\n` +
          'const t = (f) => { try { f(); return "ok"; } catch (e) { return e.message; } };\n' +
          'console.log(JSON.stringify([m.h, t(m.dev), t(m.pool), typeof m.me(), t(() => String(m.me()))]));',
      );
      expect(r.stderr).toBe('');
      expect(JSON.parse(r.stdout)).toEqual([
        'REAL-CORE',
        "TestMint: core's test doubles are not in a packaged build",
        "FakeRelayPool: core's test doubles are not in a packaged build",
        'function',
        "ME: core's test doubles are not in a packaged build",
      ]);
      // Only the host bundle: the worker's copy of core (node_modules/) keeps the real modules.
      expect(
        readFileSync(
          join(out, 'node_modules', '@sovit', 'core', 'dist', 'mocks', 'test-mint.js'),
          'utf8',
        ),
      ).toContain('TEST-MINT-BODY');
    });

    it('a test double reached past the barrel (a deep import) is refused, not inlined', async () => {
      await expect(
        stage({
          core: true,
          src: {
            'host/main.ts':
              "import { TestMint } from '../../../core/dist/mocks/test-mint.js';\nexport const h = TestMint;\n",
          },
        }),
      ).rejects.toThrow(
        /host bundle may not contain core's test doubles:[\s\S]*mocks[\\/]test-mint\.js/,
      );
    });

    it('testDoubleStub: every export a throwing value; names it cannot bind are refused', () => {
      const src = testDoubleStub(['TestMint', 'MINTS']);
      expect(src).toContain('export const MINTS = __nfRefused("MINTS");');
      expect(src).toContain('export const TestMint = __nfRefused("TestMint");');
      const file = join(root, 'stub.mjs');
      writeFileSync(file, src);
      const r = nodeModule(
        `const m = await import(${JSON.stringify(pathToFileURL(file).href)});\n` +
          'const t = (f) => { try { f(); return "ok"; } catch (e) { return e.message; } };\n' +
          'console.log(JSON.stringify([t(() => new m.TestMint()), t(() => m.TestMint()), t(() => m.MINTS.a),' +
          ' t(() => ({}) instanceof m.TestMint), t(() => { m.MINTS.a = 1; }), t(() => "a" in m.MINTS), t(() => Object.keys(m.MINTS))]));',
      );
      expect(r.stderr).toBe('');
      const msg = (n: string): string => `${n}: core's test doubles are not in a packaged build`;
      expect(JSON.parse(r.stdout)).toEqual([
        msg('TestMint'),
        msg('TestMint'),
        msg('MINTS'),
        msg('TestMint'),
        msg('MINTS'),
        msg('MINTS'),
        msg('MINTS'),
      ]);
      expect(() => testDoubleStub(['default'])).toThrow(
        /cannot stub a test double exporting default/,
      );
      expect(() => testDoubleStub(['a-b'])).toThrow(StageError);
      expect(() => testDoubleStub(['__nfRefused'])).toThrow(StageError);
    });
  },
);

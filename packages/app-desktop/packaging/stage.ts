/**
 * Stages the packaged app (issue #6, ADR 0017): a standalone directory Electron Forge packages
 * as-is (asar on, packager's prune off). Layout — the same as `dist/`, so main's path logic is
 * unchanged, except the worker:
 *
 *   package.json              name, productName, version, main, "type": "module"
 *   main/main.js              Electron main, bundled (src/main + src/ipc only; `electron` external)
 *   host/main.js              the host utilityProcess, bundled WITH its npm code (@sovit/core,
 *                             cashu-ts, nostr-tools…) so the money and signer code the host runs
 *                             lives inside app.asar; only native packages stay external
 *   preload.cjs, prompt-preload.cjs, renderer/, prompt/   copied from scripts/bundle.ts output
 *   worker/boot.mjs           UNBUNDLED boot module: `bare-encoding/global` first (D6), then…
 *   worker/worker.mjs         the worker bundle (our sources only; every npm package stays an
 *                             import that Bare resolves itself — export conditions, addons)
 *   node_modules/             the lockfile runtime closure (closure.ts), native prebuilds for the
 *                             target platform only, workspace packages as real directories
 *
 * `worker/` and `node_modules/` are unpacked from the asar (identity.ts `UNPACKED_DIRS`).
 * Needs `npm run build` first (tsc, ui css, scripts/bundle.ts). Never writes outside `out`.
 *
 *   node packaging/stage.ts [--out <dir>] [--platform <p>] [--arch <a>]
 */
import { build, type Metafile, type Plugin } from 'esbuild';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { keepPrebuild, runtimeClosure, type ClosureEntry, type Lockfile } from './closure.ts';
import {
  APP,
  NOT_SHIPPED,
  PACKAGED_WORKER_BUNDLE,
  PACKAGED_WORKER_ENTRY,
  PRELOAD_FILES,
  PROMPT_FILES,
  RENDERER_FILES,
} from './identity.ts';

export const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(PKG_DIR, '..', '..');

/**
 * D6: the worker's first module, never bundled. A bundle hoists every external import of every
 * module to its top, in the bundler's order, so an inlined globals module could run after
 * `@sovit/core` (which builds a `TextDecoder` at load). This module evaluates
 * `bare-encoding/global` before the bundle is even requested. A failed load rejects, which
 * Bare reports and exits on — the host then restarts it with back-off, then gives up.
 */
export const WORKER_BOOT_SOURCE =
  "import 'bare-encoding/global'\nimport('./worker.mjs').catch((e) => {\n  throw e\n})\n";

/** Electron 44.2.0: Chromium 152, Node 24.20. */
const NODE_TARGET = 'node24';

export interface StageOptions {
  readonly out: string;
  readonly platform: string;
  readonly arch: string;
  /** Defaults: this package and the repo root it belongs to. */
  readonly pkgDir?: string;
  readonly repoRoot?: string;
}

export interface StageReport {
  readonly out: string;
  readonly packages: readonly ClosureEntry[];
  readonly files: number;
  readonly bytes: number;
  /** Bare specifiers the host and worker bundles import (each resolves in `node_modules/`). */
  readonly externals: { readonly host: readonly string[]; readonly worker: readonly string[] };
}

export class StageError extends Error {
  override readonly name = 'StageError' as const;
}

function fail(msg: string): never {
  throw new StageError(msg);
}

/** Metafile inputs as absolute paths. */
function inputsOf(meta: Metafile, cwd: string): string[] {
  return Object.keys(meta.inputs).map((p) => (p.includes(':') ? p : resolve(cwd, p)));
}

/** The bare package names an output imports as externals (`@a/b/sub` → `@a/b`). */
function externalPackages(meta: Metafile): string[] {
  const names = new Set<string>();
  for (const out of Object.values(meta.outputs))
    for (const imp of out.imports)
      if (imp.external && !imp.path.startsWith('node:') && !imp.path.startsWith('.')) {
        const parts = imp.path.split('/');
        names.add(imp.path.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? ''));
      }
  return [...names].sort();
}

/** Inside the worker bundle, `bare-globals.js` becomes the (idempotent) external global module. */
const d6FirstImport: Plugin = {
  name: 'd6-first-import',
  setup(b) {
    b.onResolve({ filter: /[\\/]bare-globals\.js$/ }, () => ({
      path: 'bare-encoding/global',
      external: true,
    }));
  },
};

/** Whether an installed package carries native code (then the host bundle leaves it external). */
function isNative(dir: string): boolean {
  if (existsSync(join(dir, 'prebuilds')) || existsSync(join(dir, 'binding.gyp'))) return true;
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    addon?: unknown;
    gypfile?: unknown;
  };
  return pj.addon === true || pj.gypfile === true;
}

interface CopyStats {
  files: number;
  bytes: number;
}

/**
 * Copies one package directory. Symlinks are refused (their content would come from outside
 * the reviewed tree); nested `node_modules` are separate closure entries; `prebuilds/` keeps
 * the target platform only. Modes are preserved (`copyFileSync` copies permission bits), so the
 * `bare` runtime stays executable — the host refuses it otherwise (src/host/worker/sidecar.ts).
 */
export function copyPackage(
  src: string,
  dst: string,
  keep: (rel: string, isDir: boolean) => boolean,
  stats: CopyStats,
): void {
  const walk = (rel: string): void => {
    const from = join(src, rel);
    const st = lstatSync(from);
    if (st.isSymbolicLink()) fail(`symlink in a shipped package is refused: ${from}`);
    if (st.isDirectory()) {
      mkdirSync(join(dst, rel), { recursive: true });
      for (const name of readdirSync(from).sort()) {
        const child = rel === '' ? name : `${rel}/${name}`;
        const childSt = lstatSync(join(src, child));
        if (keep(child, childSt.isDirectory())) walk(child);
      }
      return;
    }
    if (!st.isFile()) fail(`unsupported entry in a shipped package: ${from}`);
    copyFileSync(from, join(dst, rel));
    stats.files++;
    stats.bytes += st.size;
  };
  walk('');
}

/** npm package filter: no nested node_modules, other platforms' prebuilds dropped. */
export function npmFilter(
  platform: string,
  arch: string,
): (rel: string, isDir: boolean) => boolean {
  return (rel, isDir) => {
    const parts = rel.split('/');
    if (parts.includes('node_modules')) return false;
    if (isDir && parts.length === 2 && parts[0] === 'prebuilds')
      return keepPrebuild(parts[1] ?? '', platform, arch);
    return true;
  };
}

/** Workspace package filter: package.json + its `files`, without tests, maps or declarations. */
export function workspaceFilter(
  files: readonly string[],
): (rel: string, isDir: boolean) => boolean {
  return (rel, isDir) => {
    const parts = rel.split('/');
    const top = parts[0] ?? '';
    if (parts.length === 1 && !isDir) return top === 'package.json' || files.includes(top);
    if (!files.includes(top)) return false;
    if (parts.includes('__tests__') || parts.includes('node_modules')) return false;
    if (isDir) return true;
    return !/\.(?:map|d\.ts|tsbuildinfo)$/.test(rel) && !rel.endsWith('.test.js');
  };
}

/**
 * Every staged directory 0755, every file 0644 — or 0755 if it was executable (the Electron
 * helpers are not here; the `bare` runtime and any package script are). Installs (a `.deb`
 * under /usr/lib, an AppImage) then never ship group-writable files, whatever the build
 * machine's umask or npm's extraction left.
 */
export function normalizeModes(root: string): void {
  const walk = (p: string): void => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) fail(`symlink in the staged tree: ${p}`);
    if (st.isDirectory()) {
      chmodSync(p, 0o755);
      for (const e of readdirSync(p)) walk(join(p, e));
    } else chmodSync(p, (st.mode & 0o111) !== 0 ? 0o755 : 0o644);
  };
  walk(root);
}

/**
 * `out` is deleted and rewritten, so it must be something this step made: absent, empty, or a
 * previous stage (its package.json names the app and it has the worker boot module). A mistyped
 * `--out ~/Projects` fails here instead of being wiped.
 */
export function assertReplaceable(out: string): void {
  if (!existsSync(out)) return;
  const st = lstatSync(out);
  if (!st.isDirectory() || st.isSymbolicLink()) fail(`${out} exists and is not a directory`);
  if (readdirSync(out).length === 0) return;
  let name: unknown;
  try {
    name = (JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')) as { name?: unknown }).name;
  } catch {
    name = undefined;
  }
  if (name !== APP.name || !existsSync(join(out, PACKAGED_WORKER_ENTRY)))
    fail(`${out} is not empty and is not a previous stage: refusing to delete it`);
}

export async function stageApp(o: StageOptions): Promise<StageReport> {
  const pkg = o.pkgDir ?? PKG_DIR;
  const root = o.repoRoot ?? REPO_ROOT;
  const dist = join(pkg, 'dist');
  const out = resolve(o.out);
  for (const f of [
    ...RENDERER_FILES.map((n) => join('renderer', n)),
    ...PROMPT_FILES.map((n) => join('prompt', n)),
    ...PRELOAD_FILES,
  ])
    if (!existsSync(join(dist, f)))
      fail(`dist/${f} is missing: run \`npm run build\` (tsc, ui css, bundle) first`);
  assertReplaceable(out);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const pj = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as { version: string };
  const electron = JSON.parse(
    readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8'),
  ) as { version: string };
  writeFileSync(
    join(out, 'package.json'),
    `${JSON.stringify(
      {
        name: APP.name,
        productName: APP.productName,
        version: pj.version,
        description: APP.description,
        author: APP.author,
        license: APP.license,
        main: 'main/main.js',
        type: 'module',
        // Read by Forge to pick the Electron version; dropped from the packaged copy.
        devDependencies: { electron: electron.version },
      },
      null,
      2,
    )}\n`,
  );

  // ---- main ----------------------------------------------------------------------------
  const mainBuild = await build({
    absWorkingDir: pkg,
    entryPoints: ['src/main/main.ts'],
    outfile: join(out, 'main', 'main.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: NODE_TARGET,
    external: ['electron'],
    tsconfig: 'tsconfig.main.json',
    sourcemap: false,
    minify: false,
    legalComments: 'eof',
    metafile: true,
    logLevel: 'warning',
  });
  const mainAllowed = [join(pkg, 'src', 'main') + sep, join(pkg, 'src', 'ipc') + sep];
  const mainBad = inputsOf(mainBuild.metafile, pkg).filter(
    (p) => !mainAllowed.some((a) => p.startsWith(a)),
  );
  if (mainBad.length > 0)
    fail(`main bundle may only contain src/main and src/ipc:\n  ${mainBad.join('\n  ')}`);

  // ---- node_modules (the closure decides what the host may leave external) ---------------
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as Lockfile;
  const packages = runtimeClosure(lock, {
    workspace: relative(root, pkg).split(sep).join('/'),
    exclude: Object.keys(NOT_SHIPPED),
    platform: o.platform,
    arch: o.arch,
  });
  const stats: CopyStats = { files: 0, bytes: 0 };
  const natives = new Set<string>();
  for (const p of packages) {
    const src = join(root, p.source);
    if (!existsSync(join(src, 'package.json')))
      fail(`${p.source} is in the lockfile but not installed`);
    const dst = join(out, p.target);
    if (p.workspace) {
      const wpj = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')) as {
        files?: string[];
      };
      copyPackage(src, dst, workspaceFilter(wpj.files ?? []), stats);
    } else {
      copyPackage(src, dst, npmFilter(o.platform, o.arch), stats);
      if (isNative(src)) natives.add(p.name);
    }
  }

  // ---- host ----------------------------------------------------------------------------
  const hostBuild = await build({
    absWorkingDir: pkg,
    entryPoints: ['src/host/main.ts'],
    outfile: join(out, 'host', 'main.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: NODE_TARGET,
    // Native packages stay real packages (their addons load from app.asar.unpacked); bare-sidecar
    // is loaded at runtime by src/host/worker/sidecar.ts from the unpacked tree.
    external: ['electron', ...natives],
    // CJS code inlined into an ESM bundle still `require`s its externals (sodium-native).
    banner: {
      js: "import { createRequire as __nfCreateRequire } from 'node:module';\nconst require = __nfCreateRequire(import.meta.url);",
    },
    tsconfig: 'tsconfig.host.json',
    sourcemap: false,
    minify: false,
    legalComments: 'eof',
    metafile: true,
    logLevel: 'warning',
  });
  const hostInputs = inputsOf(hostBuild.metafile, pkg);
  const hostBad = hostInputs.filter(
    (p) =>
      p.startsWith(join(pkg, 'src', 'worker') + sep) ||
      p.startsWith(join(pkg, 'src', 'main') + sep) ||
      p.startsWith(join(pkg, 'src', 'renderer') + sep) ||
      [...natives].some((n) => p.includes(`${sep}node_modules${sep}${n}${sep}`)),
  );
  if (hostBad.length > 0)
    fail(
      `host bundle may not contain worker/main/renderer code or native packages:\n  ${hostBad.join('\n  ')}`,
    );

  // ---- renderer, prompt, preloads (scripts/bundle.ts output) -----------------------------
  mkdirSync(join(out, 'renderer'), { recursive: true });
  mkdirSync(join(out, 'prompt'), { recursive: true });
  for (const f of RENDERER_FILES) copyFileSync(join(dist, 'renderer', f), join(out, 'renderer', f));
  for (const f of PROMPT_FILES) copyFileSync(join(dist, 'prompt', f), join(out, 'prompt', f));
  for (const f of PRELOAD_FILES) copyFileSync(join(dist, f), join(out, f));

  // ---- worker --------------------------------------------------------------------------
  const workerBuild = await build({
    absWorkingDir: pkg,
    entryPoints: ['src/worker/entry.ts'],
    outfile: join(out, PACKAGED_WORKER_BUNDLE),
    bundle: true,
    packages: 'external',
    platform: 'neutral',
    format: 'esm',
    target: 'es2022',
    tsconfig: 'tsconfig.worker.json',
    sourcemap: false,
    minify: false,
    legalComments: 'eof',
    metafile: true,
    logLevel: 'warning',
    plugins: [d6FirstImport],
  });
  const workerAllowed = [join(pkg, 'src', 'worker') + sep, join(pkg, 'src', 'ipc') + sep];
  const workerBad = inputsOf(workerBuild.metafile, pkg).filter(
    (p) => !workerAllowed.some((a) => p.startsWith(a)),
  );
  if (workerBad.length > 0)
    fail(`worker bundle may only contain src/worker and src/ipc:\n  ${workerBad.join('\n  ')}`);
  writeFileSync(join(out, PACKAGED_WORKER_ENTRY), WORKER_BOOT_SOURCE);

  // ---- every external the bundles import must be a shipped package ----------------------
  const externals = {
    host: externalPackages(hostBuild.metafile).filter((n) => n !== 'electron'),
    worker: [...new Set([...externalPackages(workerBuild.metafile), 'bare-encoding'])].sort(),
  };
  const missing = [...externals.host, ...externals.worker].filter(
    (n) => !existsSync(join(out, 'node_modules', n, 'package.json')),
  );
  if (missing.length > 0)
    fail(`bundles import packages the closure does not ship: ${[...new Set(missing)].join(', ')}`);
  // The host loads bare-sidecar at runtime (createRequire), invisible to esbuild.
  if (!existsSync(join(out, 'node_modules', 'bare-sidecar', 'package.json')))
    fail('bare-sidecar is not shipped');

  normalizeModes(out);

  let files = stats.files;
  let bytes = stats.bytes;
  const count = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (p !== join(out, 'node_modules')) count(p);
      } else {
        files++;
        bytes += statSync(p).size;
      }
    }
  };
  count(out);
  return { out, packages, files, bytes, externals };
}

function arg(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const platform = arg(argv, '--platform') ?? process.platform;
  const arch = arg(argv, '--arch') ?? process.arch;
  const out = arg(argv, '--out') ?? join(PKG_DIR, 'out', `stage-${platform}-${arch}`);
  stageApp({ out, platform, arch }).then(
    (r) => {
      process.stdout.write(
        `stage: ${r.out}: ${String(r.packages.length)} packages, ${String(r.files)} files, ${(r.bytes / 1e6).toFixed(1)} MB\n`,
      );
    },
    (err: unknown) => {
      process.stderr.write(`stage: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}

/**
 * Bundles the two browser-side parts of the desktop shell (design §4 "Bundling") after `tsc -b`
 * has type-checked them:
 *
 *   src/renderer/main.tsx  → dist/renderer/app.js   ESM, browser, minified, production React
 *   src/preload/preload.ts → dist/preload.cjs       CJS (a sandboxed preload cannot load ESM or
 *                                                   workspace modules), `electron` external
 *   static/index.html      → dist/renderer/index.html
 *   @sovit/ui/ui.css       → dist/renderer/ui.css    copied, linked with <link rel=stylesheet>
 *   src/renderer/shell.css → dist/renderer/shell.css (nothing is injected: CSP style-src 'self')
 *
 * Those four files are exactly `APP_FILES` in src/main/app-protocol.ts — all the `app:`
 * protocol serves. The build fails if the renderer bundle pulled in `@sovit/core` runtime code
 * (nostr-tools, cashu-ts), Electron or a Node builtin, or if the preload bundle contains
 * anything but src/preload + src/ipc.
 *
 * Usage (from packages/app-desktop): `node scripts/bundle.ts [--out <dir>]` — requires `tsc -b`
 * and `@sovit/ui`'s `build:css` first (the root `npm run build` does both). `--out` (default
 * `dist`) exists for the test that bundles into a temp directory.
 */
import { build, type Metafile } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const outFlag = process.argv.indexOf('--out');
const outArg = outFlag === -1 ? undefined : process.argv[outFlag + 1];
const dist = outArg === undefined ? join(pkg, 'dist') : resolve(outArg);
const rendererOut = join(dist, 'renderer');
/** Electron 44.2.0 ships Chromium 152. */
const TARGET = 'chrome152';

/** The bundle's inputs as absolute paths (metafile paths are relative to `absWorkingDir`). */
function inputsOf(meta: Metafile): string[] {
  return Object.keys(meta.inputs).map((p) => (p.includes(':') ? p : resolve(pkg, p)));
}

function fail(msg: string): never {
  process.stderr.write(`bundle: ${msg}\n`);
  process.exit(1);
}

async function bundleRenderer(): Promise<void> {
  const r = await build({
    absWorkingDir: pkg,
    entryPoints: ['src/renderer/main.tsx'],
    outfile: join(rendererOut, 'app.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: TARGET,
    minify: true,
    sourcemap: false,
    jsx: 'automatic',
    tsconfig: 'tsconfig.renderer.json',
    define: { 'process.env.NODE_ENV': '"production"' },
    legalComments: 'eof',
    metafile: true,
    logLevel: 'warning',
  });
  const core = resolve(pkg, '..', 'core') + sep;
  const bad = inputsOf(r.metafile).filter(
    (p) =>
      p.startsWith(core) ||
      /[\\/]node_modules[\\/](nostr-tools|@cashu|electron|@noble|@scure)[\\/]/.test(p) ||
      p.startsWith('node:'),
  );
  if (bad.length > 0) fail(`renderer bundle must not contain:\n  ${bad.join('\n  ')}`);
}

async function bundlePreload(): Promise<void> {
  const r = await build({
    absWorkingDir: pkg,
    entryPoints: ['src/preload/preload.ts'],
    outfile: join(dist, 'preload.cjs'),
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: TARGET,
    external: ['electron'],
    minify: false,
    sourcemap: false,
    tsconfig: 'tsconfig.preload.json',
    metafile: true,
    logLevel: 'warning',
  });
  const allowed = [join(pkg, 'src', 'preload') + sep, join(pkg, 'src', 'ipc') + sep];
  const bad = inputsOf(r.metafile).filter((p) => !allowed.some((a) => p.startsWith(a)));
  if (bad.length > 0)
    fail(`preload bundle may only contain src/preload and src/ipc:\n  ${bad.join('\n  ')}`);
}

async function copyStatic(): Promise<void> {
  const require = createRequire(import.meta.url);
  let uiCss: string;
  try {
    uiCss = require.resolve('@sovit/ui/ui.css');
  } catch {
    fail('@sovit/ui/ui.css not found — run `npm run -w packages/ui build:css` first');
  }
  await mkdir(rendererOut, { recursive: true });
  await copyFile(join(pkg, 'static', 'index.html'), join(rendererOut, 'index.html'));
  await copyFile(uiCss, join(rendererOut, 'ui.css'));
  await copyFile(join(pkg, 'src', 'renderer', 'shell.css'), join(rendererOut, 'shell.css'));
}

await mkdir(rendererOut, { recursive: true });
await Promise.all([bundleRenderer(), bundlePreload(), copyStatic()]);
process.stdout.write(
  `bundle: ${relative(process.cwd(), rendererOut) || '.'}/{index.html,app.js,ui.css,shell.css} + ${relative(process.cwd(), join(dist, 'preload.cjs'))}\n`,
);

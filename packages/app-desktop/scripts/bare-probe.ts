/**
 * Day-1 Bare probe (docs/plan/L6-design.md §6 L6-C): bundles `src/worker/probe-entry.ts`
 * (our sources only — every npm package stays an import, resolved by Bare itself, so the
 * `bare` export conditions and native addons are exercised for real) and runs it under the
 * REAL runtime the desktop ships: `bare-sidecar`'s prebuilt `bare` 1.31, spawned exactly the
 * way the host spawns the worker (D2). Prints the probe's report and exits with its verdict.
 *
 *   node packages/app-desktop/scripts/bare-probe.ts        # Node ≥ 22.18 (type stripping)
 *
 * Needs a build first (`npm run build`): workspace packages resolve to their `dist/`.
 * The bundle is written under `node_modules/.cache/` (Bare resolves packages from the
 * bundle's location upwards) and removed afterwards. `__tests__/bare-probe.test.ts` runs the
 * same probe in CI.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import Sidecar from 'bare-sidecar';
import { build } from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const ROOT = resolve(PKG, '..', '..');

interface Step {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}
interface Report {
  readonly ok: boolean;
  readonly steps: readonly Step[];
  readonly ms: number;
}

/**
 * D6 and bundling: a bundle hoists every external `import` to its top level in esbuild's
 * module order, so an inlined `bare-globals.ts` could run after `@sovit/core` (which builds a
 * `TextDecoder` at load). The bundle is started by an unbundled boot module that imports
 * `bare-encoding/global` first; inside the bundle `bare-globals.js` maps to that same module.
 * Unbundled (the `tsc` output the host runs) `bare-globals.js` evaluates first anyway.
 */
const d6FirstImport = {
  name: 'd6-first-import',
  setup(b: {
    onResolve: (o: { filter: RegExp }, cb: () => { path: string; external: boolean }) => void;
  }): void {
    b.onResolve({ filter: /\/bare-globals\.js$/ }, () => ({
      path: 'bare-encoding/global',
      external: true,
    }));
  },
};

/** 4-byte BE length + UTF-8 JSON (src/ipc/framing.ts), decoded minimally. */
function frames(onFrame: (msg: unknown) => void): (chunk: Uint8Array) => void {
  let buf = new Uint8Array(0);
  return (chunk) => {
    const next = new Uint8Array(buf.byteLength + chunk.byteLength);
    next.set(buf, 0);
    next.set(chunk, buf.byteLength);
    buf = next;
    while (buf.byteLength >= 4) {
      const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, false);
      if (buf.byteLength < 4 + len) return;
      onFrame(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(4, 4 + len))),
      );
      buf = buf.subarray(4 + len);
    }
  };
}

async function main(): Promise<number> {
  const dir = join(
    ROOT,
    'node_modules',
    '.cache',
    `nutflix-bare-probe-${randomBytes(6).toString('hex')}`,
  );
  await mkdir(dir, { recursive: true });
  const entry = join(dir, 'boot.mjs');
  try {
    await writeFile(entry, "import 'bare-encoding/global'\nimport('./probe.mjs')\n");
    await build({
      entryPoints: [join(PKG, 'src', 'worker', 'probe-entry.ts')],
      outfile: join(dir, 'probe.mjs'),
      bundle: true,
      packages: 'external',
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      logLevel: 'silent',
      plugins: [d6FirstImport],
    });
    const started = Date.now();
    const sidecar = new Sidecar(entry);
    sidecar.stdout?.resume();
    sidecar.stderr?.on('data', (d: Uint8Array) => {
      process.stderr.write(d);
    });
    let report: Report | null = null;
    const push = frames((m) => {
      const msg = m as { e?: string; msg?: string };
      if (msg.e === 'log' && typeof msg.msg === 'string') report = JSON.parse(msg.msg) as Report;
    });
    sidecar.on('data', (c: Uint8Array) => {
      push(c);
    });
    sidecar.on('error', () => undefined);
    const code = await new Promise<number | null>((done) => {
      sidecar.once('exit', (c: number | null) => {
        done(c);
      });
    });
    const r = report as Report | null;
    if (r === null) {
      process.stderr.write(`bare-probe: no report (exit ${String(code)})\n`);
      return 1;
    }
    for (const s of r.steps)
      process.stdout.write(
        `${s.ok ? 'ok  ' : 'FAIL'}  ${s.name}${s.detail ? `  (${s.detail})` : ''}\n`,
      );
    process.stdout.write(
      `\n${r.ok ? 'PASS' : 'FAIL'}: ${String(r.steps.filter((s) => s.ok).length)}/${String(r.steps.length)} steps, probe ${String(r.ms)} ms, bare process ${String(Date.now() - started)} ms, exit ${String(code)}\n`,
    );
    return r.ok && code === 0 ? 0 : 1;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

process.exitCode = await main();

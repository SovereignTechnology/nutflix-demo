/**
 * Fidelity spike — an ESM `utilityProcess` (the host's shape, design §1) that spawns the
 * pinned Bare through `bare-sidecar` (D2 as amended) and echoes one message over its IPC pipe.
 * Bundled to `utility.mjs` with `bare-sidecar` external; the bare script sits next to it.
 */
import type {} from 'electron';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface SidecarLike {
  write(chunk: Uint8Array): boolean;
  on(event: 'data', l: (chunk: Uint8Array) => void): unknown;
  on(event: 'error' | 'exit', l: (x: unknown) => void): unknown;
  destroy(): void;
}

const port = process.parentPort;
port.postMessage({ esm: true, node: process.versions.node });

const here = dirname(fileURLToPath(import.meta.url));
try {
  const Sidecar = createRequire(join(process.env['NUTFLIX_FIDELITY_PKG'] ?? here, 'package.json'))(
    'bare-sidecar',
  ) as new (entry: string) => SidecarLike;
  const sc = new Sidecar(join(here, 'bare-echo.js'));
  const timer = setTimeout(() => {
    port.postMessage({ bare: 'timeout' });
    sc.destroy();
  }, 10_000);
  sc.on('data', (chunk) => {
    clearTimeout(timer);
    port.postMessage({ bare: Buffer.from(chunk).toString('utf8') });
    sc.destroy();
  });
  sc.on('error', (e) => {
    port.postMessage({ bare: `error: ${String(e)}` });
  });
  sc.write(Buffer.from('ping'));
} catch (e: unknown) {
  port.postMessage({ bare: `spawn failed: ${e instanceof Error ? e.message : String(e)}` });
}

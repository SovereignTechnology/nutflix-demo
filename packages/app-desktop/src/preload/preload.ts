/**
 * Sandboxed preload entry (bundled to `dist/preload.cjs` by scripts/bundle.ts; `electron` is
 * the only external — a sandboxed preload gets Electron's restricted `require` and nothing
 * else). Exposes ONE key, `window.nutflix`, and only through `contextBridge`.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { createBridge } from './bridge.js';
import { createTransport } from './transport.js';

function randomHex(n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

contextBridge.exposeInMainWorld(
  'nutflix',
  createBridge(createTransport(ipcRenderer), {
    pathForFile: (file) => webUtils.getPathForFile(file),
    randomHex,
  }),
);

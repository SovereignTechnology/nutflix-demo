/**
 * Fidelity spike — sandboxed preload (bundled to CJS, `electron` external). Exposes exactly the
 * kinds of values the real bridge returns, so the page can report what `contextBridge` really
 * does with them (design risk 5): a Map, bytes, an Error with a custom `.code`, an object of
 * functions (a PlaySession), a callback subscription, and `webUtils.getPathForFile`.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('probe', {
  map: () => Promise.resolve(new Map([['https://mint.example', 21]])),
  wireMap: () => Promise.resolve({ $map: [['https://mint.example', 21]] }),
  bytes: () => Promise.resolve(new Uint8Array([1, 2, 3])),
  fail: () =>
    Promise.reject(
      Object.assign(new Error('no-seeders: nobody is seeding'), { code: 'no-seeders' }),
    ),
  session: () =>
    Promise.resolve({
      sid: 'a'.repeat(32),
      pause: () => 'paused',
      onSpend: (cb: (s: { total: number }) => void) => {
        cb({ total: 7 });
        return () => 'unsubscribed';
      },
    }),
  pathForFile: (f: File) => webUtils.getPathForFile(f),
  // Does a page File / Blob arrive as an instance of the PRELOAD world's File / Blob?
  kinds: (f: unknown, b: unknown) => ({
    fileIsFile: f instanceof File,
    blobIsBlob: b instanceof Blob,
  }),
  report: (r: unknown) => ipcRenderer.invoke('fidelity:report', r),
});

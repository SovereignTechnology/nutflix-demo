/**
 * Fidelity spike — the page (bundled to `page.js`, loaded by `index.html` under the real CSP).
 * Runs each probe and reports a JSON-safe summary through `probe.report`. The e2e drives the
 * file-picker probe with Playwright's `setInputFiles` and the seek probe through `<video>`.
 */
interface Probe {
  map(): Promise<unknown>;
  wireMap(): Promise<unknown>;
  bytes(): Promise<unknown>;
  fail(): Promise<unknown>;
  session(): Promise<{
    sid: string;
    pause(): unknown;
    onSpend(cb: (s: { total: number }) => void): () => unknown;
  }>;
  pathForFile(f: File): string;
  kinds(f: unknown, b: unknown): { fileIsFile: boolean; blobIsBlob: boolean };
  report(r: unknown): Promise<void>;
}

const probe = (window as unknown as { probe: Probe }).probe;
const out: Record<string, unknown> = {};

async function run(): Promise<void> {
  const m = await probe.map();
  out['mapIsMap'] = m instanceof Map;
  out['mapShape'] = Object.prototype.toString.call(m);
  out['mapEntries'] =
    m instanceof Map ? [...(m as Map<string, number>).entries()] : JSON.stringify(m);
  out['wireMap'] = await probe.wireMap();
  const b = await probe.bytes();
  out['bytesIsUint8Array'] = b instanceof Uint8Array;
  try {
    await probe.fail();
  } catch (e: unknown) {
    const err = e as Error & { code?: unknown };
    out['errorName'] = err.name;
    out['errorMessage'] = err.message;
    out['errorCode'] = err.code ?? null;
  }
  const s = await probe.session();
  out['sessionSid'] = s.sid;
  out['sessionPause'] = s.pause();
  let spent = 0;
  const un = s.onSpend((x) => {
    spent = x.total;
  });
  out['callbackValue'] = spent;
  out['unsubscribe'] = un();
  out['constructedFilePath'] = probe.pathForFile(new File(['x'], 'made-up.mp4'));
  out['kinds'] = probe.kinds(new File(['x'], 'k.mp4'), new Blob(['y'], { type: 'image/png' }));
  out['inlineScriptRan'] = (window as unknown as { __inline?: number }).__inline === 1;
  out['hasRequire'] = typeof (globalThis as Record<string, unknown>)['require'];
  await probe.report(out);
}

document.getElementById('pick')?.addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f === undefined) return;
  out['pickedPath'] = probe.pathForFile(f);
  void probe.report(out);
});

const v = document.getElementById('v') as HTMLVideoElement | null;
v?.addEventListener('seeked', () => {
  out['seekedTo'] = v.currentTime;
  out['videoWidth'] = v.videoWidth;
  void probe.report(out);
});
v?.addEventListener('error', () => {
  out['videoError'] = v.error?.code ?? -1;
  void probe.report(out);
});

void run();

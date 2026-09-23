/**
 * Test fixture (not a suite): a minimal worker that runs under the real `bare` via
 * `PearRuntime.run`, speaking the host ⇄ worker protocol over `Bare.IPC` with `src/ipc/`'s
 * framing, guards and error envelopes. Bundled by esbuild in `../sidecar.test.ts`.
 */
import { toWireError, wireError } from '../../../ipc/errors.js';
import { FrameDecoder, FramingError, encodeFrame } from '../../../ipc/framing.js';
import { isHostToWorker } from '../../../ipc/worker-guards.js';
import { WORKER_V } from '../../../ipc/worker-protocol.js';

const ipc = Bare.IPC;
if (ipc === null) Bare.exit(10);
else {
  const send = (m: object): void => {
    ipc.write(encodeFrame(m));
  };

  const probe = (name: string): string => typeof (globalThis as Record<string, unknown>)[name];
  send({ op: 'ev', e: 'ready', v: WORKER_V, port: 1 });
  send({
    op: 'ev',
    e: 'log',
    level: 'info',
    msg: JSON.stringify({
      argv: Bare.argv.slice(2),
      version: Bare.version,
      globals: Object.fromEntries(
        ['TextEncoder', 'TextDecoder', 'crypto', 'AbortController', 'process', 'URL', 'Buffer'].map(
          (n) => [n, probe(n)],
        ),
      ),
    }),
  });

  const decoder = new FrameDecoder((msg) => {
    if (!isHostToWorker(msg)) {
      const id = (msg as { id?: unknown }).id;
      send({
        op: 'res',
        id: typeof id === 'number' ? id : 0,
        ok: false,
        e: wireError('invalid-argument', 'message failed validation'),
      });
      return;
    }
    if (msg.op !== 'req') return;
    try {
      if (msg.m === 'seeder.unban') {
        send({ op: 'res', id: msg.id, ok: true });
      } else if (msg.m === 'studio.upload') {
        const t = msg.a.thumbnailChoice;
        // Echo the (large) payload back so both directions carry multi-chunk frames.
        send({ op: 'res', id: msg.id, ok: true, r: { echo: typeof t === 'object' ? t.hex : '' } });
      } else {
        throw new Error(`not-found: ${msg.m} is not implemented by the echo worker`);
      }
    } catch (e) {
      send({ op: 'res', id: msg.id, ok: false, e: toWireError(e) });
    }
  });

  ipc.on('data', (chunk) => {
    try {
      decoder.push(chunk);
    } catch (e) {
      // A corrupt stream is terminal: no resync, exit with a recognisable code.
      Bare.exit(e instanceof FramingError ? 3 : 4);
    }
  });
}

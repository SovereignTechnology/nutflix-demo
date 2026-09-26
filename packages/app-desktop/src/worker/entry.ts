/**
 * The Bare worker entry — what the host spawns with `bare-sidecar` (D2).
 *
 * D6: the FIRST import installs `bare-encoding`'s `TextEncoder`/`TextDecoder` as globals
 * (Bare 1.31 has neither; `@sovit/core` builds a `TextDecoder` at module load, the seeder's
 * json-store and L8's Bare runner use them). ES modules evaluate in import order, so
 * everything below sees them. `./bare-globals.ts` does what `bare-encoding/global` does,
 * minus that module's `declare global` types (see there).
 *
 * Wiring: `Bare.IPC` (bare-sidecar's pipe on fd 3, unframed chunks) ⇄ `WorkerRpc` (L6-0
 * framing + guards) ⇄ `WorkerHost` with the Bare runtime. Lifecycle:
 *   - a corrupt frame is terminal: exit 3 (no resync — L6-0);
 *   - the pipe ending or closing = the host is gone: graceful close, then exit 0 (attaching
 *     a `close` listener disables bare-sidecar's auto-exit, so we must exit ourselves);
 *   - an uncaught exception is logged (redacted) and exits 1 — the state is unknown and the
 *     host supervises; an unhandled rejection is logged and survives (Bare would otherwise
 *     abort the process on either).
 *
 * Every exit that does not follow `host.close()` goes through `exitWorker` (fix round 4): a DLEQ
 * thread parked between jobs would otherwise hold `Bare.exit` for good (see `./exit.ts`).
 */
import './bare-globals.js';

import { toWireError } from '../ipc/errors.js';
import { bareRuntime } from './adapters/bare.js';
import { exitWorker } from './exit.js';
import { WorkerHost } from './host.js';
import { toLogEvent } from './log.js';
import { WorkerRpc } from './rpc.js';

const EXIT_CORRUPT = 3;
const EXIT_NO_IPC = 10;
const SHUTDOWN_GRACE_MS = 10_000;

const ipc = Bare.IPC;
if (ipc === null) {
  Bare.exit(EXIT_NO_IPC);
} else {
  let shuttingDown = false;
  const rpc: WorkerRpc = new WorkerRpc({
    write: (b) => {
      ipc.write(b);
    },
    handler: {
      handle: (req) => host.handle(req),
      readyEvent: () => host.readyEvent(),
    },
    onFatal: () => {
      exitWorker(EXIT_CORRUPT);
    },
  });
  const host: WorkerHost = new WorkerHost({
    runtime: bareRuntime(),
    emit: (ev) => {
      rpc.emit(ev);
    },
    request: (m, a) => rpc.request(m, a),
  });

  const report = (what: string, err: unknown): void => {
    rpc.emit(
      toLogEvent(JSON.stringify({ msg: what, error: toWireError(err).message }), {
        level: 'error',
      }),
    );
  };

  const shutdown = (code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // A close still running at the deadline has not reached `providers.close()`: its DLEQ thread
    // may be parked, so the forced exit tells it to quit first.
    const force = setTimeout(() => {
      exitWorker(code);
    }, SHUTDOWN_GRACE_MS);
    void host
      .close()
      .catch((err: unknown) => {
        report('worker close failed', err);
      })
      .finally(() => {
        clearTimeout(force);
        exitWorker(code);
      });
  };

  Bare.on('uncaughtException', (err) => {
    report('uncaught exception', err);
    exitWorker(1);
  });
  Bare.on('unhandledRejection', (reason) => {
    report('unhandled rejection', reason);
  });

  ipc.on('data', (chunk) => {
    rpc.push(chunk);
  });
  // The host ending its side (EOF) or the pipe closing both mean the host is gone.
  const hostGone = (): void => {
    rpc.end();
    shutdown(0);
  };
  ipc.on('end', hostGone);
  ipc.on('close', hostGone);
  ipc.on('error', () => {
    shutdown(0);
  });
}

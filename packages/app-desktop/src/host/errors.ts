/**
 * Coded failures raised inside the host. Every error the host means the renderer to see is an
 * `IpcError` whose message starts with `"<code>: "` — the prefixes the screens classify by
 * (design §0.8) — so `toWireError` keeps it verbatim on the way out.
 */
import type { ErrorCode } from '../ipc/protocol.js';
import { IpcError, fromWireError, wireError } from '../ipc/errors.js';

/** An `IpcError` for `code` with `detail` (path-scrubbed and clamped like every wire error). */
export function hostError(code: ErrorCode, detail: string): IpcError {
  return fromWireError(wireError(code, detail));
}

/** Throws `hostError(code, detail)`. */
export function fail(code: ErrorCode, detail: string): never {
  throw hostError(code, detail);
}

/** The code an error carries, if it is one of ours (or anything with a known `.code`). */
export function codeOf(err: unknown): ErrorCode | undefined {
  return err instanceof IpcError ? err.code : undefined;
}

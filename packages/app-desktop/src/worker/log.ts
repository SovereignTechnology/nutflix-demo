/**
 * The worker's only output path (no `console.*` anywhere in `src/worker/`): `@sovit/seeder`'s
 * redacting logger whose sink turns every record into a `log` event for the host.
 *
 * Redaction is layered. The seeder's `redact()` already scrubs Cashu tokens, `nsec`s, proof
 * objects and secret-named fields, and replaces peer identifiers (`pubkey` / `peer` /
 * `noiseKey` …) with a per-process alias (security review F13); it keeps content ids (`core`,
 * `sha256`) whole. The desktop worker's logs leave the process (host → Electron log), so the
 * sink re-applies `redactString` to the finished line: every remaining 32-byte value is cut to
 * its first 8 hex chars. Nothing peer-identifying leaves whole.
 *
 * Lines are clamped to the protocol's `LIMITS.maxString` so the host guard accepts them.
 */
import type { LogLevel, LogRecord, Logger } from '@sovit/seeder';
import { createLogger, redactString } from '@sovit/seeder';

import { LIMITS } from '../ipc/protocol.js';
import type { WorkerEvent } from '../ipc/worker-protocol.js';

export type LogEvent = Extract<WorkerEvent, { readonly e: 'log' }>;

/** Cut `s` to at most `max` UTF-16 units without leaving a lone high surrogate. */
export function clampText(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, Math.max(0, max - 1));
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** The line exactly as it goes on the wire: re-redacted, clamped. */
export function toLogEvent(line: string, record: Pick<LogRecord, 'level'>): LogEvent {
  return {
    op: 'ev',
    e: 'log',
    level: record.level,
    msg: clampText(redactString(line), LIMITS.maxString),
  };
}

export interface WorkerLoggerOptions {
  readonly emit: (ev: LogEvent) => void;
  readonly level?: LogLevel;
  readonly now?: () => Date;
}

export function createWorkerLogger(opts: WorkerLoggerOptions): Logger {
  return createLogger({
    level: opts.level ?? 'info',
    ...(opts.now ? { now: opts.now } : {}),
    bindings: { component: 'worker' },
    sink: (line, record) => {
      opts.emit(toLogEvent(line, record));
    },
  });
}

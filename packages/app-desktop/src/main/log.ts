/**
 * Main-process logger. Redacting by construction: a line is a fixed event name plus scalar
 * fields (numbers, booleans) and at most a known `ErrorCode`. There is no way to log a string
 * that came from the renderer, the host or the network — no paths, URLs, tokens, pubkeys or
 * payloads (common brief: no `console.*` in runtime code).
 */
import type { ErrorCode } from '../ipc/protocol.js';
import { isErrorCode } from '../ipc/guards.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/** Scalars only; the one string a field may hold is an `ErrorCode` under the key `code`. */
export type LogFields = Readonly<Record<string, number | boolean | ErrorCode | undefined>>;
export type Logger = (level: LogLevel, event: LogEvent, fields?: LogFields) => void;

/** Every event main can log. A literal union so nothing dynamic becomes a log line. */
export type LogEvent =
  | 'app.start'
  | 'app.already-running'
  | 'app.sandbox-bypass-refused'
  | 'window.created'
  | 'window.load-failed'
  | 'renderer.gone'
  | 'host.spawned'
  | 'host.exit'
  | 'host.restart-budget-exhausted'
  | 'host.message-dropped'
  | 'host.post-failed'
  | 'gate.refused'
  | 'media.link-dropped'
  | 'media.proxy-failed'
  | 'image.timeout'
  // ADR 0013
  | 'prompt.load-failed'
  | 'prompt.window-failed'
  | 'prompt.bad-answer'
  | 'prompt.refused-sender'
  | 'keychain.ready';

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const FIELD_NAME = /^[a-z][A-Za-z0-9]{0,31}$/;

/** Formats one line; unknown/non-scalar fields and non-`ErrorCode` codes are dropped. */
export function formatLogLine(level: LogLevel, event: LogEvent, fields?: LogFields): string {
  const parts = [`[nutflix-main] ${level} ${event}`];
  if (fields !== undefined) {
    for (const [k, v] of Object.entries(fields)) {
      if (!FIELD_NAME.test(k)) continue;
      if (k === 'code') {
        if (isErrorCode(v)) parts.push(`code=${v}`);
        continue;
      }
      if (typeof v === 'number' && Number.isFinite(v)) parts.push(`${k}=${String(v)}`);
      else if (typeof v === 'boolean') parts.push(`${k}=${String(v)}`);
      // any other string (even an ErrorCode under another key) is dropped
    }
  }
  return parts.join(' ');
}

export function createLogger(write: (line: string) => void, minLevel: LogLevel = 'info'): Logger {
  return (level, event, fields) => {
    if (RANK[level] < RANK[minLevel]) return;
    try {
      write(formatLogLine(level, event, fields));
    } catch {
      // A broken stderr must never take the app down.
    }
  };
}

/** For tests and for code paths that must not log. */
export const silentLogger: Logger = () => undefined;

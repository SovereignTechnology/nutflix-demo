/**
 * The host's redacting logger (design §1; common brief: no `console.*` in runtime code, nothing
 * secret or peer-identifying in logs).
 *
 * Messages are constant strings written by our own code; everything variable goes in `fields`,
 * and every string that reaches the sink — field values, and the worker's own log lines and
 * stdout/stderr — goes through `redact` first. Numbers and booleans pass unchanged; objects are
 * never serialised (a caller that wants one logged must pick the fields it knows are safe).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Readonly<Record<string, LogValue>>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger whose lines carry `scope` (dotted onto the parent's). */
  child(scope: string): Logger;
}

/** Where finished lines go (one JSON object per line, no trailing newline). */
export type LogSink = (line: string) => void;

const LEVELS: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Longest string (after redaction) a single field or message may contribute. */
export const MAX_LOG_STRING = 512;

// Order matters: URLs are reduced to scheme://host first so their paths/queries never reach
// the later rules; then key-ish material, paths, and addresses.
const URL_RE = /\b([a-z][a-z0-9+.-]{1,15}):\/\/(?:[^\s/?#@'"`<>]*@)?([^\s/?#'"`<>]*)[^\s'"`<>]*/gi;
const BECH32_RE =
  /\b(?:npub|nsec|nprofile|nevent|naddr|nrelay|note|ncryptsec|lnbcrt|lnbc|lntbs|lntb|lnurl|cashu[AB])[0-9a-zA-Z]{6,}/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
const PATH_RE = /(^|[\s'"`=(,[{<])(?:~|\.{1,2})?(?:\/[^\s'"`)\]}>,]+)+/g;
const WIN_PATH_RE = /(^|[\s'"`=(,[{<])[A-Za-z]:\\[^\s'"`)\]}>,]*/g;
const HEX_RE = /\b[0-9a-fA-F]{16,}\b/g;
const TOKEN_RE = /[A-Za-z0-9+/_-]{32,}={0,2}/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_RE =
  /\[[0-9a-fA-F:]{2,39}(?:%\w+)?\]|(?<![\w:.])(?=[0-9a-fA-F:]*:[0-9a-fA-F:]*:)[0-9a-fA-F:]{3,39}(?:%\w+)?(?![\w:])/g;
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;
/**
 * ADR 0016 (related finding 3): a word phrase — 8 or more consecutive lower-case words of 3 to 8
 * letters (every BIP-39 English word is one), each separated from the next by a short run (1 to
 * 12 characters) of white space, digits and ASCII punctuation — quotes, brackets, `,` `&` `+`
 * `=` `%`, so a JSON array, quoted words, a numbered list, `%20` or a query string all count —
 * where a one- or two-letter key directly before a digit or `=` (`w1=`, `k=`) counts as
 * separator too (independent review IR3); short English words ("is", "to"), an opening
 * parenthesis and non-ASCII punctuation (an em dash) do not, so our own prose messages keep
 * reading. Over-matches ordinary prose on purpose: a recovery phrase must never reach a log
 * whole, and part of one is still a guessing head start. Linear: letters and separators never
 * overlap (a key needs a non-letter before it), so a failed attempt has one way to parse.
 */
const PHRASE_SEP_CHAR = String.raw`[\s!-')-@\[-\x60{-~]`;
const PHRASE_SEP = String.raw`(?:${PHRASE_SEP_CHAR}|(?<![A-Za-z])[A-Za-z]{1,2}(?=[0-9=])){1,12}`;
const PHRASE_WORD = '[a-z]{3,8}';
const PHRASE_RE = new RegExp(
  String.raw`(?<![A-Za-z])${PHRASE_WORD}(?:${PHRASE_SEP}${PHRASE_WORD}){7,}(?![A-Za-z])`,
  'g',
);

const LOOPBACK_HOST = /^(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d{1,5})?$/i;
const IP_HOST = /^(?:[\d.]+|\[[0-9a-fA-F:.%\w]*\])(?::\d{1,5})?$/;

/**
 * Removes everything that could be secret or peer-identifying from a string, keeping enough to
 * debug by: URLs keep only `scheme://host[:port]` (IP-literal hosts other than loopback become
 * `<ip>`), and file paths, bech32 keys/invoices/tokens, e-mail addresses, hex and base64 runs,
 * IP addresses and word phrases (a recovery phrase, ADR 0016) become placeholders. Bounded: only
 * the first few KiB are ever looked at. Over-redaction (a clock time read as an IPv6 address, a
 * long sentence read as a phrase) is accepted; under-redaction is not.
 */
export function redact(input: string): string {
  // Phrases first: before the path and token rules can split one into pieces that pass.
  let s = input
    .slice(0, 8 * MAX_LOG_STRING)
    .replace(CONTROL_RE, ' ')
    .replace(PHRASE_RE, '<redacted>');
  s = s.replace(URL_RE, (_all, scheme: string, host: string) => {
    const h =
      host === '' ? '<host>' : LOOPBACK_HOST.test(host) || !IP_HOST.test(host) ? host : '<ip>';
    return `${scheme.toLowerCase()}://${h}`;
  });
  s = s
    .replace(BECH32_RE, '<redacted>')
    .replace(EMAIL_RE, '<email>')
    .replace(PATH_RE, (all: string, lead: string) =>
      // `scheme://host` survives: its `//host` is not a path.
      all.slice(lead.length).startsWith('//') ? all : `${lead}<path>`,
    )
    .replace(WIN_PATH_RE, (_all, lead: string) => `${lead}<path>`)
    .replace(HEX_RE, '<hex>')
    .replace(TOKEN_RE, '<token>')
    .replace(IPV4_RE, (m) => (m === '127.0.0.1' ? m : '<ip>'))
    .replace(IPV6_RE, (m) => (m === '[::1]' || m === '::1' || !/[0-9a-fA-F]/.test(m) ? m : '<ip>'));
  return s.length <= MAX_LOG_STRING ? s : `${s.slice(0, MAX_LOG_STRING - 1)}…`;
}

function field(v: LogValue): string | number | boolean | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'boolean') return v;
  return redact(v);
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly scope?: string;
  readonly now?: () => number;
}

/** A logger writing one JSON line per entry to `sink`. The sink must never throw back. */
export function createLogger(sink: LogSink, opts: LoggerOptions = {}): Logger {
  const min = LEVELS[opts.level ?? 'info'];
  const now = opts.now ?? Date.now;
  const make = (scope: string): Logger => {
    const write = (level: LogLevel, msg: string, fields?: LogFields): void => {
      if (LEVELS[level] < min) return;
      const out: Record<string, unknown> = {
        t: new Date(now()).toISOString(),
        level,
        scope,
        msg: redact(msg),
      };
      if (fields)
        for (const [k, v] of Object.entries(fields)) {
          if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k) || k in out) continue;
          out[k] = field(v);
        }
      try {
        sink(JSON.stringify(out));
      } catch {
        // A broken sink must never take the host down.
      }
    };
    return {
      debug: (m, f) => {
        write('debug', m, f);
      },
      info: (m, f) => {
        write('info', m, f);
      },
      warn: (m, f) => {
        write('warn', m, f);
      },
      error: (m, f) => {
        write('error', m, f);
      },
      child: (s) => make(scope === '' ? s : `${scope}.${s}`),
    };
  };
  return make(opts.scope ?? 'host');
}

/** A logger that drops everything (tests, and callers that were given none). */
export const silentLogger: Logger = createLogger(() => undefined, { level: 'error' });

/** A logger that records entries in memory (tests). */
export function memoryLogger(level: LogLevel = 'debug'): Logger & {
  readonly lines: { level: LogLevel; scope: string; msg: string; [k: string]: unknown }[];
} {
  const lines: { level: LogLevel; scope: string; msg: string; [k: string]: unknown }[] = [];
  const log = createLogger(
    (line) => {
      lines.push(JSON.parse(line) as (typeof lines)[number]);
    },
    { level },
  );
  return Object.assign(log, { lines });
}

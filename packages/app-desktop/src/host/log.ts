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
 * letters (every BIP-39 English word is one), each separated from the next by 1 to 12 separator
 * units, each unit one of:
 *   - a run of white space, taken whole (up to 256 characters, so a pretty-printer's indentation
 *     however deep counts as one: fix round 7);
 *   - one ASCII digit or punctuation character other than `\` — quotes, brackets, `,` `&` `+`
 *     `=` `/` `:` … (a JSON array, quoted words, a numbered list or a query string: independent
 *     review IR3);
 *   - a percent escape, `%` and two hex digits, a letter among them or not (`%20`, `%2C`, `%2F`,
 *     `%3A`, `%5B`: a URL-encoded list or JSON array, fix round 7), or a lone `%`;
 *   - a backslash escape, `\` — or `%5C`, a JSON string inside a URL — and one of `n r t b f v`,
 *     `x` and two hex digits, or `u` and four (`\n`, `\r\n`, `\t`, `\u000b`, `\x0b`, `%5Cn`:
 *     words joined by newlines or tabs inside a JSON string or a `repr`, integration fix 2), or a
 *     lone `\`;
 *   - a key a phrase word cannot be: 1 to 16 ASCII letters directly before a digit or `=` that
 *     are not 3 to 8 lower-case letters (`w1=`, `k=`, `Word1=`, `seedWord1=`, `recoveryword1=`;
 *     a lower-case key such as `word1=` is read as a word, which covers it the same: IR3, fix
 *     round 7).
 * Right after an escape that ends in a letter, a remainder of one or two lower-case letters also
 * counts as a word, never as a key, whatever follows it. A phrase joined by a lone `%` or `\`
 * whose next word starts like an escape — `fade` read as `%fa` + `de`, `bag` as `\b` + `ag`, also
 * numbered (`\tag1`) — so keeps its chain (integration fix 2: the fix round 7 escape rule broke
 * it for `%`).
 * Short English words ("is", "to"), an opening parenthesis and non-ASCII punctuation (an em
 * dash) do not separate, so our own prose messages keep reading. Over-matches ordinary prose on
 * purpose: a recovery phrase must never reach a log whole, and part of one is still a guessing
 * head start. Not caught (a residual): Title Case or UPPER CASE words, and double-encoded
 * escapes (`%252C`, `%255Cn`).
 *
 * Linear: a separator splits into units in exactly one way — a white-space run is maximal, a `%`
 * is an escape exactly when two hex digits follow (a backslash escape when they are `5C` and a
 * backslash escape form follows), a `\` exactly when one of its escape forms follows, a key ends
 * where its letter run ends and is never something a word could be — and neither a word nor a
 * key starts right after a letter unless that letter ends an escape (a word never does), so a
 * failed attempt has one way to parse. A remainder is never a word of 3 to 8 letters (it is at
 * most 2) nor a key (a key never starts where one does), and it ends where its letter run ends.
 */
/** A backslash: bare, or percent-encoded (a JSON string inside a URL). */
const BACKSLASH = String.raw`(?:\\|%5[Cc])`;
const BACKSLASH_ESCAPE = String.raw`[nrtbfv]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}`;
/** An escape whose last character is a letter: a word (or a key) may start right after it. */
const ESCAPE_ENDING_IN_LETTER = [
  String.raw`%[0-9A-Fa-f][A-Fa-f]`,
  String.raw`${BACKSLASH}[nrtbfv]`,
  String.raw`${BACKSLASH}x[0-9A-Fa-f][A-Fa-f]`,
  String.raw`${BACKSLASH}u[0-9A-Fa-f]{3}[A-Fa-f]`,
].join('|');
const AFTER_NON_LETTER = String.raw`(?<![A-Za-z](?<!${ESCAPE_ENDING_IN_LETTER}))`;
/** What an escape ending in a letter left of a word: one or two lower-case letters. */
const REMAINDER = String.raw`(?<=${ESCAPE_ENDING_IN_LETTER})[a-z]{1,2}(?![A-Za-z])`;
const PHRASE_SEP_UNIT = [
  String.raw`\s{1,256}(?!\s)`,
  // Every ASCII punctuation character and digit except `\` (its own unit, below).
  String.raw`[!-$&')-@\[\]-\x60{-~]`,
  // Not `%5C` before a backslash escape form: that is the backslash escape, below.
  String.raw`%(?!5[Cc](?:${BACKSLASH_ESCAPE}))(?:[0-9A-Fa-f]{2}|(?![0-9A-Fa-f]{2}))`,
  String.raw`\\(?:${BACKSLASH_ESCAPE}|(?!${BACKSLASH_ESCAPE}))`,
  String.raw`%5[Cc](?:${BACKSLASH_ESCAPE})`,
  // A key is never what a word or a remainder (below) could be.
  String.raw`${AFTER_NON_LETTER}(?![a-z]{3,8}(?![A-Za-z]))(?!${REMAINDER})[A-Za-z]{1,16}(?=[0-9=])`,
].join('|');
const PHRASE_SEP = `(?:${PHRASE_SEP_UNIT}){1,12}`;
const PHRASE_WORD = '[a-z]{3,8}';
/** A word after a separator: a whole word, or the remainder an escape left of one. */
const CHAINED_WORD = `(?:${PHRASE_WORD}|${REMAINDER})`;
const PHRASE_RE = new RegExp(
  String.raw`${AFTER_NON_LETTER}${PHRASE_WORD}(?:${PHRASE_SEP}${CHAINED_WORD}){7,}(?![A-Za-z])`,
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

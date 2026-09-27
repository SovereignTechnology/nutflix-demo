import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MAX_LOG_STRING, createLogger, memoryLogger, redact } from '../log.js';

describe('redact', () => {
  const cases: [string, string][] = [
    ['relay wss://relay.damus.io/some/path?x=1 down', 'relay wss://relay.damus.io down'],
    ['https://user:pw@mint.example/v1/quote', 'https://mint.example'],
    ['link http://127.0.0.1:45000/abcdef0123456789abcdef/sid', 'link http://127.0.0.1:45000'],
    ['peer at https://203.0.113.9:8443/x', 'peer at https://<ip>'],
    ['peer 198.51.100.7 connected', 'peer <ip> connected'],
    ['peer [2001:db8::1]:443 and fe80::1%eth0', 'peer <ip>:443 and <ip>'],
    [`pubkey ${'ab'.repeat(32)}`, 'pubkey <hex>'],
    [`key npub1${'q'.repeat(58)}`, 'key <redacted>'],
    ['invoice lnbc2500n1pjq9yzapp5qqqsyqcyq5rqwzqfq', 'invoice <redacted>'],
    ['token cashuAeyJ0b2tlbiI6W3sibWludCI6Imh0dHBz', 'token <redacted>'],
    ['open /home/alice/.ssh/id_ed25519 failed', 'open <path> failed'],
    ['open "C:\\Users\\alice\\wallet.db" failed', 'open "<path>" failed'],
    ['mail alice@example.com', 'mail <email>'],
    ['b64 QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZn', 'b64 <token>'],
    ['line\u0000with\u001bcontrols', 'line with controls'],
    ['plain words stay', 'plain words stay'],
  ];
  it.each(cases)('%s', (input, want) => {
    expect(redact(input)).toBe(want);
  });

  it('is bounded and never throws', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20_000 }), (s) => {
        const r = redact(s);
        expect(r.length).toBeLessThanOrEqual(MAX_LOG_STRING);
      }),
    );
    expect(redact('ab '.repeat(100_000)).length).toBe(MAX_LOG_STRING);
  });

  it('never lets a 64-hex value through, wherever it sits', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }),
        fc.stringMatching(/^[0-9a-f]{64}$/),
        fc.string({ maxLength: 40 }),
        (a, hex, b) => {
          expect(redact(`${a} ${hex} ${b}`)).not.toContain(hex);
        },
      ),
    );
  });
});

describe('createLogger', () => {
  it('writes one JSON line per entry, redacts string fields, keeps numbers/booleans', () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l), { level: 'debug', now: () => 0 }).child('x');
    log.info('hello', { n: 3, ok: true, s: `key ${'f'.repeat(64)}`, nope: undefined });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      t: '1970-01-01T00:00:00.000Z',
      level: 'info',
      scope: 'host.x',
      msg: 'hello',
      n: 3,
      ok: true,
      s: 'key <hex>',
      nope: null,
    });
  });

  it('filters by level, ignores unsafe field names, survives a throwing sink', () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l), { level: 'warn' });
    log.info('dropped');
    log.warn('kept', { 'bad key': 1, level: 'forged' });
    expect(lines).toHaveLength(1);
    const e = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(e['level']).toBe('warn');
    expect(e['bad key']).toBeUndefined();
    const boom = createLogger(() => {
      throw new Error('sink down');
    });
    expect(() => {
      boom.error('x');
    }).not.toThrow();
  });

  it('memoryLogger shares its lines with children', () => {
    const log = memoryLogger();
    log.child('a').child('b').debug('d');
    expect(log.lines.map((l) => l.scope)).toEqual(['host.a.b']);
  });
});

/**
 * ADR 0016 related finding 3: the logger's canary for word phrases. A recovery phrase is 12
 * lower-case BIP-39 words of 3–8 letters; any run of 8 or more such words becomes `<redacted>`,
 * however it is separated or numbered, wherever it sits — before the path and token rules could
 * split it into pieces that pass.
 */
/** `inner` under `depth` levels of objects (a pretty-printer's indentation grows with it). */
function nested(depth: number, inner: object): object {
  let o = inner;
  for (let i = 0; i < depth; i++) o = { n: o };
  return o;
}

describe('redact — word phrases (ADR 0016)', () => {
  const phraseOf = (entropy: Uint8Array): string[] =>
    entropyToMnemonic(entropy, wordlist).split(' ');
  const VECTOR = phraseOf(new Uint8Array(16).fill(0x7f));

  it.each<[string, (w: string[]) => string]>([
    ['spaces', (w) => w.join(' ')],
    ['commas', (w) => w.join(', ')],
    ['newlines (control characters)', (w) => w.join('\n')],
    ['numbered', (w) => w.map((x, i) => `${String(i + 1)}. ${x}`).join(' ')],
    ['numbered with parens', (w) => w.map((x, i) => `${String(i + 1)}) ${x}`).join(' ')],
    ['slashes', (w) => w.join('/')],
    ['dashes', (w) => w.join('-')],
    ['pipes and tabs', (w) => w.join(' |\t')],
    ['in quotes inside a sentence', (w) => `error: "${w.join(' ')}" was refused`],
    ['as a path segment', (w) => `open /tmp/${w.join('/')}/x failed`],
    // Independent review IR3: the forms a library error or a forwarded line would carry.
    ['a JSON array', (w) => JSON.stringify(w)],
    ['a JSON array inside an error', (w) => `invalid mnemonic: ${JSON.stringify({ words: w })}`],
    ['single quotes per word', (w) => w.map((x) => `'${x}'`).join(' ')],
    ['double quotes per word, commas', (w) => w.map((x) => `"${x}"`).join(', ')],
    ['backticks per word', (w) => w.map((x) => `\`${x}\``).join(' ')],
    ['ampersands', (w) => w.join('&')],
    ['plus signs (form encoding)', (w) => w.join('+')],
    ['URL-encoded spaces', (w) => w.join('%20')],
    ['bracket-numbered', (w) => w.map((x, i) => `[${String(i + 1)}] ${x}`).join(' ')],
    ['short keys, numbered', (w) => w.map((x, i) => `w${String(i)}=${x}`).join(' ')],
    ['word keys, a query string', (w) => w.map((x, i) => `word${String(i + 1)}=${x}`).join('&')],
    ['one-letter keys', (w) => w.map((x) => `k=${x}`).join('&')],
    ['a JS array literal', (w) => `[ '${w.join("', '")}' ]`],
    // Fix round 7 (the lane verifier): percent escapes whose hex digits include a letter, keys a
    // phrase word cannot be, and indentation deeper than the old 12-character separator.
    ['URL-encoded, comma-joined', (w) => encodeURIComponent(w.join(','))],
    ['URL-encoded JSON array', (w) => encodeURIComponent(JSON.stringify(w))],
    ['URL-encoded JSON object', (w) => encodeURIComponent(JSON.stringify({ words: w }))],
    ['escaped slashes', (w) => w.join('%2F')],
    ['escaped colon and space', (w) => w.join('%3A%20')],
    ['lower-case escapes', (w) => w.join('%2c')],
    [
      'a form body whose key ends in an escape letter',
      (w) => `seedPhrase%3D${encodeURIComponent(w.join(','))}`,
    ],
    ['Title Case keys', (w) => w.map((x, i) => `Word${String(i + 1)}=${x}`).join('&')],
    ['camelCase keys', (w) => w.map((x, i) => `seedWord${String(i + 1)}=${x}`).join('&')],
    ['long keys', (w) => w.map((x, i) => `recoveryword${String(i + 1)}=${x}`).join('&')],
    ['upper-case keys', (w) => w.map((x, i) => `W${String(i)}=${x}`).join(';')],
    [
      'pretty-printed, nested deep (4 spaces)',
      (w) => JSON.stringify({ a: { b: { c: { words: w } } } }, null, 4),
    ],
    [
      'pretty-printed, nested deeper (tabs, a 14-character indent)',
      (w) => JSON.stringify(nested(12, { words: w }), null, '\t'),
    ],
    [
      // From the array on: the opening levels alone would pass MAX_LOG_STRING.
      'pretty-printed, nested very deep (4 spaces, a 104-character indent)',
      (w) => {
        const text = JSON.stringify(nested(24, { words: w }), null, 4);
        return text.slice(text.indexOf('"words"'));
      },
    ],
  ])('%s', (_what, fmt) => {
    const out = redact(`seed ${fmt(VECTOR)} end`);
    expect(out).toContain('<redacted>');
    // No two phrase words in a row survive, and at most a stray single word.
    for (let i = 0; i + 2 <= VECTOR.length; i++)
      expect(out).not.toContain(VECTOR.slice(i, i + 2).join(' '));
    expect(VECTOR.filter((w) => out.includes(w)).length).toBeLessThanOrEqual(1);
  });

  it('any 12-word phrase, any position, is redacted whole (property)', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 16, maxLength: 16 }),
        fc.string({ maxLength: 40 }).filter((x) => !/[a-z]$/.test(x)),
        fc.string({ maxLength: 40 }).filter((x) => !/^[a-z]/.test(x)),
        (entropy, before, after) => {
          const words = phraseOf(entropy);
          const out = redact(`${before} ${words.join(' ')} ${after}`);
          for (let i = 0; i + 3 <= words.length; i++)
            expect(out).not.toContain(words.slice(i, i + 3).join(' '));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('any 12-word phrase as a JSON array or quoted word by word is redacted whole (property)', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 16, maxLength: 16 }),
        fc.constantFrom<(w: string[]) => string>(
          (w) => JSON.stringify(w),
          (w) => w.map((x) => `'${x}'`).join(', '),
          (w) => w.join('%20'),
          (w) => w.map((x, i) => `w${String(i)}=${x}`).join('&'),
          // Fix round 7.
          (w) => encodeURIComponent(w.join(',')),
          (w) => encodeURIComponent(JSON.stringify(w)),
          (w) => w.map((x, i) => `Word${String(i + 1)}=${x}`).join('&'),
          (w) => JSON.stringify({ a: { b: { c: { words: w } } } }, null, 4),
        ),
        (entropy, fmt) => {
          const words = phraseOf(entropy);
          const out = redact(`before ${fmt(words)} after`);
          expect(out).toContain('<redacted>');
          // At most a stray word survives (a phrase's words can repeat, so count positions).
          expect(
            words.filter((x) => new RegExp(`(?<![a-z])${x}(?![a-z])`).test(out)).length,
          ).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('the rule stays linear on hostile input (no catastrophic backtracking)', () => {
    const hostile = [
      'abcdefgh1='.repeat(400),
      `${'abc '.repeat(7)}abcdefghijklmnop `.repeat(150),
      `${'ab1=abc '.repeat(7)}x`.repeat(80),
      `${'abc'.padEnd(3)}${' '.repeat(13)}`.repeat(250),
      'a1'.repeat(2000),
      // Fix round 7: escapes, white-space runs past the unit's bound, long and mixed-case keys.
      '%2C'.repeat(1400),
      `${'abc%2C'.repeat(7)}abcdefghijk `.repeat(60),
      `abc${' '.repeat(300)}`.repeat(14),
      `${'abc Abcdefghijklmnopq1= '.repeat(7)}X`.repeat(20),
      'Ab1='.repeat(1000),
      `${'abc%41%'.repeat(7)}Z`.repeat(80),
      `${'abc%2Cab1=%2CWord1='.repeat(7)}Q`.repeat(30),
    ];
    for (const h of hostile) {
      const t0 = performance.now();
      redact(h);
      expect(performance.now() - t0).toBeLessThan(250);
    }
  });

  it('eight words are a phrase; seven, capitalised prose, or short words are not', () => {
    expect(redact(VECTOR.slice(0, 8).join(' '))).toBe('<redacted>');
    expect(redact(VECTOR.slice(0, 7).join(' '))).toBe(VECTOR.slice(0, 7).join(' '));
    expect(redact('the wallet could not be created')).toBe('the wallet could not be created');
    expect(redact('payments stay unavailable')).toBe('payments stay unavailable');
  });

  it('through the logger: message, fields, and a worker line', () => {
    const log = memoryLogger();
    const text = VECTOR.join(' ');
    log.info(`restored with ${text}`, { phrase: text, line: `worker said ${text}` });
    const all = JSON.stringify(log.lines);
    for (let i = 0; i + 2 <= VECTOR.length; i++)
      expect(all).not.toContain(VECTOR.slice(i, i + 2).join(' '));
    expect(all.match(/<redacted>/g)?.length).toBe(3);
  });

  // The rule over-redacts prose on purpose; our own constant messages must still say what
  // happened, so none of them may trip it (a message that does is reworded, not the rule relaxed).
  it('no constant log message of the host (or the worker) is swallowed by the rule', async () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const files: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== '__tests__') await walk(p);
        } else if (e.name.endsWith('.ts')) files.push(p);
      }
    };
    await walk(join(src, 'host'));
    await walk(join(src, 'worker'));
    const swallowed: string[] = [];
    let seen = 0;
    for (const f of files) {
      const text = await readFile(f, 'utf8');
      for (const m of text.matchAll(
        /\blog\.(?:debug|info|warn|error)\(\s*(['`])((?:\\.|(?!\1)[^\\])*)\1/g,
      )) {
        const msg = m[2] ?? '';
        seen++;
        if (redact(msg) !== msg) swallowed.push(msg);
      }
    }
    expect(seen).toBeGreaterThan(50);
    expect(swallowed).toEqual([]);
  });
});

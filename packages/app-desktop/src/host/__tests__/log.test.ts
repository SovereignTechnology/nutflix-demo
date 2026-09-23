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

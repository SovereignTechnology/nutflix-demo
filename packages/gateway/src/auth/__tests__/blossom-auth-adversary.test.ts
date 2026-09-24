/**
 * Stage 2 adversary cases for `BlossomAuthImpl` that the L10 suite (`blossom-auth.test.ts`) did
 * not cover, each with why it was missed:
 *
 *  - BUD-09 reports: the L10 lane left `verify({ verb: 'report' })` undefined ("no test") —
 *    ADR 0010 item 4 decides it here.
 *  - Allow-list mode: L10 only tested `allow()` as lifting a deny; the gateway config calls it
 *    `allowPubkeys`, and an allow list that restricts nothing would be a silent open door.
 *  - Re-signing: L10's replay test re-encodes the JSON; BIP-340 signing is randomised, so the
 *    same event signed twice has a NEW sig and the SAME id — replay must key on the id.
 *  - Ambiguous tags (two `expiration`s, two `t`s) and non-canonical numbers (`1e10`, ` 99`):
 *    L10 used only well-formed single tags. Servers that read the first vs the last tag, or
 *    parse with `Number()`, disagree — the attacker picks the reading that helps.
 *  - `expiration === now` (L10 "not asserted"), token age past `maxAgeSec`, `server` scoping,
 *    bounded replay memory, oversized/invalid-UTF-8 headers, a non-integer request clock:
 *    none exist in L10 because they are implementation policy, not the contract's reason enum.
 */
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';

import type { NostrPubkey, Sha256Hex } from '@sovit/core';
import { BlossomAuthImpl, CLOCK_SKEW_SEC, MAX_EVENT_BYTES } from '../blossom-auth.js';
import type { BlossomAuthRequest, BlossomVerb } from '../index.js';

const NOW = 1_757_000_000;
const BLOB = 'b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553' as Sha256Hex;
const OTHER = 'c2785292b99fd6dee844f5351b92914216ed523e7d7819e64bca5fd359f5f664' as Sha256Hex;

interface Draft {
  kind?: number;
  created_at?: number;
  tags?: string[][];
  content?: string;
}

function token(o: Draft = {}): {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
} {
  return {
    kind: o.kind ?? 24242,
    created_at: o.created_at ?? NOW - 5,
    tags: o.tags ?? [
      ['t', 'upload'],
      ['x', BLOB],
      ['expiration', String(NOW + 600)],
    ],
    content: o.content ?? 'Upload Blob',
  };
}

const header = (ev: object): string =>
  `Nostr ${Buffer.from(JSON.stringify(ev), 'utf8').toString('base64')}`;
const signed = (sk: Uint8Array, o: Draft = {}): string => header(finalizeEvent(token(o), sk));
const req = (
  h: string,
  verb: BlossomVerb = 'upload',
  sha256: Sha256Hex | null = BLOB,
  now = NOW,
): BlossomAuthRequest =>
  sha256 === null ? { verb, header: h, now } : { verb, header: h, sha256, now };

function report(sk: Uint8Array, o: Draft = {}): string {
  return header(
    finalizeEvent(
      {
        kind: o.kind ?? 1984,
        created_at: o.created_at ?? NOW - 5,
        tags: o.tags ?? [
          ['x', BLOB, 'illegal'],
          ['p', 'ab'.repeat(32)],
        ],
        content: o.content ?? 'reported',
      },
      sk,
    ),
  );
}

describe('BlossomAuth — BUD-09 report (ADR 0010 item 4)', () => {
  it('a signed kind 1984 with the reported hash in an x tag is accepted under `report`; no t or expiration needed', async () => {
    const sk = generateSecretKey();
    const r = await new BlossomAuthImpl().verify(req(report(sk), 'report'));
    expect(r).toMatchObject({ ok: true, pubkey: getPublicKey(sk) });
  });

  it('a kind 24242 token is not a report, and a report is not an upload token', async () => {
    const sk = generateSecretKey();
    const auth = new BlossomAuthImpl();
    expect(await auth.verify(req(signed(sk), 'report'))).toMatchObject({
      ok: false,
      reason: 'wrong-kind',
    });
    expect(await auth.verify(req(report(sk), 'upload'))).toMatchObject({
      ok: false,
      reason: 'wrong-kind',
    });
  });

  it('the reported hash must be among the x tags; a report with no hash in the request is refused', async () => {
    const sk = generateSecretKey();
    const auth = new BlossomAuthImpl();
    expect(await auth.verify(req(report(sk), 'report', OTHER))).toMatchObject({
      ok: false,
      reason: 'wrong-hash',
    });
    expect(await auth.verify(req(report(sk), 'report', null))).toMatchObject({
      ok: false,
      status: 401,
      reason: 'wrong-hash',
    });
  });

  it('a report is accepted once (replayed after), honours a NIP-40 expiration, and cannot be from the future or stale', async () => {
    const sk = generateSecretKey();
    const auth = new BlossomAuthImpl();
    const h = report(sk);
    expect(await auth.verify(req(h, 'report'))).toMatchObject({ ok: true });
    expect(await auth.verify(req(h, 'report'))).toMatchObject({ ok: false, reason: 'replayed' });
    const expired = report(sk, {
      tags: [
        ['x', BLOB],
        ['expiration', String(NOW - 1)],
      ],
    });
    expect(await auth.verify(req(expired, 'report'))).toMatchObject({
      ok: false,
      reason: 'expired',
    });
    const future = report(sk, { created_at: NOW + 3600 });
    expect(await auth.verify(req(future, 'report'))).toMatchObject({
      ok: false,
      reason: 'expired',
    });
    const stale = report(sk, { created_at: NOW - 7200 });
    expect(await auth.verify(req(stale, 'report'))).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('a denied pubkey cannot report; allow-list mode does not stop anyone else reporting', async () => {
    const sk = generateSecretKey();
    const other = generateSecretKey();
    const auth = new BlossomAuthImpl();
    auth.allow(getPublicKey(other) as NostrPubkey);
    expect(await auth.verify(req(report(sk), 'report'))).toMatchObject({ ok: true });
    auth.deny(getPublicKey(sk) as NostrPubkey);
    expect(await auth.verify(req(report(sk, { content: 'again' }), 'report'))).toMatchObject({
      ok: false,
      status: 403,
      reason: 'denied',
    });
  });

  it('a tampered report (hash added after signing) fails the signature', async () => {
    const sk = generateSecretKey();
    const ev = finalizeEvent(token({ kind: 1984, tags: [['x', BLOB]] }), sk);
    const h = header({ ...ev, tags: [...ev.tags, ['x', OTHER]] });
    expect(await new BlossomAuthImpl().verify(req(h, 'report', OTHER))).toMatchObject({
      ok: false,
      reason: 'bad-signature',
    });
  });
});

describe('BlossomAuth — allow-list mode', () => {
  it('once any pubkey is allowed, only allowed pubkeys pass (403 denied otherwise); deny then allow is last-call-wins', async () => {
    const a = generateSecretKey();
    const b = generateSecretKey();
    const auth = new BlossomAuthImpl();
    auth.allow(getPublicKey(a) as NostrPubkey);
    expect(await auth.verify(req(signed(a)))).toMatchObject({ ok: true });
    expect(await auth.verify(req(signed(b)))).toMatchObject({
      ok: false,
      status: 403,
      reason: 'denied',
    });
    auth.deny(getPublicKey(a) as NostrPubkey);
    expect(await auth.verify(req(signed(a, { content: '2' })))).toMatchObject({
      ok: false,
      reason: 'denied',
    });
    auth.allow(getPublicKey(a) as NostrPubkey);
    expect(await auth.verify(req(signed(a, { content: '3' })))).toMatchObject({ ok: true });
  });

  it('allow/deny refuse a malformed pubkey instead of silently storing it', () => {
    const auth = new BlossomAuthImpl();
    expect(() => {
      auth.allow('AB'.repeat(32) as NostrPubkey);
    }).toThrow(/invalid-argument/);
    expect(() => {
      auth.deny('xyz' as NostrPubkey);
    }).toThrow(/invalid-argument/);
  });
});

describe('BlossomAuth — replay keyed on the event id', () => {
  it('the same event signed twice (new sig, same id) is a replay', async () => {
    const sk = generateSecretKey();
    const t = token();
    const first = finalizeEvent({ ...t, tags: t.tags.map((x) => [...x]) }, sk);
    const second = finalizeEvent({ ...t, tags: t.tags.map((x) => [...x]) }, sk);
    expect(second.id).toBe(first.id);
    expect(second.sig).not.toBe(first.sig);
    const auth = new BlossomAuthImpl();
    expect(await auth.verify(req(header(first)))).toMatchObject({ ok: true });
    expect(await auth.verify(req(header(second)))).toMatchObject({ ok: false, reason: 'replayed' });
  });

  it('memory is bounded: full of live tokens → 503 busy (never an eviction); expired tokens are swept', async () => {
    const sk = generateSecretKey();
    const auth = new BlossomAuthImpl({ capacity: 3 });
    for (let i = 0; i < 3; i++)
      expect(await auth.verify(req(signed(sk, { content: `u${i}` })))).toMatchObject({ ok: true });
    const fourth = signed(sk, { content: 'u3' });
    expect(await auth.verify(req(fourth))).toMatchObject({
      ok: false,
      status: 503,
      reason: 'busy',
    });
    expect(auth.remembered()).toBe(3);
    // The first three stay replay-protected while full.
    const again = signed(sk, { content: 'u0' });
    expect(await auth.verify(req(again))).toMatchObject({ ok: false, reason: 'replayed' });
    // Once they can no longer pass the time checks (expiration NOW+600, plus the sweep margin),
    // they are forgotten and new tokens fit again.
    const later = NOW + 600 + 400;
    const fresh = signed(sk, {
      created_at: later - 5,
      tags: [
        ['t', 'upload'],
        ['x', BLOB],
        ['expiration', String(later + 600)],
      ],
    });
    expect(await auth.verify(req(fresh, 'upload', BLOB, later))).toMatchObject({ ok: true });
    expect(auth.remembered()).toBe(1);
  });

  it('a forgotten token cannot come back: it fails the time checks first', async () => {
    const sk = generateSecretKey();
    const auth = new BlossomAuthImpl({ capacity: 1 });
    const h = signed(sk);
    expect(await auth.verify(req(h))).toMatchObject({ ok: true });
    const later = NOW + 1000;
    const other = signed(sk, {
      created_at: later - 1,
      tags: [
        ['t', 'upload'],
        ['x', BLOB],
        ['expiration', String(later + 60)],
      ],
    });
    expect(await auth.verify(req(other, 'upload', BLOB, later))).toMatchObject({ ok: true });
    expect(await auth.verify(req(h, 'upload', BLOB, later))).toMatchObject({
      ok: false,
      reason: 'expired',
    });
  });
});

describe('BlossomAuth — ambiguous and non-canonical tags', () => {
  it('two expiration tags or two t tags → malformed (no first-vs-last reading to exploit)', async () => {
    const sk = generateSecretKey();
    const auth = new BlossomAuthImpl();
    const twoExp = signed(sk, {
      tags: [
        ['t', 'upload'],
        ['x', BLOB],
        ['expiration', String(NOW - 10)],
        ['expiration', String(NOW + 600)],
      ],
    });
    expect(await auth.verify(req(twoExp))).toMatchObject({ ok: false, reason: 'malformed' });
    const twoT = signed(sk, {
      tags: [
        ['t', 'delete'],
        ['t', 'upload'],
        ['x', BLOB],
        ['expiration', String(NOW + 600)],
      ],
    });
    expect(await auth.verify(req(twoT))).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('expiration must be a canonical decimal: 1e10, hex, padded, signed, fractional, empty → malformed', async () => {
    const sk = generateSecretKey();
    const auth = new BlossomAuthImpl();
    for (const v of [
      '1e10',
      '0x7fffffff',
      ` ${NOW + 60}`,
      `${NOW + 60} `,
      `+${NOW + 60}`,
      `${NOW + 60}.5`,
      '',
      `0${NOW + 60}`,
    ]) {
      const h = signed(sk, {
        content: `exp ${v}`,
        tags: [
          ['t', 'upload'],
          ['x', BLOB],
          ['expiration', v],
        ],
      });
      expect(await auth.verify(req(h)), JSON.stringify(v)).toMatchObject({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('expiration === now is expired (the boundary L10 left open)', async () => {
    const sk = generateSecretKey();
    const h = signed(sk, {
      tags: [
        ['t', 'upload'],
        ['x', BLOB],
        ['expiration', String(NOW)],
      ],
    });
    expect(await new BlossomAuthImpl().verify(req(h))).toMatchObject({
      ok: false,
      reason: 'expired',
    });
  });

  it('a mirror request takes an upload token only — a t=mirror token is not a Blossom verb', async () => {
    const sk = generateSecretKey();
    const h = signed(sk, {
      tags: [
        ['t', 'mirror'],
        ['x', BLOB],
        ['expiration', String(NOW + 600)],
      ],
    });
    expect(await new BlossomAuthImpl().verify(req(h, 'mirror'))).toMatchObject({
      ok: false,
      reason: 'wrong-verb',
    });
  });
});

describe('BlossomAuth — time window', () => {
  it('created_at within the clock-skew allowance is accepted; one second past it is not', async () => {
    const sk = generateSecretKey();
    const auth = new BlossomAuthImpl();
    expect(await auth.verify(req(signed(sk, { created_at: NOW + CLOCK_SKEW_SEC })))).toMatchObject({
      ok: true,
    });
    expect(
      await auth.verify(req(signed(sk, { created_at: NOW + CLOCK_SKEW_SEC + 1 }))),
    ).toMatchObject({
      ok: false,
      reason: 'expired',
    });
  });

  it('a token older than maxAgeSec is expired whatever its expiration says', async () => {
    const sk = generateSecretKey();
    const h = signed(sk, {
      created_at: NOW - 3601,
      tags: [
        ['t', 'upload'],
        ['x', BLOB],
        ['expiration', String(NOW + 10 * 365 * 86_400)],
      ],
    });
    expect(await new BlossomAuthImpl().verify(req(h))).toMatchObject({
      ok: false,
      reason: 'expired',
    });
    expect(await new BlossomAuthImpl({ maxAgeSec: 7200 }).verify(req(h))).toMatchObject({
      ok: true,
    });
  });

  it('a non-integer or negative request clock fails closed', async () => {
    const sk = generateSecretKey();
    const auth = new BlossomAuthImpl();
    for (const now of [Number.NaN, NOW + 0.5, -1, Number.POSITIVE_INFINITY])
      expect(await auth.verify(req(signed(sk), 'upload', BLOB, now)), String(now)).toMatchObject({
        ok: false,
        reason: 'malformed',
      });
  });
});

describe('BlossomAuth — server scope', () => {
  const scoped = (sk: Uint8Array, servers: string[]): string =>
    signed(sk, {
      content: servers.join(','),
      tags: [
        ['t', 'upload'],
        ['x', BLOB],
        ['expiration', String(NOW + 600)],
        ...servers.map((s) => ['server', s]),
      ],
    });

  it('a token scoped to other servers is refused; scoped to this one (any case) or unscoped is accepted', async () => {
    const sk = generateSecretKey();
    const auth = new BlossomAuthImpl({ serverHost: 'https://gw.example.org' });
    expect(await auth.verify(req(scoped(sk, ['cdn.other.example'])))).toMatchObject({
      ok: false,
      status: 401,
      reason: 'wrong-server',
    });
    expect(
      await auth.verify(req(scoped(sk, ['cdn.other.example', 'GW.example.org']))),
    ).toMatchObject({ ok: true });
    expect(await auth.verify(req(scoped(sk, [])))).toMatchObject({ ok: true });
    // Suffix/prefix tricks are not the same host.
    expect(await auth.verify(req(scoped(sk, ['gw.example.org.evil.example'])))).toMatchObject({
      ok: false,
      reason: 'wrong-server',
    });
  });

  it('without a configured host, server tags are not checked', async () => {
    const sk = generateSecretKey();
    expect(
      await new BlossomAuthImpl().verify(req(scoped(sk, ['cdn.other.example']))),
    ).toMatchObject({ ok: true });
  });
});

describe('BlossomAuth — header hygiene', () => {
  it('an oversized header is refused before decoding; invalid UTF-8 is malformed', async () => {
    const auth = new BlossomAuthImpl();
    const huge = `Nostr ${'A'.repeat(Math.ceil(MAX_EVENT_BYTES / 3) * 4 + 4)}`;
    expect(await auth.verify(req(huge))).toMatchObject({ ok: false, reason: 'malformed' });
    const badUtf8 = `Nostr ${Buffer.from([0x7b, 0xff, 0xfe, 0x7d]).toString('base64')}`;
    expect(await auth.verify(req(badUtf8))).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('the auth scheme is case-insensitive (RFC 7235) and base64url is accepted; whitespace or junk inside the base64 is not', async () => {
    const sk = generateSecretKey();
    const auth = new BlossomAuthImpl();
    const ev = finalizeEvent(token({ content: 'scheme ??>>' }), sk);
    const json = Buffer.from(JSON.stringify(ev), 'utf8');
    expect(await auth.verify(req(`nostr ${json.toString('base64')}`))).toMatchObject({ ok: true });
    const ev2 = finalizeEvent(token({ content: 'url ??>>' }), sk);
    const url = Buffer.from(JSON.stringify(ev2), 'utf8').toString('base64url');
    expect(await auth.verify(req(`Nostr ${url}`))).toMatchObject({ ok: true });
    const ev3 = finalizeEvent(token({ content: 'junk' }), sk);
    const b64 = Buffer.from(JSON.stringify(ev3), 'utf8').toString('base64');
    for (const h of [
      `Nostr  ${b64}`,
      `Nostr ${b64.slice(0, 20)} ${b64.slice(20)}`,
      `Nostr ${b64}!`,
    ])
      expect(await auth.verify(req(h))).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('a __proto__ key in the event JSON neither pollutes prototypes nor survives into the result', async () => {
    const sk = generateSecretKey();
    const ev = finalizeEvent(token(), sk);
    const json = JSON.stringify(ev).replace(/^\{/, '{"__proto__":{"polluted":true},');
    const r = await new BlossomAuthImpl().verify(
      req(`Nostr ${Buffer.from(json).toString('base64')}`),
    );
    expect(r).toMatchObject({ ok: true });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    if (r.ok)
      expect(Object.keys(r.event).sort()).toEqual([
        'content',
        'created_at',
        'id',
        'kind',
        'pubkey',
        'sig',
        'tags',
      ]);
  });
});

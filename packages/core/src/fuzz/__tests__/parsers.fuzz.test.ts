/**
 * The fuzz campaign's targets (execution plan §4): everything that reads payment data a peer, a
 * relay or a mint controls. Each must never throw on any input (a documented `RangeError` aside),
 * and must accept only what is exactly well-formed. Quick in the ordinary suite; long in the
 * `fuzz` workflow (`./fuzz.mts`).
 */
import * as fc from 'fast-check';
import { describe, expect } from 'vitest';

import type { CashuP2pkPubkey, HelloMessage, PayProtocolMessage } from '../../contracts/index.js';
import { VIDEOS } from '../../mocks/fixtures.js';
import { buildVideoEvent } from '../../manifest/build.js';
import { verifyVideoEvent } from '../../manifest/verify.js';
import { TestSigner } from '../../nostr/__tests__/helpers.js';
import { checkPayLock } from '../../payment/lock.js';
import { isValidCarry, isValidSplit, splitPay, splitSequence } from '../../payment/split.js';
import { payCodec } from '../../pay-protocol/index.js';
import { verifyHello } from '../../pay-protocol/hello.js';
import { helloArb, messageArb } from '../../pay-protocol/__tests__/arbitraries.mjs';
import { fuzzIt, mutatedBytes, mutatedString } from './fuzz.mjs';

const TARGET = `02${'ab'.repeat(32)}` as CashuP2pkPubkey;
const OTHER = `03${'cd'.repeat(32)}` as CashuP2pkPubkey;

describe('fuzz: the pay/1 codec (peers’ bytes)', () => {
  // Any bytes: never throws; whatever it accepts it re-encodes to the very same bytes.
  const canonical = (bytes: Uint8Array): void => {
    // A throw fails the property: `decode` must never throw.
    const m: PayProtocolMessage | null = payCodec.decode(bytes);
    if (m !== null) expect(Buffer.from(payCodec.encode(m)).equals(Buffer.from(bytes))).toBe(true);
  };
  fuzzIt('raw bytes', fc.uint8Array({ maxLength: 512 }), canonical);
  fuzzIt(
    'mutated valid frames',
    messageArb.chain((m) => mutatedBytes(payCodec.encode(m))),
    canonical,
  );
  fuzzIt('valid frames round-trip', messageArb, (m) => {
    expect(payCodec.decode(payCodec.encode(m))).toEqual(m);
  });
});

describe('fuzz: the P2PK lock of every proof received (checkPayLock)', () => {
  const valid = (tags: readonly (readonly string[])[]) =>
    JSON.stringify(['P2PK', { nonce: 'ab'.repeat(16), data: TARGET, tags }]);
  const seeds = fc.constantFrom(
    valid([]),
    valid([['sigflag', 'SIG_INPUTS']]),
    valid([['pay1', 'x'.repeat(64)]]),
    valid([['locktime', '1700000000']]),
  );
  const lockOk = (secret: string): void => {
    let v: ReturnType<typeof checkPayLock> | undefined;
    expect(() => {
      v = checkPayLock(secret, TARGET, { binding: 'x'.repeat(64) });
    }).not.toThrow();
    if (v?.ok === true) {
      // Accepted only when the lock names exactly the target.
      const parsed = JSON.parse(secret) as [string, { data?: unknown }];
      expect(String(parsed[1].data).toLowerCase()).toBe(TARGET);
    }
    expect(checkPayLock(secret, OTHER).ok).toBe(false);
  };
  fuzzIt('arbitrary strings', fc.string({ maxLength: 300, unit: 'binary' }), lockOk);
  fuzzIt('mutated valid secrets', seeds.chain(mutatedString), lockOk);
  fuzzIt('arbitrary JSON', fc.json({ maxDepth: 4 }), lockOk);
});

describe('fuzz: a peer’s HELLO (verifyHello)', () => {
  fuzzIt(
    'random HELLOs never verify, never throw',
    fc.tuple(
      helloArb,
      fc.uint8Array({ minLength: 32, maxLength: 32 }),
      fc.uint8Array({ minLength: 32, maxLength: 32 }),
    ),
    ([hello, hash, key]: [HelloMessage, Uint8Array, Uint8Array]) => {
      let ok: boolean | undefined;
      expect(() => {
        ok = verifyHello(hello, {
          handshakeHash: hash,
          localNoiseKey: key,
          remoteNoiseKey: key,
        }).ok;
      }).not.toThrow();
      expect(ok).toBe(false);
    },
  );
});

describe('fuzz: a video manifest from a relay (verifyVideoEvent)', () => {
  const signer = new TestSigner();
  const signed = Promise.all(VIDEOS.slice(0, 3).map((v) => signer.signEvent(buildVideoEvent(v))));
  const never = (raw: unknown): void => {
    expect(() => verifyVideoEvent(raw)).not.toThrow();
  };
  fuzzIt('arbitrary values', fc.anything({ maxDepth: 4 }), never);
  fuzzIt('arbitrary JSON', fc.jsonValue({ maxDepth: 5 }), never);
  fuzzIt(
    'mutated signed events (any field, any tag)',
    fc.tuple(fc.nat(2), fc.nat(), fc.jsonValue({ maxDepth: 2 }), fc.nat()),
    async ([which, at, value, tagAt]) => {
      const ev = (await signed)[which]!;
      const keys = Object.keys(ev);
      const k = keys[at % keys.length]!;
      never({ ...ev, [k]: value });
      const tags = ev.tags.map((t) => [...t]);
      const t = tags[tagAt % tags.length]!;
      t[at % t.length] = typeof value === 'string' ? value : JSON.stringify(value);
      const r = verifyVideoEvent({ ...ev, tags });
      // A tag edited after signing must never verify.
      expect(r.ok).toBe(JSON.stringify(tags) === JSON.stringify(ev.tags));
    },
  );
});

describe('fuzz: the creator split of every PAY (splitPay)', () => {
  const amount = fc.oneof(
    fc.integer({ min: -5, max: 2 ** 41 }),
    fc.double(),
    fc.constant(Number.NaN),
  );
  const split = fc.oneof(
    fc.integer({ min: 0, max: 100 }).map((c) => ({ seeder: 100 - c, creator: c })),
    fc.record({
      seeder: fc.integer({ min: -10, max: 110 }),
      creator: fc.integer({ min: -10, max: 110 }),
    }),
    fc.anything(),
  );
  const carry = fc.oneof(fc.integer({ min: -2, max: 101 }), fc.double());
  fuzzIt(
    'valid input: the parts sum to the amount; invalid: RangeError only',
    fc.tuple(amount, split, carry),
    ([a, s, c]) => {
      const valid =
        Number.isSafeInteger(a) && a >= 0 && a <= 2 ** 40 && isValidSplit(s) && isValidCarry(c);
      if (!valid) {
        expect(() => splitPay(a, s as never, c)).toThrow(RangeError);
        return;
      }
      const r = splitPay(a, s, c);
      expect(r.seederSats + r.creatorSats === a).toBe(true); // === : -0 and 0 are one amount
      expect(r.seederSats).toBeGreaterThanOrEqual(0);
      expect(r.creatorSats).toBeGreaterThanOrEqual(0);
      expect(r.carryOut >= 0 && r.carryOut < 100).toBe(true);
    },
  );
  fuzzIt(
    'telescoping (ADR 0007): over a sequence, creator total = floor((Σ amounts × c + carryIn) / 100)',
    fc.tuple(
      fc.array(fc.integer({ min: 0, max: 100_000 }), { maxLength: 50 }),
      fc.integer({ min: 0, max: 100 }),
      fc.integer({ min: 0, max: 99 }),
    ),
    ([amounts, c, carryIn]) => {
      const s = { seeder: 100 - c, creator: c };
      const seq = splitSequence(amounts, s, carryIn);
      const creator = seq.splits.reduce((n, p) => n + p.creatorSats, 0);
      const total = amounts.reduce((n, x) => n + x, 0);
      expect(creator).toBe(Math.floor((total * c + carryIn) / 100));
    },
  );
});

/**
 * ADR 0016 (issue #3): the locked `seed.ts` — the NUT-13 recovery phrase, the seed in secure
 * memory, and this device's durable counters.
 *
 *   the phrase          12 words over 16 bytes from the library's CSPRNG; indices round-trip;
 *                       typed words are NFKD-normalised and lower-cased; every refusal names the
 *                       problem (`length`, `word`, `checksum`) and never a word;
 *   the seed            `mnemonicToSeed(words, '')` in secure memory — proven by the NUT-13 test
 *                       vectors (docs/vendor/NUT-13-tests.md) through OUR wiring: v1 `00…` keysets
 *                       derive by the BIP-32 path, v2 `01…` keysets by HMAC-SHA256; a wiped seed
 *                       (or wiped entropy, whose phrase is public) is refused before any derivation;
 *   the counters        leased ahead (the lease is on disk before a counter is handed out), so a
 *                       restart or a crash never hands one out twice; a failed save hands out
 *                       nothing; a keyset the store does not know is probed first, and without an
 *                       answer nothing is derived; closed means closed; the `published` watermark
 *                       and the ranges a startup restore scans.
 */
import type { OutputData } from '@cashu/cashu-ts';
import { type HasKeysetKeys } from '@cashu/cashu-ts';
import { describe, expect, it } from 'vitest';

import { MemoryCounterStore } from '../../mocks/counter-store.js';
import type { CounterState, RecoveryEntropy } from '../recovery-api.js';
import {
  COUNTER_LEASE,
  COUNTER_LIMIT,
  COUNTER_PROBE_SPAN,
  CounterStateError,
  DurableCounterSource,
  counterBinding,
  RecoveryPhraseError,
  RecoverySeedError,
  entropyFromBytes,
  entropyFromHex,
  entropyToHex,
  isCounterState,
  recoveryPhrases,
  sameSeed,
  seedBytes,
  wipeEntropy,
} from '../seed.js';
import { seedGuardedOutputs } from '../spend.js';

// docs/vendor/NUT-13-tests.md (cashubtc/nuts@8bde3c0)
const VECTOR_WORDS =
  'half depart obvious quality work element tank gorilla view sugar picture humble'.split(' ');
const V1 = {
  keysetId: '009a1f293253e41e',
  secrets: [
    '485875df74771877439ac06339e284c3acfcd9be7abf3bc20b516faeadfe77ae',
    '8f2b39e8e594a4056eb1e6dbb4b0c38ef13b1b2c751f64f810ec04ee35b77270',
    'bc628c79accd2364fd31511216a0fab62afd4a18ff77a20deded7b858c9860c8',
    '59284fd1650ea9fa17db2b3acf59ecd0f2d52ec3261dd4152785813ff27a33bf',
    '576c23393a8b31cc8da6688d9c9a96394ec74b40fdaf1f693a6bb84284334ea0',
  ],
  r: [
    'ad00d431add9c673e843d4c2bf9a778a5f402b985b8da2d5550bf39cda41d679',
    '967d5232515e10b81ff226ecf5a9e2e2aff92d66ebc3edf0987eb56357fd6248',
    'b20f47bb6ae083659f3aa986bfa0435c55c6d93f687d51a01f26862d9b9a4899',
    'fb5fca398eb0b1deb955a2988b5ac77d32956155f1c002a373535211a2dfdc29',
    '5f09bfbfe27c439a597719321e061e2e40aad4a36768bb2bcc3de547c9644bf9',
  ],
};
const V2 = {
  keysetId: '015ba18a8adcd02e715a58358eb618da4a4b3791151a4bee5e968bb88406ccf76a',
  secrets: [
    'db5561a07a6e6490f8dadeef5be4e92f7cebaecf2f245356b5b2a4ec40687298',
    'b70e7b10683da3bf1cdf0411206f8180c463faa16014663f39f2529b2fda922e',
    '78a7ac32ccecc6b83311c6081b89d84bb4128f5a0d0c5e1af081f301c7a513f5',
    '094a2b6c63bfa7970bc09cda0e1cfc9cd3d7c619b8e98fabcfc60aea9e4963e5',
    '5e89fc5d30d0bf307ddf0a3ac34aa7a8ee3702169dafa3d3fe1d0cae70ecd5ef',
  ],
  r: [
    '6d26181a3695e32e9f88b80f039ba1ae2ab5a200ad4ce9dbc72c6d3769f2b035',
    'bde4354cee75545bea1a2eee035a34f2d524cee2bb01613823636e998386952e',
    'f40cc1218f085b395c8e1e5aaa25dccc851be3c6c7526a0f4e57108f12d6dac4',
    '099ed70fc2f7ac769bc20b2a75cb662e80779827b7cc358981318643030577d0',
    '5550337312d223ba62e3f75cfe2ab70477b046d98e3e71804eade3956c7b98cf',
  ],
};

const KS_A = '01' + 'aa'.repeat(32);
const KS_B = '00' + 'bb'.repeat(7);

/** `[secret hex, r hex]` of the deterministic outputs `[start, start + n)` under `keysetId`. */
function derive(
  seed: Awaited<ReturnType<typeof recoveryPhrases.toSeed>>,
  keysetId: string,
  start: number,
  n: number,
): [string, string][] {
  const keyset: HasKeysetKeys = { id: keysetId, keys: {} };
  return seedGuardedOutputs(seed)
    .createDeterministicData(0, seedBytes(seed), start, keyset, new Array<number>(n).fill(0))
    .map((o: OutputData) => [
      new TextDecoder().decode(o.secret),
      o.blindingFactor.toString(16).padStart(64, '0'),
    ]);
}

/** The error a call throws (or rejects with). */
async function caught(f: () => unknown): Promise<unknown> {
  try {
    await f();
  } catch (e) {
    return e;
  }
  throw new Error('expected a refusal');
}

describe('the phrase (RecoveryPhrases)', () => {
  it('generate: 16 bytes of entropy, a different phrase each time, 12 valid indices', () => {
    const a = recoveryPhrases.generate();
    const b = recoveryPhrases.generate();
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a.length).toBe(16);
    expect(entropyToHex(a)).not.toBe(entropyToHex(b));
    const idx = recoveryPhrases.toIndices(a);
    expect(idx).toHaveLength(12);
    for (const i of idx) expect(Number.isInteger(i) && i >= 0 && i < 2048).toBe(true);
  });

  it('indices round-trip to the same entropy; the vector phrase round-trips through its words', () => {
    const e = recoveryPhrases.generate();
    const back = recoveryPhrases.fromIndices(recoveryPhrases.toIndices(e));
    expect(entropyToHex(back)).toBe(entropyToHex(e));
    const v = recoveryPhrases.fromWords(VECTOR_WORDS);
    expect(entropyToHex(recoveryPhrases.fromIndices(recoveryPhrases.toIndices(v)))).toBe(
      entropyToHex(v),
    );
  });

  it('typed words are NFKD-normalised, trimmed and lower-cased', () => {
    const typed = VECTOR_WORDS.map((w, i) => (i % 2 === 0 ? ` ${w.toUpperCase()}\t` : w));
    expect(entropyToHex(recoveryPhrases.fromWords(typed))).toBe(
      entropyToHex(recoveryPhrases.fromWords(VECTOR_WORDS)),
    );
    // A full-width "Ｈａｌｆ" folds to "half" under NFKD + lower-case.
    const wide = ['Ｈａｌｆ', ...VECTOR_WORDS.slice(1)];
    expect(entropyToHex(recoveryPhrases.fromWords(wide))).toBe(
      entropyToHex(recoveryPhrases.fromWords(VECTOR_WORDS)),
    );
  });

  it('refusals name the problem — length, word, checksum — and never quote a word', async () => {
    const cases: [() => unknown, string][] = [
      [() => recoveryPhrases.fromWords(VECTOR_WORDS.slice(0, 11)), 'length'],
      [() => recoveryPhrases.fromWords([...VECTOR_WORDS, 'half']), 'length'],
      [() => recoveryPhrases.fromWords('not an array' as unknown as string[]), 'length'],
      [() => recoveryPhrases.fromWords([...VECTOR_WORDS.slice(0, 11), 'zzzzqx']), 'word'],
      [
        () => recoveryPhrases.fromWords([...VECTOR_WORDS.slice(0, 11), 7 as unknown as string]),
        'word',
      ],
      // Every word is in the list; the last one breaks the checksum.
      [() => recoveryPhrases.fromWords([...VECTOR_WORDS.slice(0, 11), 'zoo']), 'checksum'],
      [() => recoveryPhrases.fromIndices([1, 2, 3]), 'length'],
      [() => recoveryPhrases.fromIndices(new Array<number>(12).fill(2048)), 'word'],
      [() => recoveryPhrases.fromIndices([...new Array<number>(11).fill(0), -1]), 'word'],
      [() => recoveryPhrases.fromIndices([...new Array<number>(11).fill(0), 1.5]), 'word'],
      [() => recoveryPhrases.fromIndices(new Array<number>(12).fill(1)), 'checksum'],
      [() => recoveryPhrases.toIndices(new Uint8Array(15) as RecoveryEntropy), 'length'],
      [() => entropyFromBytes(new Uint8Array(17)), 'length'],
      [() => entropyFromHex('00'.repeat(15)), 'length'],
      [() => entropyFromHex('AB'.repeat(16)), 'length'],
    ];
    for (const [f, problem] of cases) {
      const e = await caught(f);
      expect(e).toBeInstanceOf(RecoveryPhraseError);
      expect((e as RecoveryPhraseError).problem).toBe(problem);
      expect((e as Error).message).toBe(`recovery-phrase: ${problem}`);
      for (const w of [...VECTOR_WORDS, 'zoo', 'zzzzqx'])
        expect((e as Error).message).not.toContain(w);
    }
  });

  it('entropy read back from hex or bytes lands in a new buffer; the caller keeps its own', () => {
    const e = recoveryPhrases.generate();
    const hex = entropyToHex(e);
    expect(hex).toMatch(/^[0-9a-f]{32}$/);
    expect(entropyToHex(entropyFromHex(hex))).toBe(hex);
    const plain = Uint8Array.from(e);
    const adopted = entropyFromBytes(plain);
    expect(adopted).not.toBe(plain);
    expect(entropyToHex(adopted)).toBe(hex);
    expect(Array.from(plain)).toEqual(Array.from(e)); // not zeroed behind the caller's back
  });

  it('wipeEntropy zeroes it, and zeroed entropy is refused before it is shown or seeded', async () => {
    const e = recoveryPhrases.generate();
    wipeEntropy(e);
    expect(Array.from(e).every((b) => b === 0)).toBe(true);
    expect(await caught(() => recoveryPhrases.toIndices(e))).toBeInstanceOf(RecoverySeedError);
    expect(await caught(() => recoveryPhrases.toSeed(e))).toBeInstanceOf(RecoverySeedError);
    wipeEntropy(e); // idempotent
  });

  it('zeroed entropy is refused before it is written as a relay copy (its phrase is public)', async () => {
    // Independent review 2026-09-27, finding 9: `entropyToHex` checked only the length.
    const e = recoveryPhrases.generate();
    wipeEntropy(e);
    expect(await caught(() => entropyToHex(e))).toBeInstanceOf(RecoverySeedError);
    expect(await caught(() => entropyToHex(new Uint8Array(3) as RecoveryEntropy))).toBeInstanceOf(
      RecoveryPhraseError,
    );
  });
});

describe('the seed: the NUT-13 test vectors through our wiring', () => {
  it('v1 (00…) keysets derive by the BIP-32 path: secrets and blinding factors match', async () => {
    const seed = await recoveryPhrases.toSeed(recoveryPhrases.fromWords(VECTOR_WORDS));
    const got = derive(seed, V1.keysetId, 0, 5);
    expect(got.map((g) => g[0])).toEqual(V1.secrets);
    expect(got.map((g) => g[1])).toEqual(V1.r);
    // Counter 3 alone is the vector's counter 3 (the counter picks the path, not the position).
    expect(derive(seed, V1.keysetId, 3, 1)[0]).toEqual([V1.secrets[3], V1.r[3]]);
  });

  it('v2 (01…) keysets derive by HMAC-SHA256: secrets and blinding factors match', async () => {
    const seed = await recoveryPhrases.toSeed(recoveryPhrases.fromWords(VECTOR_WORDS));
    const got = derive(seed, V2.keysetId, 0, 5);
    expect(got.map((g) => g[0])).toEqual(V2.secrets);
    expect(got.map((g) => g[1])).toEqual(V2.r);
  });

  it('the seed is 64 bytes in its own buffer; a wiped seed is zero and refused', async () => {
    const seed = await recoveryPhrases.toSeed(recoveryPhrases.fromWords(VECTOR_WORDS));
    const bytes = seedBytes(seed);
    expect(bytes.length).toBe(64);
    expect(seed.wiped).toBe(false);
    seed.wipe();
    expect(seed.wiped).toBe(true);
    expect(Array.from(bytes).every((b) => b === 0)).toBe(true);
    expect(await caught(() => seedBytes(seed))).toMatchObject({ problem: 'wiped' });
    // cashu-ts holds the buffer by reference: the guarded output creator refuses it too.
    expect(await caught(() => derive(seed, V2.keysetId, 0, 1))).toBeInstanceOf(RecoverySeedError);
    seed.wipe(); // idempotent
  });

  it('a seed core did not make is refused (the derivation takes only its own buffers)', async () => {
    const fake = { wipe: () => undefined, wiped: false };
    expect(await caught(() => seedBytes(fake))).toMatchObject({ problem: 'foreign' });
    const seed = await recoveryPhrases.toSeed(recoveryPhrases.fromWords(VECTOR_WORDS));
    const other = new Uint8Array(64).fill(7);
    const keyset: HasKeysetKeys = { id: V2.keysetId, keys: {} };
    expect(
      await caught(() =>
        seedGuardedOutputs(seed).createDeterministicData(0, other, 0, keyset, [0]),
      ),
    ).toMatchObject({ problem: 'foreign' });
  });

  it('counters at or past 2^31 are refused (a v1 counter is a hardened BIP-32 index)', async () => {
    const seed = await recoveryPhrases.toSeed(recoveryPhrases.fromWords(VECTOR_WORDS));
    // Starting at 2^31: refused before anything is derived, v1 or v2.
    for (const id of [V1.keysetId, V2.keysetId])
      expect(await caught(() => derive(seed, id, COUNTER_LIMIT, 1))).toMatchObject({
        code: 'invalid-argument',
      });
    // A range running past it: v2 (HMAC) has no limit of its own in cashu-ts — ours refuses it;
    // v1 is refused by cashu-ts's own BIP-32 check as well.
    expect(await caught(() => derive(seed, V2.keysetId, COUNTER_LIMIT - 1, 2))).toMatchObject({
      code: 'invalid-argument',
    });
    expect(await caught(() => derive(seed, V1.keysetId, COUNTER_LIMIT - 1, 2))).toBeInstanceOf(
      Error,
    );
    expect(derive(seed, V1.keysetId, COUNTER_LIMIT - 1, 1)).toHaveLength(1);
    expect(derive(seed, V2.keysetId, COUNTER_LIMIT - 1, 1)).toHaveLength(1);
  });

  it('sameSeed: the same phrase twice is the same seed; another phrase, or a wiped one, is not', async () => {
    const e = recoveryPhrases.fromWords(VECTOR_WORDS);
    const a = await recoveryPhrases.toSeed(e);
    const b = await recoveryPhrases.toSeed(e);
    const c = await recoveryPhrases.toSeed(recoveryPhrases.generate());
    expect(sameSeed(a, b)).toBe(true);
    expect(sameSeed(a, c)).toBe(false);
    expect(sameSeed(a, undefined)).toBe(false);
    b.wipe();
    expect(sameSeed(a, b)).toBe(false);
  });
});

describe('DurableCounterSource: counters never repeat', () => {
  const state = (
    next: Record<string, number>,
    published: Record<string, number> = {},
  ): CounterState => ({
    v: 1,
    next,
    published,
  });

  it('leases ahead: the lease is on disk BEFORE the range is handed out', async () => {
    const store = new MemoryCounterStore(state({ [KS_A]: 0 }));
    const src = new DurableCounterSource(store);
    const r1 = await src.reserve(KS_A, 5);
    expect(r1).toEqual({ start: 0, count: 5 });
    expect(store.saved).toEqual([state({ [KS_A]: 5 + COUNTER_LEASE })]);
    // Inside the lease: no second write.
    expect(await src.reserve(KS_A, 10)).toEqual({ start: 5, count: 10 });
    expect(store.saved).toHaveLength(1);
    // Past it: a new lease first.
    expect(await src.reserve(KS_A, 30)).toEqual({ start: 15, count: 30 });
    expect(store.saved.at(-1)?.next[KS_A]).toBe(45 + COUNTER_LEASE);
  });

  it('a restart continues at the lease: nothing handed out before is handed out again', async () => {
    const store = new MemoryCounterStore(state({ [KS_A]: 0 }));
    const a = new DurableCounterSource(store);
    await a.reserve(KS_A, 3);
    await a.reserve(KS_A, 4);
    // Crash: the process dies with the lease unused.
    const b = new DurableCounterSource(store);
    const r = await b.reserve(KS_A, 2);
    expect(r.start).toBe(COUNTER_LEASE + 3);
    expect(r.start).toBeGreaterThanOrEqual(7);
  });

  it('a failed save hands out nothing and moves nothing; the next call writes again', async () => {
    const store = new MemoryCounterStore(state({ [KS_A]: 0 }));
    const src = new DurableCounterSource(store);
    store.failNextSave();
    await expect(src.reserve(KS_A, 3)).rejects.toThrow('simulated write failure');
    expect(await src.snapshot()).toEqual({ [KS_A]: 0 });
    expect(await src.reserve(KS_A, 3)).toEqual({ start: 0, count: 3 });
    expect(store.state?.next[KS_A]).toBe(3 + COUNTER_LEASE);
  });

  it('concurrent reservations never overlap (one at a time, in call order)', async () => {
    const store = new MemoryCounterStore(state({ [KS_A]: 0 }));
    const src = new DurableCounterSource(store, { lease: 4 });
    const got = await Promise.all(
      Array.from({ length: 20 }, (_, i) => src.reserve(KS_A, (i % 3) + 1)),
    );
    const used = new Set<number>();
    for (const r of got)
      for (let c = r.start; c < r.start + r.count; c++) {
        expect(used.has(c)).toBe(false);
        used.add(c);
      }
  });

  it('keysets count separately, one counter per keyset id (across every mint)', async () => {
    const store = new MemoryCounterStore(state({ [KS_A]: 10, [KS_B]: 0 }));
    const src = new DurableCounterSource(store);
    expect((await src.reserve(KS_A, 1)).start).toBe(10);
    expect((await src.reserve(KS_B, 1)).start).toBe(0);
    expect(await src.snapshot()).toEqual({ [KS_A]: 11, [KS_B]: 1 });
  });

  it('reserve(n = 0) peeks without moving the cursor or writing', async () => {
    const store = new MemoryCounterStore(state({ [KS_A]: 7 }));
    const src = new DurableCounterSource(store);
    expect(await src.reserve(KS_A, 0)).toEqual({ start: 7, count: 0 });
    expect(await src.reserve(KS_A, 0)).toEqual({ start: 7, count: 0 });
    expect(store.saved).toHaveLength(0);
  });

  it('reserveAt: a range below the cursor is refused; one above burns the gap and is leased', async () => {
    const store = new MemoryCounterStore(state({ [KS_A]: 0 }));
    const src = new DurableCounterSource(store);
    await src.reserve(KS_A, 10);
    await expect(src.reserveAt(KS_A, 5, 2)).rejects.toMatchObject({ problem: 'argument' });
    expect(await src.reserveAt(KS_A, 100, 3)).toEqual({ start: 100, count: 3 });
    expect(store.state?.next[KS_A]).toBe(103 + COUNTER_LEASE);
    expect((await src.reserve(KS_A, 1)).start).toBe(103);
  });

  it('advanceToAtLeast never moves back, and a move past the lease is written first', async () => {
    const store = new MemoryCounterStore(state({ [KS_A]: 0 }));
    const src = new DurableCounterSource(store);
    await src.reserve(KS_A, 5);
    await src.advanceToAtLeast(KS_A, 2);
    expect((await src.snapshot())[KS_A]).toBe(5);
    await src.advanceToAtLeast(KS_A, 500);
    expect(store.state?.next[KS_A]).toBe(500);
    expect((await new DurableCounterSource(store).reserve(KS_A, 1)).start).toBe(500);
  });

  it('refuses bad arguments: a non-hex keyset id, a negative or fractional count or counter', async () => {
    const src = new DurableCounterSource(new MemoryCounterStore(state({ [KS_A]: 0 })));
    for (const f of [
      () => src.reserve('not-hex', 1),
      () => src.reserve('', 1),
      () => src.reserve(KS_A, -1),
      () => src.reserve(KS_A, 1.5),
      () => src.reserveAt(KS_A, -1, 1),
      () => src.advanceToAtLeast(KS_A, COUNTER_LIMIT + 1),
    ])
      expect(await caught(f)).toMatchObject({ problem: 'argument' });
    expect(() => new DurableCounterSource(new MemoryCounterStore(), { lease: 0 })).toThrow(
      CounterStateError,
    );
  });

  it('the counter space ends below 2^31: a range past it is refused, not wrapped', async () => {
    const store = new MemoryCounterStore(state({ [KS_A]: COUNTER_LIMIT - 2 }));
    const src = new DurableCounterSource(store);
    expect(await src.reserve(KS_A, 2)).toEqual({ start: COUNTER_LIMIT - 2, count: 2 });
    expect(store.state?.next[KS_A]).toBe(COUNTER_LIMIT); // the lease is capped, not wrapped
    await expect(src.reserve(KS_A, 1)).rejects.toMatchObject({ problem: 'exhausted' });
  });

  it('a malformed counters file is refused, not guessed at (and nothing is derived)', async () => {
    for (const bad of [
      { v: 2, next: {}, published: {} },
      { v: 1, next: { [KS_A]: -1 }, published: {} },
      { v: 1, next: { 'NOT HEX': 1 }, published: {} },
      { v: 1, next: { [KS_A]: 1.5 }, published: {} },
      { v: 1, next: [], published: {} },
      { v: 1, next: {} },
    ]) {
      expect(isCounterState(bad)).toBe(false);
      const store = new MemoryCounterStore();
      store.state = bad as unknown as CounterState;
      await expect(new DurableCounterSource(store).reserve(KS_A, 1)).rejects.toMatchObject({
        problem: 'malformed',
      });
    }
    expect(isCounterState(state({ [KS_A]: 3 }, { [KS_A]: 1 }))).toBe(true);
  });

  it('closed: every reservation throws, and so does moving the cursor', async () => {
    const src = new DurableCounterSource(new MemoryCounterStore(state({ [KS_A]: 0 })));
    src.close();
    expect(src.closed).toBe(true);
    await expect(src.reserve(KS_A, 1)).rejects.toMatchObject({ problem: 'closed' });
    await expect(src.reserveAt(KS_A, 5, 1)).rejects.toMatchObject({ problem: 'closed' });
    await expect(src.advanceToAtLeast(KS_A, 5)).rejects.toMatchObject({ problem: 'closed' });
  });
});

describe('DurableCounterSource: a keyset the store does not know is probed first', () => {
  // Independent review 2026-09-27, finding 2: the probe is no longer a registry of every loaded
  // mint's probe (`addProbe`), run by `reserve` and maxed across mints — a mint announcing another
  // mint's keyset id pushed the cursor ~20 000 ahead. The `Spender` now calls `ensureProbed` with
  // the probe of the ONE mint an operation runs at, and a probe moves the cursor by at most one
  // batch (`COUNTER_PROBE_SPAN`). The tests below keep each property the registry tests checked,
  // through that API; "several mints: the furthest wins" and "an unregistered probe is not asked"
  // were properties of the registry itself and are replaced by the two tests after them.
  it('no state at all: the probe answers, the cursor starts past what the mint signed', async () => {
    const store = new MemoryCounterStore(null);
    const src = new DurableCounterSource(store);
    const asked: [string, number][] = [];
    const probe = (id: string, from: number): Promise<number | undefined> => {
      asked.push([id, from]);
      return Promise.resolve(id === KS_A ? 37 : undefined); // was 137: past one batch now (below)
    };
    await src.ensureProbed(KS_A, probe);
    expect((await src.reserve(KS_A, 2)).start).toBe(37);
    expect(asked).toEqual([[KS_A, 0]]);
    // Probed once per process: the next operation asks nobody.
    await src.ensureProbed(KS_A, probe);
    expect((await src.reserve(KS_A, 1)).start).toBe(39);
    expect(asked).toHaveLength(1);
    // And the probe's answer is covered by the lease on disk.
    expect(store.state?.next[KS_A]).toBe(39 + COUNTER_LEASE);
  });

  it('a keyset the stored state knows is not probed', async () => {
    const src = new DurableCounterSource(
      new MemoryCounterStore({ v: 1, next: { [KS_A]: 4 }, published: {} }),
    );
    let asked = 0;
    await src.ensureProbed(KS_A, () => {
      asked++;
      return Promise.resolve(999);
    });
    expect((await src.reserve(KS_A, 1)).start).toBe(4);
    expect(asked).toBe(0);
  });

  it('a probe moves the cursor by at most one batch, however far the mint claims this seed signed', async () => {
    expect(COUNTER_PROBE_SPAN).toBe(100);
    const src = new DurableCounterSource(new MemoryCounterStore(null));
    await src.ensureProbed(KS_A, () => Promise.resolve(19_936));
    expect((await src.reserve(KS_A, 1)).start).toBe(COUNTER_PROBE_SPAN);
  });

  it('reserve never asks anyone by itself: an unknown keyset is refused until ensureProbed ran', async () => {
    const src = new DurableCounterSource(new MemoryCounterStore(null));
    await expect(src.reserve(KS_A, 1)).rejects.toMatchObject({ problem: 'unprobed' });
    await expect(src.reserveAt(KS_A, 3, 1)).rejects.toMatchObject({ problem: 'unprobed' });
    // One keyset probed says nothing about another.
    await src.ensureProbed(KS_A, () => Promise.resolve(0));
    await expect(src.reserve(KS_B, 1)).rejects.toMatchObject({ problem: 'unprobed' });
  });

  it('nobody can answer (the mint does not serve the keyset): nothing is derived', async () => {
    const src = new DurableCounterSource(new MemoryCounterStore(null));
    await expect(src.ensureProbed(KS_A, () => Promise.resolve(undefined))).rejects.toMatchObject({
      problem: 'unprobed',
    });
    await expect(src.reserve(KS_A, 1)).rejects.toMatchObject({ problem: 'unprobed' });
  });

  it('a probe that fails (the mint cannot be asked) refuses the reservation; a later one works', async () => {
    const src = new DurableCounterSource(new MemoryCounterStore(null));
    let down = true;
    const probe = (): Promise<number> =>
      down ? Promise.reject(new Error('connect ETIMEDOUT')) : Promise.resolve(3);
    await expect(src.ensureProbed(KS_A, probe)).rejects.toThrow('ETIMEDOUT');
    await expect(src.reserve(KS_A, 1)).rejects.toMatchObject({ problem: 'unprobed' });
    down = false;
    await src.ensureProbed(KS_A, probe);
    expect((await src.reserve(KS_A, 1)).start).toBe(3);
  });

  it('a probe answering nonsense (negative, fractional, past 2^31, below the cursor) refuses the reservation', async () => {
    for (const bad of [-1, 2.5, COUNTER_LIMIT + 1, Number.NaN]) {
      const src = new DurableCounterSource(new MemoryCounterStore(null));
      await expect(src.ensureProbed(KS_A, () => Promise.resolve(bad))).rejects.toMatchObject({
        problem: 'unprobed',
      });
      await expect(src.reserve(KS_A, 1)).rejects.toMatchObject({ problem: 'unprobed' });
    }
  });

  it('a slow probe at one mint does not hold up reservations under keysets already known', async () => {
    // Found fixing finding 2: the probe ran inside the serial chain, so a mint answering slowly
    // (up to the transport's 30 s) stalled every seeded reservation at every mint.
    const src = new DurableCounterSource(
      new MemoryCounterStore({ v: 1, next: { [KS_A]: 0 }, published: {} }),
    );
    let release: (n: number) => void = () => undefined;
    const probing = src.ensureProbed(
      KS_B,
      () =>
        new Promise<number>((res) => {
          release = res;
        }),
    );
    const other = src.reserve(KS_A, 1);
    const first = await Promise.race([
      other.then(() => 'reserved'),
      new Promise((r) => {
        setTimeout(() => {
          r('blocked');
        }, 500);
      }),
    ]);
    expect(first).toBe('reserved');
    release(0);
    await probing;
    expect((await src.reserve(KS_B, 1)).start).toBe(0);
  });

  it('closed during the probe: the reservation is refused', async () => {
    const src = new DurableCounterSource(new MemoryCounterStore(null));
    let release: (n: number) => void = () => undefined;
    let asked: () => void = () => undefined;
    const probing = new Promise<void>((res) => (asked = res));
    const r = src.ensureProbed(
      KS_A,
      () =>
        new Promise<number>((res) => {
          release = res;
          asked();
        }),
    );
    await probing;
    src.close();
    release(5);
    await expect(r).rejects.toMatchObject({ problem: 'closed' });
    await expect(src.ensureProbed(KS_A, () => Promise.resolve(0))).rejects.toMatchObject({
      problem: 'closed',
    });
  });
});

describe('DurableCounterSource: two writers, and the phrase a counters file belongs to', () => {
  const B1 = 'ff' + '11'.repeat(16);
  const B2 = 'ff' + '22'.repeat(16);

  it('two sources over one file never hand out the same counter: a lease another writer took moves the cursor past it', async () => {
    // Independent review 2026-09-27, finding 5 (the shell should never do this: residual 2).
    const store = new MemoryCounterStore({ v: 1, next: { [KS_A]: 0 }, published: {} });
    const a = new DurableCounterSource(store);
    const b = new DurableCounterSource(store);
    await a.snapshot(); // both loaded before either leased
    await b.snapshot();
    const got = [
      await a.reserve(KS_A, 5),
      await b.reserve(KS_A, 5),
      await a.reserve(KS_A, 40), // past a's own lease: b's is on disk above it
      await b.reserve(KS_A, 3),
    ];
    const used = new Set<number>();
    for (const r of got)
      for (let c = r.start; c < r.start + r.count; c++) {
        expect(used.has(c)).toBe(false);
        used.add(c);
      }
    // A caller-fixed range inside another writer's lease is refused, not handed out.
    const c = new DurableCounterSource(store);
    const d = new DurableCounterSource(store);
    await c.snapshot();
    await d.snapshot();
    const onDisk = store.state?.next[KS_A] ?? 0;
    await d.reserve(KS_A, 1);
    await expect(c.reserveAt(KS_A, onDisk, 1)).rejects.toMatchObject({ problem: 'argument' });
  });

  it('a file another phrase wrote reads as no state: every keyset is probed from 0, and the file is taken over', async () => {
    const store = new MemoryCounterStore(null);
    const first = new DurableCounterSource(store, { binding: B1 });
    await first.ensureProbed(KS_A, () => Promise.resolve(0));
    await first.reserve(KS_A, 450);
    expect(store.state?.published[B1]).toBe(0);
    first.close();
    const rotated = new DurableCounterSource(store, { binding: B2 });
    const asked: number[] = [];
    await rotated.ensureProbed(KS_A, (_id, from) => {
      asked.push(from);
      return Promise.resolve(from);
    });
    expect(asked).toEqual([0]); // not 450 + the lease
    expect((await rotated.reserve(KS_A, 3)).start).toBe(0);
    // The file is the new phrase's now: its binding, its counters, none of the old ones.
    expect(store.state?.published[B2]).toBe(0);
    expect(store.state?.published[B1]).toBeUndefined();
    expect(store.state?.next[KS_A]).toBe(3 + COUNTER_LEASE);
    // A restart of the new phrase continues from it without a probe.
    const again = new DurableCounterSource(store, { binding: B2 });
    expect((await again.reserve(KS_A, 1)).start).toBe(3 + COUNTER_LEASE);
  });

  it('a closed source of the old phrase flushing late leaves the file the new phrase took over alone', async () => {
    const store = new MemoryCounterStore(null);
    const old = new DurableCounterSource(store, { binding: B1 });
    await old.ensureProbed(KS_A, () => Promise.resolve(0));
    await old.reserve(KS_A, 5);
    await old.markPublished(new Set()); // dirty: a flush would write
    old.close();
    const rotated = new DurableCounterSource(store, { binding: B2 });
    await rotated.ensureProbed(KS_A, () => Promise.resolve(0));
    await rotated.reserve(KS_A, 2);
    const taken = structuredClone(store.state);
    await old.flush();
    expect(store.state).toEqual(taken);
  });

  it('a file without a binding (written before it existed) is adopted; the same phrase keeps merging', async () => {
    const store = new MemoryCounterStore({ v: 1, next: { [KS_A]: 9 }, published: { [KS_A]: 2 } });
    const src = new DurableCounterSource(store, { binding: B1 });
    expect((await src.reserve(KS_A, 1)).start).toBe(9);
    expect(store.state).toEqual({
      v: 1,
      next: { [KS_A]: 10 + COUNTER_LEASE },
      published: { [KS_A]: 2, [B1]: 0 },
    });
    expect(isCounterState(store.state)).toBe(true);
    // A binding that is not one is refused at construction.
    expect(() => new DurableCounterSource(store, { binding: 'ff00' })).toThrow(CounterStateError);
  });

  it('counterBinding: the same phrase gives the same binding, another phrase another; never the seed', async () => {
    const entropy = recoveryPhrases.generate();
    const a = await recoveryPhrases.toSeed(entropy);
    const b = await recoveryPhrases.toSeed(entropy);
    const c = await recoveryPhrases.toSeed(recoveryPhrases.generate());
    expect(counterBinding(a)).toMatch(/^ff[0-9a-f]{32}$/);
    expect(counterBinding(a)).toBe(counterBinding(b));
    expect(counterBinding(a)).not.toBe(counterBinding(c));
    expect(Buffer.from(seedBytes(a)).toString('hex')).not.toContain(counterBinding(a).slice(2));
    a.wipe();
    expect(() => counterBinding(a)).toThrow(RecoverySeedError);
  });
});

describe('DurableCounterSource: the published watermark (ADR 0016 §3)', () => {
  it('unpublished = [published, next) as stored; markPublished moves it to the cursor, flush writes it', async () => {
    const store = new MemoryCounterStore({ v: 1, next: { [KS_A]: 0 }, published: {} });
    const src = new DurableCounterSource(store);
    await src.reserve(KS_A, 5);
    expect(await src.unpublished()).toEqual([{ keysetId: KS_A, from: 0, to: 5 + COUNTER_LEASE }]);
    await src.markPublished(new Set());
    // Kept in memory until the next lease or a flush (a stale watermark only restores more).
    expect(store.state?.published).toEqual({});
    await src.flush();
    expect(store.state?.published).toEqual({ [KS_A]: 5 });
    expect(await src.unpublished()).toEqual([{ keysetId: KS_A, from: 5, to: 5 + COUNTER_LEASE }]);
    // A restart sees the same ranges.
    expect(await new DurableCounterSource(store).unpublished()).toEqual([
      { keysetId: KS_A, from: 5, to: 5 + COUNTER_LEASE },
    ]);
  });

  it('markPublished leaves the keysets it is told to hold (a startup restore did not finish them)', async () => {
    // `hold` is required (an empty set to hold nothing): forgetting it must not move a held keyset.
    const store = new MemoryCounterStore({ v: 1, next: { [KS_A]: 0, [KS_B]: 0 }, published: {} });
    const src = new DurableCounterSource(store);
    await src.reserve(KS_A, 3);
    await src.reserve(KS_B, 4);
    await src.markPublished(new Set([KS_A]));
    await src.flush();
    expect(store.state?.published).toEqual({ [KS_B]: 4 });
  });

  it('a keyset whose stored [published, next) is not empty is held from load until a startup restore scanned it (fix round 7)', async () => {
    // The verifier's finding: the hold started empty, so an operation finishing before the
    // startup restore marked an earlier process's range published. It is held from the load now.
    const store = new MemoryCounterStore({
      v: 1,
      next: { [KS_A]: 10, [KS_B]: 5 },
      published: { [KS_A]: 3, [KS_B]: 5 },
    });
    const src = new DurableCounterSource(store);
    await src.reserve(KS_A, 2);
    await src.reserve(KS_B, 2);
    await src.markPublished(new Set());
    await src.flush();
    expect(store.state?.published).toEqual({ [KS_A]: 3, [KS_B]: 7 });
    // The hold outlives the source: a successor over the same file holds the range again.
    src.close();
    const next = new DurableCounterSource(store);
    await next.reserve(KS_A, 1);
    await next.markPublished(new Set());
    await next.flush();
    expect(store.state?.published[KS_A]).toBe(3);
    // Released per keyset once scanned: 10 + 2 was leased to 44 and the successor handed out 44,
    // so A moves to 45; B's unused lease [7, 39) is a range too, not scanned, so it stays held.
    await next.markScanned([KS_A]);
    await next.markPublished(new Set());
    await next.flush();
    expect(store.state?.published).toEqual({ [KS_A]: 45, [KS_B]: 7 });
  });

  it('flush works after close (the wallet closes the source first, then writes the watermark)', async () => {
    const store = new MemoryCounterStore({ v: 1, next: { [KS_A]: 0 }, published: {} });
    const src = new DurableCounterSource(store);
    await src.reserve(KS_A, 3);
    await src.markPublished(new Set());
    src.close();
    await src.flush();
    expect(store.state?.published).toEqual({ [KS_A]: 3 });
  });

  it('a closed source flushing late never moves a stored lease back (its successor leased further)', async () => {
    const store = new MemoryCounterStore({ v: 1, next: { [KS_A]: 0 }, published: {} });
    const old = new DurableCounterSource(store);
    await old.reserve(KS_A, 5);
    await old.markPublished(new Set());
    old.close();
    const successor = new DurableCounterSource(store);
    expect((await successor.reserve(KS_A, 100)).start).toBe(5 + COUNTER_LEASE);
    const leased = store.state?.next[KS_A] ?? 0;
    await old.flush(); // the old one's watermark reaches the file…
    expect(store.state?.published[KS_A]).toBe(5);
    expect(store.state?.next[KS_A]).toBe(leased); // …without its older lease
  });

  it('a stored watermark above next is clamped (it can never skip a counter still leased)', async () => {
    const store = new MemoryCounterStore({ v: 1, next: { [KS_A]: 10 }, published: { [KS_A]: 50 } });
    const src = new DurableCounterSource(store);
    expect(await src.unpublished()).toEqual([]);
    await src.reserve(KS_A, 40);
    expect(await src.unpublished()).toEqual([{ keysetId: KS_A, from: 10, to: 50 + COUNTER_LEASE }]);
  });
});

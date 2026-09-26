/**
 * Issue #2 (security review F4): auto top-ups EXECUTE — against the REAL wallet code (core's
 * `CashuWallet` over a `MemoryProofStore`) and two in-process TestMints joined by simulated
 * Lightning: the melt at the source mint pays the target mint's invoice.
 *
 * Pins Cameron's rules (2026-09-24): off unless on; only into mints on the user's own list (never a
 * manifest's mint, never `fromMint` itself); at most 10 000 sats a top-up and 50 000 in any rolling
 * 24 h (fees included, in flight included); the first funding of a mint asks and only an explicit
 * yes is remembered; one top-up at a time; failures and declines back off; the ledger survives a
 * restart and a corrupt one fails CLOSED; every top-up is in the wallet history.
 */
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MintUrl, NostrPubkey, Sats, Settings, UnixSeconds, Wallet } from '@sovit/core';
import {
  AUTO_TOP_UP_MAX_SATS,
  AUTO_TOP_UP_MAX_SATS_PER_DAY,
  mocks,
  wallet as walletMod,
} from '@sovit/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { memoryLogger } from '../log.js';
import { GateRefusal, PAY_STILL_BUILDING } from '../pay-melt-gate.js';
import { JsonFile } from '../settings/json-file.js';
import { DEFAULT_SETTINGS } from '../settings/settings.js';
import type { FirstFundingQuestion, TopUpOutcome, TopUpVault } from '../topup/auto-topup.js';
import {
  AutoTopUp,
  TOP_UP_DECLINED_BACKOFF_MS,
  TOP_UP_FAIL_BACKOFF_MS,
  TOP_UP_MAX_BACKOFF_MS,
  TOP_UP_MIN_INTERVAL_MS,
  TOP_UP_RESOLVE_EVERY_MS,
  maxFeeReserve,
  meltSentNothing,
  topUpAmount,
} from '../topup/auto-topup.js';
import {
  DAY_MS,
  MAX_OPEN_TOP_UPS,
  TOP_UP_LEDGER_FILE,
  TopUpLedger,
  parseLedger,
} from '../topup/ledger.js';
import { parseOpenTopUp, serializeOpenTopUp } from '../topup/open-topup.js';
import { testVault } from './support/topup-vault.js';

const TARGET = 'https://mint-target.topup.test' as MintUrl;
const SOURCE = 'https://mint-source.topup.test' as MintUrl;
const SECOND = 'https://mint-second.topup.test' as MintUrl;
/** A mint first seen in a video's manifest (a creator's own mint). */
const STRANGER = 'https://creator-mint.topup.test' as MintUrl;
const T0 = 1_800_000_000_000;
/** The identity the test's wallet belongs to (round 4: an open top-up is finished by it). */
const OWNER = 'a1'.repeat(32) as NostrPubkey;

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await chmod(d, 0o700).catch(() => undefined);
    await rm(d, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'nf-topup-'));
  dirs.push(d);
  return d;
}

interface Setup {
  readonly top: AutoTopUp;
  readonly wallet: walletMod.CashuWallet;
  /** The wallet's store (its journal): a new wallet over it is the same identity, relocked. */
  readonly store: walletMod.MemoryProofStore;
  readonly conns: walletMod.CashuMintConnections;
  readonly ledger: TopUpLedger;
  readonly target: mocks.TestMint;
  readonly source: mocks.TestMint;
  readonly lightning: mocks.TestLightning;
  readonly asked: FirstFundingQuestion[];
  readonly log: ReturnType<typeof memoryLogger>;
  readonly dir: string;
  settings: Settings;
  /** The wallet the AutoTopUp sees now (a signer change swaps it). */
  current: Wallet | undefined;
  answer: boolean | Error | (() => boolean);
  t: number;
  /** The money plane's startup settle, as the vault reports it. */
  recovery: Promise<unknown>;
  /** Texts the vault sealed (what the ledger keeps, in the clear). */
  readonly sealed: string[];
  /**
   * The same identity with a new wallet over the same store (a lock/unlock, or the next start):
   * `w` is registered as `OWNER`'s.
   */
  adopt(w: Wallet): void;
  /** A fresh AutoTopUp over a re-opened ledger in the same directory (a restart). */
  restart(): Promise<AutoTopUp>;
}

async function setup(
  o: {
    fund?: number;
    feeReserve?: number;
    inputFeePpk?: number;
    amountSats?: number;
    belowSats?: number;
    dir?: string;
    wrap?: (w: Wallet) => Wallet;
    noAsk?: boolean;
    /** The source mint restores (NUT-09), so core journals its melts (default on). */
    sourceNut09?: boolean;
    /** The wallet's journal ages on the test's clock (`t`), not the system's. */
    walletClock?: boolean;
  } = {},
): Promise<Setup> {
  const lightning = new mocks.TestLightning();
  const target = new mocks.TestMint({
    url: TARGET,
    seed: new Uint8Array(32).fill(0x31),
    lightning,
  });
  const second = new mocks.TestMint({
    url: SECOND,
    seed: new Uint8Array(32).fill(0x33),
    lightning,
  });
  const source = new mocks.TestMint({
    url: SOURCE,
    seed: new Uint8Array(32).fill(0x32),
    lightning,
    feeReserve: o.feeReserve ?? 2,
    ...(o.inputFeePpk === undefined ? {} : { inputFeePpk: o.inputFeePpk }),
    ...(o.sourceNut09 === undefined ? {} : { nut09: o.sourceNut09 }),
  });
  const byUrl: Record<string, mocks.TestMint> = {
    [TARGET]: target,
    [SOURCE]: source,
    [SECOND]: second,
  };
  const conns = new walletMod.CashuMintConnections({ request: (m) => byUrl[m]?.request });
  const store = new walletMod.MemoryProofStore();
  const s = {} as Setup;
  s.t = T0;
  const wallet = new walletMod.CashuWallet({
    mints: conns,
    store,
    ...(o.walletClock === true ? { now: () => Math.floor(s.t / 1000) as UnixSeconds } : {}),
  });
  if ((o.fund ?? 0) > 0) {
    const q = await wallet.mintQuote(SOURCE, o.fund as Sats);
    source.payQuote(q.quoteId);
    await wallet.pollQuote(q);
  }
  const dir = o.dir ?? (await tempDir());
  const log = memoryLogger('debug');
  const asked: FirstFundingQuestion[] = [];
  const now = (): number => s.t;
  const ledger = await TopUpLedger.open(dir, log, now);
  s.settings = {
    ...DEFAULT_SETTINGS,
    defaultMints: [TARGET, SOURCE, SECOND],
    autoTopUp: {
      belowSats: (o.belowSats ?? 1_000) as Sats,
      fromMint: SOURCE,
      ...(o.amountSats === undefined ? {} : { amountSats: o.amountSats as Sats }),
    },
  };
  s.answer = true;
  const w = o.wrap ? o.wrap(wallet) : wallet;
  s.current = w;
  s.recovery = Promise.resolve();
  const sealed: string[] = [];
  // Which identity a wallet belongs to: the test's wallet (and wrappers over it, and wallets
  // adopted as its relocked self) is OWNER's; any other wallet is a stranger's of its own.
  const owners = new WeakMap<object, NostrPubkey>([[wallet, OWNER]]);
  let strangers = 0;
  const ownerOf = (x: Wallet): NostrPubkey => {
    for (let p: object | null = x; p !== null; p = Object.getPrototypeOf(p) as object | null) {
      const known = owners.get(p);
      if (known !== undefined) return known;
    }
    const fresh = (++strangers).toString(16).padStart(64, 'b') as NostrPubkey;
    owners.set(x, fresh);
    return fresh;
  };
  const vault = (x: Wallet): TopUpVault | undefined => {
    if (x !== s.current) return undefined;
    const owner = ownerOf(x);
    return testVault({
      owner,
      ...(owner === OWNER ? { store } : {}),
      mints: conns,
      recovery: s.recovery,
      sealed,
    });
  };
  const make = (l: TopUpLedger): AutoTopUp =>
    new AutoTopUp({
      settings: () => s.settings,
      wallet: () => s.current,
      vault,
      ledger: l,
      ...(o.noAsk === true
        ? {}
        : {
            askFirstFunding: (q) => {
              asked.push(q);
              const a = s.answer;
              if (a instanceof Error) return Promise.reject(a);
              return Promise.resolve(typeof a === 'function' ? a() : a);
            },
          }),
      log,
      now,
      sleep: () => Promise.resolve(),
      pollAttempts: 3,
    });
  return Object.assign(s, {
    top: make(ledger),
    wallet,
    store,
    conns,
    sealed,
    adopt: (x: Wallet) => {
      owners.set(x, OWNER);
    },
    ledger,
    target,
    source,
    lightning,
    asked,
    log,
    dir,
    restart: async () => make(await TopUpLedger.open(dir, log, now)),
  });
}

/** Moves the clock past the spacing between attempts. */
function later(s: Setup, ms = TOP_UP_MIN_INTERVAL_MS): void {
  s.t += ms;
}

describe('topUpAmount / maxFeeReserve', () => {
  it('absent = the max (10 000); never above it; not a whole positive number = refused', () => {
    const a = { belowSats: 1 as Sats, fromMint: SOURCE };
    expect(AUTO_TOP_UP_MAX_SATS).toBe(10_000);
    expect(topUpAmount(a)).toBe(10_000);
    expect(topUpAmount({ ...a, amountSats: 2_500 as Sats })).toBe(2_500);
    expect(topUpAmount({ ...a, amountSats: 50_000 as Sats })).toBe(10_000);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(topUpAmount({ ...a, amountSats: bad as Sats }), String(bad)).toBeNull();
  });

  it('a fee reserve of 5 % with a 10-sat floor', () => {
    expect(maxFeeReserve(1)).toBe(10);
    expect(maxFeeReserve(200)).toBe(10);
    expect(maxFeeReserve(10_000)).toBe(500);
  });
});

describe('AutoTopUp — executes (issue #2)', () => {
  it('a trusted mint below the threshold: asked once, one top-up of amountSats from fromMint, both sides in history', async () => {
    const s = await setup({ fund: 20_000, amountSats: 2_000 });
    expect(await s.top.check(TARGET, 0 as Sats)).toBe('done');
    expect(s.asked).toEqual([{ target: TARGET, source: SOURCE, amount: 2_000 }]);
    expect(await s.wallet.balance(TARGET)).toBe(2_000);
    // The unused fee reserve came back: exactly the amount left the source.
    expect(await s.wallet.balance(SOURCE)).toBe(18_000);
    expect(s.lightning.paid).toHaveLength(1);
    // History: in at the target ("top-up", core's mint), out at the source (relabelled): no extra.
    const all = (await s.wallet.history()).map((e) => s.top.relabel(e));
    const inAtTarget = all.filter((e) => e.mint === TARGET);
    const outAtSource = all.filter((e) => e.mint === SOURCE && e.direction === 'out');
    expect(inAtTarget).toMatchObject([{ direction: 'in', amount: 2_000, memo: 'top-up' }]);
    expect(outAtSource).toMatchObject([{ amount: 2_000, memo: 'top-up' }]);
    const raw = await s.wallet.history({ mint: SOURCE });
    expect(raw.filter((e) => e.direction === 'out').map((e) => e.memo)).toEqual([
      'melt to Lightning',
    ]);
    // The ledger: allowed, and one done entry counting what moved.
    expect(s.ledger.snapshot().allowed).toEqual([TARGET]);
    expect(s.ledger.snapshot().entries).toMatchObject([
      { state: 'done', amount: 2_000, sats: 2_000, target: TARGET, from: SOURCE },
    ]);
    expect(s.ledger.used(s.t)).toBe(2_000);
    // Logs: an outcome, never a mint URL, an invoice or a quote.
    const logged = JSON.stringify(s.log.lines);
    expect(logged).toContain('auto top-up done');
    expect(logged).not.toMatch(/topup\.test|lnbc|mint-target/);
  });

  it('the default amount is the max, 10 000 sats', async () => {
    const s = await setup({ fund: 20_000 });
    expect(await s.top.check(TARGET)).toBe('done');
    expect(await s.wallet.balance(TARGET)).toBe(10_000);
  });

  it('settings holding an amount above the max (as if a guard were bypassed) move only 10 000', async () => {
    const s = await setup({ fund: 30_000, amountSats: 50_000, belowSats: 60_000 });
    expect(await s.top.check(TARGET)).toBe('done');
    expect(s.asked).toEqual([{ target: TARGET, source: SOURCE, amount: 10_000 }]);
    expect(await s.wallet.balance(TARGET)).toBe(10_000);
    expect(await s.wallet.balance(SOURCE)).toBe(20_000);
  });

  it('not due: off, balance at/above the threshold, a manifest mint not on the list, fromMint itself — nothing is quoted', async () => {
    const s = await setup({ fund: 20_000 });
    const quote = vi.spyOn(s.wallet, 'mintQuote');
    const off: Settings = { ...s.settings, autoTopUp: { belowSats: 0 as Sats, fromMint: SOURCE } };
    const cases: [Settings, MintUrl, number][] = [
      [off, TARGET, 0],
      [{ ...s.settings, autoTopUp: undefined } as unknown as Settings, TARGET, 0],
      [s.settings, TARGET, 1_000],
      [s.settings, STRANGER, 0],
      [s.settings, SOURCE, 0],
    ];
    for (const [settings, mint, balance] of cases) {
      s.settings = settings;
      expect(await s.top.check(mint, balance as Sats), mint).toBe('not-due');
    }
    // A balance that looked low but is not (re-read before anything moves).
    s.settings = { ...off, autoTopUp: { belowSats: 1_000 as Sats, fromMint: SOURCE } };
    const q = await s.wallet.mintQuote(TARGET, 1_500 as Sats);
    s.target.payQuote(q.quoteId);
    await s.wallet.pollQuote(q);
    quote.mockClear();
    expect(await s.top.check(TARGET, 0 as Sats)).toBe('not-due');
    expect(quote).not.toHaveBeenCalled();
    expect(s.asked).toEqual([]);
  });

  it('first funding declined (or closed, or the prompt failed): nothing moves, no re-prompt storm, asked again after the backoff', async () => {
    const s = await setup({ fund: 20_000 });
    const quote = vi.spyOn(s.wallet, 'mintQuote');
    s.answer = false;
    expect(await s.top.check(TARGET)).toBe('declined');
    expect(quote).not.toHaveBeenCalled();
    expect(await s.wallet.balance(SOURCE)).toBe(20_000);
    expect(s.ledger.snapshot()).toEqual({ allowed: [], entries: [] });
    // Payments keep draining the mint: not asked again within the hour.
    for (let i = 0; i < 20; i++) {
      later(s, TOP_UP_DECLINED_BACKOFF_MS / 40);
      expect(await s.top.check(TARGET, 0 as Sats)).toBe('backoff');
    }
    expect(s.asked).toHaveLength(1);
    later(s, TOP_UP_DECLINED_BACKOFF_MS / 2 + 1);
    s.answer = new Error('prompt window failed');
    expect(await s.top.check(TARGET)).toBe('declined');
    expect(s.asked).toHaveLength(2);
    expect(quote).not.toHaveBeenCalled();
  });

  it('no prompt window at all: a mint is never funded for the first time', async () => {
    const s = await setup({ fund: 20_000, noAsk: true });
    expect(await s.top.check(TARGET)).toBe('declined');
    expect(await s.wallet.balance(TARGET)).toBe(0);
  });

  it('an explicit yes is remembered (persisted): later top-ups into that mint run unattended, a new mint asks', async () => {
    const s = await setup({ fund: 30_000, amountSats: 1_000 });
    expect(await s.top.check(TARGET)).toBe('done');
    expect(s.asked).toHaveLength(1);
    // Drain the target below the threshold again (a streaming payment would).
    const p2pk = '02' + '11'.repeat(32);
    await s.wallet.send(600 as Sats, { p2pk: p2pk as never, mint: TARGET });
    later(s);
    expect(await s.top.check(TARGET)).toBe('done');
    expect(s.asked).toHaveLength(1);
    // Across a restart, too.
    await s.wallet.send(1_000 as Sats, { p2pk: p2pk as never, mint: TARGET });
    later(s);
    const again = await s.restart();
    expect(await again.check(TARGET)).toBe('done');
    expect(s.asked).toHaveLength(1);
    // Another trusted mint is a first funding of its own.
    later(s);
    expect(await again.check(SECOND)).toBe('done');
    expect(s.asked.map((q) => q.target)).toEqual([TARGET, SECOND]);
  });

  it('the settings changed while the question was open: the yes is remembered, nothing moves', async () => {
    const s = await setup({ fund: 20_000 });
    const quote = vi.spyOn(s.wallet, 'mintQuote');
    const settings = s.settings;
    // The user turns auto top-up off in Settings while the question is still open, then says yes.
    s.answer = () => {
      s.settings = { ...settings, autoTopUp: { belowSats: 0 as Sats, fromMint: SOURCE } };
      return true;
    };
    expect(await s.top.check(TARGET)).toBe('not-due');
    expect(quote).not.toHaveBeenCalled();
    expect(s.ledger.isAllowed(TARGET)).toBe(true);
  });

  it('two payments at once: ONE top-up (the second joins it); another mint meanwhile is busy', async () => {
    const s = await setup({ fund: 30_000, amountSats: 1_000 });
    const quote = vi.spyOn(s.wallet, 'mintQuote');
    const [a, b, c] = await Promise.all([
      s.top.check(TARGET, 10 as Sats),
      s.top.check(TARGET, 5 as Sats),
      s.top.check(SECOND, 0 as Sats),
    ]);
    expect([a, b, c]).toEqual(['done', 'done', 'busy']);
    expect(quote).toHaveBeenCalledTimes(1);
    expect(await s.wallet.balance(TARGET)).toBe(1_000);
    // And right after it, the next attempt waits (no storm on the balance events it caused).
    expect(await s.top.check(SECOND, 0 as Sats)).toBe('backoff');
  });
});

describe('AutoTopUp — caps', () => {
  it('rolling 24 h: at most 50 000 sats, fees included — the top-up beyond it is refused; the window rolls', async () => {
    const s = await setup({ fund: 80_000, amountSats: 10_000, belowSats: 60_000, feeReserve: 2 });
    const outcomes: TopUpOutcome[] = [];
    for (let i = 0; i < 6; i++) {
      outcomes.push(await s.top.check(i % 2 === 0 ? TARGET : SECOND));
      later(s);
    }
    // 4 × 10 000 moved; the fifth would reserve 10 000 + 2 (fee reserve) → 50 002 > 50 000.
    expect(outcomes).toEqual(['done', 'done', 'done', 'done', 'cap', 'cap']);
    expect(s.ledger.used(s.t)).toBe(40_000);
    expect((await s.wallet.balance(TARGET)) + (await s.wallet.balance(SECOND))).toBe(40_000);
    expect(s.log.lines.filter((l) => l['outcome'] === 'cap')).toHaveLength(1); // throttled
    // 24 h after the first one, it has left the window: room for one more.
    s.t = T0 + DAY_MS + 1;
    expect(await s.top.check(TARGET)).toBe('done');
  });

  it('fees count: what left the source (input fees too) is what the ledger counts; the fee allowance is reserved', async () => {
    const s = await setup({
      fund: 30_000,
      amountSats: 5_000,
      belowSats: 60_000,
      inputFeePpk: 1_000,
    });
    const reserve = vi.spyOn(s.ledger, 'reserve');
    expect(await s.top.check(TARGET)).toBe('done');
    // 1 sat per input: 64 inputs allowed for, plus the 2-sat Lightning reserve.
    expect(reserve.mock.calls[0]![0]).toMatchObject({ amount: 5_000, sats: 5_000 + 2 + 64 });
    const left = 30_000 - (await s.wallet.balance(SOURCE));
    expect(left).toBeGreaterThan(5_000);
    expect(s.ledger.used(s.t)).toBe(left);
    // A source whose fees would pass 5 % is refused before anything moves.
    const dear = await setup({ fund: 30_000, amountSats: 1_000, inputFeePpk: 1_000 });
    expect(await dear.top.check(TARGET)).toBe('refused');
    expect(await dear.wallet.balance(SOURCE)).toBe(30_000);
  });

  it('smaller top-ups: five of 9 000 fit, the sixth does not (45 000 + 9 002 > 50 000)', async () => {
    const s = await setup({ fund: 80_000, amountSats: 9_000, belowSats: 60_000 });
    const outcomes: TopUpOutcome[] = [];
    for (let i = 0; i < 6; i++) {
      outcomes.push(await s.top.check(TARGET));
      later(s);
    }
    expect(outcomes).toEqual(['done', 'done', 'done', 'done', 'done', 'cap']);
    expect(await s.wallet.balance(TARGET)).toBe(45_000);
    expect(AUTO_TOP_UP_MAX_SATS_PER_DAY).toBe(50_000);
  });

  it('the ledger survives a restart: what moved before still counts', async () => {
    const s = await setup({ fund: 80_000, amountSats: 10_000, belowSats: 60_000 });
    for (let i = 0; i < 4; i++) {
      expect(await s.top.check(TARGET)).toBe('done');
      later(s);
    }
    const again = await s.restart();
    expect(await again.check(TARGET)).toBe('cap');
    expect(await s.wallet.balance(TARGET)).toBe(40_000);
    const file = JSON.parse(await readFile(join(s.dir, TOP_UP_LEDGER_FILE), 'utf8')) as {
      entries: unknown[];
    };
    expect(file.entries).toHaveLength(4);
    expect((await stat(join(s.dir, TOP_UP_LEDGER_FILE))).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['not JSON', '{nope'],
    ['an unknown version', JSON.stringify({ v: 2, allowed: [], entries: [] })],
    ['an unknown key', JSON.stringify({ v: 1, allowed: [], entries: [], reset: true })],
    [
      'a negative count',
      JSON.stringify({
        v: 1,
        allowed: [],
        entries: [{ id: 'ab'.repeat(8), at: T0, sats: -50_000, amount: 0, state: 'done' }],
      }),
    ],
    ['a bare array', '[]'],
  ])(
    'a corrupt ledger (%s) fails CLOSED: the cap reads as reached for 24 h, never reset to zero',
    async (_what, body) => {
      const dir = await tempDir();
      await writeFile(join(dir, TOP_UP_LEDGER_FILE), body, { mode: 0o600 });
      const s = await setup({ fund: 20_000, dir });
      expect(s.ledger.used(s.t)).toBe(AUTO_TOP_UP_MAX_SATS_PER_DAY);
      expect(await s.top.check(TARGET)).toBe('cap');
      expect(s.asked).toEqual([]);
      expect(await s.wallet.balance(TARGET)).toBe(0);
      // The bad file was kept aside and replaced by the closed marker, so a restart stays closed.
      expect(await readFile(join(dir, `${TOP_UP_LEDGER_FILE}.corrupt`), 'utf8')).toBe(body);
      later(s);
      const again = await s.restart();
      expect(await again.check(TARGET)).toBe('cap');
      // It heals after 24 h — and asks again (nothing is remembered as allowed).
      s.t = T0 + DAY_MS + 1;
      expect(await again.check(TARGET)).toBe('done');
      expect(s.asked).toHaveLength(1);
    },
  );

  it('a corrupt ledger that cannot even be replaced: every top-up refused this run, the file left in place', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, TOP_UP_LEDGER_FILE), '{broken', { mode: 0o600 });
    await chmod(dir, 0o500);
    const s = await setup({ fund: 20_000, dir });
    expect(s.ledger.used(s.t)).toBe(AUTO_TOP_UP_MAX_SATS_PER_DAY);
    expect(s.ledger.fits(1)).toBe(false);
    expect(await s.top.check(TARGET)).toBe('cap');
    s.t = T0 + 2 * DAY_MS; // no marker on disk to age out: still closed
    expect(await s.top.check(TARGET)).toBe('cap');
    expect(await readFile(join(dir, TOP_UP_LEDGER_FILE), 'utf8')).toBe('{broken');
  });

  it('JsonFile can keep a corrupt file in place (the ledger never reads corrupt as missing)', async () => {
    const dir = await tempDir();
    const path = join(dir, 'x.json');
    await writeFile(path, 'nope');
    const f = new JsonFile(path, () => null, memoryLogger(), { moveAsideCorrupt: false });
    expect(await f.load()).toMatchObject({ kind: 'corrupt' });
    expect(await readFile(path, 'utf8')).toBe('nope');
    expect(await f.load()).toMatchObject({ kind: 'corrupt' });
  });

  it('a ledger that cannot be written refuses before anything moves', async () => {
    const s = await setup({ fund: 20_000 });
    await chmod(s.dir, 0o500);
    const melt = vi.spyOn(s.wallet, 'melt');
    expect(await s.top.check(TARGET)).toBe('failed'); // the allowance could not be persisted
    expect(s.ledger.isAllowed(TARGET)).toBe(false);
    expect(melt).not.toHaveBeenCalled();
    expect(await s.wallet.balance(SOURCE)).toBe(20_000);
  });
});

describe('AutoTopUp — refusals and failures back off', () => {
  it('the source lacks amount + fee reserve: refused, nothing reserved, backed off', async () => {
    const s = await setup({ fund: 1_001, amountSats: 1_000, feeReserve: 2 });
    const melt = vi.spyOn(s.wallet, 'melt');
    expect(await s.top.check(TARGET)).toBe('source-short');
    expect(melt).not.toHaveBeenCalled();
    expect(s.ledger.used(s.t)).toBe(0);
    later(s, TOP_UP_FAIL_BACKOFF_MS / 2);
    expect(await s.top.check(TARGET)).toBe('backoff');
    later(s, TOP_UP_FAIL_BACKOFF_MS / 2);
    expect(await s.top.check(TARGET)).toBe('source-short'); // tried once more, still short
    later(s, TOP_UP_FAIL_BACKOFF_MS + 1);
    expect(await s.top.check(TARGET)).toBe('backoff'); // …and the backoff doubled
    expect(melt).not.toHaveBeenCalled();
  });

  it('a target that invoices more than asked, or a source asking a fee reserve above 5 %: refused', async () => {
    const liar = await setup({
      fund: 20_000,
      amountSats: 1_000,
      wrap: (w) =>
        Object.assign(Object.create(w) as Wallet, {
          meltQuote: async (m: MintUrl, b: string) => ({
            ...(await w.meltQuote(m, b)),
            amount: 1_001 as Sats,
          }),
        }),
    });
    expect(await liar.top.check(TARGET)).toBe('refused');
    expect(await liar.wallet.balance(SOURCE)).toBe(20_000);
    const greedy = await setup({ fund: 20_000, amountSats: 1_000, feeReserve: 51 });
    expect(await greedy.top.check(TARGET)).toBe('refused');
    expect(await greedy.wallet.balance(SOURCE)).toBe(20_000);
  });

  it('a mint failure backs off 1 min, then 2 min: no retry per payment, no storm', async () => {
    const s = await setup({ fund: 20_000 });
    s.target.failNext(1);
    const quote = vi.spyOn(s.wallet, 'mintQuote');
    expect(await s.top.check(TARGET)).toBe('failed');
    for (let i = 0; i < 10; i++) expect(await s.top.check(TARGET, 0 as Sats)).toBe('backoff');
    expect(quote).toHaveBeenCalledTimes(1);
    later(s, TOP_UP_FAIL_BACKOFF_MS + 1);
    s.target.failNext(1);
    expect(await s.top.check(TARGET)).toBe('failed');
    later(s, TOP_UP_FAIL_BACKOFF_MS + 1);
    expect(await s.top.check(TARGET)).toBe('backoff'); // doubled
    later(s, TOP_UP_FAIL_BACKOFF_MS);
    expect(await s.top.check(TARGET)).toBe('done');
  });

  it('a melt that throws or is not paid stays COUNTED (its sats may have left)', async () => {
    const s = await setup({
      fund: 20_000,
      amountSats: 3_000,
      wrap: (w) =>
        Object.assign(Object.create(w) as Wallet, {
          melt: () => Promise.reject(new Error('connection reset')),
        }),
    });
    expect(await s.top.check(TARGET)).toBe('failed');
    expect(s.ledger.snapshot().entries).toMatchObject([{ state: 'unknown', sats: 3_002 }]);
    expect(s.ledger.used(s.t)).toBe(3_002);
    const unpaid = await setup({
      fund: 20_000,
      amountSats: 3_000,
      wrap: (w) =>
        Object.assign(Object.create(w) as Wallet, {
          melt: () => Promise.resolve({ paid: false, change: 0 as Sats }),
        }),
    });
    expect(await unpaid.top.check(TARGET)).toBe('failed');
    expect(unpaid.ledger.used(unpaid.t)).toBe(3_002);
    // Core's pre-flight refusal (input fees on top of amount + reserve): nothing moved, not counted.
    const short = await setup({
      fund: 20_000,
      amountSats: 3_000,
      wrap: (w) =>
        Object.assign(Object.create(w) as Wallet, {
          melt: () =>
            Promise.reject(new walletMod.WalletError('insufficient-funds', 'not enough sats')),
        }),
    });
    expect(await short.top.check(TARGET)).toBe('source-short');
    expect(short.ledger.snapshot().entries).toMatchObject([{ state: 'failed' }]);
    expect(short.ledger.used(short.t)).toBe(0);
  });

  it('a melt the money plane’s PAY/melt gate refused (it never started: a PAY at the source was still being built) moved nothing: not counted, backed off (lane I2-paygate)', async () => {
    const s = await setup({
      fund: 20_000,
      amountSats: 3_000,
      wrap: (w) =>
        Object.assign(Object.create(w) as Wallet, {
          melt: () => Promise.reject(new GateRefusal(PAY_STILL_BUILDING)),
        }),
    });
    expect(await s.top.check(TARGET)).toBe('failed');
    expect(s.ledger.snapshot().entries).toMatchObject([{ state: 'failed' }]);
    expect(s.ledger.used(s.t)).toBe(0);
    expect(s.lightning.paid).toEqual([]);
    expect(await s.top.check(TARGET)).toBe('backoff'); // a failure's backoff, as any other
  });
});

describe('AutoTopUp — paid at the source, not yet minted at the target', () => {
  it('counts what moved, backs off, and mints at the next trigger with the same wallet — never pays twice', async () => {
    let unpaidPolls = 3;
    const s = await setup({
      fund: 20_000,
      amountSats: 2_000,
      wrap: (w) =>
        Object.assign(Object.create(w) as Wallet, {
          pollQuote: (q: Parameters<Wallet['pollQuote']>[0]) =>
            unpaidPolls-- > 0 ? Promise.resolve({ state: 'UNPAID' as const }) : w.pollQuote(q),
        }),
    });
    expect(await s.top.check(TARGET)).toBe('failed');
    expect(await s.wallet.balance(TARGET)).toBe(0);
    expect(await s.wallet.balance(SOURCE)).toBe(18_000);
    expect(s.ledger.used(s.t)).toBe(2_000);
    expect(s.log.lines.map((l) => l.msg)).toContain(
      'auto top-up paid but not yet minted at the target; retried later',
    );
    later(s, TOP_UP_FAIL_BACKOFF_MS + 1);
    // Another signer's wallet meanwhile: the paid quote is NOT minted into it.
    const paying = s.current!;
    const other = new walletMod.CashuWallet({
      mints: new walletMod.CashuMintConnections({
        request: (m) => (m === TARGET ? s.target.request : s.source.request),
      }),
      store: new walletMod.MemoryProofStore(),
    });
    const otherPoll = vi.spyOn(other, 'pollQuote');
    s.current = other;
    expect(await s.top.check(TARGET, 0 as Sats)).not.toBe('done');
    expect(otherPoll).not.toHaveBeenCalled();
    expect(await other.balance(TARGET)).toBe(0);
    s.current = paying;
    later(s, TOP_UP_MAX_BACKOFF_MS);
    // The retry mints it; the target is then above its threshold: nothing else moves.
    expect(await s.top.check(TARGET, 0 as Sats)).toBe('not-due');
    expect(await s.wallet.balance(TARGET)).toBe(2_000);
    expect(await s.wallet.balance(SOURCE)).toBe(18_000);
    expect(s.lightning.paid).toHaveLength(1);
  });
});

describe('AutoTopUp — a melt of the user’s own at the source, in the same moment', () => {
  it.each([7_000, 500])(
    '(%i sats) is neither labelled "top-up" nor counted: only the top-up’s own melt line is',
    async (own) => {
      let userMelt: Promise<unknown> | undefined;
      const s: Setup = await setup({
        fund: 30_000,
        amountSats: 2_000,
        wrap: (w) =>
          Object.assign(Object.create(w) as Wallet, {
            melt: async (q: Parameters<Wallet['melt']>[0]) => {
              // The user withdraws from the same mint while the top-up's melt runs: more than the
              // top-up's reservation, or less than its amount.
              userMelt = (async () => {
                const inv = await w.mintQuote(SECOND, own as Sats);
                await w.melt(await w.meltQuote(SOURCE, inv.bolt11));
              })();
              await userMelt;
              return w.melt(q);
            },
          }),
      });
      expect(await s.top.check(TARGET)).toBe('done');
      await userMelt;
      expect(s.ledger.used(s.t)).toBe(2_000);
      const outs = (await s.wallet.history({ mint: SOURCE }))
        .filter((e) => e.direction === 'out')
        .map((e) => [e.amount, s.top.relabel(e).memo]);
      expect(outs).toEqual([
        [2_000, 'top-up'],
        [own, 'melt to Lightning'],
      ]);
    },
  );

  it('a count the file could not hold is clamped, never written (the ledger stays readable)', async () => {
    const dir = await tempDir();
    const l = await TopUpLedger.open(dir, memoryLogger(), () => T0);
    const id = await l.reserve({ amount: 10, sats: 12, target: TARGET, from: SOURCE });
    await l.settle(id, { state: 'done', sats: 10 ** 12 });
    const again = await TopUpLedger.open(dir, memoryLogger(), () => T0);
    expect(again.snapshot().entries).toMatchObject([{ state: 'done', sats: 100_000 }]);
    expect(again.fits(1)).toBe(false);
    // Nor is a mint URL or an amount the file's guard would refuse.
    const fresh = await TopUpLedger.open(await tempDir(), memoryLogger(), () => T0);
    for (const bad of [
      { amount: 10, sats: 12, target: 'javascript:x' as MintUrl, from: SOURCE },
      { amount: 10, sats: 12, target: TARGET, from: 'https://a b.example' as MintUrl },
      { amount: 0, sats: 12, target: TARGET, from: SOURCE },
      { amount: 10, sats: 9, target: TARGET, from: SOURCE },
      { amount: 10.5, sats: 12, target: TARGET, from: SOURCE },
    ])
      await expect(fresh.reserve(bad), JSON.stringify(bad)).rejects.toThrow(/ledger stores/);
    await expect(fresh.allow('file:///etc' as MintUrl)).rejects.toThrow(/ledger stores/);
    expect(fresh.snapshot()).toEqual({ allowed: [], entries: [] });
  });
});

describe('AutoTopUp — the history label', () => {
  it('only the funding melt (by id, or while in flight) reads "top-up"; other melts keep their memo', async () => {
    const s = await setup({ fund: 20_000, amountSats: 1_000 });
    expect(await s.top.check(TARGET)).toBe('done');
    // A melt the user makes themselves at the source.
    const q = await s.wallet.mintQuote(SECOND, 500 as Sats);
    const m = await s.wallet.meltQuote(SOURCE, q.bolt11);
    await s.wallet.melt(m);
    const out = (await s.wallet.history({ mint: SOURCE }))
      .filter((e) => e.direction === 'out')
      .map((e) => s.top.relabel(e).memo);
    expect(out).toEqual(['melt to Lightning', 'top-up']);
    const inEntry = (await s.wallet.history({ mint: TARGET }))[0]!;
    expect(s.top.relabel(inEntry)).toBe(inEntry);
    expect(s.top.relabelChange({ type: 'balance', mint: TARGET, balance: 1 as Sats })).toEqual({
      type: 'balance',
      mint: TARGET,
      balance: 1,
    });
  });
});

// ---- independent review of the lane (docs/reviews/2026-09-25-pre-push-auto-topup.md) ------------

describe('AutoTopUp — review F2: the "top-up" label outlives the 24-hour window', () => {
  it('a funding melt still reads "top-up" the next day, after the window pruned its entry — and after a restart', async () => {
    const s = await setup({ fund: 30_000, amountSats: 1_000 });
    expect(await s.top.check(TARGET)).toBe('done');
    const melt = (await s.wallet.history({ mint: SOURCE })).find((e) => e.direction === 'out')!;
    expect(s.top.relabel(melt).memo).toBe('top-up');
    // A day and an hour later another write (a new mint allowed) prunes the rolling window.
    s.t = T0 + DAY_MS + 60 * 60_000;
    await s.ledger.allow(SECOND);
    expect(s.ledger.snapshot().entries).toEqual([]);
    expect(s.top.relabel(melt).memo).toBe('top-up');
    const again = await s.restart();
    expect(again.relabel(melt).memo).toBe('top-up');
  });

  it('the list is bounded: the newest 256 ids are kept, a file holding more fails CLOSED, a file without the list reads fine', async () => {
    const dir = await tempDir();
    let t = T0;
    const l = await TopUpLedger.open(dir, memoryLogger(), () => t);
    // One write per id (a settle), 300 of them: the entry ages out of the window after a day,
    // the ids must not. Each write is an atomic replace with two fsyncs (file and directory):
    // about 1 s alone, but it passed the default 5 s once on a loaded, shared box — hence the
    // explicit 30 s timeout on this test only.
    const id = await l.reserve({ amount: 1, sats: 1, target: TARGET, from: SOURCE });
    for (let i = 0; i < 300; i++) {
      await l.settle(id, { state: 'done', sats: 1, melt: `melt-${String(i)}` as never });
      t += DAY_MS / 250;
    }
    expect(l.snapshot().entries).toEqual([]);
    expect(l.topUpMelts()).toHaveLength(256);
    expect(l.isTopUpMelt('melt-299')).toBe(true);
    expect(l.isTopUpMelt('melt-44')).toBe(true);
    expect(l.isTopUpMelt('melt-43')).toBe(false);
    const again = await TopUpLedger.open(dir, memoryLogger(), () => t);
    expect(again.topUpMelts()).toEqual(l.topUpMelts());
    // More than the bound on disk: never read — the ledger fails closed like any corrupt file.
    const file = JSON.parse(await readFile(join(dir, TOP_UP_LEDGER_FILE), 'utf8')) as {
      melts: string[];
    };
    await writeFile(
      join(dir, TOP_UP_LEDGER_FILE),
      JSON.stringify({ ...file, melts: [...file.melts, 'one-too-many'] }),
    );
    const over = await TopUpLedger.open(dir, memoryLogger(), () => t);
    expect(over.fits(1)).toBe(false);
    expect(over.topUpMelts()).toEqual([]);
    // A ledger written before the list existed (no `melts` key) is not corrupt.
    const old = await tempDir();
    await writeFile(
      join(old, TOP_UP_LEDGER_FILE),
      JSON.stringify({ v: 1, allowed: [TARGET], entries: [] }),
    );
    const read = await TopUpLedger.open(old, memoryLogger(), () => T0);
    expect(read.isAllowed(TARGET)).toBe(true);
    expect(read.fits(AUTO_TOP_UP_MAX_SATS_PER_DAY)).toBe(true);
  }, 30_000);
});

describe('AutoTopUp — review F3: a reservation in flight when the host died', () => {
  it('still counts after the ledger is reopened: fits() refuses what no longer fits', async () => {
    const dir = await tempDir();
    const l = await TopUpLedger.open(dir, memoryLogger(), () => T0);
    // Reserved (the melt was about to run) — and the host was killed before it answered.
    await l.reserve({ amount: 10_000, sats: 10_502, target: TARGET, from: SOURCE });
    const again = await TopUpLedger.open(dir, memoryLogger(), () => T0 + 60_000);
    expect(again.snapshot().entries).toMatchObject([{ state: 'pending', sats: 10_502 }]);
    expect(again.used()).toBe(10_502);
    expect(again.fits(AUTO_TOP_UP_MAX_SATS_PER_DAY - 10_502)).toBe(true);
    expect(again.fits(AUTO_TOP_UP_MAX_SATS_PER_DAY - 10_502 + 1)).toBe(false);
  });

  it('end to end: a melt that never answered, then a restart — the next top-up that no longer fits is refused', async () => {
    let hang = true;
    const s = await setup({
      fund: 80_000,
      amountSats: 10_000,
      belowSats: 60_000,
      wrap: (w) =>
        Object.assign(Object.create(w) as Wallet, {
          melt: (q: Parameters<Wallet['melt']>[0]) =>
            hang ? new Promise<never>(() => undefined) : w.melt(q),
        }),
    });
    for (let i = 0; i < 4; i++) {
      hang = i === 3; // three top-ups move, the fourth's melt never answers (the host dies)
      const out = s.top.check(TARGET);
      if (i < 3) expect(await out).toBe('done');
      else
        await vi.waitFor(() => {
          expect(s.ledger.snapshot().entries).toHaveLength(4);
        });
      later(s);
    }
    hang = false;
    const again = await s.restart();
    // 30 000 moved + 10 002 still reserved: another 10 002 would pass 50 000.
    expect(await again.check(TARGET)).toBe('cap');
    expect(await s.wallet.balance(TARGET)).toBe(30_000);
  });
});

describe('AutoTopUp — review F4 and info: still wanted after the question and right before the melt', () => {
  it('signed out, or another signer, while the question was open: the yes is remembered, nothing moves', async () => {
    for (const next of ['signed-out', 'switched'] as const) {
      const s = await setup({ fund: 20_000 });
      const quote = vi.spyOn(s.wallet, 'mintQuote');
      const other = new walletMod.CashuWallet({
        mints: new walletMod.CashuMintConnections({ request: () => s.source.request }),
        store: new walletMod.MemoryProofStore(),
      });
      s.answer = () => {
        s.current = next === 'signed-out' ? undefined : other;
        return true;
      };
      expect(await s.top.check(TARGET), next).toBe('not-due');
      expect(quote).not.toHaveBeenCalled();
      expect(s.lightning.paid).toEqual([]);
      expect(s.ledger.snapshot().entries).toEqual([]);
    }
  });

  it.each([
    [
      'turned off',
      (st: Settings): Settings => ({
        ...st,
        autoTopUp: { belowSats: 0 as Sats, fromMint: SOURCE },
      }),
    ],
    [
      'another source',
      (st: Settings): Settings => ({ ...st, autoTopUp: { ...st.autoTopUp!, fromMint: SECOND } }),
    ],
    [
      'another amount',
      (st: Settings): Settings => ({
        ...st,
        autoTopUp: { ...st.autoTopUp!, amountSats: 999 as Sats },
      }),
    ],
    [
      'the target taken off the list',
      (st: Settings): Settings => ({ ...st, defaultMints: [SOURCE, SECOND] }),
    ],
  ])(
    'settings changed while the quotes were fetched (%s): nothing is reserved, nothing moves',
    async (_what, change) => {
      const s: Setup = await setup({
        fund: 20_000,
        amountSats: 1_000,
        wrap: (w) =>
          Object.assign(Object.create(w) as Wallet, {
            inputFeePpk: (m: MintUrl) => {
              s.settings = change(s.settings);
              return w.inputFeePpk(m);
            },
          }),
      });
      await s.ledger.allow(TARGET); // allowed earlier: no question on this path
      const melt = vi.spyOn(s.wallet, 'melt');
      expect(await s.top.check(TARGET)).toBe('not-due');
      expect(melt).not.toHaveBeenCalled();
      expect(s.ledger.snapshot().entries).toEqual([]);
      expect(await s.wallet.balance(SOURCE)).toBe(20_000);
    },
  );

  it.each(['signed-out', 'switched', 'turned off'] as const)(
    'the last look right before the melt (%s): the reservation is released, nothing moves',
    async (what) => {
      let reads = 0;
      const s: Setup = await setup({
        fund: 20_000,
        amountSats: 1_000,
        wrap: (w) =>
          Object.assign(Object.create(w) as Wallet, {
            // The source history is read once the reservation is on disk, just before the melt.
            history: (o?: Parameters<Wallet['history']>[0]) => {
              if (reads++ === 0) {
                if (what === 'signed-out') s.current = undefined;
                else if (what === 'switched') s.current = Object.create(w) as Wallet;
                else
                  s.settings = {
                    ...s.settings,
                    autoTopUp: { belowSats: 0 as Sats, fromMint: SOURCE },
                  };
              }
              return w.history(o);
            },
          }),
      });
      await s.ledger.allow(TARGET);
      const melt = vi.spyOn(s.wallet, 'melt');
      expect(await s.top.check(TARGET)).toBe('not-due');
      expect(melt).not.toHaveBeenCalled();
      expect(s.ledger.snapshot().entries).toMatchObject([{ state: 'failed' }]);
      expect(s.ledger.used(s.t)).toBe(0);
      expect(await s.wallet.balance(SOURCE)).toBe(20_000);
    },
  );

  it('a signer switch while the check itself reads the target balance: caught after the read, nothing reserved', async () => {
    let targetReads = 0;
    const s: Setup = await setup({
      fund: 20_000,
      amountSats: 1_000,
      wrap: (w) =>
        Object.assign(Object.create(w) as Wallet, {
          balance: (m: MintUrl) => {
            // The 2nd read of the target is the pre-reservation check's own (the 1st is the due
            // check): the wallet changes while that read is awaited.
            if (m === TARGET && ++targetReads === 2) s.current = Object.create(w) as Wallet;
            return w.balance(m);
          },
        }),
    });
    await s.ledger.allow(TARGET);
    const melt = vi.spyOn(s.wallet, 'melt');
    expect(await s.top.check(TARGET)).toBe('not-due');
    expect(melt).not.toHaveBeenCalled();
    expect(s.ledger.snapshot().entries).toEqual([]);
  });
});

describe('AutoTopUp — review F5: what a paid melt moved, without its history line', () => {
  it('no melt line to read: the whole reservation counts (never the reservation less the change)', async () => {
    const s = await setup({
      fund: 20_000,
      amountSats: 1_000,
      feeReserve: 2,
      wrap: (w) =>
        Object.assign(Object.create(w) as Wallet, {
          history: () => Promise.resolve([]),
        }),
    });
    expect(await s.top.check(TARGET)).toBe('done');
    // What really left: 1 000 (the 2-sat reserve came back as change); counted: all 1 002.
    expect(await s.wallet.balance(SOURCE)).toBe(19_000);
    expect(s.ledger.used(s.t)).toBe(1_002);
  });

  it('input fees past the allowance (a source held in many small proofs): what left the source is counted', async () => {
    // 120 one-sat proofs at a source charging 100 ppk per input: a melt of 100 + 2 needs 114
    // inputs, 12 sats of input fees against the 7 the reservation allowed for. (120 separate
    // mint quotes plus a 114-input melt take ~3 s alone: an explicit 30 s timeout, this test only.)
    const s = await setup({ amountSats: 100, belowSats: 60, inputFeePpk: 100 });
    for (let i = 0; i < 120; i++) {
      const q = await s.wallet.mintQuote(SOURCE, 1 as Sats);
      s.source.payQuote(q.quoteId);
      await s.wallet.pollQuote(q);
    }
    const reserve = vi.spyOn(s.ledger, 'reserve');
    expect(await s.top.check(TARGET)).toBe('done');
    expect(reserve.mock.calls[0]![0]).toMatchObject({ amount: 100, sats: 100 + 2 + 7 });
    const left = 120 - (await s.wallet.balance(SOURCE));
    expect(left).toBeGreaterThan(109); // more than was reserved
    expect(s.ledger.used(s.t)).toBe(left);
    expect(await s.wallet.balance(TARGET)).toBe(100);
  }, 30_000);
});

describe('AutoTopUp — review info: a ledger that cannot record the yes', () => {
  it('backs the mint off like a decline: not asked again after every failure backoff', async () => {
    const s = await setup({ fund: 20_000 });
    await chmod(s.dir, 0o500);
    expect(await s.top.check(TARGET)).toBe('failed');
    expect(s.asked).toHaveLength(1);
    // Past the failure backoff (1 min, then 2), still inside the hour: not asked again.
    for (let i = 0; i < 5; i++) {
      later(s, 4 * TOP_UP_FAIL_BACKOFF_MS);
      expect(await s.top.check(TARGET)).toBe('backoff');
    }
    expect(s.asked).toHaveLength(1);
    later(s, TOP_UP_DECLINED_BACKOFF_MS);
    expect(await s.top.check(TARGET)).toBe('failed');
    expect(s.asked).toHaveLength(2);
    expect(await s.wallet.balance(SOURCE)).toBe(20_000);
  });
});

describe('AutoTopUp — review info: the defensive quote checks', () => {
  it('a melt quote for another mint than fromMint: refused, nothing moves', async () => {
    const s = await setup({
      fund: 20_000,
      amountSats: 1_000,
      wrap: (w) =>
        Object.assign(Object.create(w) as Wallet, {
          meltQuote: async (_m: MintUrl, b: string) => w.meltQuote(SECOND, b),
        }),
    });
    const melt = vi.spyOn(s.wallet, 'melt');
    expect(await s.top.check(TARGET)).toBe('refused');
    expect(melt).not.toHaveBeenCalled();
    expect(s.ledger.snapshot().entries).toEqual([]);
  });

  it.each([Number.NaN, -10, -1_000, 1.5, Number.POSITIVE_INFINITY])(
    'an input fee of %s ppk: refused, nothing moves',
    async (ppk) => {
      const s = await setup({
        fund: 20_000,
        amountSats: 1_000,
        wrap: (w) =>
          Object.assign(Object.create(w) as Wallet, {
            inputFeePpk: () => Promise.resolve(ppk),
          }),
      });
      const melt = vi.spyOn(s.wallet, 'melt');
      expect(await s.top.check(TARGET)).toBe('refused');
      expect(melt).not.toHaveBeenCalled();
      expect(s.ledger.snapshot().entries).toEqual([]);
    },
  );
});

describe('AutoTopUp.paymentAt — the money plane’s trigger (review F1)', () => {
  it('reads the balance first: not due holds no flight; due runs the top-up; off never reads the wallet', async () => {
    const s = await setup({ fund: 20_000, amountSats: 1_000 });
    const balance = vi.spyOn(s.wallet, 'balance');
    s.settings = { ...s.settings, autoTopUp: { belowSats: 0 as Sats, fromMint: SOURCE } };
    expect(await s.top.paymentAt(TARGET)).toBe('not-due');
    expect(balance).not.toHaveBeenCalled();
    s.settings = { ...s.settings, autoTopUp: { belowSats: 1_000 as Sats, fromMint: SOURCE } };
    expect(await s.top.paymentAt(STRANGER)).toBe('not-due');
    expect(balance).not.toHaveBeenCalled();
    expect(await s.top.paymentAt(TARGET)).toBe('done');
    later(s);
    // Above the threshold now: not due, and no flight was taken for it.
    const p = s.top.paymentAt(TARGET);
    expect(s.top.inFlight).toBeNull();
    expect(await p).toBe('not-due');
    s.current = undefined;
    expect(await s.top.paymentAt(TARGET)).toBe('not-due');
  });
});

// ---- cross-lane review round 4 ------------------------------------------------------------

/** Past every backoff a failed top-up may have set. */
function pastBackoff(s: Setup): void {
  later(s, TOP_UP_MAX_BACKOFF_MS + 1);
}

/** The source's history as the screens show it (the top-up's label applied). */
async function sourceMemos(s: Setup, top: AutoTopUp = s.top): Promise<(string | undefined)[]> {
  const w = s.current ?? s.wallet;
  return (await w.history({ mint: SOURCE })).map((e) => top.relabel(e).memo);
}

describe('AutoTopUp — round 4 (money high): a melt whose outcome is unknown keeps the target quote', () => {
  it.each(['later', 'now'] as const)(
    'answered PENDING, then settled paid (the target’s invoice paid %s): minted exactly once, Lightning paid once, the entry done, the settled line reads "top-up"',
    async (paidAt) => {
      const s = await setup({ fund: 20_000, amountSats: 2_000 });
      s.source.holdNextMelt(1, { lightning: paidAt });
      expect(await s.top.check(TARGET)).toBe('failed');
      const [open] = s.ledger.snapshot().entries;
      expect(open).toMatchObject({ state: 'unknown', sats: 2_002, owner: OWNER });
      expect(open?.open).toEqual(expect.any(String));
      // Kept sealed: the ledger file holds no invoice or quote id in the clear.
      expect(s.sealed).toHaveLength(1);
      const file = await readFile(join(s.dir, TOP_UP_LEDGER_FILE), 'utf8');
      expect(file).not.toMatch(/lnbc/);
      expect(s.sealed[0]).toMatch(/lnbc/);

      // A PAY meanwhile, the melt still pending at the source: nothing new moves into the target.
      pastBackoff(s);
      const meanwhile = await s.top.check(TARGET);
      if (paidAt === 'later') {
        expect(meanwhile).toBe('unresolved');
        expect(s.lightning.paid).toHaveLength(0);
        expect(await s.top.check(TARGET)).toBe('backoff'); // retried at most once a minute
      } else {
        // The target already has the payment: minted at this trigger, before the source settles.
        expect(meanwhile).toBe('not-due');
        expect(await s.wallet.balance(TARGET)).toBe(2_000);
      }

      s.source.settleMelts('paid');
      await s.wallet.recoverPending(); // the money plane's settle loop
      pastBackoff(s);
      expect(await s.top.check(TARGET)).toBe('not-due');
      pastBackoff(s);
      expect(await s.top.check(TARGET, 0 as Sats)).toBe('not-due');

      expect(s.lightning.paid).toHaveLength(1);
      expect(await s.wallet.balance(TARGET)).toBe(2_000);
      expect(await s.wallet.balance(SOURCE)).toBe(18_000);
      expect(s.wallet.pendingMintQuotes()).toEqual([]);
      const [entry, ...more] = s.ledger.snapshot().entries;
      expect(more).toEqual([]);
      expect(entry).toMatchObject({ state: 'done', sats: 2_000 });
      expect(entry?.open).toBeUndefined();
      // Every top-up is a history entry: the journal's settled melt reads "top-up" too.
      const raw = await s.wallet.history({ mint: SOURCE });
      expect(raw.map((e) => e.memo)).toContain('melt to Lightning (change recovered)');
      expect(await sourceMemos(s)).not.toContain('melt to Lightning (change recovered)');
      expect((await sourceMemos(s)).filter((m) => m === 'top-up')).toHaveLength(2); // funding in, melt out
    },
  );

  it('the melt throws after the mint executed (its answer lost while the payment was in flight): minted once when it settles paid', async () => {
    const s: Setup = await setup({
      fund: 20_000,
      amountSats: 2_000,
      wrap: (w) =>
        Object.assign(Object.create(w) as Wallet, {
          melt: (q: Parameters<Wallet['melt']>[0]) => {
            s.source.dropNextResponse(1); // the melt's own POST (its quote lookup is a GET)
            return w.melt(q);
          },
        }),
    });
    s.source.holdNextMelt(1);
    expect(await s.top.check(TARGET)).toBe('failed');
    expect(s.ledger.snapshot().entries).toMatchObject([{ state: 'unknown', owner: OWNER }]);
    expect(s.log.lines.map((l) => l.msg)).toContain(
      'auto top-up melt outcome unknown; its quote is kept until it is',
    );
    s.source.settleMelts('paid');
    await s.wallet.recoverPending();
    pastBackoff(s);
    expect(await s.top.check(TARGET)).toBe('not-due');
    expect(s.lightning.paid).toHaveLength(1);
    expect(await s.wallet.balance(TARGET)).toBe(2_000);
    expect(s.ledger.snapshot().entries).toMatchObject([{ state: 'done' }]);
  });

  it('the melt throws after the mint paid, not journaled (a source without NUT-09): its quote is minted at the next trigger, never paid again', async () => {
    const s: Setup = await setup({
      fund: 20_000,
      amountSats: 2_000,
      sourceNut09: false,
      wrap: (w) =>
        Object.assign(Object.create(w) as Wallet, {
          melt: (q: Parameters<Wallet['melt']>[0]) => {
            s.source.dropNextResponse(1); // the mint pays the invoice, the answer never arrives
            return w.melt(q);
          },
        }),
    });
    expect(await s.top.check(TARGET)).toBe('failed');
    expect(s.lightning.paid).toHaveLength(1);
    expect(s.ledger.snapshot().entries).toMatchObject([{ state: 'unknown' }]);
    pastBackoff(s);
    expect(await s.top.check(TARGET)).toBe('not-due');
    expect(s.lightning.paid).toHaveLength(1);
    expect(await s.wallet.balance(TARGET)).toBe(2_000);
    expect(s.ledger.snapshot().entries).toMatchObject([{ state: 'done' }]);
  });

  it('answered PENDING where core cannot journal (a source without NUT-09): kept while the source mint says PENDING, released by nothing but UNPAID, minted once when it pays', async () => {
    const s = await setup({ fund: 20_000, amountSats: 2_000, sourceNut09: false });
    s.source.holdNextMelt(1);
    expect(await s.top.check(TARGET)).toBe('failed');
    expect(s.ledger.snapshot().entries).toMatchObject([{ state: 'unknown' }]);
    // Nothing journaled at the source; its own quote state is what keeps the quote open.
    pastBackoff(s);
    expect(await s.top.check(TARGET)).toBe('unresolved');
    expect(s.lightning.paid).toHaveLength(0);
    s.source.settleMelts('paid');
    pastBackoff(s);
    expect(await s.top.check(TARGET)).toBe('not-due');
    expect(s.lightning.paid).toHaveLength(1);
    expect(await s.wallet.balance(TARGET)).toBe(2_000);
  });

  it.each(['before', 'after'] as const)(
    'a restart %s the source settles: the next start mints it once',
    async (when) => {
      const s = await setup({ fund: 20_000, amountSats: 2_000 });
      s.source.holdNextMelt(1);
      expect(await s.top.check(TARGET)).toBe('failed');
      if (when === 'after') s.source.settleMelts('paid');
      // The host dies: a new ledger read from disk, a new wallet over the same journal.
      const again = await s.restart();
      const w2 = new walletMod.CashuWallet({ mints: s.conns, store: s.store });
      s.adopt(w2);
      s.current = w2;
      await w2.recoverPending(); // the next start's settle
      if (when === 'before') {
        expect(await again.check(TARGET)).toBe('unresolved');
        s.source.settleMelts('paid');
        await w2.recoverPending();
        pastBackoff(s);
      }
      expect(await again.check(TARGET)).toBe('not-due');
      expect(s.lightning.paid).toHaveLength(1);
      expect(await w2.balance(TARGET)).toBe(2_000);
      const reread = await TopUpLedger.open(s.dir, memoryLogger(), () => s.t);
      expect(reread.snapshot().entries).toMatchObject([{ state: 'done' }]);
      expect(reread.snapshot().entries[0]?.open).toBeUndefined();
    },
  );

  it('a lock/unlock of the same identity before the source settles: the new wallet mints it once, the old one is never used again', async () => {
    const s = await setup({ fund: 20_000, amountSats: 2_000 });
    s.source.holdNextMelt(1);
    expect(await s.top.check(TARGET)).toBe('failed');
    const oldPoll = vi.spyOn(s.wallet, 'pollQuote');
    // Locked, then unlocked: the money plane opens a new wallet over the same journal.
    const w2 = new walletMod.CashuWallet({ mints: s.conns, store: s.store });
    s.adopt(w2);
    s.current = w2;
    s.source.settleMelts('paid');
    await w2.recoverPending();
    await s.top.resume(); // the host calls it when the new plane opens
    expect(await w2.balance(TARGET)).toBe(2_000);
    expect(oldPoll).not.toHaveBeenCalled();
    pastBackoff(s);
    expect(await s.top.check(TARGET)).toBe('not-due');
    expect(s.lightning.paid).toHaveLength(1);
  });

  it('settled NOT paid while the quote is still UNPAID: the quote is released (still counted) and the next top-up runs', async () => {
    const s = await setup({ fund: 20_000, amountSats: 2_000, walletClock: true });
    s.source.holdNextMelt(1);
    expect(await s.top.check(TARGET)).toBe('failed');
    s.source.settleMelts('failed');
    // A melt with no trace is settled only once it is old enough (core, PENDING_SETTLE_AFTER_S).
    later(s, (walletMod.PENDING_SETTLE_AFTER_S + 1) * 1000);
    await s.wallet.recoverPending();
    expect(await s.wallet.balance(SOURCE)).toBe(20_000); // its inputs came back
    pastBackoff(s);
    expect(await s.top.check(TARGET)).toBe('done');
    expect(s.lightning.paid).toHaveLength(1);
    expect(await s.wallet.balance(TARGET)).toBe(2_000);
    const entries = s.ledger.snapshot().entries;
    expect(entries).toMatchObject([
      { state: 'unknown', sats: 2_002 },
      { state: 'done', sats: 2_000 },
    ]);
    expect(entries.every((e) => e.open === undefined)).toBe(true);
    expect(s.log.lines.map((l) => l.msg)).toContain(
      'auto top-up melt not paid: its quote is released',
    );
  });

  it('another identity signed in neither polls nor releases the open quote, and is not blocked by it; its owner mints it later', async () => {
    const s = await setup({ fund: 20_000, amountSats: 2_000 });
    s.source.holdNextMelt(1, { lightning: 'now' });
    expect(await s.top.check(TARGET)).toBe('failed');
    const other = new walletMod.CashuWallet({
      mints: s.conns,
      store: new walletMod.MemoryProofStore(),
    });
    const otherPoll = vi.spyOn(other, 'pollQuote');
    s.current = other;
    pastBackoff(s);
    expect(await s.top.check(TARGET)).toBe('source-short'); // its own attempt, not blocked
    await s.top.resume();
    expect(otherPoll).not.toHaveBeenCalled();
    expect(await other.balance(TARGET)).toBe(0);
    expect(s.ledger.openEntries(OWNER)).toHaveLength(1);
    s.current = s.wallet;
    await s.top.resume();
    expect(await s.wallet.balance(TARGET)).toBe(2_000);
    // Minted; its melt still pending at the source: open only for the melt's label, no longer
    // holding back a top-up into the target.
    expect(s.ledger.openEntries(OWNER)).toMatchObject([{ state: 'done', minted: true }]);
    expect(s.ledger.hasOpen(OWNER, TARGET)).toBe(false);
    s.source.settleMelts('paid');
    await s.wallet.recoverPending();
    later(s, TOP_UP_RESOLVE_EVERY_MS + 1);
    await s.top.resume();
    expect(s.ledger.openEntries(OWNER)).toEqual([]);
    expect(s.ledger.snapshot().entries).toMatchObject([{ state: 'done', sats: 2_000 }]);
    expect((await sourceMemos(s)).filter((m) => m === 'top-up')).toHaveLength(2);
    expect(s.lightning.paid).toHaveLength(1);
  });

  it('an open quote that does not unseal (damaged, or swapped for another entry’s) is kept, never minted or released', async () => {
    const s = await setup({ fund: 20_000, amountSats: 2_000 });
    s.source.holdNextMelt(1);
    expect(await s.top.check(TARGET)).toBe('failed');
    const file = join(s.dir, TOP_UP_LEDGER_FILE);
    const raw = JSON.parse(await readFile(file, 'utf8')) as {
      entries: { open?: string }[];
    };
    raw.entries[0]!.open = Buffer.from('someone else\n{}').toString('base64');
    await writeFile(file, JSON.stringify(raw));
    const again = await s.restart();
    s.source.settleMelts('paid');
    await s.wallet.recoverPending();
    pastBackoff(s);
    expect(await again.check(TARGET)).toBe('unresolved');
    expect(await s.wallet.balance(TARGET)).toBe(0);
    expect(s.lightning.paid).toHaveLength(1);
    expect(s.log.lines.map((l) => l.msg)).toContain(
      'an open auto top-up could not be read; it is kept',
    );
  });
});

describe('AutoTopUp — round 4 (low): paid but not minted, then a lock/unlock of the same identity', () => {
  it('the new wallet mints it (the retry follows the identity, not the wallet instance)', async () => {
    let unpaidPolls = 3;
    const s = await setup({
      fund: 20_000,
      amountSats: 2_000,
      wrap: (w) =>
        Object.assign(Object.create(w) as Wallet, {
          pollQuote: (q: Parameters<Wallet['pollQuote']>[0]) =>
            unpaidPolls-- > 0 ? Promise.resolve({ state: 'UNPAID' as const }) : w.pollQuote(q),
        }),
    });
    expect(await s.top.check(TARGET)).toBe('failed');
    expect(s.ledger.snapshot().entries).toMatchObject([{ state: 'done', owner: OWNER }]);
    const w2 = new walletMod.CashuWallet({ mints: s.conns, store: s.store });
    s.adopt(w2);
    s.current = w2;
    await s.top.resume();
    expect(await w2.balance(TARGET)).toBe(2_000);
    expect(s.ledger.openEntries(OWNER)).toEqual([]);
    expect(s.lightning.paid).toHaveLength(1);
  });

  it('every trigger finishes it, also one that is not due (the target recovered another way): paced, never beside a run', async () => {
    let unpaidPolls = 3;
    const s = await setup({
      fund: 20_000,
      amountSats: 2_000,
      wrap: (w) =>
        Object.assign(Object.create(w) as Wallet, {
          pollQuote: (q: Parameters<Wallet['pollQuote']>[0]) =>
            unpaidPolls-- > 0 ? Promise.resolve({ state: 'UNPAID' as const }) : w.pollQuote(q),
        }),
    });
    expect(await s.top.check(TARGET)).toBe('failed');
    const poll = vi.spyOn(s.current!, 'pollQuote');
    // A PAY with the target well above its threshold: not due — and the paid quote is minted.
    expect(await s.top.check(TARGET, 5_000 as Sats)).toBe('not-due');
    await vi.waitFor(async () => {
      expect(await s.wallet.balance(TARGET)).toBe(2_000);
    });
    expect(poll).toHaveBeenCalledTimes(1);
    expect(s.ledger.openEntries(OWNER)).toEqual([]);
    // Nothing open any more: later triggers poll nothing.
    later(s, TOP_UP_RESOLVE_EVERY_MS + 1);
    expect(await s.top.check(TARGET, 5_000 as Sats)).toBe('not-due');
    expect(poll).toHaveBeenCalledTimes(1);
  });
});

describe('AutoTopUp — round 4 (info): a provable "nothing was sent" is not unknown', () => {
  it('core’s refusals before the melt request (quote lookup failed, amount changed, fee raised): not counted, the quote dropped', async () => {
    const cases: [string, (w: Wallet, s: Setup) => Wallet['melt']][] = [
      [
        'the melt quote could not be read',
        (w, s) => (q) => {
          s.source.failNext(1);
          return w.melt(q);
        },
      ],
      ['the amount changed', (w) => (q) => w.melt({ ...q, amount: q.amount + 1 })],
      ['the fee reserve was raised', (w) => (q) => w.melt({ ...q, feeReserve: q.feeReserve - 1 })],
    ];
    for (const [what, melt] of cases) {
      const s: Setup = await setup({
        fund: 20_000,
        amountSats: 2_000,
        wrap: (w) =>
          Object.assign(Object.create(w) as Wallet, {
            melt: (q: Parameters<Wallet['melt']>[0]) => melt(w, s)(q),
          }),
      });
      expect(await s.top.check(TARGET), what).toBe('failed');
      expect(s.ledger.snapshot().entries, what).toMatchObject([{ state: 'failed' }]);
      expect(s.ledger.snapshot().entries[0]?.open, what).toBeUndefined();
      expect(s.ledger.used(s.t), what).toBe(0);
      expect(s.lightning.paid, what).toEqual([]);
    }
  });

  it('classifies real core errors: an earlier unresolved melt of the quote, and the gate, sent nothing; a refusal after the request, a lost answer or a plain error may have', async () => {
    const s = await setup({ fund: 20_000 });
    const q = await s.wallet.meltQuote(
      SOURCE,
      (await s.wallet.mintQuote(TARGET, 100 as Sats)).bolt11,
    );
    s.source.holdNextMelt(1);
    expect(await s.wallet.melt(q)).toMatchObject({ paid: false });
    const again = await s.wallet.melt(q).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(walletMod.WalletError);
    expect(meltSentNothing(again)).toBe(true);
    expect(meltSentNothing(new GateRefusal(PAY_STILL_BUILDING))).toBe(true);
    expect(meltSentNothing(new walletMod.WalletError('insufficient-funds', 'x'))).toBe(true);
    // A coded refusal after the request (the next test drives a real one): core words it like a
    // melt that may have run — not provable. So is a lost answer, or anything not core's.
    const coded = new walletMod.WalletError('mint-error', 'melt failed (MintOperationError 11002)');
    expect(meltSentNothing(coded)).toBe(false);
    expect(
      meltSentNothing(
        new walletMod.WalletError(
          'mint-error',
          'melt outcome unknown (Error): its inputs are held',
        ),
      ),
    ).toBe(false);
    expect(meltSentNothing(new Error('journal-unreadable: the wallet is closed'))).toBe(false);
  });

  it('a coded refusal after the request stays counted, and its quote is released once the source says UNPAID', async () => {
    const s = await setup({ fund: 20_000, amountSats: 2_000 });
    s.source.failNextMelt(); // the mint refuses the melt request with a code: nothing executed
    expect(await s.top.check(TARGET)).toBe('failed');
    expect(s.ledger.snapshot().entries).toMatchObject([{ state: 'unknown', sats: 2_002 }]);
    expect(s.ledger.openEntries(OWNER)).toHaveLength(1);
    pastBackoff(s);
    expect(await s.top.check(TARGET)).toBe('done'); // released, then a fresh top-up
    expect(s.ledger.snapshot().entries).toMatchObject([{ state: 'unknown' }, { state: 'done' }]);
    expect(s.ledger.openEntries(OWNER)).toEqual([]);
    expect(s.lightning.paid).toHaveLength(1);
    expect(await s.wallet.balance(TARGET)).toBe(2_000);
  });
});

describe('AutoTopUp — round 4 (info): the startup settle first, a play waits a bounded time', () => {
  it('no balance is read and nothing is quoted before the money plane’s startup settle is over', async () => {
    const s = await setup({ fund: 20_000, amountSats: 2_000 });
    let settled: () => void = () => undefined;
    s.recovery = new Promise<void>((r) => {
      settled = r;
    });
    const quote = vi.spyOn(s.wallet, 'mintQuote');
    const balance = vi.spyOn(s.wallet, 'balance');
    const out = s.top.check(TARGET);
    await new Promise((r) => setTimeout(r, 20));
    expect(quote).not.toHaveBeenCalled();
    expect(balance).not.toHaveBeenCalled();
    settled();
    expect(await out).toBe('done');
  });

  it('a play waits for its top-up at most playWaitMs past the question; the top-up finishes in the background', async () => {
    let release: () => void = () => undefined;
    const s: Setup = await setup({
      fund: 20_000,
      amountSats: 2_000,
      wrap: (w) =>
        Object.assign(Object.create(w) as Wallet, {
          melt: async (q: Parameters<Wallet['melt']>[0]) => {
            await new Promise<void>((r) => {
              release = r;
            });
            return w.melt(q);
          },
        }),
    });
    const top = new AutoTopUp({
      settings: () => s.settings,
      wallet: () => s.current,
      vault: (w) =>
        w === s.current ? testVault({ owner: OWNER, store: s.store, mints: s.conns }) : undefined,
      ledger: s.ledger,
      // The question stays open longer than the play's wait: the wait starts after it.
      askFirstFunding: () =>
        new Promise((r) => {
          setTimeout(() => {
            r(true);
          }, 60);
        }),
      log: s.log,
      now: () => s.t,
      sleep: () => Promise.resolve(),
      pollAttempts: 3,
      playWaitMs: 30,
    });
    const started = Date.now();
    expect(await top.checkForPlay(TARGET)).toBe('in-flight');
    expect(Date.now() - started).toBeGreaterThanOrEqual(60 + 25);
    expect(top.inFlight).not.toBeNull();
    release();
    expect(await top.inFlight).toBe('done');
    expect(await s.wallet.balance(TARGET)).toBe(2_000);
    // Quick top-ups are simply awaited: nothing in flight, the outcome itself.
    later(s);
    expect(await top.checkForPlay(TARGET)).toBe('not-due');
  });
});

describe('TopUpLedger — round 4: open top-ups', () => {
  it('kept across a reopen and past the 24-hour window (no longer counted), bounded, dropped by failed or open: null', async () => {
    const dir = await tempDir();
    let t = T0;
    const l = await TopUpLedger.open(dir, memoryLogger(), () => t);
    const id = await l.reserve({ amount: 1_000, sats: 1_002, target: TARGET, from: SOURCE });
    await l.attach(id, { owner: OWNER, open: 'c2VhbGVk' });
    await expect(l.attach(id, { owner: 'nope' as NostrPubkey, open: 'x' })).rejects.toThrow();
    await expect(l.attach(id, { owner: OWNER, open: 'not base64!' })).rejects.toThrow();
    await l.settle(id, { state: 'unknown' }); // keeps it open
    t += 2 * DAY_MS;
    const other = await l.reserve({ amount: 1_000, sats: 1_002, target: SECOND, from: SOURCE });
    const again = await TopUpLedger.open(dir, memoryLogger(), () => t);
    expect(again.openEntries(OWNER).map((e) => e.id)).toEqual([id]);
    expect(again.hasOpen(OWNER, TARGET)).toBe(true);
    expect(again.hasOpen(OWNER, SECOND)).toBe(false);
    expect(again.hasOpen('b'.repeat(64) as NostrPubkey, TARGET)).toBe(false);
    expect(again.used()).toBe(1_002); // the other one only: the open one is past the window
    await again.settle(id, { state: 'done', open: null });
    await again.settle(other, { state: 'failed' });
    const third = await TopUpLedger.open(dir, memoryLogger(), () => t + 1);
    expect(third.openEntries(OWNER)).toEqual([]);
    expect(third.snapshot().entries.map((e) => e.id)).toEqual([other]); // the old one pruned now
    // At most MAX_OPEN_TOP_UPS open; a failed reservation drops its quote.
    const ids: string[] = [];
    for (let i = 0; i < MAX_OPEN_TOP_UPS; i++) {
      const x = await third.reserve({ amount: 1, sats: 1, target: TARGET, from: SOURCE });
      await third.attach(x, { owner: OWNER, open: 'c2VhbGVk' });
      ids.push(x);
    }
    const over = await third.reserve({ amount: 1, sats: 1, target: TARGET, from: SOURCE });
    await expect(third.attach(over, { owner: OWNER, open: 'c2VhbGVk' })).rejects.toThrow();
    await third.settle(ids[0]!, { state: 'failed' });
    expect(third.openCount()).toBe(MAX_OPEN_TOP_UPS - 1);
  });

  it('a file whose open top-up is out of shape fails CLOSED', () => {
    const good = {
      v: 1,
      allowed: [],
      entries: [
        {
          id: '0123456789abcdef',
          at: T0,
          sats: 2,
          amount: 1,
          state: 'unknown',
          owner: OWNER,
          open: 'c2VhbGVk',
        },
      ],
    };
    expect(parseLedger(good)).not.toBeNull();
    for (const bad of [
      { owner: 'A1'.repeat(32) },
      { open: 'has spaces' },
      { open: 'a'.repeat(16_385) },
      { stray: 1 },
    ]) {
      const e = { ...good.entries[0], ...bad };
      expect(parseLedger({ ...good, entries: [e] }), JSON.stringify(bad).slice(0, 40)).toBeNull();
    }
  });
});

describe('open-topup — round 4: the record read back strictly', () => {
  const record = {
    quote: {
      mint: TARGET,
      quoteId: 'q1',
      amount: 2_000,
      bolt11: 'lnbc20000n1testmint',
      expiry: 0,
      state: 'UNPAID' as const,
    },
    melt: { mint: SOURCE, quoteId: 'm2' },
    before: { newest: 1_800_000_000, ids: ['mem-00000001', 'not an id!'] },
  };

  it('round trip; an id the ledger would not store is left out of the anchor, never the reason nothing runs', () => {
    const text = serializeOpenTopUp(record);
    expect(parseOpenTopUp(text)).toEqual({
      ...record,
      before: { newest: 1_800_000_000, ids: ['mem-00000001'] },
    });
    expect(parseOpenTopUp(serializeOpenTopUp({ ...record, before: null }))?.before).toBeNull();
  });

  it('anything not exactly a record is null (a stray key, a wrong type, a bad mint, an invoice too long); serialising one throws', () => {
    const wire = JSON.parse(serializeOpenTopUp(record)) as Record<string, unknown>;
    for (const bad of [
      { ...wire, stray: 1 },
      { ...wire, v: 2 },
      { ...wire, quote: { ...record.quote, amount: '2000' } },
      { ...wire, quote: { ...record.quote, mint: 'ftp://x' } },
      { ...wire, melt: { mint: SOURCE } },
      { ...wire, before: { newest: -1, ids: [] } },
    ])
      expect(parseOpenTopUp(JSON.stringify(bad))).toBeNull();
    expect(parseOpenTopUp('not json')).toBeNull();
    expect(() =>
      serializeOpenTopUp({
        ...record,
        quote: { ...record.quote, bolt11: `lnbc${'q'.repeat(4096)}` },
      }),
    ).toThrow();
  });
});

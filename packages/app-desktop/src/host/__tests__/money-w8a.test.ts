/**
 * Lane W8a (final cross-lane review, money plane / NUT-13): the money plane with core's real
 * NUT-13 code, the in-process TestMint, a FakeRelayPool and a real LocalSigner.
 *
 *   PAY behind a restore   a restore holds its mint in the PAY/melt gate: a PAY asked meanwhile
 *                          is refused at once — nothing spent — and no P2PK set is made after the
 *                          worker's deadline (the reviewer's reproduction built one);
 *   the seeded belt        a seeded PAY's belt counts what a seeded send costs (12.6 s, not 105.6);
 *   prepare                a PAY's mint is loaded (and its keyset probed) before its turn, so the
 *                          seeded belt — which leaves no time for a load — still admits it;
 *   a send's own turn      a send whose turn in core comes after an operation the gate does not see
 *                          (a redeem) is asked again there, and refused with nothing spent;
 *   the wallet's close     drained before the swap moves on; a watermark write after that is
 *                          skipped (the late-write race of integration fix 2);
 *   the startup restore    ecash a crash cut off before NIP-60 is restored at the next open, inside
 *                          the gate (core's contract request 4, ADR 0016 §3);
 *   the counters file      the desktop's real file store through PAYs, a reopen and a rotation.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import type { RequestFn } from '@cashu/cashu-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  CashuP2pkPubkey,
  CoreKeyHex,
  HyperblobId,
  MintUrl,
  NostrPubkey,
  PricePolicy,
  RelayUrl,
  Sats,
  Signer,
  UnixSeconds,
} from '@sovit/core';
import { NostrKind, mocks, nostr, signer as signerMod, wallet as walletMod } from '@sovit/core';

import {
  PAY_BUILD_SEEDED_START_BY_MS,
  PAY_BUILD_START_BY_MS,
  WORKER_HOST_REQUEST_TIMEOUT_MS,
  sendStartByMs,
} from '../../ipc/deadlines.js';
import type { SessionId } from '../../ipc/protocol.js';
import { memoryLogger } from '../log.js';
import { MoneyPlane } from '../money.js';
import { HOLD_AT_MINT, PAY_TOO_LATE } from '../pay-melt-gate.js';
import { recoveryCore } from '../recovery/core.js';
import { FileCounterStore } from '../recovery/files.js';

// Real NUT-13 derivations and restores against the in-process mint (a hash-to-curve per output):
// under the whole suite on a shared box these overrun vitest's 5 s default.
vi.setConfig({ testTimeout: 60_000 });

const MINT = 'https://mint.money-w8a.test' as MintUrl;
const RELAY = 'wss://relay.money-w8a.test' as RelayUrl;
const PHRASE = '5a'.repeat(16);
const OTHER_PHRASE = 'a5'.repeat(16);
const CORE = 'c0'.repeat(32) as CoreKeyHex;
const SID = 'ab'.repeat(16) as SessionId;
const BLOB: HyperblobId = { blockOffset: 10, blockLength: 40, byteOffset: 0, byteLength: 40960 };
const CREATOR_P2PK = Buffer.from(getPubKeyFromPrivKey(new Uint8Array(32).fill(0x21))).toString(
  'hex',
) as CashuP2pkPubkey;
const CREATOR = 'c1'.repeat(32) as NostrPubkey;
const SEEDER_P2PK = Buffer.from(getPubKeyFromPrivKey(new Uint8Array(32).fill(0x22))).toString(
  'hex',
) as CashuP2pkPubkey;
const SEEDER = 'd1'.repeat(32) as NostrPubkey;
const POLICY: PricePolicy = {
  satsPerBlock: 2 as Sats,
  blockSize: 1024,
  mints: [MINT],
  split: { seeder: 50, creator: 50 },
  creatorP2pk: CREATOR_P2PK,
};

const build = (from = 10) => ({
  sid: SID,
  range: { core: CORE, fromBlock: from, toBlock: from + 1 },
  seeder: { pubkey: SEEDER, p2pk: SEEDER_P2PK, mint: MINT },
  policy: POLICY,
  carryIn: 0,
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function seedOf(hex: string): Promise<walletMod.RecoverySeed> {
  return walletMod.recoveryPhrases.toSeed(walletMod.entropyFromHex(hex));
}

interface Held {
  readonly path: string;
  release(): void;
}

/** A transport over the mint that holds the requests `hold` picks, recording when each arrives. */
function holding(clock: () => number) {
  let pick: ((path: string) => boolean) | null = null;
  const arrived: Held[] = [];
  const waiting: ((h: Held) => void)[] = [];
  const reached: { readonly path: string; readonly at: number }[] = [];
  const wrap =
    (inner: RequestFn): RequestFn =>
    <T>(args: Parameters<RequestFn>[0]): Promise<T> => {
      const path = `${(args.method ?? 'GET').toUpperCase()} ${new URL(args.endpoint).pathname}`;
      const send = (): Promise<T> => {
        reached.push({ path, at: clock() });
        return inner<T>(args);
      };
      if (pick?.(path) !== true) return send();
      return new Promise<T>((resolve, reject) => {
        const h: Held = {
          path,
          release: () => {
            send().then(resolve, reject);
          },
        };
        const w = waiting.shift();
        if (w === undefined) arrived.push(h);
        else w(h);
      });
    };
  return {
    wrap,
    reached,
    hold(p: ((path: string) => boolean) | null): void {
      pick = p;
    },
    next(): Promise<Held> {
      const h = arrived.shift();
      return h !== undefined ? Promise.resolve(h) : new Promise((r) => waiting.push(r));
    },
  };
}

function observe<T>(p: Promise<T>): { done: boolean; value?: T; error?: unknown } {
  const o: { done: boolean; value?: T; error?: unknown } = { done: false };
  p.then(
    (v) => {
      o.done = true;
      o.value = v;
    },
    (e: unknown) => {
      o.done = true;
      o.error = e;
    },
  );
  return o;
}

const settleIo = (): Promise<void> => new Promise((r) => setTimeout(r, 40));
const isSwap = (p: string): boolean => p === 'POST /v1/swap';
const isRestore = (p: string): boolean => p === 'POST /v1/restore';

interface Setup {
  readonly mint: mocks.TestMint;
  readonly signer: Signer;
  readonly t: ReturnType<typeof holding>;
  readonly clock: { now: number };
}

async function setup(): Promise<Setup> {
  const clock = { now: 0 };
  const mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x63) });
  const { signer } = await signerMod.LocalSigner.create({
    passphrase: Buffer.from('money w8a test passphrase'),
    cost: signerMod.minimumCost(),
  });
  return { mint, signer, t: holding(() => clock.now), clock };
}

let tick = 1_757_100_000;

/** A plane over `s`: seeded with `phrase` (none: unseeded) and `counters`. */
async function plane(
  s: Setup,
  o: {
    phrase?: string | null;
    counters?: walletMod.CounterStore;
    pool?: nostr.FakeRelayPool;
    create?: boolean;
  } = {},
): Promise<{ plane: MoneyPlane; seed: walletMod.RecoverySeed | undefined }> {
  const core = recoveryCore();
  if (core === undefined) throw new Error('recoveryCore() is not wired');
  const seed = o.phrase === null ? undefined : await seedOf(o.phrase ?? PHRASE);
  const p = await MoneyPlane.open({
    signer: s.signer,
    journalDir: null,
    tailDir: null,
    pool: o.pool ?? new nostr.FakeRelayPool(),
    relays: () => [{ url: RELAY, read: true, write: true }],
    defaultMints: () => [MINT],
    log: memoryLogger('warn'),
    mintRequest: () => s.t.wrap(s.mint.request),
    ...(o.create === false ? {} : { createWallet: true }),
    now: () => tick++ as UnixSeconds,
    clock: () => s.clock.now,
    ...(seed === undefined
      ? {}
      : {
          seed: {
            material: { seed, counters: o.counters ?? new mocks.MemoryCounterStore() },
            core,
          },
        }),
  });
  cleanups.push(async () => {
    p.close();
    await p.drained();
  });
  return { plane: p, seed };
}

async function fund(p: MoneyPlane, mint: mocks.TestMint, sats: number): Promise<void> {
  const q = await p.wallet.mintQuote(MINT, sats as Sats);
  mint.payQuote(q.quoteId);
  await p.wallet.pollQuote(q);
}

describe('W8a: a restore holds its mint — the PAY-behind-restore loss', () => {
  it("the reviewer's reproduction: a PAY asked while a restore scans its mint is refused at once, nothing spent, and no P2PK set is made after the worker's deadline", async () => {
    const s = await setup();
    const { plane: p } = await plane(s);
    await fund(p, s.mint, 200);
    await p.startupRestore;
    p.authorizeSession(SID, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    const h = p.handlers();
    const other = await seedOf(OTHER_PHRASE);
    // The user presses Restore: the scan's first batch hangs at the mint.
    s.t.hold(isRestore);
    const restore = observe(p.seeded!.restoreFromSeed(other, [MINT]));
    const batch = await s.t.next();
    s.t.hold(null);
    // A paid video plays on at the same mint: its PAY arrives while the restore holds the mint.
    const asked = s.clock.now;
    const pay = observe(h['pay.build']!(build()));
    await settleIo();
    expect(pay.done).toBe(true); // at once — not queued behind the scan
    expect(pay.error).toMatchObject({
      code: 'rate-limited',
      message: `rate-limited: ${HOLD_AT_MINT}`,
    });
    // The worker gives up on that PAY; only then does the scan end.
    s.clock.now += WORKER_HOST_REQUEST_TIMEOUT_MS;
    batch.release();
    await settleIo();
    await settleIo();
    expect(restore.done).toBe(true);
    const late = s.t.reached.filter(
      (r) => isSwap(r.path) && r.at >= asked + WORKER_HOST_REQUEST_TIMEOUT_MS,
    );
    expect(late).toEqual([]); // the reproduction built its 2 locked proofs here
    expect(await p.wallet.balance(MINT)).toBe(200);
    // The mark cleared with the scan: the next PAY is built.
    const msg = await h['pay.build']!(build(12));
    expect(msg.seederProofs.proofs.reduce((n, x) => n + x.amount, 0)).toBe(2);
    other.wipe();
  });

  it('the startup restore of this device’s unpublished range holds the mint too — and brings back ecash a crash cut off before NIP-60', async () => {
    const s = await setup();
    const counters = new mocks.MemoryCounterStore();
    // Device run 1: its relays drop the wallet's token events (the outbox never drains), so the
    // top-up's proofs live only in this process — then it "crashes" (the plane is closed).
    const lossy = new nostr.FakeRelayPool({
      rejectPublish: (e) =>
        e.kind === NostrKind.WalletToken ||
        e.kind === NostrKind.WalletHistory ||
        e.kind === NostrKind.Deletion
          ? 'relay down'
          : null,
    });
    const run1 = await plane(s, { counters, pool: lossy });
    await fund(run1.plane, s.mint, 64);
    await run1.plane.startupRestore;
    run1.plane.close();
    await run1.plane.drained();
    // Run 2: the relays hold the wallet event but no token. The counters file says which
    // counters were handed out and not known published: they are scanned at the open.
    const kept = new nostr.FakeRelayPool();
    for (const e of lossy.events()) kept.store(e);
    s.t.hold(isRestore);
    const run2 = await plane(s, { counters, pool: kept, create: false });
    const batch = await s.t.next();
    s.t.hold(null);
    run2.plane.authorizeSession(SID, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    const pay = observe(run2.plane.handlers()['pay.build']!(build()));
    await settleIo();
    expect(pay.error).toMatchObject({
      code: 'rate-limited',
      message: `rate-limited: ${HOLD_AT_MINT}`,
    });
    batch.release();
    expect(await run2.plane.startupRestore).toEqual({ restoredMints: 1, unfinished: 0 });
    expect(await run2.plane.wallet.balance(MINT)).toBe(64);
  });
});

describe('W8a: the seeded PAY deadline', () => {
  it('the seeded belt: a PAY that waited behind another longer than 12.6 s is refused before the wallet (unseeded it had 105.6 s)', async () => {
    const s = await setup();
    const { plane: p } = await plane(s);
    await fund(p, s.mint, 200);
    await p.startupRestore;
    p.authorizeSession(SID, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    const h = p.handlers();
    s.t.hold(isSwap);
    const first = observe(h['pay.build']!(build()));
    const held = await s.t.next();
    s.t.hold(null);
    const second = observe(h['pay.build']!(build(12)));
    await settleIo();
    expect(second.done).toBe(false);
    s.clock.now += PAY_BUILD_SEEDED_START_BY_MS + 1;
    expect(PAY_BUILD_SEEDED_START_BY_MS + 1).toBeLessThan(PAY_BUILD_START_BY_MS);
    held.release();
    await settleIo();
    await settleIo();
    expect(first.done && first.error === undefined).toBe(true);
    expect(second.error).toMatchObject({
      code: 'rate-limited',
      message: `rate-limited: ${PAY_TOO_LATE}`,
    });
    expect(s.t.reached.filter((r) => isSwap(r.path))).toHaveLength(2); // the first PAY's sends
  });

  it('a PAY at a mint this plane has not loaded: loaded and probed before its turn, so the seeded belt admits it', async () => {
    const s = await setup();
    const pool = new nostr.FakeRelayPool();
    const a = await plane(s, { pool, phrase: null });
    await fund(a.plane, s.mint, 64);
    a.plane.close();
    await a.plane.drained();
    // A new plane (a signer swap, a reopen) whose counters file knows the mint's keyset and has
    // nothing unpublished (so its startup restore asks no mint): nothing loaded the mint yet.
    const k = s.mint.keysetId;
    const counters = new mocks.MemoryCounterStore({
      v: 1,
      next: { [k]: 50 },
      published: { [k]: 50 },
    });
    const { plane: b } = await plane(s, { counters, pool, create: false });
    expect(await b.startupRestore).toEqual({ restoredMints: 0, unfinished: 0 });
    b.authorizeSession(SID, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    const from = s.t.reached.length;
    const msg = await b.handlers()['pay.build']!(build());
    expect(msg.creatorProofs.proofs.reduce((n, x) => n + x.amount, 0)).toBe(2);
    const paths = s.t.reached.slice(from).map((r) => r.path);
    expect(paths).toContain('GET /v1/keysets');
    expect(paths.indexOf('GET /v1/keysets')).toBeLessThan(paths.indexOf('POST /v1/swap'));
    expect(await b.wallet.balance(MINT)).toBe(60);
  });

  it('a send whose turn at the mint comes after an operation the gate does not see (a redeem) — too late for what is left of the PAY — is refused there, nothing spent', async () => {
    const s = await setup();
    const { plane: p } = await plane(s, { phrase: null });
    await fund(p, s.mint, 200);
    p.authorizeSession(SID, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    const h = p.handlers();
    // A seeder's redeem holds the mint at core (its swap hangs): not a melt, not a hold.
    s.t.hold(isSwap);
    const redeem = observe(
      h['seller.redeem']!({ mint: MINT, proofs: s.mint.issue(8, { p2pk: p.p2pk }) }),
    );
    const held = await s.t.next();
    s.t.hold(null);
    const asked = s.clock.now;
    const pay = observe(h['pay.build']!(build()));
    await settleIo();
    expect(pay.done).toBe(false); // passed the gate; queued behind the redeem in core
    s.clock.now += sendStartByMs(0, true, false, 2) + 1;
    held.release();
    await settleIo();
    await settleIo();
    expect(redeem).toMatchObject({ done: true, value: { ok: true, sats: 8 } });
    expect(pay.error).toMatchObject({
      code: 'rate-limited',
      message: `rate-limited: ${PAY_TOO_LATE}`,
    });
    // Only the redeem's swap reached the mint; nothing of the PAY was built.
    expect(s.t.reached.filter((r) => isSwap(r.path))).toHaveLength(1);
    expect(s.t.reached.filter((r) => isSwap(r.path) && r.at > asked)).toHaveLength(1);
    expect(await p.wallet.balance(MINT)).toBe(208);
  });
});

describe('W8a: the wallet lifecycle at close', () => {
  it('the swap waits (bounded) for the wallet to drain; once it moved on, the watermark is never written — made when the wallet drained in time', async () => {
    const s = await setup();
    const counters = new mocks.MemoryCounterStore();
    const { plane: p } = await plane(s, { counters });
    await fund(p, s.mint, 64);
    await p.startupRestore;
    // A receive whose swap hangs at the mint holds the wallet open past the close.
    s.t.hold(isSwap);
    const running = observe(p.wallet.receive({ mint: MINT, proofs: s.mint.issue(8) }));
    const held = await s.t.next();
    s.t.hold(null);
    p.close();
    await p.drained(20); // the swap moves on after 20 ms
    const saves = counters.saved.length;
    held.release();
    await settleIo();
    await settleIo();
    expect(running.done).toBe(true);
    expect(counters.saved.length).toBe(saves); // no late write

    const s2 = await setup();
    const c2 = new mocks.MemoryCounterStore();
    const q = await plane(s2, { counters: c2 });
    await fund(q.plane, s2.mint, 64); // the watermark moved (written with the next lease, or here)
    await q.plane.startupRestore;
    const before = c2.saved.length;
    q.plane.close();
    await q.plane.drained();
    expect(c2.saved.length).toBe(before + 1);
  });
});

describe('W8a: the desktop counters file under core’s real NUT-13 code', () => {
  it('PAYs, a reopen with the same phrase and one with a rotated phrase — every lease saved to the file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nf-w8a-counters-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const s = await setup();
    const pubkey = await s.signer.getPublicKey();
    const counters = new FileCounterStore(root, pubkey);
    const pool = new nostr.FakeRelayPool();
    const a = await plane(s, { counters, pool });
    await fund(a.plane, s.mint, 100);
    await a.plane.startupRestore;
    a.plane.authorizeSession(SID, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    await a.plane.handlers()['pay.build']!(build());
    const first = await counters.load();
    const next1 = first?.next[s.mint.keysetId] ?? 0;
    expect(next1).toBeGreaterThan(0);
    a.plane.close();
    await a.plane.drained();

    const b = await plane(s, { counters, pool, create: false });
    await b.plane.startupRestore;
    b.plane.authorizeSession(SID, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    for (let i = 0; i < 12; i++) await b.plane.handlers()['pay.build']!(build(10 + 2 * (i % 20)));
    const second = await counters.load();
    expect(second?.next[s.mint.keysetId] ?? 0).toBeGreaterThan(next1);
    expect(await b.plane.wallet.balance(MINT)).toBe(100 - 4 * 13);
    b.plane.close();
    await b.plane.drained();

    // A rotated phrase over the same store object: the file is another phrase's — no state, a
    // probe from 0 — and the first save takes it over.
    const c = await plane(s, { counters, pool, create: false, phrase: OTHER_PHRASE });
    await c.plane.startupRestore;
    c.plane.authorizeSession(SID, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    await c.plane.handlers()['pay.build']!(build());
    const third = await counters.load();
    expect(Object.keys(third?.published ?? {}).filter((k) => k.startsWith('ff'))).toHaveLength(1);
    expect(third?.published).not.toEqual(second?.published);
    expect(await c.plane.wallet.balance(MINT)).toBe(100 - 4 * 14);
  });
});

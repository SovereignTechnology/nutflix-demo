/**
 * Issue #2 across the process boundaries: the whole host (`createHost`: the user's NIP-60 wallet
 * opened by the money plane on a FakeRelayPool with a real LocalSigner, two in-process TestMints
 * joined by simulated Lightning), renderer calls over the host's IPC (`play`, `wallet.history`),
 * and "main" answering the first-funding question the host posts as a `prompt` HostOut.
 *
 *   - a manifest naming a mint the user never listed: no top-up, no question, play `no-balance`;
 *   - a trusted mint with nothing in it: the host asks main (target, amount, source), tops up
 *     within the cap, and the play goes ahead; both sides are in the wallet history as "top-up";
 *   - declined: nothing moves, play `no-balance`, and the next play does not ask again;
 *   - two plays at once: one question, one top-up;
 *   - review finding 1: the user's own withdrawal that empties an allowed mint moves nothing (a
 *     balance event never starts a top-up); a PAY for the open session (the worker's `pay.build`
 *     into the money plane) that leaves the mint below its threshold does;
 *   - lane I2-paygate (ADR 0012 amendment): both melts the desktop runs — the user's withdrawal
 *     (the renderer's `wallet.melt`) and an auto top-up's funding melt — go through the money
 *     plane's PAY/melt gate: each waits for the PAY in flight at its mint, and PAYs there are
 *     refused (`rate-limited`, nothing spent) until it settles.
 */
import { getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import type { RequestFn } from '@cashu/cashu-ts';
import type {
  CashuP2pkPubkey,
  CoreKeyHex,
  HyperblobId,
  MintUrl,
  NostrPubkey,
  Sats,
  VideoManifest,
  WalletHistoryEntry,
} from '@sovit/core';
import { mocks, nostr, signer as signerMod, wallet as walletMod } from '@sovit/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isHostOut } from '../../ipc/guards.js';
import type { HostOut, PromptForm, ReplyMsg, SessionId } from '../../ipc/protocol.js';
import { IPC_V } from '../../ipc/protocol.js';
import { SignerIdentity } from '../identity.js';
import { memoryLogger } from '../log.js';
import { MoneyPlane } from '../money.js';
import { TOP_UP_LEDGER_FILE } from '../topup/ledger.js';
import { seedVideos } from './support/catalog.js';
import { coreTestKit } from './support/core-helpers.js';
import type { Rig } from './support/rig.js';
import type { FakeWorkerOptions } from './support/fake-worker.js';
import { RELAY_A, eventually, rig } from './support/rig.js';

const kit = await coreTestKit();

const TARGET = 'https://mint-target.topup-host.test' as MintUrl;
const SOURCE = 'https://mint-source.topup-host.test' as MintUrl;
const STRANGER = 'https://creator-mint.topup-host.test' as MintUrl;
const SECOND = 'https://mint-second.topup-host.test' as MintUrl;
/** Real curve points: the PAY locks proofs to them. */
const p2pkOf = (fill: number): CashuP2pkPubkey =>
  Buffer.from(getPubKeyFromPrivKey(new Uint8Array(32).fill(fill))).toString(
    'hex',
  ) as CashuP2pkPubkey;
const CREATOR_P2PK = p2pkOf(0x5a);
const SEEDER_P2PK = p2pkOf(0x5b);
const SEEDER = 'd5'.repeat(32) as NostrPubkey;

let r: Rig | undefined;
afterEach(async () => {
  await r?.close();
  r = undefined;
});

let nextId = 1;
async function invoke(rr: Rig, method: string, args: unknown[]): Promise<ReplyMsg> {
  const id = nextId++;
  rr.host.handle({ kind: 'call', wc: 5, msg: { v: IPC_V, id, method, args } });
  const out = await rr.until(
    (o): o is Extract<HostOut, { kind: 'reply' }> =>
      o.kind === 'reply' && o.wc === 5 && o.msg.id === id,
    `reply to ${method}`,
    20_000,
  );
  return out.msg;
}

interface World {
  readonly r: Rig;
  readonly asked: PromptForm[];
  readonly lightning: mocks.TestLightning;
  readonly stranger: mocks.TestMint;
  /** The top-up's source and target mints (round 4: a melt answered PENDING). */
  readonly source: mocks.TestMint;
  readonly target: mocks.TestMint;
  readonly trusted: VideoManifest;
  readonly foreign: VideoManifest;
  /** A video paid at two of the user's trusted mints. */
  readonly both: VideoManifest;
  /** A video paid at the top-up's source mint (never topped up: it is the source). */
  readonly atSource: VideoManifest;
  answer: boolean;
}

async function world(
  o: {
    readonly hooks?: object;
    readonly tickMs?: number;
    /** Wraps a mint's transport (lane I2-paygate: holding requests). */
    readonly wrap?: (mint: MintUrl, request: RequestFn) => RequestFn;
    readonly worker?: FakeWorkerOptions;
  } = {},
): Promise<World> {
  const lightning = new mocks.TestLightning();
  const target = new mocks.TestMint({
    url: TARGET,
    seed: new Uint8Array(32).fill(0x51),
    lightning,
  });
  const source = new mocks.TestMint({
    url: SOURCE,
    seed: new Uint8Array(32).fill(0x52),
    lightning,
    feeReserve: 2,
  });
  const stranger = new mocks.TestMint({ url: STRANGER, seed: new Uint8Array(32).fill(0x53) });
  const second = new mocks.TestMint({
    url: SECOND,
    seed: new Uint8Array(32).fill(0x54),
    lightning,
  });
  const byUrl: Record<string, mocks.TestMint> = {
    [SECOND]: second,
    [TARGET]: target,
    [SOURCE]: source,
    [STRANGER]: stranger,
  };
  const mintRequest = (m: MintUrl): RequestFn | undefined => {
    const request = byUrl[m]?.request;
    return request === undefined ? undefined : (o.wrap?.(m, request) ?? request);
  };
  // The user's NIP-60 wallet already exists on their relays (created in an earlier session).
  const { signer } = await signerMod.LocalSigner.create({
    passphrase: Buffer.from('auto top-up host test passphrase'),
    cost: signerMod.minimumCost(),
  });
  const pool = new nostr.FakeRelayPool();
  const first = await MoneyPlane.open({
    signer,
    pool,
    relays: () => [{ url: RELAY_A, read: true, write: true }],
    defaultMints: () => [TARGET, SOURCE],
    log: memoryLogger('warn'),
    mintRequest,
    createWallet: true,
    journalDir: null, // in memory: this only creates the NIP-60 wallet (merge of issues #2 and #8)
  });
  first.close();

  const asked: PromptForm[] = [];
  const w = { asked, lightning, stranger, source, target, answer: true } as unknown as World;
  let t = 1_800_000_000_000;
  const rr = await rig({
    pool,
    identity: new SignerIdentity(signer),
    mintRequest,
    ...(o.worker === undefined ? {} : { worker: o.worker }),
    topUp: {
      ...o.hooks,
      now: () => (t += o.tickMs ?? 1_000),
      sleep: () => Promise.resolve(),
      pollAttempts: 3,
    },
    onOut: (o, host) => {
      if (o.kind !== 'prompt') return;
      asked.push(o.form);
      // What main would do: the HostOut passed main's guard, the page answered.
      expect(isHostOut(o)).toBe(true);
      const confirm = w.answer;
      queueMicrotask(() => {
        host().handle({
          kind: 'prompt-answer',
          req: o.req,
          answer: { kind: 'top-up-first', confirm },
        });
      });
    },
  });
  await rr.ready();
  await rr.host.adapter.updateSettings({
    defaultMints: [TARGET, SOURCE, SECOND],
    autoTopUp: { belowSats: 1_000 as Sats, fromMint: SOURCE, amountSats: 2_000 as Sats },
  });
  // Fund the source mint (the user's own Lightning top-up there).
  const wallet = rr.host.adapter.wallet;
  const q = await wallet.mintQuote(SOURCE, 20_000 as Sats);
  source.payQuote(q.quoteId);
  await wallet.pollQuote(q);
  const base = mocks.VIDEOS[0]!;
  const fixture = {
    ...base,
    price: { ...base.price, satsPerBlock: 50 as Sats, creatorP2pk: CREATOR_P2PK },
  };
  const [trusted, foreign, both, atSource] = await seedVideos(kit, rr.pool, new kit.TestSigner(), [
    { ...fixture, price: { ...fixture.price, mints: [TARGET] } },
    {
      ...fixture,
      title: 'A creator-run mint',
      price: { ...fixture.price, mints: [STRANGER] },
    },
    {
      ...fixture,
      title: 'Two trusted mints',
      price: { ...fixture.price, mints: [TARGET, SECOND] },
    },
    {
      ...fixture,
      title: 'Paid at the source mint',
      price: { ...fixture.price, mints: [SOURCE] },
    },
  ]);
  return Object.assign(w, {
    r: rr,
    trusted: trusted!.video,
    foreign: foreign!.video,
    both: both!.video,
    atSource: atSource!.video,
  });
}

const balance = async (rr: Rig, mint: MintUrl): Promise<number> => {
  const res = await invoke(rr, 'wallet.balance', [mint]);
  if (!res.ok) throw new Error(res.error.message);
  return res.result as number;
};

describe('auto top-up through the host (issue #2)', () => {
  it('a manifest naming an unknown mint: no top-up, no question — play fails no-balance', async () => {
    const w = await world();
    r = w.r;
    const res = await invoke(w.r, 'play', [w.foreign.id]);
    expect(!res.ok && res.error.code).toBe('no-balance');
    expect(w.asked).toEqual([]);
    expect(w.lightning.paid).toEqual([]);
    expect(w.stranger.calls).toEqual([]);
    expect(w.r.worker().calls('play.open')).toEqual([]);
    expect(await balance(w.r, SOURCE)).toBe(20_000);
  }, 30_000);

  it('a trusted mint: main is asked once (target, amount, source), one top-up within the cap, the play goes ahead, history says "top-up" on both sides', async () => {
    const w = await world();
    r = w.r;
    const res = await invoke(w.r, 'play', [w.trusted.id]);
    expect(res.ok).toBe(true);
    expect(w.asked).toEqual([
      { kind: 'top-up-first', target: TARGET, source: SOURCE, amount: 2_000 },
    ]);
    expect(w.lightning.paid).toHaveLength(1);
    expect(await balance(w.r, TARGET)).toBe(2_000);
    expect(await balance(w.r, SOURCE)).toBe(18_000);
    expect(w.r.worker().calls('play.open')).toHaveLength(1);
    const h = await invoke(w.r, 'wallet.history', [{ limit: 10 }]);
    const entries = (h.ok ? h.result : []) as WalletHistoryEntry[];
    // The user's own funding of the source is a "top-up" too (core's mint memo); the auto top-up
    // adds exactly its two sides — nothing is logged twice.
    const top = entries.filter((e) => e.memo === 'top-up');
    expect(top.map((e) => [e.mint, e.direction, e.amount]).sort()).toEqual(
      [
        [SOURCE, 'in', 20_000],
        [TARGET, 'in', 2_000],
        [SOURCE, 'out', 2_000],
      ].sort(),
    );
    expect(entries).toHaveLength(3);
    // The log names no mint, invoice or quote.
    expect(JSON.stringify(w.r.log.lines)).not.toMatch(/topup-host\.test|lnbc/);
  }, 30_000);

  it('declined: nothing moves, play fails no-balance, the next play does not ask again', async () => {
    // A test hook smuggling its own "yes" (or wallet) through HostOptions.topUp is ignored.
    const w = await world({
      hooks: { askFirstFunding: () => Promise.resolve(true), settings: () => ({}) },
    });
    r = w.r;
    w.answer = false;
    const first = await invoke(w.r, 'play', [w.trusted.id]);
    expect(!first.ok && first.error.code).toBe('no-balance');
    const second = await invoke(w.r, 'play', [w.trusted.id]);
    expect(!second.ok && second.error.code).toBe('no-balance');
    expect(w.asked).toHaveLength(1);
    expect(w.lightning.paid).toEqual([]);
    expect(await balance(w.r, SOURCE)).toBe(20_000);
  }, 30_000);

  it('a video paid at two trusted mints, declined: ONE question for the play, not one per mint', async () => {
    // A clock that passes the minute between attempts at every read: the play itself must stop.
    const w = await world({ tickMs: 61_000 });
    r = w.r;
    w.answer = false;
    const res = await invoke(w.r, 'play', [w.both.id]);
    expect(!res.ok && res.error.code).toBe('no-balance');
    expect(w.asked).toEqual([
      { kind: 'top-up-first', target: TARGET, source: SOURCE, amount: 2_000 },
    ]);
    expect(w.lightning.paid).toEqual([]);
  }, 30_000);

  it('two plays at once: one question, one top-up, both plays go ahead', async () => {
    const w = await world();
    r = w.r;
    const [a, b] = await Promise.all([
      invoke(w.r, 'play', [w.trusted.id]),
      invoke(w.r, 'play', [w.trusted.id]),
    ]);
    expect([a.ok, b.ok]).toEqual([true, true]);
    expect(w.asked).toHaveLength(1);
    expect(w.lightning.paid).toHaveLength(1);
    expect(await balance(w.r, TARGET)).toBe(2_000);
  }, 30_000);
});

/** The user's own withdrawal from `mint` to a Lightning invoice (Wallet → Withdraw). */
async function withdraw(rr: Rig, mint: MintUrl, amount: number): Promise<void> {
  const wallet = rr.host.adapter.wallet;
  const invoice = await wallet.mintQuote(SECOND, amount as Sats);
  const q = await wallet.meltQuote(mint, invoice.bolt11);
  expect((await wallet.melt(q)).paid).toBe(true);
}

/** Whatever a balance event may have started has finished. */
async function settled(rr: Rig): Promise<void> {
  await new Promise((res) => setTimeout(res, 50));
  await rr.host.adapter.topUpInFlight();
}

describe('auto top-up follows payments, not balance events (issue #2, review finding 1)', () => {
  it('the user withdrawing an allowed trusted mint to zero: nothing moves', async () => {
    // A clock past the minute between attempts at every read: only the trigger can stop it.
    const w = await world({ tickMs: 61_000 });
    r = w.r;
    expect((await invoke(w.r, 'play', [w.trusted.id])).ok).toBe(true);
    expect(w.lightning.paid).toHaveLength(1); // TARGET allowed and topped up to 2 000
    await withdraw(w.r, TARGET, 2_000);
    await settled(w.r);
    expect(await balance(w.r, TARGET)).toBe(0);
    expect(w.lightning.paid).toHaveLength(2); // the withdrawal itself, nothing more
    expect(await balance(w.r, SOURCE)).toBe(18_000);
    expect(w.asked).toHaveLength(1);
  }, 30_000);

  it('a PAY for the open session leaves the mint below its threshold: topped up, unattended', async () => {
    const w = await world({ tickMs: 61_000 });
    r = w.r;
    expect((await invoke(w.r, 'play', [w.trusted.id])).ok).toBe(true);
    await withdraw(w.r, TARGET, 1_000); // 1 000 left: at the threshold, not below it
    await settled(w.r);
    expect(w.lightning.paid).toHaveLength(2);
    const open = w.r.worker().calls('play.open')[0] as {
      readonly sid: SessionId;
      readonly rendition: {
        readonly hyper: { readonly core: CoreKeyHex; readonly blob: HyperblobId };
      };
    };
    const { core, blob } = open.rendition.hyper;
    // The worker pays for two blocks at TARGET: 100 sats drawn, 900 left — below 1 000.
    await w.r.worker().request('pay.build', {
      sid: open.sid,
      range: { core, fromBlock: blob.blockOffset, toBlock: blob.blockOffset + 1 },
      seeder: { pubkey: SEEDER, p2pk: SEEDER_P2PK, mint: TARGET },
      policy: w.trusted.price,
      carryIn: 0,
    });
    await eventually(() => w.lightning.paid.length === 3, 'the auto top-up', 10_000);
    await w.r.host.adapter.topUpInFlight();
    expect(await balance(w.r, TARGET)).toBe(900 + 2_000);
    expect(await balance(w.r, SOURCE)).toBe(16_000);
    expect(w.asked).toHaveLength(1); // allowed at the play: no second question
  }, 30_000);
});

/** A request the holding transport keeps from its mint until the test lets it go. */
interface Held {
  release(): void;
}

/** Mint transports that hold the requests `hold` picks (mint, `METHOD /path`). */
function holding() {
  let pick: ((mint: MintUrl, path: string) => boolean) | null = null;
  const arrived: Held[] = [];
  const waiting: ((h: Held) => void)[] = [];
  const wrap =
    (mint: MintUrl, inner: RequestFn): RequestFn =>
    <T>(args: Parameters<RequestFn>[0]): Promise<T> => {
      const path = `${(args.method ?? 'GET').toUpperCase()} ${new URL(args.endpoint).pathname}`;
      if (pick?.(mint, path) !== true) return inner<T>(args);
      return new Promise<T>((resolve, reject) => {
        const h: Held = {
          release: () => {
            inner<T>(args).then(resolve, reject);
          },
        };
        const w = waiting.shift();
        if (w === undefined) arrived.push(h);
        else w(h);
      });
    };
  return {
    wrap,
    hold(p: ((mint: MintUrl, path: string) => boolean) | null): void {
      pick = p;
    },
    next(): Promise<Held> {
      const h = arrived.shift();
      return h !== undefined ? Promise.resolve(h) : new Promise((r) => waiting.push(r));
    },
  };
}

interface PlayOpen {
  readonly sid: SessionId;
  readonly rendition: {
    readonly hyper: { readonly core: CoreKeyHex; readonly blob: HyperblobId };
  };
}

/** The worker's `pay.build` for the last session opened, two blocks at `mint`. */
function payFor(w: World, video: VideoManifest, mint: MintUrl): Promise<unknown> {
  const opens = w.r.worker().calls('play.open') as PlayOpen[];
  const open = opens[opens.length - 1]!;
  const { core, blob } = open.rendition.hyper;
  return w.r.worker().request('pay.build', {
    sid: open.sid,
    range: { core, fromBlock: blob.blockOffset, toBlock: blob.blockOffset + 1 },
    seeder: { pubkey: SEEDER, p2pk: SEEDER_P2PK, mint },
    policy: video.price,
    carryIn: 0,
  });
}

describe('every desktop melt goes through the PAY/melt gate (lane I2-paygate, ADR 0012 amendment)', () => {
  it("the user's withdrawal (the renderer's wallet.melt) waits for the PAY in flight at its mint; PAYs there are refused until it settles", async () => {
    const t = holding();
    const w = await world({ wrap: t.wrap });
    r = w.r;
    expect((await invoke(w.r, 'play', [w.trusted.id])).ok).toBe(true); // TARGET: 2 000 sats
    const wallet = w.r.host.adapter.wallet;
    const invoice = await wallet.mintQuote(SECOND, 500 as Sats);
    const quoted = await invoke(w.r, 'wallet.meltQuote', [TARGET, invoice.bolt11]);
    expect(quoted.ok).toBe(true);
    const entered = vi.spyOn(wallet, 'melt'); // asked for (the gate's side)
    const started = vi.spyOn(walletMod.CashuWallet.prototype, 'melt'); // past the gate, in core
    try {
      t.hold((mint, path) => mint === TARGET && path === 'POST /v1/swap');
      const pay = payFor(w, w.trusted, TARGET);
      const held = await t.next(); // the PAY's first send is at the mint
      t.hold(null);
      const withdrawal = invoke(w.r, 'wallet.melt', [quoted.ok ? quoted.result : null]);
      await eventually(() => entered.mock.calls.length === 1, 'the withdrawal at the gate');
      await new Promise((res) => setTimeout(res, 30));
      expect(started).not.toHaveBeenCalled();
      await expect(payFor(w, w.trusted, TARGET)).rejects.toMatchObject({ code: 'rate-limited' });
      held.release();
      await expect(pay).resolves.toMatchObject({ seederProofs: { mint: TARGET } });
      const res = await withdrawal;
      expect(res.ok && (res.result as { paid: boolean }).paid).toBe(true);
      expect(started).toHaveBeenCalledTimes(1);
      expect(await balance(w.r, TARGET)).toBe(2_000 - 100 - 500);
    } finally {
      entered.mockRestore();
      started.mockRestore();
    }
  }, 30_000);

  it("an auto top-up's funding melt waits for the PAY in flight at the source mint; PAYs there are refused until it settles", async () => {
    const t = holding();
    const w = await world({ wrap: t.wrap });
    r = w.r;
    // A video paid at SOURCE: the source is never topped up, nothing is asked.
    expect((await invoke(w.r, 'play', [w.atSource.id])).ok).toBe(true);
    expect(w.asked).toEqual([]);
    const wallet = w.r.host.adapter.wallet;
    const entered = vi.spyOn(wallet, 'melt');
    const started = vi.spyOn(walletMod.CashuWallet.prototype, 'melt');
    try {
      t.hold((mint, path) => mint === SOURCE && path === 'POST /v1/swap');
      const pay = payFor(w, w.atSource, SOURCE);
      const held = await t.next();
      t.hold(null);
      // A play at TARGET (empty) starts the top-up TARGET ← SOURCE: its melt is at SOURCE.
      const play = invoke(w.r, 'play', [w.trusted.id]);
      await eventually(
        () => entered.mock.calls.length === 1,
        'the top-up melt at the gate',
        10_000,
      );
      await new Promise((res) => setTimeout(res, 30));
      expect(started).not.toHaveBeenCalled();
      expect(w.lightning.paid).toEqual([]);
      await expect(payFor(w, w.atSource, SOURCE)).rejects.toMatchObject({ code: 'rate-limited' });
      held.release();
      await expect(pay).resolves.toMatchObject({ seederProofs: { mint: SOURCE } });
      expect((await play).ok).toBe(true);
      expect(started).toHaveBeenCalledTimes(1);
      expect(w.lightning.paid).toHaveLength(1);
      expect(await balance(w.r, TARGET)).toBe(2_000);
    } finally {
      entered.mockRestore();
      started.mockRestore();
    }
  }, 30_000);
});

describe('cross-lane review round 4 through the whole host', () => {
  it('a funding melt answered PENDING while the target already has the payment: its quote is kept sealed to the identity, the next play mints it once and goes ahead — no second melt', async () => {
    const w = await world();
    r = w.r;
    w.source.holdNextMelt(1, { lightning: 'now' });
    const first = await invoke(w.r, 'play', [w.trusted.id]);
    expect(!first.ok && first.error.code).toBe('no-balance');
    expect(w.lightning.paid).toHaveLength(1);
    // Kept on the ledger entry, sealed (NIP-44 to self through the signer): no invoice in the clear.
    const file = await readFile(join(w.r.userData, TOP_UP_LEDGER_FILE), 'utf8');
    const saved = JSON.parse(file) as {
      entries: { state: string; owner?: string; open?: string }[];
    };
    expect(saved.entries).toMatchObject([{ state: 'unknown' }]);
    expect(saved.entries[0]?.owner).toMatch(/^[0-9a-f]{64}$/);
    expect(saved.entries[0]?.open).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(file).not.toMatch(/lnbc/);
    expect(Buffer.from(saved.entries[0]?.open ?? '', 'base64').toString('latin1')).not.toMatch(
      /lnbc|quoteId/,
    );

    const second = await invoke(w.r, 'play', [w.trusted.id]);
    expect(second.ok).toBe(true);
    expect(await balance(w.r, TARGET)).toBe(2_000);
    expect(w.lightning.paid).toHaveLength(1); // never paid twice
    expect(w.asked).toHaveLength(1);
    expect(JSON.stringify(w.r.log.lines)).not.toMatch(/topup-host\.test|lnbc/);
  }, 30_000);

  it('a play at zero balance waits for a slow top-up only playWaitMs past the question: no-balance at once, the top-up finishes in the background, the next play goes ahead', async () => {
    const t = holding();
    const w = await world({ wrap: t.wrap, hooks: { playWaitMs: 50 } });
    r = w.r;
    t.hold((mint, path) => mint === SOURCE && path === 'POST /v1/melt/bolt11');
    const started = Date.now();
    const first = await invoke(w.r, 'play', [w.trusted.id]);
    expect(!first.ok && first.error.code).toBe('no-balance');
    expect(!first.ok && first.error.message).toMatch(/a top-up is on its way/);
    expect(Date.now() - started).toBeLessThan(10_000);
    const melt = await t.next(); // the Lightning payment still in flight
    t.hold(null);
    melt.release();
    await vi.waitFor(
      async () => {
        expect(await balance(w.r, TARGET)).toBe(2_000); // minted in the background
      },
      { timeout: 10_000 },
    );
    expect((await invoke(w.r, 'play', [w.trusted.id])).ok).toBe(true);
    expect(w.lightning.paid).toHaveLength(1);
  }, 30_000);

  // Lane R6-reconcile (the round-5 verifier): the adapter asked `checkForPlay` once PER MINT, each
  // with a whole `playWaitMs` of its own, so a video at two trusted mints could wait twice the
  // bound. One call for the play now: here the first mint's run takes 60 % of the bound and ends
  // not due (the settings changed meanwhile), and the second mint's run gets only the rest.
  it('a video at two trusted mints waits one playWaitMs in all, not one per mint', async () => {
    const W = 3_000;
    const t = holding();
    // A clock that passes the minute between attempts at every read (the second mint's run is
    // not spaced out behind the first's).
    const w = await world({ wrap: t.wrap, tickMs: 61_000, hooks: { playWaitMs: W } });
    r = w.r;
    t.hold(
      (mint, path) => (mint === TARGET || mint === SECOND) && path === 'POST /v1/mint/quote/bolt11',
    );
    const reply = invoke(w.r, 'play', [w.both.id]);
    const first = await t.next(); // the first mint's run, at its quote
    const since = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 0.6 * W));
    await w.r.host.adapter.updateSettings({
      autoTopUp: { belowSats: 1_000 as Sats, fromMint: SOURCE, amountSats: 2_500 as Sats },
    });
    first.release(); // that run is no longer the one the settings want: it ends not due
    const second = await t.next(); // the second mint's run, at its quote: held
    const res = await reply;
    const took = performance.now() - since;
    expect(!res.ok && res.error.code).toBe('no-balance');
    expect(!res.ok && res.error.message).toMatch(/a top-up is on its way/);
    expect(took).toBeLessThan(1.3 * W); // not 0.6 W, then a whole bound for the second mint
    expect(w.asked.map((f) => (f as { target?: MintUrl }).target)).toEqual([TARGET, SECOND]);
    // The second mint's top-up finishes in the background.
    t.hold(null);
    second.release();
    await w.r.host.adapter.topUpInFlight();
    expect(await balance(w.r, SECOND)).toBe(2_500);
  }, 30_000);
});

// Fix round 4 (cross-lane review, HIGH): the host revoked a session before the worker heard
// `play.close`, so the PAY the worker builds for the session's tail while it closes was refused
// 'session-closed' — with the real money plane here, and the worker's side played by the fake.
describe('closing a session: the tail PAY the worker builds meanwhile is authorised (fix round 4)', () => {
  it('pay.build during play.close is paid; after play.close answered the session is revoked', async () => {
    const outcomes: string[] = [];
    const tailPay = async (fw: {
      calls(m: 'play.open'): unknown[];
      request(m: 'pay.build', a: never): Promise<unknown>;
    }): Promise<string> => {
      const open = fw.calls('play.open')[0] as {
        readonly sid: SessionId;
        readonly rendition: {
          readonly hyper: { readonly core: CoreKeyHex; readonly blob: HyperblobId };
        };
        readonly policy: VideoManifest['price'];
      };
      const { core, blob } = open.rendition.hyper;
      return fw
        .request('pay.build', {
          sid: open.sid,
          range: { core, fromBlock: blob.blockOffset, toBlock: blob.blockOffset },
          seeder: { pubkey: SEEDER, p2pk: SEEDER_P2PK, mint: TARGET },
          policy: open.policy,
          carryIn: 0,
        } as never)
        .then(
          () => 'paid',
          (e: unknown) => (e as { code?: string }).code ?? 'error',
        );
    };
    const w = await world({
      tickMs: 61_000,
      worker: {
        handlers: {
          // The worker pays the session's tail BEFORE it answers play.close.
          'play.close': async (_a, fw) => {
            outcomes.push(await tailPay(fw));
            return undefined;
          },
        },
      },
    });
    r = w.r;
    expect((await invoke(w.r, 'play', [w.trusted.id])).ok).toBe(true);
    const [session] = w.r.host.adapter.sessions.all();
    await session!.closeAsync();
    expect(outcomes).toEqual(['paid']);
    // Once play.close answered, nothing more is paid for that session.
    expect(await tailPay(w.r.worker() as never)).toBe('session-closed');
  }, 30_000);
});

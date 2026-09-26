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
 *     into the money plane) that leaves the mint below its threshold does.
 */
import { getPubKeyFromPrivKey } from '@cashu/cashu-ts';
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
import { mocks, nostr, signer as signerMod } from '@sovit/core';
import { afterEach, describe, expect, it } from 'vitest';

import { isHostOut } from '../../ipc/guards.js';
import type { HostOut, PromptForm, ReplyMsg, SessionId } from '../../ipc/protocol.js';
import { IPC_V } from '../../ipc/protocol.js';
import { SignerIdentity } from '../identity.js';
import { memoryLogger } from '../log.js';
import { MoneyPlane } from '../money.js';
import { seedVideos } from './support/catalog.js';
import { coreTestKit } from './support/core-helpers.js';
import type { Rig } from './support/rig.js';
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
  readonly trusted: VideoManifest;
  readonly foreign: VideoManifest;
  /** A video paid at two of the user's trusted mints. */
  readonly both: VideoManifest;
  answer: boolean;
}

async function world(
  o: { readonly hooks?: object; readonly tickMs?: number } = {},
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
  const mintRequest = (m: MintUrl) => byUrl[m]?.request;
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
  });
  first.close();

  const asked: PromptForm[] = [];
  const w = { asked, lightning, stranger, answer: true } as unknown as World;
  let t = 1_800_000_000_000;
  const rr = await rig({
    pool,
    identity: new SignerIdentity(signer),
    mintRequest,
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
  const [trusted, foreign, both] = await seedVideos(kit, rr.pool, new kit.TestSigner(), [
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
  ]);
  return Object.assign(w, {
    r: rr,
    trusted: trusted!.video,
    foreign: foreign!.video,
    both: both!.video,
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

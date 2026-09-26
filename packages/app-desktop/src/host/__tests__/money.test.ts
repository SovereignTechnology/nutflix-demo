/**
 * The host's money plane (ADR 0012) against the in-process TestMint, a FakeRelayPool and a real
 * LocalSigner (real NIP-44): the NIP-60 wallet opens (never created by accident), and every worker
 * request is AUTHORISED — a PAY only for a registered session's core, blob range, manifest terms
 * and budget; a HELLO signature only over a pay/1 challenge; seller hooks only at the wallet's own
 * mints; nutzaps only to creators seen in a manifest (the user's own share redeemed instead).
 */
import { getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import type {
  CashuP2pkPubkey,
  CoreKeyHex,
  HyperblobId,
  MintUrl,
  NostrEvent,
  NostrPubkey,
  PricePolicy,
  RelayUrl,
  Sats,
  Signer,
  UnixSeconds,
} from '@sovit/core';
import { NostrKind, mocks, nostr, payProtocol, payment, signer as signerMod } from '@sovit/core';
import { describe, expect, it } from 'vitest';

import type { SessionId } from '../../ipc/protocol.js';
import { memoryLogger } from '../log.js';
import { MoneyPlane, sessionBudgetBlocks } from '../money.js';

const MINT = 'https://mint.money.test' as MintUrl;
const OTHER_MINT = 'https://mint-other.money.test' as MintUrl;
const RELAY = 'wss://relay.money.test' as RelayUrl;
const CORE = 'c0'.repeat(32) as CoreKeyHex;
const SID = 'ab'.repeat(16) as SessionId;
const BLOB: HyperblobId = { blockOffset: 10, blockLength: 4, byteOffset: 0, byteLength: 4096 };
const CREATOR_SK = new Uint8Array(32).fill(0x21);
const CREATOR_P2PK = Buffer.from(getPubKeyFromPrivKey(CREATOR_SK)).toString(
  'hex',
) as CashuP2pkPubkey;
const CREATOR = 'c1'.repeat(32) as NostrPubkey;
const SEEDER_SK = new Uint8Array(32).fill(0x22);
const SEEDER_P2PK = Buffer.from(getPubKeyFromPrivKey(SEEDER_SK)).toString('hex') as CashuP2pkPubkey;
const SEEDER = 'd1'.repeat(32) as NostrPubkey;

const POLICY: PricePolicy = {
  satsPerBlock: 2 as Sats,
  blockSize: 1024,
  mints: [MINT],
  split: { seeder: 50, creator: 50 },
  creatorP2pk: CREATOR_P2PK,
};

async function rig(
  o: {
    fund?: number;
    pool?: nostr.FakeRelayPool;
    onPayment?: (mint: MintUrl) => unknown;
  } = {},
) {
  const mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x61) });
  const pool = o.pool ?? new nostr.FakeRelayPool();
  const { signer } = await signerMod.LocalSigner.create({
    passphrase: Buffer.from('money plane test passphrase'),
    cost: signerMod.minimumCost(),
  });
  let t = 1_757_000_000;
  const plane = await MoneyPlane.open({
    signer,
    journalDir: null, // in memory: these tests are not about the journal
    pool,
    relays: () => [{ url: RELAY, read: true, write: true }],
    defaultMints: () => [MINT],
    log: memoryLogger('warn'),
    mintRequest: () => mint.request,
    createWallet: true,
    now: () => t++ as UnixSeconds,
    ...(o.onPayment === undefined ? {} : { onPayment: o.onPayment }),
  });
  if ((o.fund ?? 0) > 0) {
    const q = await plane.wallet.mintQuote(MINT, o.fund as Sats);
    mint.payQuote(q.quoteId);
    await plane.wallet.pollQuote(q);
  }
  return { mint, pool, signer, plane, h: plane.handlers() };
}

const build = (
  over: Partial<{ range: { core: CoreKeyHex; fromBlock: number; toBlock: number } }> & {
    policy?: PricePolicy;
    mint?: MintUrl;
    sid?: SessionId;
  } = {},
) => ({
  sid: over.sid ?? SID,
  range: over.range ?? { core: CORE, fromBlock: 10, toBlock: 11 },
  seeder: { pubkey: SEEDER, p2pk: SEEDER_P2PK, mint: over.mint ?? MINT },
  policy: over.policy ?? POLICY,
  carryIn: 0,
});

const code = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'resolved',
    (e: unknown) => String((e as { code?: unknown }).code),
  );

describe('MoneyPlane: the NIP-60 wallet', () => {
  it('opens with an explicit create; a restart reads the same key; nothing is created on a mere miss', async () => {
    const pool = new nostr.FakeRelayPool();
    const a = await rig({ pool });
    const info = pool.published.find((p) => p.event.kind === NostrKind.NutzapInfo);
    await new Promise((r) => setTimeout(r, 20)); // the 10019 is published best effort
    const info2 = info ?? pool.published.find((p) => p.event.kind === NostrKind.NutzapInfo);
    expect(nostr.parseNutzapInfo(info2!.event)).toMatchObject({
      pubkey: a.plane.pubkey,
      p2pk: a.plane.p2pk,
    });
    expect(a.plane.payments()).toEqual({
      pubkey: a.plane.pubkey,
      p2pk: a.plane.p2pk,
      mints: [MINT],
    });
    const again = await MoneyPlane.open({
      signer: a.signer,
      journalDir: null, // in memory: these tests are not about the journal
      pool,
      relays: () => [{ url: RELAY, read: true, write: true }],
      defaultMints: () => [MINT],
      log: memoryLogger('warn'),
    });
    expect(again.p2pk).toBe(a.plane.p2pk);
    // Another user, no wallet on the relays, no explicit create: refused, nothing published.
    const { signer: other } = await signerMod.LocalSigner.create({
      passphrase: Buffer.from('another user passphrase'),
      cost: signerMod.minimumCost(),
    });
    const before = pool.published.length;
    await expect(
      MoneyPlane.open({
        signer: other,
        journalDir: null, // in memory: these tests are not about the journal
        pool,
        relays: () => [{ url: RELAY, read: true, write: true }],
        defaultMints: () => [MINT],
        log: memoryLogger('warn'),
      }),
    ).rejects.toThrow(/no-wallet:/);
    expect(pool.published.length).toBe(before);
  });
});

describe('MoneyPlane: pay.build is authorised', () => {
  it('only for a registered session, its core, its blob range, its manifest terms and its budget', async () => {
    const { plane, h } = await rig({ fund: 200 });
    expect(await code(h['pay.build']!(build()))).toBe('session-closed');
    plane.authorizeSession(SID, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    const refused = async (b: ReturnType<typeof build>): Promise<string> =>
      code(h['pay.build']!(b));
    expect(
      await refused(
        build({ range: { core: 'd0'.repeat(32) as CoreKeyHex, fromBlock: 10, toBlock: 11 } }),
      ),
    ).toBe('forbidden');
    expect(await refused(build({ range: { core: CORE, fromBlock: 9, toBlock: 10 } }))).toBe(
      'forbidden',
    );
    expect(await refused(build({ range: { core: CORE, fromBlock: 12, toBlock: 14 } }))).toBe(
      'forbidden',
    );
    expect(await refused(build({ policy: { ...POLICY, creatorP2pk: SEEDER_P2PK } }))).toBe(
      'forbidden',
    );
    expect(await refused(build({ policy: { ...POLICY, satsPerBlock: 3 as Sats } }))).toBe(
      'forbidden',
    );
    expect(
      await refused(build({ policy: { ...POLICY, split: { seeder: 90, creator: 10 } } })),
    ).toBe('forbidden');
    expect(await refused(build({ mint: OTHER_MINT }))).toBe('forbidden');
    expect(await refused(build({ policy: { ...POLICY, mints: [MINT, OTHER_MINT] } }))).toBe(
      'forbidden',
    );

    // The honest PAY: verifies at a real seeder engine against the mint's keyset.
    const msg = await h['pay.build']!(build());
    const seeder = new payment.RealPaymentEngine({
      config: {
        windowBlocks: 16,
        acceptedMints: [MINT],
        ownP2pk: SEEDER_P2PK,
        ownPubkey: SEEDER,
        flushEveryBlocks: 64,
        flushEveryMs: 60_000,
      },
      seen: new payment.SeenSecrets(),
      keyset: (m, id) => plane.wallet.keyset(m, id),
    });
    for (let i = 10; i <= 11; i++)
      seeder.recordUpload(plane.pubkey, { core: CORE, fromBlock: i, toBlock: i }, POLICY);
    expect(await seeder.verify(plane.pubkey, msg, POLICY)).toEqual({
      ok: true,
      credited: 4,
      blocks: 2,
    });
    expect(await plane.wallet.balance(MINT)).toBeLessThan(200);
    // A lower asking price is fine (the payer may pay less than the manifest).
    await h['pay.build']!(
      build({
        policy: { ...POLICY, satsPerBlock: 1 as Sats },
        range: { core: CORE, fromBlock: 12, toBlock: 13 },
      }),
    );

    // The budget: twice the blob plus one window — then no more.
    expect(sessionBudgetBlocks(BLOB)).toBe(12);
    for (let i = 0; i < 4; i++)
      await h['pay.build']!(build({ range: { core: CORE, fromBlock: 10, toBlock: 11 } }));
    expect(await refused(build())).toBe('forbidden');
    // Revoked: nothing more for this session.
    plane.revokeSession(SID);
    expect(await refused(build())).toBe('session-closed');
  });

  it('no balance → no-balance, and the budget is not spent by the failed PAY', async () => {
    const { plane, h } = await rig();
    plane.authorizeSession(SID, { core: CORE, blob: BLOB, policy: POLICY });
    expect(await code(h['pay.build']!(build()))).toBe('no-balance');
    plane.close();
    expect(await code(h['pay.build']!(build()))).toBe('payments-unavailable');
  });
});

describe('MoneyPlane: the auto top-up trigger (issue #2, review finding 1)', () => {
  it('onPayment names the mint of every authorised PAY — paid or short — never of a refused one; a throw never breaks the PAY', async () => {
    const seen: MintUrl[] = [];
    const { plane, h } = await rig({ fund: 6, onPayment: (m) => seen.push(m) });
    // Refused before anything is drawn: no session, then terms that are not the video's.
    expect(await code(h['pay.build']!(build()))).toBe('session-closed');
    plane.authorizeSession(SID, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    expect(await code(h['pay.build']!(build({ mint: OTHER_MINT })))).toBe('forbidden');
    expect(seen).toEqual([]);
    // Paid (4 sats of 6), then short (2 left): both name the mint the PAY drew from.
    await h['pay.build']!(build());
    expect(seen).toEqual([MINT]);
    expect(
      await code(h['pay.build']!(build({ range: { core: CORE, fromBlock: 12, toBlock: 13 } }))),
    ).toBe('no-balance');
    expect(seen).toEqual([MINT, MINT]);
    // A hook that throws is swallowed: the PAY still answers.
    const boom = await rig({
      fund: 200,
      onPayment: () => {
        throw new Error('top-up check failed');
      },
    });
    boom.plane.authorizeSession(SID, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
    expect(await code(boom.h['pay.build']!(build()))).toBe('resolved');
    // Nor does an async hook that rejects: no unhandled rejection reaches the host process.
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const rejecting = await rig({
        fund: 200,
        onPayment: () => Promise.reject(new Error('top-up check failed')),
      });
      rejecting.plane.authorizeSession(SID, { core: CORE, blob: BLOB, policy: POLICY }, CREATOR);
      expect(await code(rejecting.h['pay.build']!(build()))).toBe('resolved');
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('liveWallet is the wallet while the plane is open, and nothing once it is closed', async () => {
    const { plane } = await rig();
    expect(plane.liveWallet).toBe(plane.wallet);
    plane.close();
    expect(plane.liveWallet).toBeUndefined();
  });
});

describe('MoneyPlane: pay.hello', () => {
  it('signs a HELLO the receiving end verifies for THIS connection — and only the challenge it is given', async () => {
    const { plane, h } = await rig();
    const hh = new Uint8Array(64).fill(3);
    const us = new Uint8Array(32).fill(4);
    const them = new Uint8Array(32).fill(5);
    const hostSigner: Pick<Signer, 'signEvent'> = {
      signEvent: async (t) => {
        const challenge = t.tags.find((x) => x[0] === 'challenge')?.[1] ?? '';
        const r = await h['pay.hello']!({ challenge });
        return {
          ...t,
          pubkey: r.pubkey,
          created_at: r.createdAt,
          sig: r.signature,
          id: '',
        } as unknown as NostrEvent;
      },
    };
    const hello = await payProtocol.buildHello(
      hostSigner,
      { handshakeHash: hh, localNoiseKey: us, remoteNoiseKey: them },
      {
        acceptedMints: [MINT],
        satsPerBlock: 2 as Sats,
        split: { seeder: 50, creator: 50 },
        p2pk: plane.p2pk,
        windowBlocks: 4,
      },
    );
    expect(hello.pubkey).toBe(plane.pubkey);
    // The peer's view of the same connection.
    expect(
      payProtocol.verifyHello(
        { type: 'HELLO', ...hello },
        { handshakeHash: hh, localNoiseKey: them, remoteNoiseKey: us },
      ),
    ).toEqual({ ok: true });
    // Replayed on another connection: refused.
    expect(
      payProtocol.verifyHello(
        { type: 'HELLO', ...hello },
        { handshakeHash: new Uint8Array(64).fill(8), localNoiseKey: them, remoteNoiseKey: us },
      ).ok,
    ).toBe(false);
  });
});

describe('MoneyPlane: seller hooks', () => {
  it('redeem takes proofs locked to the wallet key at its own mints; a replay reads as spent', async () => {
    const { mint, plane, h } = await rig();
    const proofs = mint.issue(8, { p2pk: plane.p2pk });
    expect(await h['seller.redeem']!({ mint: MINT, proofs })).toEqual({ ok: true, sats: 8 });
    expect(await h['seller.redeem']!({ mint: MINT, proofs })).toEqual({ ok: false, spent: true });
    expect(await h['seller.checkSpent']!({ mint: MINT, proofs })).toEqual(proofs.map(() => true));
    expect(await h['seller.spentByUs']!({ mint: MINT, proofs })).toBe(true);
    // Locked to someone else: not ours, not a double-spend.
    const theirs = mint.issue(4, { p2pk: SEEDER_P2PK });
    expect(await h['seller.redeem']!({ mint: MINT, proofs: theirs })).toEqual({
      ok: false,
      spent: false,
    });
    expect(await code(h['seller.redeem']!({ mint: OTHER_MINT, proofs }))).toBe('forbidden');
    expect(await h['seller.keyset']!({ mint: OTHER_MINT, id: mint.keysetId })).toBeNull();
    expect(await h['seller.keyset']!({ mint: MINT, id: mint.keysetId })).toMatchObject({
      id: mint.keysetId,
    });
  });

  it("nutzap: the user's own creator share is redeemed, a known creator gets a kind 9321, an unknown one is refused (retried)", async () => {
    const { mint, pool, plane, h } = await rig();
    const own = {
      mint: MINT,
      unit: 'sat' as const,
      lockedTo: plane.p2pk,
      proofs: mint.issue(4, { p2pk: plane.p2pk }),
    };
    await h['seller.nutzap']!({ set: own, core: CORE });
    expect(await plane.wallet.balance(MINT)).toBe(4);
    const toCreator = {
      mint: MINT,
      unit: 'sat' as const,
      lockedTo: CREATOR_P2PK,
      proofs: mint.issue(4, { p2pk: CREATOR_P2PK }),
    };
    expect(await code(h['seller.nutzap']!({ set: toCreator, core: CORE }))).toBe('not-found');
    plane.rememberCreator(CREATOR_P2PK, CREATOR);
    await h['seller.nutzap']!({ set: toCreator, core: CORE });
    const z = pool.published
      .filter((p) => p.event.kind === NostrKind.NutzapPayout)
      .map((p) => nostr.parseNutzap(p.event));
    expect(z).toHaveLength(1);
    expect(z[0]).toMatchObject({
      recipient: CREATOR,
      sender: plane.pubkey,
      claimedAmount: 4,
      mint: MINT,
    });
  });
});

/**
 * The host's money plane (ADR 0012): the one place in the desktop app that can spend.
 *
 *   wallet   `CashuWallet` over `Nip60ProofStore` (the user's NIP-60 wallet on their relays,
 *            NIP-44 to self through the signer), keyed by the NIP-60 wallet key (kind 17375, held
 *            by the signer or in secure memory). The user's kind 10019 is published so creators'
 *            shares can reach them. Its mints are reached through `mint-transport.ts`
 *            (`node:http(s)`, each request sent once: issue #8 fix round 2). Its journal (ADR 0014
 *            and its amendment, issue #8) is a sealed file per identity in `journalDir`
 *            (`wallet-journal.ts`): every operation's outputs are on disk before its request
 *            reaches the mint, and what a crash cut off is
 *            settled at the next open (`recoverPending`, NUT-09). While entries are left, the
 *            plane settles them by itself (`SettleLoop`): a send or melt whose answer is unknown
 *            holds its inputs out of the balance, and they come back (or leave) once the mint can
 *            say — with no restart and no other payment needed. A journal that does not open
 *            refuses the whole wallet — loudly, and the file is kept (it may be money).
 *   viewer   `RealPaymentEngine` (viewer side) building OUR PAYs.
 *   seller   the hooks the worker's seeder engine calls: keysets (rate-limited), redeem, NUT-07
 *            checks, nutzaps.
 *
 * The worker handles peer data, so everything it asks is treated as coming from a less-trusted
 * process (it is re-validated by the IPC guards before reaching here). What this module adds is
 * AUTHORISATION:
 *
 *   - `pay.build` pays only for an open play session the host itself registered
 *     (`authorizeSession`), only for that session's core and blob range, only on its manifest
 *     terms (creator key, split, block size, mints; a price at most the manifest's), and only up
 *     to a block budget of twice the blob (headroom for the duplicate deliveries of F33). A
 *     compromised worker cannot pay a stranger, pay for another video, or drain the wallet.
 *   - PAY builds and melts at one mint never overlap (`pay-melt-gate.ts`, ADR 0012 amendment
 *     2026-09-25): every melt of this wallet — the user's withdrawal, an auto top-up's funding
 *     melt — goes through the gate (`GatedCashuWallet.melt`), and a PAY is refused at once, with
 *     nothing spent, while a melt is pending or in flight at its mint. A PAY queued behind a melt
 *     could be built after the worker's deadline, its proofs lost. At its turn a PAY must still
 *     have time for its worst case — which grows with the journal entries left at its mint (each
 *     P2PK send settles every one first) and shrinks once the mint is loaded
 *     (`payBuildStartByMs`, cross-lane review round 4).
 *   - `pay.hello` signs a kind-HELLO event over a `pay/1` challenge and nothing else.
 *   - `seller.*` act only at the wallet's own mints; `redeem` only takes proofs locked to the
 *     wallet key (the wallet refuses others); a nutzap goes only to a creator the host has seen in
 *     a manifest, or — for the user's own videos — is redeemed straight into the wallet.
 */
import type {
  CashuP2pkPubkey,
  CoreKeyHex,
  HyperblobId,
  MeltQuote,
  MintKeyset,
  MintUrl,
  NostrEvent,
  NostrFilter,
  NostrPubkey,
  PayMessage,
  PricePolicy,
  RelayConfig,
  RelayUrl,
  Sats,
  Signer,
  UnixSeconds,
} from '@sovit/core';
import {
  DEFAULT_WINDOW_BLOCKS,
  PAY_HELLO_KIND,
  nostr,
  payment,
  wallet as walletMod,
} from '@sovit/core';

import { payBuildStartByMs } from '../ipc/deadlines.js';
import type { SessionId } from '../ipc/protocol.js';
import type { HostMethodTable, RedeemResult } from '../ipc/worker-protocol.js';
import { hostError } from './errors.js';
import type { Logger } from './log.js';
import { hostMintRequest } from './mint-transport.js';
import { PayMeltGate } from './pay-melt-gate.js';
import type { PlaneSeed } from './recovery/service.js';
import type { TopUpVault } from './topup/auto-topup.js';
import { openWalletJournal } from './wallet-journal.js';
import type { HostRequestHandlers } from './worker/supervisor.js';

type RequestFn = NonNullable<
  ConstructorParameters<typeof walletMod.CashuMintConnections>[0]
>['request'];

export interface MoneyPlaneOptions {
  /** The connected, unlocked signer. */
  readonly signer: Signer;
  readonly pool: nostr.PoolLike;
  readonly relays: () => readonly RelayConfig[];
  /** Settings' mints: a NEW wallet event lists them; the wallet also holds ecash there. */
  readonly defaultMints: () => readonly MintUrl[];
  readonly log: Logger;
  /**
   * Tests: the in-process `TestMint` transport. Default: `hostMintRequest()` (`mint-transport.ts`),
   * `node:http(s)` sending each request ONCE — never cashu-ts's own fetch transport, which retries
   * swaps and melts at a NUT-19 mint (issue #8, fix round 2). An injected transport must not retry
   * either: the wallet reads a coded answer as the mint's answer to its one request.
   */
  readonly mintRequest?: RequestFn;
  /**
   * Where the sealed wallet journal lives (`<userData>/wallet`, created 0700). Required, so no
   * caller loses durability by leaving it out: `null` (tests only) keeps the journal in memory,
   * where a crash loses an operation whose answer was lost.
   */
  readonly journalDir: string | null;
  /**
   * Make a NEW wallet key when the relays hold none — only for an explicit "create my wallet".
   * Default false: at startup a miss may just be unreachable relays, and creating then would
   * replace the user's real wallet event (kind 17375 is replaceable).
   */
  readonly createWallet?: boolean;
  readonly now?: () => UnixSeconds;
  /**
   * Issue #2: a PAY for an open play session drew (or, short, tried to draw) from `mint` — the
   * one trigger of an auto top-up outside a play opening. Called after the PAY's authorisation
   * passed and it reached the wallet, never for a refused one (by its terms, or by the PAY/melt
   * gate); not awaited — its result is ignored, and a throw or a rejected promise is swallowed.
   */
  readonly onPayment?: (mint: MintUrl) => unknown;
  /** Tests: the journal settle loop's timer (default `setTimeout`, unref'd). */
  readonly settleTimer?: walletMod.SettleTimer;
  /**
   * Tests: the PAY/melt gate's monotonic clock in ms (default `performance.now`) — when a PAY
   * request arrived and whether it may still reach the wallet (`PAY_BUILD_START_BY_MS`).
   */
  readonly clock?: () => number;
  /**
   * ADR 0016: this device's recovery phrase (`RecoveryService.seedFor`). With it, every mint
   * connection derives its outputs from the seed and draws NUT-13 counters from the counters
   * file, and `seeded` is the wallet's seeded view (reissue, restore). The plane owns the seed:
   * it is wiped when the plane closes (or fails to open).
   */
  readonly seed?: PlaneSeed;
}

/**
 * The money plane's wallet: core's `CashuWallet`, whose every melt goes through the plane's
 * PAY/melt gate — whoever holds the wallet (the renderer's `wallet.melt` through the adapter, the
 * auto top-up through `liveWallet`, a test) can only melt that way. `melt` is the one
 * `CashuWallet` method that pays an invoice (`pay-melt-gate.test.ts` pins that core adds no other
 * behind the gate's back).
 */
class GatedCashuWallet extends walletMod.CashuWallet {
  constructor(
    o: walletMod.CashuWalletOptions,
    private readonly gate: PayMeltGate,
  ) {
    super(o);
  }

  override melt(quote: MeltQuote): Promise<{ paid: boolean; preimage?: string; change: Sats }> {
    return this.gate.melt(quote.mint, () => super.melt(quote));
  }
}

interface SessionBudget {
  readonly core: CoreKeyHex;
  readonly first: number;
  readonly last: number;
  readonly policy: PricePolicy;
  readonly budgetBlocks: number;
  paidBlocks: number;
}

/** Blocks a session may pay for: the blob twice (duplicate deliveries, F33) plus one window. */
export function sessionBudgetBlocks(blob: HyperblobId): number {
  return 2 * blob.blockLength + DEFAULT_WINDOW_BLOCKS;
}

export class MoneyPlane {
  readonly wallet: walletMod.CashuWallet;
  readonly pubkey: NostrPubkey;
  readonly p2pk: CashuP2pkPubkey;
  readonly mints: readonly MintUrl[];
  /** How the wallet key is held (the UI must say which, build-plan §3). */
  readonly mode: 'signer' | 'memory';
  /** ADR 0016: the wallet's seeded view, when the plane opened with this device's phrase. */
  readonly seeded: walletMod.SeededWallet | undefined;
  /**
   * The startup settle of a journal a crash left entries in (ADR 0014 amendment): its counts, or
   * `null` when there was nothing to settle (or it failed; the next payment retries).
   */
  recovery: Promise<{ readonly recovered: number; readonly left: number } | null> =
    Promise.resolve(null);
  /**
   * Settles the journal whenever an entry can be decided (issue #8 review, finding 1): held
   * inputs come back after `PENDING_SETTLE_AFTER_S` even when nothing else runs at that mint.
   */
  readonly settles: walletMod.SettleLoop;
  private readonly sessions = new Map<SessionId, SessionBudget>();
  private readonly creators = new Map<string, NostrPubkey>();
  private readonly viewer: payment.RealPaymentEngine;
  /** PAY builds and melts at one mint never overlap (`pay-melt-gate.ts`). */
  private readonly gate: PayMeltGate;
  /** The wallet's store: its journal entries per mint (a PAY's belt, an open top-up's melt). */
  private readonly store: walletMod.Nip60ProofStore;
  /** The wallet's mint connections (a melt quote's state, read only). */
  private readonly conns: walletMod.CashuMintConnections;
  /** Mints whose wallet has loaded: a PAY there needs no load round trip (`payBuildWorstMs`). */
  private readonly loaded: ReadonlySet<MintUrl>;
  private readonly keyset: (mint: MintUrl, id: string) => Promise<MintKeyset | undefined>;
  private readonly now: () => UnixSeconds;
  private readonly closeKey: () => void;
  private readonly closeJournal: () => void;
  private readonly closeSeed: () => void;
  private closed = false;

  private constructor(
    private readonly o: MoneyPlaneOptions,
    parts: {
      readonly wallet: walletMod.CashuWallet;
      readonly gate: PayMeltGate;
      readonly store: walletMod.Nip60ProofStore;
      readonly conns: walletMod.CashuMintConnections;
      readonly loaded: ReadonlySet<MintUrl>;
      readonly pubkey: NostrPubkey;
      readonly nip60: walletMod.Nip60Wallet;
      readonly journal: walletMod.SealedJournal | undefined;
    },
  ) {
    this.wallet = parts.wallet;
    this.gate = parts.gate;
    this.store = parts.store;
    this.conns = parts.conns;
    this.loaded = parts.loaded;
    this.pubkey = parts.pubkey;
    this.p2pk = parts.nip60.p2pk;
    this.mints = [...new Set([...parts.nip60.mints, ...o.defaultMints()])];
    this.mode = parts.nip60.mode;
    this.closeKey = () => {
      parts.nip60.close();
    };
    this.closeJournal = () => {
      parts.journal?.close();
    };
    // ADR 0016: a seed the wallet did not take (core's option not recognised) is never a silent
    // "covered": logged, wiped at once, and the recovery status reads `unreadable`.
    const seeded = o.seed?.core.seeded(parts.wallet);
    if (o.seed !== undefined && seeded === undefined) {
      o.log.error('the wallet did not take the recovery phrase: new ecash is not covered');
      o.seed.material.seed.wipe();
    }
    this.seeded = seeded;
    this.closeSeed = () => {
      o.seed?.material.seed.wipe();
    };
    this.now = o.now ?? ((): UnixSeconds => Math.floor(Date.now() / 1000) as UnixSeconds);
    this.viewer = new payment.RealPaymentEngine({
      config: {
        windowBlocks: DEFAULT_WINDOW_BLOCKS,
        acceptedMints: [],
        ownP2pk: this.p2pk,
        ownPubkey: this.pubkey,
        flushEveryBlocks: 64,
        flushEveryMs: 60_000,
      },
      wallet: this.wallet,
      now: this.now,
    });
    this.keyset = walletMod.guardedKeyset((m, id) => this.wallet.keyset(m, id));
    this.settles = new walletMod.SettleLoop({
      wallet: this.wallet,
      now: this.now,
      ...(o.settleTimer === undefined ? {} : { timer: o.settleTimer }),
      onSettled: (r) => {
        if (r.recovered > 0)
          o.log.info('wallet journal settled', { recovered: r.recovered, left: r.left });
      },
    });
  }

  /** Open the user's NIP-60 wallet with `signer` and publish their kind 10019. */
  static async open(o: MoneyPlaneOptions): Promise<MoneyPlane> {
    const relays = nip60Relays(o.pool, o.relays);
    const pubkey = await o.signer.getPublicKey();
    const nip60 = await walletMod.openNip60Wallet({
      signer: o.signer,
      relays,
      defaultMints: o.defaultMints(),
      ...(o.createWallet === true ? { create: true } : {}),
      ...(o.now === undefined ? {} : { now: o.now }),
    });
    let journal: walletMod.SealedJournal | undefined;
    try {
      // Sealed to this identity; a file that does not open refuses the wallet (and is kept).
      if (o.journalDir !== null)
        journal = await openWalletJournal({ dir: o.journalDir, signer: o.signer, pubkey });
      const store = await walletMod.Nip60ProofStore.load({
        signer: o.signer,
        relays,
        ...(o.now === undefined ? {} : { now: o.now }),
        ...(journal === undefined ? {} : { journal }),
      });
      // One attempt per request (fix round 2): never cashu-ts's retrying fetch transport — not by
      // default, and not for a mint an injected (test) transport leaves out.
      const single = hostMintRequest();
      const gate = new PayMeltGate(o.clock === undefined ? {} : { clock: o.clock });
      const conns = new walletMod.CashuMintConnections({
        request: (mint) => o.mintRequest?.(mint) ?? single,
        // ADR 0016: with this device's phrase, every output derives from it and draws NUT-13
        // counters from the counters file (core's option, recovery/core.ts WIRING POINT).
        ...(o.seed === undefined ? {} : o.seed.core.seedOption(o.seed.material)),
      });
      // Which mints have loaded (cached by `conns` from then on): a PAY's belt counts no load
      // round trip for them. Recorded by wrapping `conns.wallet` on this instance, so the wallet
      // is handed the connections object itself (ADR 0016: a seeded wallet finds its seed there).
      const loaded = new Set<MintUrl>();
      const load = conns.wallet.bind(conns);
      conns.wallet = (mint) =>
        load(mint).then((w) => {
          loaded.add(mint);
          return w;
        });
      const wallet = new GatedCashuWallet(
        {
          mints: conns,
          store,
          key: nip60.key,
          configuredMints: [...new Set([...nip60.mints, ...o.defaultMints()])],
          ...(o.now === undefined ? {} : { now: o.now }),
        },
        gate,
      );
      const plane = new MoneyPlane(o, {
        wallet,
        gate,
        store,
        conns,
        loaded,
        pubkey,
        nip60,
        journal,
      });
      // What a crash cut off (a request sent, its answer never seen) is settled now: NUT-09
      // restores what the mint signed; every operation at a mint settles it first anyway.
      if ((journal?.initial.ops.length ?? 0) > 0)
        plane.recovery = wallet.recoverPending().then(
          (r) => {
            o.log.info('wallet journal settled after a restart', {
              recovered: r.recovered,
              left: r.left,
            });
            return r;
          },
          () => {
            o.log.warn('wallet journal not settled yet (it is retried at the next payment)');
            return null;
          },
        );
      // From then on, entries settle by themselves when the mint can decide them (after the
      // startup settle, so the two do not ask the mint twice).
      void plane.recovery.then(() => {
        plane.settles.start();
      });
      // Where the user takes nutzaps: creators' shares of their own videos (best effort).
      walletMod
        .publishNutzapInfo({
          signer: o.signer,
          relays,
          readRelays: readRelays(o.relays()),
          mints: plane.mints,
          p2pk: plane.p2pk,
          ...(o.now === undefined ? {} : { now: o.now }),
        })
        .catch(() => {
          o.log.warn('kind 10019 not published (relays unreachable)');
        });
      o.log.info('money plane open', { mode: plane.mode, mints: plane.mints.length });
      return plane;
    } catch (err) {
      nip60.close();
      journal?.close();
      o.seed?.material.seed.wipe();
      throw err;
    }
  }

  /** What the worker's init carries (public values only). */
  payments(): { pubkey: NostrPubkey; p2pk: CashuP2pkPubkey; mints: readonly MintUrl[] } {
    return { pubkey: this.pubkey, p2pk: this.p2pk, mints: this.mints };
  }

  /** Let the worker pay for `sid` — the session's core, blob range and manifest terms only. */
  authorizeSession(
    sid: SessionId,
    s: { readonly core: CoreKeyHex; readonly blob: HyperblobId; readonly policy: PricePolicy },
    creator?: NostrPubkey,
  ): void {
    this.sessions.set(sid, {
      core: s.core,
      first: s.blob.blockOffset,
      last: s.blob.blockOffset + s.blob.blockLength - 1,
      policy: s.policy,
      budgetBlocks: sessionBudgetBlocks(s.blob),
      paidBlocks: 0,
    });
    if (creator !== undefined) this.rememberCreator(s.policy.creatorP2pk, creator);
  }

  revokeSession(sid: SessionId): void {
    this.sessions.delete(sid);
  }

  /** A creator seen in a manifest: nutzaps for proofs locked to `p2pk` go to `pubkey`. */
  rememberCreator(p2pk: CashuP2pkPubkey, pubkey: NostrPubkey): void {
    if (this.creators.size >= 10_000) this.creators.clear();
    this.creators.set(p2pk.toLowerCase(), pubkey);
  }

  /** The worker's requests (`pay.*`, `seller.*`). */
  handlers(): Omit<HostRequestHandlers, 'studio.publish'> {
    return {
      'pay.build': (a) => this.payBuild(a),
      'pay.hello': (a) => this.payHello(a),
      'seller.keyset': (a) => this.sellerKeyset(a),
      'seller.redeem': (a) => this.sellerRedeem(a),
      'seller.checkSpent': (a) => {
        this.ownMint(a.mint);
        return this.wallet.checkSpent(a);
      },
      'seller.spentByUs': (a) => {
        this.ownMint(a.mint);
        return this.wallet.spentByUs(a);
      },
      'seller.nutzap': (a) => this.sellerNutzap(a),
    };
  }

  /**
   * The wallet while the plane still holds its key; `undefined` once `close` ran (signed out,
   * locked, another signer). Issue #2: what an auto top-up runs with, so one in flight stops
   * before its melt.
   */
  get liveWallet(): walletMod.CashuWallet | undefined {
    return this.closed ? undefined : this.wallet;
  }

  /**
   * What an auto top-up needs from this plane besides its wallet (cross-lane review round 4):
   * the identity; sealing to it — NIP-44 to self through the signer, how the NIP-60 proofs are
   * kept, for a target quote that is bearer money once paid unless the mint locked it; whether a
   * melt is still journaled; the mint's own state of a melt quote (a read); the startup settle.
   * Refused once the plane is closed (its signer is no longer the user's).
   */
  topUpVault(): TopUpVault {
    return {
      owner: this.pubkey,
      seal: async (plain) => {
        this.open();
        return await this.o.signer.nip44Encrypt(this.pubkey, plain);
      },
      unseal: async (sealed) => {
        this.open();
        return await this.o.signer.nip44Decrypt(this.pubkey, sealed);
      },
      meltPending: async (mint, quoteId) =>
        (await this.store.pending(mint)).some(
          (op) => op.kind === 'melt' && op.key.includes(quoteId),
        ),
      meltState: async (mint, quoteId) => {
        this.open();
        const state: unknown = (await (await this.conns.wallet(mint)).checkMeltQuoteBolt11(quoteId))
          .state;
        if (state !== 'UNPAID' && state !== 'PENDING' && state !== 'PAID')
          throw hostError('internal', 'the mint answered no melt quote state');
        return state;
      },
      recovery: () => this.recovery,
    };
  }

  /**
   * Wipe a wallet key held in memory and the journal key; later calls reject, and an operation
   * still in flight can journal nothing more (its entry, already on disk, is settled at the next
   * open).
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sessions.clear();
    this.settles.stop();
    this.closeKey();
    this.closeJournal();
    // The seam's contract: core refuses to derive from a wiped seed (never from zeros).
    this.closeSeed();
  }

  // ---- viewer ----------------------------------------------------------------------------

  private async payBuild(a: HostMethodTable['pay.build'][0]): Promise<PayMessage> {
    // The belt's clock starts when the request arrives (`PAY_BUILD_START_BY_MS`).
    const arrived = this.gate.now();
    this.open();
    const s = this.sessions.get(a.sid);
    if (s === undefined) throw hostError('session-closed', 'no open play session for this PAY');
    if (a.range.core !== s.core) throw hostError('forbidden', 'the PAY is for another video');
    if (a.range.fromBlock < s.first || a.range.toBlock > s.last)
      throw hostError('forbidden', 'the PAY covers blocks outside the video');
    const p = a.policy;
    const m = s.policy;
    if (
      p.creatorP2pk.toLowerCase() !== m.creatorP2pk.toLowerCase() ||
      p.split.seeder !== m.split.seeder ||
      p.split.creator !== m.split.creator ||
      p.blockSize !== m.blockSize ||
      p.satsPerBlock > m.satsPerBlock ||
      !p.mints.every((x) => m.mints.includes(x)) ||
      !m.mints.includes(a.seeder.mint)
    )
      throw hostError('forbidden', 'the PAY terms are not the video’s');
    const blocks = a.range.toBlock - a.range.fromBlock + 1;
    if (s.paidBlocks + blocks > s.budgetBlocks)
      throw hostError('forbidden', 'the session has paid for its whole budget');
    s.paidBlocks += blocks;
    try {
      // Refused at once (`rate-limited:`, nothing spent) while a melt is pending or in flight at
      // this mint, or once the PAY has waited too long for its turn there (the gate's rules):
      // how long depends on the journal entries left at the mint, read at its turn (round 4).
      const mint = a.seeder.mint;
      const startBy = async (): Promise<number> =>
        payBuildStartByMs((await this.store.pending(mint)).length, this.loaded.has(mint));
      return await this.gate.pay(
        mint,
        arrived,
        async () => {
          // The turn may have come after a sign-out or the session's end: spend nothing then.
          this.open();
          if (this.sessions.get(a.sid) !== s)
            throw hostError('session-closed', 'the play session closed before the PAY was built');
          try {
            return await this.viewer.pay(a.range, a.seeder, p, { carryIn: a.carryIn });
          } finally {
            // Issue #2: the mint the next PAY draws from (an auto top-up checks it; never awaited).
            this.paidAt(a.seeder.mint);
          }
        },
        startBy,
      );
    } catch (err) {
      s.paidBlocks -= blocks;
      if (err instanceof walletMod.WalletError && err.code === 'insufficient-funds')
        throw hostError('no-balance', 'not enough sats at this mint to keep streaming');
      throw err;
    }
  }

  private paidAt(mint: MintUrl): void {
    const hook = this.o.onPayment;
    if (hook === undefined) return;
    // A top-up check never breaks a payment: a throw — or an async hook's rejection, which a
    // `try` would not see (an async function passes for a `void` one) — is swallowed here.
    void Promise.resolve()
      .then(() => hook(mint))
      .catch(() => undefined);
  }

  private async payHello(
    a: HostMethodTable['pay.hello'][0],
  ): Promise<HostMethodTable['pay.hello'][1]> {
    this.open();
    const ev = await this.o.signer.signEvent({
      kind: PAY_HELLO_KIND,
      created_at: this.now(),
      tags: [['challenge', a.challenge]],
      content: '',
    });
    return { pubkey: ev.pubkey, createdAt: ev.created_at as UnixSeconds, signature: ev.sig };
  }

  // ---- seller ----------------------------------------------------------------------------

  private ownMint(mint: MintUrl): void {
    this.open();
    if (!this.mints.includes(mint)) throw hostError('forbidden', 'not a mint this wallet uses');
  }

  private async sellerKeyset(
    a: HostMethodTable['seller.keyset'][0],
  ): Promise<HostMethodTable['seller.keyset'][1]> {
    if (!this.mints.includes(a.mint)) return null;
    return (await this.keyset(a.mint, a.id)) ?? null;
  }

  private async sellerRedeem(a: HostMethodTable['seller.redeem'][0]): Promise<RedeemResult> {
    this.ownMint(a.mint);
    try {
      return { ok: true, sats: await this.wallet.receive(a) };
    } catch (err) {
      return {
        ok: false,
        spent: err instanceof walletMod.WalletError && err.code === 'spent',
      };
    }
  }

  private async sellerNutzap(a: HostMethodTable['seller.nutzap'][0]): Promise<undefined> {
    this.ownMint(a.set.mint);
    // The user's own video: the creator share is ours — redeem it rather than nutzap ourselves.
    if (a.set.lockedTo.toLowerCase() === this.p2pk.toLowerCase()) {
      await this.wallet.receive(a.set);
      return undefined;
    }
    const creator = this.creators.get(a.set.lockedTo.toLowerCase());
    if (creator === undefined)
      throw hostError('not-found', 'no creator known for this share yet (retried next flush)');
    await nostr.nutzapPublisher({
      signer: this.o.signer,
      pool: this.o.pool,
      relays: writeRelays(this.o.relays()),
      recipientFor: () => creator,
    })(a.set, { core: a.core });
    return undefined;
  }

  private open(): void {
    if (this.closed) throw hostError('payments-unavailable', 'the wallet is locked');
  }
}

function readRelays(r: readonly RelayConfig[]): RelayUrl[] {
  return r.filter((x) => x.read).map((x) => x.url);
}

function writeRelays(r: readonly RelayConfig[]): RelayUrl[] {
  return r.filter((x) => x.write).map((x) => x.url);
}

/** The NIP-60 store's relay port over the host's pool (write relays out, read relays in). */
function nip60Relays(
  pool: nostr.PoolLike,
  relays: () => readonly RelayConfig[],
): walletMod.Nip60Relays {
  return {
    publish: async (ev: NostrEvent) => {
      const res = await pool.publish(writeRelays(relays()), ev);
      if (!res.some((x) => x.ok))
        throw hostError('relay-down', 'no relay accepted the wallet event');
    },
    query: async (filter: NostrFilter) => {
      const raw = await pool.query(readRelays(relays()), filter, { maxWaitMs: 5000 });
      const out: NostrEvent[] = [];
      for (const r of raw) {
        const ev = nostr.verifyIncoming(r);
        if (ev !== null) out.push(ev);
      }
      return out;
    },
  };
}

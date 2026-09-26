/**
 * The host's money plane (ADR 0012): the one place in the desktop app that can spend.
 *
 *   wallet   `CashuWallet` over `Nip60ProofStore` (the user's NIP-60 wallet on their relays,
 *            NIP-44 to self through the signer), keyed by the NIP-60 wallet key (kind 17375, held
 *            by the signer or in secure memory). The user's kind 10019 is published so creators'
 *            shares can reach them.
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
 *   - `pay.hello` signs a kind-HELLO event over a `pay/1` challenge and nothing else.
 *   - `seller.*` act only at the wallet's own mints; `redeem` only takes proofs locked to the
 *     wallet key (the wallet refuses others); a nutzap goes only to a creator the host has seen in
 *     a manifest, or — for the user's own videos — is redeemed straight into the wallet.
 */
import type {
  CashuP2pkPubkey,
  CoreKeyHex,
  HyperblobId,
  MintKeyset,
  MintUrl,
  NostrEvent,
  NostrFilter,
  NostrPubkey,
  PayMessage,
  PricePolicy,
  RelayConfig,
  RelayUrl,
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

import type { SessionId } from '../ipc/protocol.js';
import type { HostMethodTable, RedeemResult } from '../ipc/worker-protocol.js';
import { hostError } from './errors.js';
import type { Logger } from './log.js';
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
  /** Tests: the in-process `TestMint` transport. Default: the global `fetch` (the host has JIT). */
  readonly mintRequest?: RequestFn;
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
   * passed, never for a refused one; not awaited — its result is ignored, and a throw or a
   * rejected promise is swallowed.
   */
  readonly onPayment?: (mint: MintUrl) => unknown;
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
  private readonly sessions = new Map<SessionId, SessionBudget>();
  private readonly creators = new Map<string, NostrPubkey>();
  private readonly viewer: payment.RealPaymentEngine;
  private readonly keyset: (mint: MintUrl, id: string) => Promise<MintKeyset | undefined>;
  private readonly now: () => UnixSeconds;
  private readonly closeKey: () => void;
  private closed = false;

  private constructor(
    private readonly o: MoneyPlaneOptions,
    parts: {
      readonly wallet: walletMod.CashuWallet;
      readonly pubkey: NostrPubkey;
      readonly nip60: walletMod.Nip60Wallet;
    },
  ) {
    this.wallet = parts.wallet;
    this.pubkey = parts.pubkey;
    this.p2pk = parts.nip60.p2pk;
    this.mints = [...new Set([...parts.nip60.mints, ...o.defaultMints()])];
    this.mode = parts.nip60.mode;
    this.closeKey = () => {
      parts.nip60.close();
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
    try {
      const store = await walletMod.Nip60ProofStore.load({
        signer: o.signer,
        relays,
        ...(o.now === undefined ? {} : { now: o.now }),
      });
      const wallet = new walletMod.CashuWallet({
        mints: new walletMod.CashuMintConnections(
          o.mintRequest === undefined ? {} : { request: o.mintRequest },
        ),
        store,
        key: nip60.key,
        configuredMints: [...new Set([...nip60.mints, ...o.defaultMints()])],
        ...(o.now === undefined ? {} : { now: o.now }),
      });
      const plane = new MoneyPlane(o, { wallet, pubkey, nip60 });
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

  /** Wipe a wallet key held in memory; later calls reject. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sessions.clear();
    this.closeKey();
  }

  // ---- viewer ----------------------------------------------------------------------------

  private async payBuild(a: HostMethodTable['pay.build'][0]): Promise<PayMessage> {
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
      return await this.viewer.pay(a.range, a.seeder, p, { carryIn: a.carryIn });
    } catch (err) {
      s.paidBlocks -= blocks;
      if (err instanceof walletMod.WalletError && err.code === 'insufficient-funds')
        throw hostError('no-balance', 'not enough sats at this mint to keep streaming');
      throw err;
    } finally {
      // Issue #2: the mint the next PAY draws from (an auto top-up checks it; never awaited).
      this.paidAt(a.seeder.mint);
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

/**
 * DevEngine — `MockPaymentEngine('honest')` with ONE rule re-expressed so that a peer that
 * received a NON-PREFIX set of blocks can be paid, and its mock secrets namespaced per
 * engine (`--dev-mocks` and the §5(a) rig only).
 *
 * The mock decides `range-not-uploaded` as `range.toBlock >= uploadedCount(peer, core)`: it
 * treats a block INDEX as a COUNT, i.e. it assumes every viewer downloads a core from one
 * seeder as a prefix `[0, n)`. That breaks the moment a viewer seeks, or fetches one blob
 * from two seeders (design §5(a): S2 serves `[16, 32)` — its 16 uploads make the PAY for
 * block 16 fail `16 >= 16`). The v4 contract cannot carry the index anyway:
 * `PaymentEngineSeeder.recordUpload(peer, blocks, core?)` has none (see
 * docs/contract-requests/L6-C.md). What the contract CAN express is the count rule:
 *
 *   a peer may pay, per core, for at most as many blocks as it was sent and has not yet paid
 *   for — and never for the same block twice.
 *
 * DevEngine enforces exactly that: replay (`range-already-paid`) on the REAL block indexes
 * here, and the count rule by handing the mock the next `blocks` ordinals of this peer's
 * paid-for sequence on this core (`[paid, paid + blocks − 1]`, so the mock's
 * `toBlock < uploaded` reads `paid + blocks ≤ uploaded`). Everything else — amounts, P2PK
 * targets, mints, DLEQ stand-ins, windows, bans, the swap batch, double-spend — is the
 * mock's own code, unchanged. Nothing here is crypto.
 */
import type {
  BanEntry,
  BlockRange,
  CashuP2pkPubkey,
  MintUrl,
  NostrPubkey,
  PayMessage,
  PaymentEngine,
  PaymentEngineConfig,
  PeerWindow,
  PricePolicy,
  Sats,
  VerifyResult,
} from '@sovit/core';
import { mocks } from '@sovit/core';

function overlaps(a: BlockRange, b: BlockRange): boolean {
  return a.fromBlock <= b.toBlock && b.fromBlock <= a.toBlock;
}

export class DevEngine implements PaymentEngine {
  readonly mock: mocks.MockPaymentEngine;
  /** `peer|core` → real ranges accepted. */
  private readonly paidRanges = new Map<string, BlockRange[]>();
  /** `peer|core` → blocks accepted (the ordinal the next PAY starts at). */
  private readonly paidCount = new Map<string, number>();

  /** Namespaces this engine's mock secrets (see `own`). */
  private readonly id: string;

  constructor(mock: mocks.MockPaymentEngine, id: string) {
    this.mock = mock;
    this.id = id;
  }

  get config(): PaymentEngineConfig {
    return this.mock.config;
  }

  // ---- viewer side: the mock's -------------------------------------------------------------

  async pay(
    range: BlockRange,
    seeder: {
      readonly pubkey: NostrPubkey;
      readonly p2pk: CashuP2pkPubkey;
      readonly mint: MintUrl;
    },
    policy: PricePolicy,
  ): Promise<PayMessage> {
    const msg = await this.mock.pay(range, seeder, policy);
    return {
      ...msg,
      seederProofs: this.own(msg.seederProofs),
      creatorProofs: this.own(msg.creatorProofs),
    };
  }

  /**
   * The mock mints secrets `mock:<counter>:<target>` from a per-INSTANCE counter, so two
   * in-process mock wallets paying the same seeder mint IDENTICAL secrets and the seeder's
   * swap batch reports a double-spend. Real secrets are random; namespacing by engine keeps
   * the mock's `mock:` authenticity prefix and its replay detection within one wallet.
   */
  private own(set: PayMessage['seederProofs']): PayMessage['seederProofs'] {
    return {
      ...set,
      proofs: set.proofs.map((p) => ({
        ...p,
        secret: p.secret.replace(/^mock:/, `mock:${this.id}.`),
      })),
    };
  }

  spent(): { readonly total: Sats; readonly perPeer: ReadonlyMap<NostrPubkey, Sats> } {
    return this.mock.spent();
  }

  // ---- seeder side --------------------------------------------------------------------------

  async verify(peer: NostrPubkey, msg: PayMessage, policy: PricePolicy): Promise<VerifyResult> {
    if (this.mock.isBanned(peer) || !mocks.isPayMessage(msg))
      return this.mock.verify(peer, msg, policy);
    const { range } = msg;
    const blocks = range.toBlock - range.fromBlock + 1;
    if (range.fromBlock < 0 || blocks < 1) return this.mock.verify(peer, msg, policy);
    const key = `${peer}|${range.core ?? ''}`;
    const accepted = this.paidRanges.get(key) ?? [];
    if (accepted.some((r) => overlaps(r, range)))
      return { ok: false, reason: 'range-already-paid' };
    const base = this.paidCount.get(key) ?? 0;
    const r = await this.mock.verify(
      peer,
      { ...msg, range: { ...range, fromBlock: base, toBlock: base + blocks - 1 } },
      policy,
    );
    if (r.ok) {
      this.paidRanges.set(key, [...accepted, { ...range }]);
      this.paidCount.set(key, base + blocks);
    }
    return r;
  }

  recordUpload(
    peer: NostrPubkey,
    blocks: number,
    core?: Parameters<PaymentEngine['recordUpload']>[2],
  ): PeerWindow {
    return this.mock.recordUpload(peer, blocks, core);
  }

  rebind(from: NostrPubkey, to: NostrPubkey): PeerWindow {
    if (from !== to) {
      for (const [key, ranges] of [...this.paidRanges]) {
        if (!key.startsWith(`${from}|`)) continue;
        const moved = `${to}|${key.slice(from.length + 1)}`;
        this.paidRanges.set(moved, [...(this.paidRanges.get(moved) ?? []), ...ranges]);
        this.paidCount.set(
          moved,
          (this.paidCount.get(moved) ?? 0) + (this.paidCount.get(key) ?? 0),
        );
        this.paidRanges.delete(key);
        this.paidCount.delete(key);
      }
    }
    return this.mock.rebind(from, to);
  }

  window(peer: NostrPubkey): PeerWindow | undefined {
    return this.mock.window(peer);
  }
  windows(): readonly PeerWindow[] {
    return this.mock.windows();
  }
  onWindowExceeded(cb: (w: PeerWindow) => void): () => void {
    return this.mock.onWindowExceeded(cb);
  }
  onDoubleSpend(
    cb: (peer: NostrPubkey, detail: { readonly mint: MintUrl; readonly amount: Sats }) => void,
  ): () => void {
    return this.mock.onDoubleSpend(cb);
  }
  flush(): Promise<{ readonly swapped: Sats; readonly nutzapped: Sats; readonly failed: number }> {
    return this.mock.flush();
  }
  ban(peer: NostrPubkey, reason: string, noiseKey?: Uint8Array): void {
    this.mock.ban(peer, reason, noiseKey);
  }
  unban(peer: NostrPubkey): void {
    this.mock.unban(peer);
  }
  isBanned(peer: NostrPubkey): boolean {
    return this.mock.isBanned(peer);
  }
  bans(): readonly BanEntry[] {
    return this.mock.bans();
  }
  /** Proofs accepted and not yet swapped (the mock's test hook). */
  pendingCount(): number {
    return this.mock.pendingCount();
  }
}

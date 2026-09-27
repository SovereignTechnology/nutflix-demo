/**
 * Payout: the seeder's earnings leave the server for the owner's own wallet (ADR 0011 §7). When
 * the balance at a mint reaches `thresholdSats`, the whole balance (less the swap fee) is sent
 * as P2PK proofs locked to the owner's wallet key and published as a NIP-61 nutzap to the owner's
 * pubkey, which their NIP-60/61 wallet picks up. The owner melts to Lightning from there.
 *
 * Why not melt on the server: no Lightning invoices or control socket on the daemon, the server
 * keeps only small balances, and what it paid out is locked to a key it does not hold — a later
 * compromise of the server cannot take it back.
 *
 * Durability: each payout's locked set is appended to `<dataDir>/wallet/payouts.jsonl` (0600,
 * fsynced) as soon as the mint returns it, BEFORE it is published; one not yet published (every
 * relay refused, or a crash) is published again on the next run. The proofs in it are locked to
 * the owner, so the file is safe at rest. Residual (ADR 0016 related finding 2): a crash between
 * the mint's swap and that append loses the payout. The sealed wallet file's journal (ADR 0014)
 * holds the swap's outputs — the locked set (`send`) and the change — before the request goes out,
 * and the startup settle (`recoverPending`) restores them from the mint (NUT-09), but only to
 * account for them: the change is kept, the restored locked set is never handed to
 * `payouts.jsonl`, so it is never published to the owner. NUT-13 would NOT fix this: it derives
 * no NUT-10/P2PK secrets, so it recovers the change, not the payout. The fix is to hand a
 * recovered payout set to `payouts.jsonl` from that settle.
 *
 * A payout is irreversible and goes to a key typed into a config file, so none leaves before the
 * owner's own kind 10019 (signed by `owner.pubkey`, fetched from the payout relays) confirms that
 * `owner.p2pk` is the key their wallet takes nutzaps at. A 10019 naming another key stops payouts
 * until restart; none found (no NIP-61 wallet, or relays down) keeps the money here and asks again
 * on the next run. A relay can withhold or serve a stale 10019 — both stop payouts, never misdirect.
 *
 * Nutzaps are public: a payout links this seeder's pubkey to the owner's and shows the amount. A
 * dedicated wallet pubkey keeps an owner's main identity out of it (deploy/systemd/README.md).
 */
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';

import { NostrKind, nostr as nostrMod, wallet as walletMod } from '@sovit/core';
import type {
  CashuP2pkPubkey,
  LockedProofSet,
  MintUrl,
  NostrPubkey,
  RelayUrl,
  Sats,
  Signer,
  UnixSeconds,
  nostr,
} from '@sovit/core';

import type { Logger } from '../log/logger.js';
import { assertPrivateSync, readTextIfExistsSync } from './files.js';

/** How far below the balance a payout steps to leave room for the swap fee. */
const MAX_FEE_STEPS = 64;

interface SentRecord {
  readonly t: 'sent';
  readonly id: string;
  readonly at: number;
  readonly set: LockedProofSet;
}
interface PublishedRecord {
  readonly t: 'published';
  readonly id: string;
  readonly at: number;
}

function isLockedSet(x: unknown): x is LockedProofSet {
  if (typeof x !== 'object' || x === null) return false;
  const s = x as { mint?: unknown; proofs?: unknown };
  return typeof s.mint === 'string' && Array.isArray(s.proofs) && s.proofs.length > 0;
}

export interface PayoutOptions {
  readonly wallet: Pick<walletMod.CashuWallet, 'balances' | 'send'>;
  readonly signer: Pick<Signer, 'signEvent'>;
  readonly pool: nostr.PoolLike;
  readonly owner: { readonly pubkey: NostrPubkey; readonly p2pk: CashuP2pkPubkey };
  readonly relays: readonly RelayUrl[];
  readonly thresholdSats: number;
  /** `<dataDir>/wallet/payouts.jsonl`. */
  readonly logPath: string;
  readonly logger: Logger;
  readonly now?: () => UnixSeconds;
}

/** What the owner's kind 10019 said about `owner.p2pk`. */
export type OwnerCheck = 'match' | 'mismatch' | 'unknown';

export interface PayoutResult {
  /** Payouts made this run (sats locked to the owner, per mint). */
  readonly paid: readonly { readonly mint: MintUrl; readonly amount: number }[];
  /** Earlier payouts published this run (their first publish had failed). */
  readonly republished: number;
  /** Payouts still waiting for a relay to accept them. */
  readonly unpublished: number;
  /** The owner check this run relied on; new payouts are made only on `match`. */
  readonly owner: OwnerCheck;
}

export class Payout {
  private running: Promise<PayoutResult> | null = null;
  /** `match` and `mismatch` are final for this process; `unknown` is asked again next run. */
  private ownerCheck: OwnerCheck = 'unknown';
  private readonly log: Logger;
  private readonly now: () => UnixSeconds;

  constructor(private readonly o: PayoutOptions) {
    if (!Number.isSafeInteger(o.thresholdSats) || o.thresholdSats < 1)
      throw new Error('payout: thresholdSats must be a positive integer');
    this.log = o.logger.child({ component: 'payout' });
    this.now = o.now ?? ((): UnixSeconds => Math.floor(Date.now() / 1000) as UnixSeconds);
    assertPrivateSync(o.logPath, 'the payout log');
  }

  /** One run at a time; a call while one runs gets that run's result. */
  run(): Promise<PayoutResult> {
    if (this.running !== null) return this.running;
    const r = this.runOnce().finally(() => {
      this.running = null;
    });
    this.running = r;
    return r;
  }

  /** Resolves when no run is in flight (shutdown waits for it before closing the relays). */
  async idle(): Promise<void> {
    await this.running?.catch(() => undefined);
  }

  /** Ask the owner's kind 10019 whether `owner.p2pk` is where their wallet takes nutzaps. */
  private async confirmOwner(): Promise<OwnerCheck> {
    if (this.ownerCheck !== 'unknown') return this.ownerCheck;
    let raws: readonly unknown[];
    try {
      raws = await this.o.pool.query(
        this.o.relays,
        { kinds: [NostrKind.NutzapInfo], authors: [this.o.owner.pubkey], limit: 5 },
        { maxWaitMs: 5000 },
      );
    } catch {
      raws = [];
    }
    let newest: nostrMod.NutzapInfo | null = null;
    for (const raw of raws) {
      const ev = nostrMod.verifyIncoming(raw);
      if (ev?.pubkey !== this.o.owner.pubkey) continue;
      const info = nostrMod.parseNutzapInfo(ev);
      if (info !== null && (newest === null || info.createdAt > newest.createdAt)) newest = info;
    }
    if (newest === null) {
      this.log.warn(
        'payout waits: the owner’s kind 10019 was not found on the payout relays, so payout.p2pk cannot be confirmed',
      );
      return 'unknown';
    }
    // Compare the x-only parts: a 10019 may give the key without its parity byte (NIP-61).
    const same = newest.p2pk.slice(2).toLowerCase() === this.o.owner.p2pk.slice(2).toLowerCase();
    this.ownerCheck = same ? 'match' : 'mismatch';
    if (same) this.log.info('payout.p2pk confirmed by the owner’s kind 10019');
    else
      this.log.error(
        'payouts stopped: payout.p2pk is not the key the owner’s kind 10019 names — fix the config and restart',
      );
    return this.ownerCheck;
  }

  private async runOnce(): Promise<PayoutResult> {
    let republished = 0;
    for (const rec of this.unpublished()) if (await this.publish(rec)) republished++;

    const paid: { mint: MintUrl; amount: number }[] = [];
    const owner = await this.confirmOwner();
    if (owner !== 'match')
      return { paid, republished, unpublished: this.unpublished().length, owner };
    let balances: ReadonlyMap<MintUrl, Sats>;
    try {
      balances = await this.o.wallet.balances();
    } catch (err) {
      this.log.warn('payout skipped: balances unavailable', { error: err });
      return { paid, republished, unpublished: this.unpublished().length, owner };
    }
    for (const [mint, balance] of balances) {
      if (balance < this.o.thresholdSats) continue;
      const set = await this.sendAll(mint, balance);
      if (set === null) continue;
      const rec: SentRecord = { t: 'sent', id: randomUUID(), at: this.now(), set };
      this.append(rec);
      const amount = set.proofs.reduce((a, p) => a + p.amount, 0);
      paid.push({ mint, amount });
      this.log.info('payout locked to the owner', { mint, sats: amount });
      await this.publish(rec);
    }
    return { paid, republished, unpublished: this.unpublished().length, owner };
  }

  /**
   * Send the whole balance less the swap fee: the fee depends on the inputs the wallet selects, so
   * step down from the balance until the wallet can cover amount + fee. An amount it cannot cover
   * fails locally (`insufficient-funds`) before any mint request.
   */
  private async sendAll(mint: MintUrl, balance: number): Promise<LockedProofSet | null> {
    for (let fee = 0; fee <= MAX_FEE_STEPS && balance - fee >= 1; fee++) {
      try {
        return await this.o.wallet.send((balance - fee) as Sats, {
          p2pk: this.o.owner.p2pk,
          mint,
          memo: 'payout to owner',
        });
      } catch (err) {
        if (err instanceof walletMod.WalletError && err.code === 'insufficient-funds') continue;
        this.log.error('payout failed', { mint, error: err });
        return null;
      }
    }
    this.log.warn('payout skipped: the balance does not cover the swap fee', { mint });
    return null;
  }

  private async publish(rec: SentRecord): Promise<boolean> {
    try {
      const ev = await this.o.signer.signEvent({
        kind: NostrKind.NutzapPayout,
        created_at: this.now(),
        content: '',
        tags: [
          ...rec.set.proofs.map((p) => [
            'proof',
            JSON.stringify({
              id: p.id,
              amount: p.amount,
              secret: p.secret,
              C: p.C,
              ...(p.dleq === undefined ? {} : { dleq: p.dleq }),
            }),
          ]),
          ['u', rec.set.mint],
          ['p', this.o.owner.pubkey],
        ],
      });
      const results = await this.o.pool.publish(this.o.relays, ev);
      if (!results.some((r) => r.ok)) throw new Error('no relay accepted the payout nutzap');
      this.append({ t: 'published', id: rec.id, at: this.now() });
      return true;
    } catch (err) {
      this.log.warn('payout not published yet (retried on the next run)', {
        mint: rec.set.mint,
        error: err,
      });
      return false;
    }
  }

  /** Durable append: one JSON line, fsynced before the payout moves on. */
  private append(rec: SentRecord | PublishedRecord): void {
    const fd = openSync(this.o.logPath, 'a', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(rec)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** Payouts in the log without a `published` record. */
  private unpublished(): SentRecord[] {
    const text = readTextIfExistsSync(this.o.logPath);
    if (text === null) return [];
    const sent = new Map<string, SentRecord>();
    for (const line of text.split('\n')) {
      if (line === '') continue;
      let r: unknown;
      try {
        r = JSON.parse(line);
      } catch {
        continue; // a torn last line
      }
      const rec = r as { t?: unknown; id?: unknown; set?: unknown } | null;
      if (rec?.t === 'sent' && typeof rec.id === 'string' && isLockedSet(rec.set))
        sent.set(rec.id, rec as SentRecord);
      else if (rec?.t === 'published' && typeof rec.id === 'string') sent.delete(rec.id);
    }
    return [...sent.values()];
  }
}

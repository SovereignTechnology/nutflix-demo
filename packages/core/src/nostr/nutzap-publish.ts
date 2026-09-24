/**
 * What a node publishes to Nostr for its payments, signed by its `Signer` (ADR 0011 §5):
 *
 *   - the creator's share of a flush as ONE NIP-61 nutzap (kind 9321) — `RealPaymentEngine`'s
 *     `nutzap` hook. The event names the creator (`p`), the mint (`u`), the video when known (`e`)
 *     and carries the proofs, P2PK-locked to the creator, so a relay or reader cannot spend them.
 *     It never names the viewers whose PAYs it forwards.
 *   - the node's own kind 10019: where it takes nutzaps (relays, mints, its P2PK key).
 *
 * Portable (no socket code): the caller passes a `PoolLike` (the seeder daemon a `ws`-backed pool,
 * the desktop host its own).
 */
import type {
  CashuP2pkPubkey,
  CashuProof,
  CoreKeyHex,
  LockedProofSet,
  MintUrl,
  NostrEvent,
  NostrEventId,
  NostrPubkey,
  RelayUrl,
  Signer,
  UnixSeconds,
} from '../contracts/index.js';
import { NostrKind } from '../contracts/index.js';
import type { PoolLike } from './types.js';

/** Publish, resolving with the relays that accepted; throws when none did. */
async function publishAny(
  pool: PoolLike,
  relays: readonly RelayUrl[],
  ev: NostrEvent,
  what: string,
): Promise<readonly RelayUrl[]> {
  const results = await pool.publish(relays, ev);
  const ok = results.filter((r) => r.ok).map((r) => r.url);
  if (ok.length === 0) throw new Error(`${what}: no relay accepted the event`);
  return ok;
}

/** A proof as NIP-61 carries it: the NUT-00 fields plus the DLEQ, never a witness. */
function proofTag(p: CashuProof): string[] {
  return [
    'proof',
    JSON.stringify({
      id: p.id,
      amount: p.amount,
      secret: p.secret,
      C: p.C,
      ...(p.dleq === undefined ? {} : { dleq: p.dleq }),
    }),
  ];
}

export interface NutzapPublisherOptions {
  readonly signer: Pick<Signer, 'signEvent'>;
  readonly pool: PoolLike;
  readonly relays: readonly RelayUrl[];
  /**
   * The Nostr pubkey whose clients look for nutzaps to `lockedTo`; `undefined` = a P2PK key this
   * node forwards nothing to (the publish fails and the engine keeps the PAYs queued).
   */
  readonly recipientFor: (lockedTo: CashuP2pkPubkey) => NostrPubkey | undefined;
  readonly videoEventFor?: (core: CoreKeyHex) => NostrEventId | undefined;
  readonly now?: () => UnixSeconds;
}

/** The engine's `nutzap` hook. Rejects unless at least one relay accepted the event. */
export function nutzapPublisher(
  o: NutzapPublisherOptions,
): (set: LockedProofSet, ctx: { readonly core: CoreKeyHex }) => Promise<void> {
  const now = o.now ?? ((): UnixSeconds => Math.floor(Date.now() / 1000) as UnixSeconds);
  return async (set, ctx) => {
    const recipient = o.recipientFor(set.lockedTo);
    if (recipient === undefined)
      throw new Error('nutzap: no creator pubkey is configured for this P2PK key');
    const video = o.videoEventFor?.(ctx.core);
    const ev = await o.signer.signEvent({
      kind: NostrKind.NutzapPayout,
      created_at: now(),
      content: '',
      tags: [
        ...set.proofs.map(proofTag),
        ['u', set.mint],
        ...(video === undefined ? [] : [['e', video]]),
        ['p', recipient],
      ],
    });
    await publishAny(o.pool, o.relays, ev, 'nutzap');
  };
}

/** Publish this node's kind 10019 (NIP-61): its relays, mints and P2PK key. */
export async function announceNutzapInfo(o: {
  readonly signer: Pick<Signer, 'signEvent'>;
  readonly pool: PoolLike;
  readonly relays: readonly RelayUrl[];
  readonly mints: readonly MintUrl[];
  readonly p2pk: CashuP2pkPubkey;
  readonly now?: () => UnixSeconds;
}): Promise<readonly RelayUrl[]> {
  const created = (o.now ?? ((): UnixSeconds => Math.floor(Date.now() / 1000) as UnixSeconds))();
  const ev = await o.signer.signEvent({
    kind: NostrKind.NutzapInfo,
    created_at: created,
    content: '',
    tags: [
      ...o.relays.map((r) => ['relay', r]),
      ...o.mints.map((m) => ['mint', m, 'sat']),
      ['pubkey', o.p2pk],
    ],
  });
  return publishAny(o.pool, o.relays, ev, 'kind 10019');
}

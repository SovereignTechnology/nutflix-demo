/**
 * Reactions with NIP-09 deletions (SE-5, contracts v4 `unreact`).
 *
 * `unreact` is a kind-5 deletion request referencing ONLY the viewer's own kind-7 ids on the
 * video — never a `-` reaction (dislikes are public; un-like must not register as one) and never
 * anyone else's ids. Counting honours deletions the NIP-09 way: a deletion hides a reaction only
 * when both were signed by the same pubkey (vendored NIP-09: "A client MUST validate that each
 * event pubkey referenced in the e tag of the deletion request is identical to the deletion
 * request pubkey"). Everything read here came through `NostrClient` (verifyIncoming).
 */
import type { NostrEventId, NostrPubkey, NostrTag, UnixSeconds } from '@sovit/core';
import { NostrKind, nostr } from '@sovit/core';

/** NIP-09 deletion request (not in core's `NostrKind`; contracts are frozen at v4). */
export const DELETION_KIND = 5 as const;

/** `#e` values per relay query — same chunk as L1's `countLikesByTarget`. */
const CHUNK = 100;

/**
 * The deletion request for `reactionIds` (all the viewer's own kind-7 events on one video).
 * Pure; the caller signs and publishes it. Refuses an empty list (nothing to withdraw).
 */
export function buildUnreactDeletion(
  reactionIds: readonly NostrEventId[],
  createdAt: UnixSeconds,
): nostr.EventDraft {
  if (reactionIds.length === 0) throw new RangeError('unreact: no reaction ids to delete');
  const tags: NostrTag[] = [...new Set(reactionIds)].map((id) => ['e', id]);
  tags.push(['k', String(NostrKind.Reaction)]);
  return { kind: DELETION_KIND, created_at: createdAt, tags, content: '' };
}

/** Every kind-7 event `viewer` signed whose target (NIP-25: the LAST `e` tag) is `videoId`. */
export async function ownReactionIds(
  client: nostr.NostrClient,
  viewer: NostrPubkey,
  videoId: NostrEventId,
): Promise<NostrEventId[]> {
  const events = await client.query({
    kinds: [NostrKind.Reaction],
    authors: [viewer],
    '#e': [videoId],
  });
  const ids: NostrEventId[] = [];
  for (const ev of events) {
    const r = nostr.parseReaction(ev);
    // The relay filtered on `authors`, but a relay is untrusted: check the signed pubkey.
    if (r?.target === videoId && r.author === viewer) ids.push(r.id);
  }
  return ids;
}

/** Ids among `reactions` that their own author asked to delete (NIP-09 pubkey rule). */
export async function deletedReactionIds(
  client: nostr.NostrClient,
  reactions: readonly nostr.ParsedReaction[],
): Promise<ReadonlySet<string>> {
  const deleted = new Set<string>();
  if (reactions.length === 0) return deleted;
  const byId = new Map(reactions.map((r) => [r.id as string, r]));
  const ids = [...byId.keys()];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const deletions = await client.query({
      kinds: [DELETION_KIND],
      '#e': ids.slice(i, i + CHUNK),
    });
    for (const d of deletions) {
      for (const id of nostr.tagValues(d, 'e')) {
        const r = byId.get(id);
        if (r?.author === d.pubkey) deleted.add(id);
      }
    }
  }
  return deleted;
}

/** L1's `fetchReactions`, minus reactions their authors deleted. */
export async function fetchReactionSummary(
  client: nostr.NostrClient,
  videoId: NostrEventId,
  viewer: NostrPubkey | null,
): Promise<nostr.ReactionSummary> {
  const events = await client.query({ kinds: [NostrKind.Reaction], '#e': [videoId] });
  const parsed = events.flatMap((ev) => {
    const r = nostr.parseReaction(ev);
    return r?.target === videoId ? [r] : [];
  });
  const deleted = await deletedReactionIds(client, parsed);
  const live = parsed.filter((r) => !deleted.has(r.id));
  return nostr.summarizeReactions(live, viewer ?? undefined);
}

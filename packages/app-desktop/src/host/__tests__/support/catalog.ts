/**
 * Test support (not a suite): real, signed NIP-71 copies of core's fixture videos in a
 * `FakeRelayPool`, so the adapter reads them through L1 exactly as it would from a relay.
 */
import type { NostrEvent, VideoManifest } from '@sovit/core';
import { manifest, mocks, nostr } from '@sovit/core';

import type { CoreTestKit, TestSignerLike } from './core-helpers.js';

export interface SeededVideo {
  readonly fixture: VideoManifest;
  readonly event: NostrEvent;
  /** What the adapter returns for it (parsed from the signed event). */
  readonly video: VideoManifest;
}

export async function seedVideos(
  kit: CoreTestKit,
  pool: nostr.FakeRelayPool,
  creator: TestSignerLike,
  fixtures: readonly VideoManifest[] = mocks.VIDEOS,
): Promise<SeededVideo[]> {
  const out: SeededVideo[] = [];
  for (const fixture of fixtures) {
    const event = await kit.signedVideo(creator, fixture);
    pool.store(event);
    const verified = nostr.verifyIncoming(event);
    if (verified === null) throw new Error('fixture did not verify');
    const parsed = manifest.parseVideoEvent(verified);
    if (!parsed.ok) throw new Error('fixture did not parse');
    out.push({ fixture, event, video: parsed.value });
  }
  return out;
}

/** A kind-7 reaction to `video` by `by`, stored in `pool`. */
export async function storeReaction(
  kit: CoreTestKit,
  pool: nostr.FakeRelayPool,
  by: TestSignerLike,
  video: VideoManifest,
  content: string,
  createdAt: number,
): Promise<NostrEvent> {
  const draft = nostr.buildReactionEvent(
    { id: video.id, pubkey: video.author, kind: video.kind },
    content,
    createdAt as never,
  );
  const ev = await kit.sign(by, draft);
  pool.store(ev);
  return ev;
}

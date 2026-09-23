/**
 * `--dev-fixtures` catalogue (design §5(a)). DEV ONLY and refused unless `--dev-mocks` is on
 * too (`host.ts`): it serves core's mock fixture manifests plus the LIVE manifests the worker
 * announces in its `dev.fixtures` event (cores it actually seeds on its dev network). None of
 * these are signed events — they bypass `verifyIncoming` by construction — so every use is
 * logged loudly, and nothing here is reachable in a production run.
 */
import type {
  FeedQuery,
  NostrEventId,
  NostrPubkey,
  Page,
  Profile,
  VideoManifest,
} from '@sovit/core';
import { mocks } from '@sovit/core';

import type { Logger } from '../log.js';
import type { CatalogSource, SearchQuery } from './catalog.js';
import { FEED_PAGE } from './catalog.js';

function paginate<T>(items: readonly T[], cursor: string | undefined, limit: number): Page<T> {
  const start = cursor !== undefined && /^\d{1,9}$/.test(cursor) ? Number(cursor) : 0;
  const slice = items.slice(start, start + limit);
  const end = start + slice.length;
  return end < items.length ? { items: slice, next: String(end) } : { items: slice };
}

export class FixtureCatalog implements CatalogSource {
  private readonly log: Logger;
  private live: readonly VideoManifest[] = [];
  private readonly liveIds = new Set<string>();

  constructor(log: Logger) {
    this.log = log.child('dev-fixtures');
    this.log.warn('DEV FIXTURES ON: serving UNSIGNED fixture manifests (never in production)');
  }

  /** The worker's `dev.fixtures` event: replaces the live set. */
  setLive(videos: readonly VideoManifest[]): void {
    this.live = videos;
    this.liveIds.clear();
    for (const v of videos) this.liveIds.add(v.id);
    this.log.warn('dev fixtures: live manifests from the worker (unsigned)', {
      count: videos.length,
    });
  }

  private all(): VideoManifest[] {
    const seen = new Set(this.liveIds);
    return [...this.live, ...mocks.VIDEOS.filter((v) => !seen.has(v.id))];
  }

  feed(q: FeedQuery, viewer: NostrPubkey | null): Promise<Page<VideoManifest>> {
    let items = this.all();
    switch (q.source) {
      case 'subscriptions':
        items = viewer === null ? [] : items.filter((v) => v.kind === 21);
        break;
      case 'trending':
        // Live (playable) first, then the mock fixtures in their own order.
        items = items.filter((v) => v.kind === 21);
        break;
      case 'tags':
        items = items.filter((v) => v.tags.some((t) => q.tags?.includes(t)));
        break;
      case 'author':
        items = items.filter((v) => v.author === q.author);
        break;
      case 'shorts':
        items = items.filter((v) => v.kind === 22);
        break;
    }
    return Promise.resolve(paginate(items, q.cursor, q.limit ?? FEED_PAGE));
  }

  video(id: NostrEventId): Promise<VideoManifest | null> {
    return Promise.resolve(this.all().find((v) => v.id === id) ?? null);
  }

  videos(ids: readonly NostrEventId[]): Promise<VideoManifest[]> {
    const byId = new Map(this.all().map((v) => [v.id as string, v]));
    return Promise.resolve(
      [...new Set(ids)].flatMap((id) => {
        const v = byId.get(id);
        return v ? [v] : [];
      }),
    );
  }

  related(id: NostrEventId, limit: number): Promise<readonly VideoManifest[]> {
    const all = this.all();
    const v = all.find((x) => x.id === id);
    if (!v) return Promise.resolve([]);
    const score = (o: VideoManifest): number =>
      (o.author === v.author ? 2 : 0) + o.tags.filter((t) => v.tags.includes(t)).length;
    return Promise.resolve(
      all
        .filter((o) => o.id !== id)
        .sort((a, b) => score(b) - score(a))
        .slice(0, limit),
    );
  }

  search(q: SearchQuery): Promise<Page<VideoManifest>> {
    const needle = q.text.trim().toLowerCase();
    const items =
      needle === ''
        ? []
        : this.all().filter(
            (v) => v.title.toLowerCase().includes(needle) || v.tags.some((t) => t.includes(needle)),
          );
    return Promise.resolve(paginate(items, q.cursor, FEED_PAGE));
  }

  profile(pubkey: NostrPubkey): Promise<Profile | null> {
    if (pubkey === mocks.ME) return Promise.resolve(mocks.MY_PROFILE);
    return Promise.resolve(mocks.CHANNELS.find((c) => c.pubkey === pubkey)?.profile ?? null);
  }

  /** Live fixtures are seeded by the worker's own dev network; mock fixtures by nobody. */
  seedersOnline(video: VideoManifest): Promise<number> {
    return Promise.resolve(this.liveIds.has(video.id) ? 1 : 0);
  }
}

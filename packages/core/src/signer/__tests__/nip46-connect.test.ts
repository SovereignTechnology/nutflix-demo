/**
 * The NIP-46 connector against a fake bunker over an in-memory relay (the real `BunkerSigner`
 * wire: kind 24133, NIP-44, `#p` routing). Covers `remember` / `resumeBunker` (ADR 0013: the
 * desktop seals `resume` in the OS keychain) and the setup deadline — nostr-tools waits for an
 * answer forever, and a bunker that revoked a client simply never answers it.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import * as nip44 from 'nostr-tools/nip44';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import type { Event as NostrToolsEvent } from 'nostr-tools/pure';

import type { NostrPubkey } from '../../contracts/index.js';
import { connectBunker, resumeBunker } from '../nip46-connect.js';

/**
 * `nostr-tools/pool`'s SimplePool, for the calls made WITHOUT a pool: routed to the test's
 * in-memory relay, recording `close()` (the connector must close a pool it made).
 */
const own = vi.hoisted(() => ({
  shared: undefined as
    undefined | { subscribe: (...a: never[]) => unknown; publish: (...a: never[]) => unknown },
  closed: [] as string[][],
}));
vi.mock('nostr-tools/pool', () => ({
  SimplePool: class {
    subscribe(...a: never[]): unknown {
      return own.shared?.subscribe(...a);
    }
    publish(...a: never[]): unknown {
      return own.shared?.publish(...a);
    }
    close(relays: string[]): void {
      own.closed.push(relays);
    }
  },
}));
import { Nip46Signer } from '../remote.js';

const NOSTR_CONNECT = 24133;
const RELAY = 'wss://relay.example';

interface Filter {
  kinds?: number[];
  authors?: string[];
  '#p'?: string[];
}
interface Handlers {
  onevent: (e: NostrToolsEvent) => void;
}

/** Just the two pool calls `BunkerSigner` makes, routed in memory. */
class MemoryPool {
  private readonly subs = new Set<{ filter: Filter; h: Handlers }>();
  subscribe(_relays: string[], filter: Filter, h: Handlers): { close: () => void } {
    const sub = { filter, h };
    this.subs.add(sub);
    return {
      close: () => {
        this.subs.delete(sub);
      },
    };
  }
  publish(_relays: string[], ev: NostrToolsEvent): Promise<string>[] {
    for (const { filter, h } of [...this.subs]) {
      if (filter.kinds && !filter.kinds.includes(ev.kind)) continue;
      if (filter.authors && !filter.authors.includes(ev.pubkey)) continue;
      const p = ev.tags.find((t) => t[0] === 'p')?.[1];
      if (filter['#p'] && (p === undefined || !filter['#p'].includes(p))) continue;
      queueMicrotask(() => {
        h.onevent(ev);
      });
    }
    return [Promise.resolve('ok')];
  }
  asPool(): AbstractSimplePool {
    return this as unknown as AbstractSimplePool;
  }
}

/** A remote signer holding the user's key: answers only clients that connected with its secret. */
class FakeBunker {
  readonly sk = generateSecretKey();
  readonly pk = getPublicKey(this.sk) as NostrPubkey;
  readonly authorized = new Set<string>();
  readonly seen: string[] = [];
  /** Answer the first get_public_key with an `auth_url` challenge first (NIP-46 auth flow). */
  authUrl: string | undefined;
  /** …and the real answer only after this long (the user approving on the web page). */
  approveAfterMs = 0;
  constructor(
    private readonly pool: MemoryPool,
    private readonly secret: string,
  ) {
    pool.subscribe(
      [RELAY],
      { kinds: [NOSTR_CONNECT], '#p': [this.pk] },
      {
        onevent: (e) => {
          this.onRequest(e);
        },
      },
    );
  }
  uri(secret = this.secret): string {
    return `bunker://${this.pk}?relay=${encodeURIComponent(RELAY)}&secret=${secret}`;
  }
  private onRequest(e: NostrToolsEvent): void {
    if (!verifyEvent(e)) return;
    const ck = nip44.getConversationKey(this.sk, e.pubkey);
    const req = JSON.parse(nip44.decrypt(e.content, ck)) as {
      id: string;
      method: string;
      params: string[];
    };
    this.seen.push(req.method);
    let result: string | undefined;
    let error: string | undefined;
    if (req.method === 'connect') {
      if (req.params[1] === this.secret) {
        this.authorized.add(e.pubkey);
        result = 'ack';
      } else error = 'bad secret';
    } else if (!this.authorized.has(e.pubkey)) {
      return; // an unknown (or revoked) client is ignored, as real bunkers do
    } else if (req.method === 'get_public_key') {
      if (this.authUrl !== undefined) {
        const challenge = finalizeEvent(
          {
            kind: NOSTR_CONNECT,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['p', e.pubkey]],
            content: nip44.encrypt(
              JSON.stringify({ id: req.id, result: 'auth_url', error: this.authUrl }),
              ck,
            ),
          },
          this.sk,
        );
        this.authUrl = undefined;
        void this.pool.publish([RELAY], challenge);
        if (this.approveAfterMs > 0) {
          const later = finalizeEvent(
            {
              kind: NOSTR_CONNECT,
              created_at: Math.floor(Date.now() / 1000),
              tags: [['p', e.pubkey]],
              content: nip44.encrypt(JSON.stringify({ id: req.id, result: this.pk }), ck),
            },
            this.sk,
          );
          setTimeout(() => {
            void this.pool.publish([RELAY], later);
          }, this.approveAfterMs);
          return;
        }
      }
      result = this.pk;
    } else if (req.method === 'sign_event') {
      const t = JSON.parse(req.params[0] ?? '{}') as Parameters<typeof finalizeEvent>[0];
      result = JSON.stringify(finalizeEvent(t, this.sk));
    } else error = 'unsupported';
    const reply = finalizeEvent(
      {
        kind: NOSTR_CONNECT,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', e.pubkey]],
        content: nip44.encrypt(JSON.stringify({ id: req.id, result, error }), ck),
      },
      this.sk,
    );
    void this.pool.publish([RELAY], reply);
  }
}

const decodeResume = (b: Uint8Array): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>;

describe('connectBunker / resumeBunker (ADR 0013)', () => {
  it('connects, and with remember hands back a resume blob without the URI secret', async () => {
    const pool = new MemoryPool();
    const b = new FakeBunker(pool, 'one-time-s3cret');
    const s = await connectBunker(b.uri(), { pool: pool.asPool(), remember: true });
    expect(s.relays).toEqual([RELAY]);
    const signer = await Nip46Signer.adopt(s.bunker, s.relays);
    expect(await signer.getPublicKey()).toBe(b.pk);
    const ev = await signer.signEvent({
      kind: 1,
      created_at: 1_700_000_000,
      tags: [],
      content: 'x',
    });
    expect(ev.pubkey).toBe(b.pk);
    expect(s.resume).toBeInstanceOf(Uint8Array);
    const r = decodeResume(s.resume ?? new Uint8Array());
    expect(Object.keys(r).sort()).toEqual(['key', 'pubkey', 'relays', 'v']);
    expect(r['pubkey']).toBe(b.pk);
    expect(new TextDecoder().decode(s.resume)).not.toContain('one-time-s3cret');
    await signer.close();
  });

  it('without remember there is no resume blob', async () => {
    const pool = new MemoryPool();
    const b = new FakeBunker(pool, 's');
    const s = await connectBunker(b.uri(), { pool: pool.asPool() });
    expect(s.resume).toBeUndefined();
    await s.bunker.close();
  });

  it('resumes the session later without a new connect (the bunker knows the client key)', async () => {
    const pool = new MemoryPool();
    const b = new FakeBunker(pool, 's');
    const first = await connectBunker(b.uri(), { pool: pool.asPool(), remember: true });
    await first.bunker.close();
    const connects = b.seen.filter((m) => m === 'connect').length;
    const again = await resumeBunker(first.resume ?? new Uint8Array(), { pool: pool.asPool() });
    const signer = await Nip46Signer.adopt(again.bunker, again.relays);
    expect(await signer.getPublicKey()).toBe(b.pk);
    const ev = await signer.signEvent({
      kind: 1,
      created_at: 1_700_000_001,
      tags: [],
      content: 'y',
    });
    expect(ev.pubkey).toBe(b.pk);
    expect(b.seen.filter((m) => m === 'connect').length).toBe(connects);
    await signer.close();
  });

  it('a revoked client is refused within the deadline, not waited on forever', async () => {
    const pool = new MemoryPool();
    const b = new FakeBunker(pool, 's');
    const first = await connectBunker(b.uri(), { pool: pool.asPool(), remember: true });
    await first.bunker.close();
    b.authorized.clear();
    const t0 = Date.now();
    await expect(
      resumeBunker(first.resume ?? new Uint8Array(), { pool: pool.asPool(), timeoutMs: 150 }),
    ).rejects.toThrow(/^remote-signer:/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('a wrong secret, or a bunker that never answers, fails connect with remote-signer', async () => {
    const pool = new MemoryPool();
    const b = new FakeBunker(pool, 'right');
    await expect(connectBunker(b.uri('wrong'), { pool: pool.asPool() })).rejects.toThrow(
      /^remote-signer:/,
    );
    const silent = getPublicKey(generateSecretKey());
    await expect(
      connectBunker(`bunker://${silent}?relay=${RELAY}`, { pool: pool.asPool(), timeoutMs: 100 }),
    ).rejects.toThrow(/^remote-signer:/);
  });

  it('an auth_url challenge never reaches the console (it may carry a token)', async () => {
    const pool = new MemoryPool();
    const b = new FakeBunker(pool, 's');
    b.authUrl = 'https://auth.bunker.example/approve?token=SESSION-TOKEN';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const s = await connectBunker(b.uri(), { pool: pool.asPool() });
      await s.bunker.close();
      expect(warn).not.toHaveBeenCalled();
      // A caller that supports the flow gets the URL instead.
      const urls: string[] = [];
      b.authUrl = 'https://auth.bunker.example/approve?token=OTHER';
      const t = await connectBunker(b.uri(), { pool: pool.asPool(), onauth: (u) => urls.push(u) });
      await t.bunker.close();
      expect(urls).toEqual(['https://auth.bunker.example/approve?token=OTHER']);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('an auth_url challenge pushes the setup deadline out while the user approves', async () => {
    const pool = new MemoryPool();
    const b = new FakeBunker(pool, 's');
    b.authUrl = 'https://auth.bunker.example/approve';
    b.approveAfterMs = 300;
    const urls: string[] = [];
    const s = await connectBunker(b.uri(), {
      pool: pool.asPool(),
      timeoutMs: 100,
      onauth: (u) => urls.push(u),
    });
    expect(urls).toEqual(['https://auth.bunker.example/approve']);
    expect(await s.bunker.getPublicKey()).toBe(b.pk);
    await s.bunker.close();
  });

  it('a pool the connector made itself is closed with the bunker, and when setup fails', async () => {
    const pool = new MemoryPool();
    own.shared = pool;
    own.closed.length = 0;
    const b = new FakeBunker(pool, 's');
    const s = await connectBunker(b.uri(), { remember: true });
    const signer = await Nip46Signer.adopt(s.bunker, s.relays);
    expect(await signer.getPublicKey()).toBe(b.pk);
    expect(own.closed).toEqual([]);
    await signer.close();
    expect(own.closed).toEqual([[RELAY]]);
    const again = await resumeBunker(s.resume ?? new Uint8Array());
    await again.bunker.close();
    expect(own.closed).toHaveLength(2);
    const silent = getPublicKey(generateSecretKey());
    await expect(
      connectBunker(`bunker://${silent}?relay=${RELAY}`, { timeoutMs: 50 }),
    ).rejects.toThrow(/^remote-signer:/);
    expect(own.closed).toHaveLength(3);
    own.shared = undefined;
  });

  it('refuses a resume blob that is not a session', async () => {
    const enc = (o: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(o));
    const key = 'ab'.repeat(32);
    const pubkey = 'cd'.repeat(32);
    const bad = [
      new Uint8Array([0xff, 0xfe]),
      enc('x'),
      enc({ v: 2, key, pubkey, relays: [RELAY] }),
      enc({ v: 1, key: 'zz', pubkey, relays: [RELAY] }),
      enc({ v: 1, key, pubkey: pubkey.toUpperCase(), relays: [RELAY] }),
      enc({ v: 1, key, pubkey, relays: [] }),
      enc({ v: 1, key, pubkey, relays: ['ws://relay.example'] }),
      enc({ v: 1, key, pubkey, relays: [RELAY], extra: new Array(17).fill(RELAY) }).slice(0, 5),
    ];
    for (const b of bad) await expect(resumeBunker(b)).rejects.toThrow(/^invalid-argument:/);
  });
});

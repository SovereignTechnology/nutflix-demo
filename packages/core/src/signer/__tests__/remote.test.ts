/**
 * NIP-46 / NIP-07 adapters: a remote signer is not trusted. Adversary cases: a returned event
 * with different content / tags / kind / created_at, one signed by another key, one that does
 * not verify, the `{ ...verified, content }` symbol-cache trick, an invalid pubkey at connect,
 * an extension without NIP-44, and an extension whose methods live on its prototype.
 */
import { describe, expect, it } from 'vitest';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';

import type { NostrPubkey } from '../../contracts/index.js';
import { parseBunkerUri } from '../nip46-connect.js';
import {
  Nip07Signer,
  Nip46Signer,
  checkRemoteSigned,
  type BunkerLike,
  type Nip07Provider,
} from '../remote.js';

const SK = new Uint8Array(32).fill(41);
const PK = getPublicKey(SK) as NostrPubkey;
const OTHER_SK = new Uint8Array(32).fill(42);
const TEMPLATE = {
  kind: 1,
  created_at: 1_700_000_000,
  tags: [['e', 'ab'.repeat(32)]],
  content: 'hi',
};

interface Tpl {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/** A bunker that signs honestly, then lets a test corrupt its reply. */
function bunker(
  mutate: (signed: ReturnType<typeof finalizeEvent>, t: Tpl) => unknown = (s) => s,
): BunkerLike & {
  closed: boolean;
} {
  const b = {
    closed: false,
    getPublicKey: () => Promise.resolve(PK),
    signEvent: (t: Tpl) =>
      Promise.resolve(mutate(finalizeEvent({ ...t, tags: t.tags.map((x) => [...x]) }, SK), t)),
    nip44Encrypt: (peer: string, pt: string) =>
      Promise.resolve(nip44.encrypt(pt, nip44.getConversationKey(SK, peer))),
    nip44Decrypt: (peer: string, ct: string) =>
      Promise.resolve(nip44.decrypt(ct, nip44.getConversationKey(SK, peer))),
    close: () => {
      b.closed = true;
      return Promise.resolve();
    },
  };
  return b;
}

const tampers: [string, (s: ReturnType<typeof finalizeEvent>, t: Tpl) => unknown][] = [
  ['different content (symbol-cache spread)', (s) => ({ ...s, content: 'evil' })],
  ['different tags', (s) => ({ ...s, tags: [['p', 'cd'.repeat(32)]] })],
  ['different kind', (s) => ({ ...s, kind: 7 })],
  ['different created_at', (s) => ({ ...s, created_at: s.created_at + 1 })],
  [
    'a validly signed DIFFERENT event',
    (_s, t) => finalizeEvent({ ...t, tags: t.tags.map((x) => [...x]), content: 'other' }, SK),
  ],
  [
    'signed by another key',
    (_s, t) => finalizeEvent({ ...t, tags: t.tags.map((x) => [...x]) }, OTHER_SK),
  ],
  ['a broken signature', (s) => ({ ...s, sig: '00'.repeat(64) })],
  ['not an event', () => 'nope'],
  ['null', () => null],
];

describe('checkRemoteSigned', () => {
  it('accepts exactly the requested event signed by the pinned key', () => {
    const signed = finalizeEvent({ ...TEMPLATE, tags: TEMPLATE.tags.map((t) => [...t]) }, SK);
    expect(checkRemoteSigned(TEMPLATE, signed, PK)).toMatchObject({ content: 'hi', pubkey: PK });
  });
  for (const [name, f] of tampers) {
    it(`refuses ${name}`, () => {
      const signed = finalizeEvent({ ...TEMPLATE, tags: TEMPLATE.tags.map((t) => [...t]) }, SK);
      expect(() => checkRemoteSigned(TEMPLATE, f(signed, TEMPLATE), PK)).toThrow(/remote-signer/);
    });
  }
});

describe('Nip46Signer', () => {
  it('pins the pubkey at connect, signs through the bunker and verifies the reply; NIP-44 passes through', async () => {
    const s = await Nip46Signer.adopt(bunker(), ['wss://relay.example']);
    expect(await s.getPublicKey()).toBe(PK);
    expect(s.detail).toContain('wss://relay.example');
    expect(s.detail).not.toContain('secret');
    expect(await s.signEvent(TEMPLATE)).toMatchObject({ pubkey: PK, content: 'hi' });
    const peer = getPublicKey(OTHER_SK) as NostrPubkey;
    const ct = await s.nip44Encrypt(peer, 'x');
    expect(nip44.decrypt(ct, nip44.getConversationKey(OTHER_SK, PK))).toBe('x');
  });

  for (const [name, f] of tampers) {
    it(`refuses a bunker reply that is ${name}`, async () => {
      const s = await Nip46Signer.adopt(bunker(f), ['wss://relay.example']);
      await expect(s.signEvent(TEMPLATE)).rejects.toThrow(/remote-signer/);
    });
  }

  it('refuses an invalid pubkey at connect and closes the session; lock / close gate every call', async () => {
    const bad = { ...bunker(), getPublicKey: () => Promise.resolve('not-a-key') };
    const closed = { v: false };
    bad.close = () => {
      closed.v = true;
      return Promise.resolve();
    };
    await expect(Nip46Signer.adopt(bad, [])).rejects.toThrow(/invalid pubkey/);
    expect(closed.v).toBe(true);

    const b = bunker();
    const s = await Nip46Signer.adopt(b, ['wss://r.example']);
    await s.lock();
    expect(s.isLocked()).toBe(true);
    await expect(s.signEvent(TEMPLATE)).rejects.toThrow(/signer-locked/);
    s.unlock();
    await expect(s.signEvent(TEMPLATE)).resolves.toBeDefined();
    await s.close();
    expect(b.closed).toBe(true);
    s.unlock(); // a closed session stays unusable
    await expect(s.getPublicKey()).rejects.toThrow(/no-signer/);
  });
});

describe('Nip07Signer', () => {
  /** An extension whose methods live on the prototype (a class instance, like most do). */
  class Extension implements Nip07Provider {
    constructor(
      private readonly f: (s: ReturnType<typeof finalizeEvent>, t: Tpl) => unknown = (s) => s,
    ) {}
    getPublicKey(): Promise<string> {
      return Promise.resolve(PK);
    }
    signEvent(t: Tpl): Promise<unknown> {
      return Promise.resolve(
        this.f(finalizeEvent({ ...t, tags: t.tags.map((x) => [...x]) }, SK), t),
      );
    }
    readonly nip44 = {
      encrypt: (peer: string, pt: string): Promise<string> =>
        Promise.resolve(nip44.encrypt(pt, nip44.getConversationKey(SK, peer))),
      decrypt: (peer: string, ct: string): Promise<string> =>
        Promise.resolve(nip44.decrypt(ct, nip44.getConversationKey(SK, peer))),
    };
  }

  it('works with an extension whose methods are on its prototype, and verifies every reply', async () => {
    const s = await Nip07Signer.adopt(new Extension());
    expect(await s.getPublicKey()).toBe(PK);
    expect(await s.signEvent(TEMPLATE)).toMatchObject({ content: 'hi' });
    for (const [, f] of tampers) {
      const t = await Nip07Signer.adopt(new Extension(f));
      await expect(t.signEvent(TEMPLATE)).rejects.toThrow(/remote-signer/);
    }
  });

  it('refuses no extension, an extension without NIP-44, and an invalid pubkey', async () => {
    await expect(Nip07Signer.adopt(undefined)).rejects.toThrow(/no-signer/);
    await expect(
      Nip07Signer.adopt({
        getPublicKey: () => Promise.resolve(PK),
        signEvent: () => Promise.resolve(null),
      }),
    ).rejects.toThrow(/NIP-44/);
    const bad = new Extension();
    bad.getPublicKey = (): Promise<string> => Promise.resolve('x');
    await expect(Nip07Signer.adopt(bad)).rejects.toThrow(/invalid pubkey/);
  });
});

describe('parseBunkerUri (NIP-46 connector)', () => {
  const pk = 'ab'.repeat(32);
  it('accepts bunker://<hex>?relay=wss://… and keeps the secret for the handshake only', () => {
    expect(parseBunkerUri(`bunker://${pk}?relay=wss://relay.example&secret=s3`)).toEqual({
      pubkey: pk,
      relays: ['wss://relay.example'],
      secret: 's3',
    });
  });
  it('refuses NIP-05 names (no fetch of a user-named URL), no relay, ws:// relays and junk', () => {
    for (const bad of [
      'alice@example.com',
      `bunker://${pk}`,
      `bunker://${pk}?relay=ws://relay.example`,
      `bunker://${pk}?relay=https://relay.example`,
      `bunker://${pk.slice(2)}?relay=wss://r.example`,
      `nostrconnect://${pk}?relay=wss://r.example`,
      '',
    ])
      expect(() => parseBunkerUri(bad), bad).toThrow(/invalid-argument/);
  });
});

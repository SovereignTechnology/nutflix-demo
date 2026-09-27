/**
 * ADR 0016 D2: the relay copy — kind 30078, `d` = `nutflix/nut13/<device id>`, content NIP-44 to
 * self, no other tag — and the restore-only read of every copy the identity can decrypt: only
 * this identity's, signature-checked, newest per `d`, blanks skipped, undecryptable counted.
 */
import { describe, expect, it } from 'vitest';

import type { NostrEvent, NostrPubkey, RelayUrl, UnixSeconds } from '@sovit/core';
import { nostr, signer as signerMod, wallet as walletMod } from '@sovit/core';

import {
  MAX_RELAY_COPIES,
  copyD,
  parseRelayCopy,
  publishRelayCopy,
  readRelayCopies,
  retireRelayCopy,
} from '../recovery/relay-copy.js';

const W = 'wss://write.test' as RelayUrl;
const R = 'wss://read.test' as RelayUrl;
const DEV = 'ab'.repeat(16);
const ENTROPY = '7f'.repeat(16);

type Me = signerMod.LocalSigner & { readonly pk: NostrPubkey };
async function me(): Promise<Me> {
  const { signer } = await signerMod.LocalSigner.create({
    passphrase: new TextEncoder().encode('a long enough passphrase'),
    cost: signerMod.minimumCost(),
  });
  return Object.assign(signer, { pk: await signer.getPublicKey() });
}

describe('the relay copy', () => {
  it('publish: kind 30078 to the write relays, exactly one tag (the d), the sealed content as given', async () => {
    const s = await me();
    const pool = new nostr.FakeRelayPool();
    const sealed = await s.nip44Encrypt(
      s.pk,
      JSON.stringify({ v: 1, entropy: ENTROPY, created: 1 }),
    );
    const ok = await publishRelayCopy({
      signer: s,
      relays: { pool, write: () => [W], read: () => [R] },
      device: DEV,
      sealed,
      now: () => 1_760_000_000 as UnixSeconds,
    });
    expect(ok).toBe(true);
    expect(pool.published).toHaveLength(1);
    const { relays, event } = pool.published[0] ?? { relays: [], event: undefined };
    expect(relays).toEqual([W]);
    expect(event?.kind).toBe(walletMod.RECOVERY_RELAY_KIND);
    expect(event?.tags).toEqual([['d', `nutflix/nut13/${DEV}`]]);
    expect(event?.content).toBe(sealed);
    // Encrypted to SELF: this identity opens it, and the plaintext is exactly a RecoveryRelayCopy.
    expect(parseRelayCopy(await s.nip44Decrypt(s.pk, event?.content ?? ''))).toEqual({
      v: 1,
      entropy: ENTROPY,
      created: 1,
    });
    expect(event?.content).not.toContain(ENTROPY);
    // Nothing identifying in the event beyond the random device id.
    expect(JSON.stringify(event?.tags)).not.toMatch(/nutflix\/nut13\/(?![0-9a-f]{32}")/);
  });

  it('no write relay, or every relay refusing: false (the caller reports "this device only")', async () => {
    const s = await me();
    const none = await publishRelayCopy({
      signer: s,
      relays: { pool: new nostr.FakeRelayPool(), write: () => [], read: () => [] },
      device: DEV,
      sealed: 'x',
      now: () => 1 as UnixSeconds,
    });
    expect(none).toBe(false);
    const refusing = new nostr.FakeRelayPool({ rejectPublish: () => 'blocked' });
    const refused = await publishRelayCopy({
      signer: s,
      relays: { pool: refusing, write: () => [W], read: () => [] },
      device: DEV,
      sealed: 'x',
      now: () => 1 as UnixSeconds,
    });
    expect(refused).toBe(false);
  });

  it('copyD refuses anything but a 32-hex device id', () => {
    expect(copyD(DEV)).toBe(`nutflix/nut13/${DEV}`);
    expect(() => copyD('../x')).toThrow(/invalid-argument/);
    expect(() => copyD(DEV.toUpperCase())).toThrow(/invalid-argument/);
  });

  it('parseRelayCopy: exactly { v: 1, entropy: 32 lower hex, created }', () => {
    expect(parseRelayCopy(JSON.stringify({ v: 1, entropy: ENTROPY, created: 0 }))).not.toBeNull();
    for (const bad of [
      'nope',
      '[]',
      JSON.stringify({ v: 2, entropy: ENTROPY, created: 0 }),
      JSON.stringify({ v: 1, entropy: ENTROPY.toUpperCase(), created: 0 }),
      JSON.stringify({ v: 1, entropy: ENTROPY.slice(2), created: 0 }),
      JSON.stringify({ v: 1, entropy: ENTROPY, created: -1 }),
      JSON.stringify({ v: 1, entropy: ENTROPY, created: 0, words: 'abandon' }),
    ])
      expect(parseRelayCopy(bad)).toBeNull();
  });
});

describe('reading the copies (restore only)', () => {
  it('this identity only, signatures checked, newest per d, blanks skipped, undecryptable counted', async () => {
    const s = await me();
    const other = await me();
    const pool = new nostr.FakeRelayPool();
    const relays = { pool, write: () => [W], read: () => [R] };
    const put = async (who: Me, d: string, content: string, at: number): Promise<void> => {
      pool.store(
        await who.signEvent({
          kind: walletMod.RECOVERY_RELAY_KIND,
          created_at: at,
          tags: [['d', d]],
          content,
        }),
      );
    };
    const seal = (who: Me, entropy: string): Promise<string> =>
      who.nip44Encrypt(who.pk, JSON.stringify({ v: 1, entropy, created: 1 }));
    const E1 = '11'.repeat(16);
    const E2 = '22'.repeat(16);
    await put(s, `nutflix/nut13/${'01'.repeat(16)}`, await seal(s, E1), 10);
    await put(s, `nutflix/nut13/${'02'.repeat(16)}`, await seal(s, E2), 10);
    // Retired: a newer blank replaces the copy.
    await put(s, `nutflix/nut13/${'03'.repeat(16)}`, await seal(s, '33'.repeat(16)), 10);
    await put(s, `nutflix/nut13/${'03'.repeat(16)}`, '', 11);
    // Another app's d, a malformed device id, another identity's copy.
    await put(s, 'otherapp/state', await seal(s, '44'.repeat(16)), 10);
    await put(s, 'nutflix/nut13/NOTHEX', await seal(s, '55'.repeat(16)), 10);
    await put(other, `nutflix/nut13/${'06'.repeat(16)}`, await seal(other, '66'.repeat(16)), 10);
    // Sealed to someone else (does not decrypt for us) and garbage content: counted.
    await put(s, `nutflix/nut13/${'07'.repeat(16)}`, await seal(other, '77'.repeat(16)), 10);
    await put(s, `nutflix/nut13/${'08'.repeat(16)}`, 'garbage', 10);
    // A tampered event (bad signature) claiming to be ours.
    const good = await s.signEvent({
      kind: walletMod.RECOVERY_RELAY_KIND,
      created_at: 12,
      tags: [['d', `nutflix/nut13/${'09'.repeat(16)}`]],
      content: await seal(s, '99'.repeat(16)),
    });
    pool.inject({ ...good, content: await seal(s, 'aa'.repeat(16)) });

    const r = await readRelayCopies({ signer: s, pubkey: s.pk, relays });
    expect(pool.queries).toEqual([
      {
        relays: [R],
        filter: { kinds: [walletMod.RECOVERY_RELAY_KIND], authors: [s.pk], limit: 500 },
      },
    ]);
    expect(r.copies.map((c) => c.entropy).sort()).toEqual([E1, E2]);
    expect(r.unreadable).toBe(2);
  });

  it('a relay that ignores the filter: another author re-publishing our ciphertext is not a copy', async () => {
    const s = await me();
    const other = await me();
    const base = new nostr.FakeRelayPool();
    const E1 = '11'.repeat(16);
    const sealed = await s.nip44Encrypt(s.pk, JSON.stringify({ v: 1, entropy: E1, created: 1 }));
    const ours = await s.signEvent({
      kind: walletMod.RECOVERY_RELAY_KIND,
      created_at: 10,
      tags: [['d', `nutflix/nut13/${'01'.repeat(16)}`]],
      content: sealed,
    });
    const theirs = await other.signEvent({
      kind: walletMod.RECOVERY_RELAY_KIND,
      created_at: 11,
      tags: [['d', `nutflix/nut13/${'02'.repeat(16)}`]],
      content: sealed,
    });
    // Answers every query with both events, whatever the filter says.
    const pool: nostr.PoolLike = {
      query: () => Promise.resolve([ours, theirs]),
      subscribe: (r, f, h) => base.subscribe(r, f, h),
      publish: (r, e) => base.publish(r, e),
      close: () => {
        base.close();
      },
    };
    const r = await readRelayCopies({
      signer: s,
      pubkey: s.pk,
      relays: { pool, write: () => [], read: () => [R] },
    });
    expect(r.copies).toEqual([{ device: '01'.repeat(16), entropy: E1 }]);
    expect(r.unreadable).toBe(0);
  });

  it('no read relay → nothing read at all', async () => {
    const s = await me();
    const pool = new nostr.FakeRelayPool();
    const r = await readRelayCopies({
      signer: s,
      pubkey: s.pk,
      relays: { pool, write: () => [W], read: () => [] },
    });
    expect(r).toEqual({ copies: [], unreadable: 0, omitted: 0 });
    expect(pool.queries).toEqual([]);
  });

  it(`at most ${String(MAX_RELAY_COPIES)} copies are decrypted`, async () => {
    const s = await me();
    const pool = new nostr.FakeRelayPool();
    let decrypts = 0;
    const counting = {
      nip44Decrypt: (pk: string, c: string) => {
        decrypts++;
        return s.nip44Decrypt(pk as never, c);
      },
    };
    for (let i = 0; i < MAX_RELAY_COPIES + 5; i++)
      pool.store(
        await s.signEvent({
          kind: walletMod.RECOVERY_RELAY_KIND,
          created_at: 10,
          tags: [['d', `nutflix/nut13/${i.toString(16).padStart(32, '0')}`]],
          content: 'x',
        }),
      );
    await readRelayCopies({
      signer: counting,
      pubkey: s.pk,
      relays: { pool, write: () => [], read: () => [R] },
    });
    expect(decrypts).toBe(MAX_RELAY_COPIES);
  });

  // Independent review IR6: the fake pool replaces parameterised-replaceable events itself, so
  // the reader never saw two versions of one `d`; real relays can return both.
  it('newest per d, whatever order the relays answer in: a newer blank retires the copy, a newer copy wins', async () => {
    const s = await me();
    const d = `nutflix/nut13/${'03'.repeat(16)}`;
    const ev = async (at: number, content: string): Promise<NostrEvent> =>
      s.signEvent({
        kind: walletMod.RECOVERY_RELAY_KIND,
        created_at: at,
        tags: [['d', d]],
        content,
      });
    const seal = (entropy: string): Promise<string> =>
      s.nip44Encrypt(s.pk, JSON.stringify({ v: 1, entropy, created: 1 }));
    const E1 = '11'.repeat(16);
    const E2 = '22'.repeat(16);
    const old = await ev(10, await seal(E1));
    const blank = await ev(11, '');
    const newer = await ev(12, await seal(E2));
    const answering = (events: readonly unknown[]): nostr.PoolLike => {
      const base = new nostr.FakeRelayPool();
      return {
        query: () => Promise.resolve(events),
        subscribe: (r, f, h) => base.subscribe(r, f, h),
        publish: (r, e) => base.publish(r, e),
        close: () => {
          base.close();
        },
      };
    };
    const read = (events: readonly unknown[]) =>
      readRelayCopies({
        signer: s,
        pubkey: s.pk,
        relays: { pool: answering(events), write: () => [], read: () => [R] },
      });
    for (const order of [
      [old, blank],
      [blank, old],
    ])
      expect(await read(order)).toEqual({ copies: [], unreadable: 0, omitted: 0 });
    for (const order of [
      [old, blank, newer],
      [newer, old, blank],
      [blank, newer, old],
    ])
      expect((await read(order)).copies).toEqual([{ device: '03'.repeat(16), entropy: E2 }]);
  });

  // Independent review IR10: blanks are dropped before the cap, and the cap is never silent.
  it(`blanks never crowd out a live copy, and copies beyond ${String(MAX_RELAY_COPIES)} are counted`, async () => {
    const s = await me();
    const pool = new nostr.FakeRelayPool();
    const E1 = '11'.repeat(16);
    const at = (i: number): string => `nutflix/nut13/${i.toString(16).padStart(32, '0')}`;
    // The relay answers newest first: MAX_RELAY_COPIES retired blanks, then the one live copy.
    for (let i = 0; i < MAX_RELAY_COPIES; i++)
      pool.store(
        await s.signEvent({
          kind: walletMod.RECOVERY_RELAY_KIND,
          created_at: 100,
          tags: [['d', at(i)]],
          content: '',
        }),
      );
    pool.store(
      await s.signEvent({
        kind: walletMod.RECOVERY_RELAY_KIND,
        created_at: 50,
        tags: [['d', at(999)]],
        content: await s.nip44Encrypt(s.pk, JSON.stringify({ v: 1, entropy: E1, created: 1 })),
      }),
    );
    const relays = { pool, write: () => [], read: () => [R] };
    expect(await readRelayCopies({ signer: s, pubkey: s.pk, relays })).toEqual({
      copies: [{ device: at(999).slice('nutflix/nut13/'.length), entropy: E1 }],
      unreadable: 0,
      omitted: 0,
    });
    for (let i = 0; i < MAX_RELAY_COPIES + 2; i++)
      pool.store(
        await s.signEvent({
          kind: walletMod.RECOVERY_RELAY_KIND,
          created_at: 200,
          tags: [['d', at(2000 + i)]],
          content: 'x',
        }),
      );
    const r = await readRelayCopies({ signer: s, pubkey: s.pk, relays });
    expect(r.unreadable).toBe(MAX_RELAY_COPIES);
    expect(r.omitted).toBe(3);
  });

  it('retire: a blank replacement and a NIP-09 deletion naming the address; never throws', async () => {
    const s = await me();
    const pool = new nostr.FakeRelayPool();
    const ok = await retireRelayCopy({
      signer: s,
      pubkey: s.pk,
      relays: { pool, write: () => [W], read: () => [] },
      device: DEV,
      now: () => 20 as UnixSeconds,
    });
    expect(ok).toBe(true);
    const [blank, del] = pool.published.map((p) => p.event);
    expect(blank).toMatchObject({
      kind: 30078,
      content: '',
      tags: [['d', `nutflix/nut13/${DEV}`]],
    });
    expect(del).toMatchObject({
      kind: 5,
      tags: [
        ['a', `30078:${s.pk}:nutflix/nut13/${DEV}`],
        ['k', '30078'],
      ],
    });
    const failing = {
      signEvent: () => Promise.reject(new Error('remote-signer: no answer')),
    };
    expect(
      await retireRelayCopy({
        signer: failing,
        pubkey: s.pk,
        relays: { pool, write: () => [W], read: () => [] },
        device: DEV,
        now: () => 20 as UnixSeconds,
      }),
    ).toBe(false);
  });
});

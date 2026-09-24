/**
 * Nip60ProofStore: NIP-60 transitions on an in-memory relay with a real LocalSigner (NIP-44 to
 * self). Adversary / failure cases: a relay outage (outbox, nothing lost), superseded tokens by
 * `del` and by kind-5, another author's token events, undecryptable content, duplicate proofs
 * across events, and no plaintext proof on the relay.
 */
import { describe, expect, it } from 'vitest';

import type { CashuProof, MintUrl, NostrEvent, NostrFilter, Sats } from '../../contracts/index.js';
import { NostrKind } from '../../contracts/index.js';
import { minimumCost } from '../../signer/keyfile.js';
import { LocalSigner } from '../../signer/local.js';
import { Nip60ProofStore, type Nip60Relays } from '../nip60.js';

const MINT = 'https://mint.test-a.example' as MintUrl;
const OTHER_MINT = 'https://mint.test-b.example' as MintUrl;

function proof(n: number, amount = 1): CashuProof {
  return {
    id: '00aa',
    amount,
    secret: `secret-${String(n)}`,
    C: `02${String(n).padStart(64, '0')}`,
  };
}

function relay(): Nip60Relays & { events: NostrEvent[]; down: boolean } {
  const r = {
    events: [] as NostrEvent[],
    down: false,
    publish: (e: NostrEvent) => {
      if (r.down) return Promise.reject(new Error('relay down'));
      r.events.push(e);
      return Promise.resolve();
    },
    query: (f: NostrFilter) =>
      Promise.resolve(
        r.events.filter(
          (e) =>
            (f.kinds === undefined || f.kinds.includes(e.kind)) &&
            (f.authors === undefined || f.authors.includes(e.pubkey)),
        ),
      ),
  };
  return r;
}

async function signer(): Promise<LocalSigner> {
  return (
    await LocalSigner.create({
      passphrase: new TextEncoder().encode('pw pw pw pw'),
      cost: minimumCost(),
    })
  ).signer;
}

describe('Nip60ProofStore', () => {
  it('transitions publish token (with del), deletion (k=7375) and history; a fresh load rebuilds the same state', async () => {
    const s = await signer();
    const r = relay();
    const store = await Nip60ProofStore.load({ signer: s, relays: r });
    await store.commit({
      mint: MINT,
      spent: [],
      added: [proof(1, 8), proof(2, 4)],
      history: { direction: 'in', amount: 12 as Sats, memo: 'top-up' },
    });
    await store.commit({
      mint: MINT,
      spent: [proof(1, 8)],
      added: [proof(3, 2)],
      history: { direction: 'out', amount: 6 as Sats },
    });
    expect((await store.proofs(MINT)).map((p) => p.secret).sort()).toEqual([
      'secret-2',
      'secret-3',
    ]);

    const kinds = r.events.map((e) => e.kind);
    expect(kinds).toEqual([7375, 7376, 7375, 5, 7376]);
    const deletion = r.events[3]!;
    expect(deletion.tags).toContainEqual(['k', '7375']);
    expect(deletion.tags).toContainEqual(['e', r.events[0]!.id]);
    // Nothing on the relay is plaintext.
    const all = JSON.stringify(r.events);
    for (const n of [1, 2, 3]) expect(all).not.toContain(`secret-${String(n)}`);

    const again = await Nip60ProofStore.load({ signer: s, relays: r });
    expect((await again.proofs(MINT)).map((p) => p.secret).sort()).toEqual([
      'secret-2',
      'secret-3',
    ]);
    const h = await again.history();
    expect(h.map((e) => [e.direction, e.amount])).toEqual([
      ['out', 6],
      ['in', 12],
    ]);
    expect(h[0]!.destroyed).toEqual([r.events[0]!.id]);
    expect(h[0]!.created).toEqual([r.events[2]!.id]);
  });

  it('a relay outage keeps the transition locally (proofs never forgotten) and publishes it on the next sync', async () => {
    const s = await signer();
    const r = relay();
    const store = await Nip60ProofStore.load({ signer: s, relays: r });
    r.down = true;
    await store.commit({
      mint: MINT,
      spent: [],
      added: [proof(1, 16)],
      history: { direction: 'in', amount: 16 as Sats },
    });
    expect(await store.proofs(MINT)).toHaveLength(1);
    expect(store.unsynced()).toBe(2);
    expect(r.events).toHaveLength(0);
    r.down = false;
    await store.sync();
    expect(store.unsynced()).toBe(0);
    const again = await Nip60ProofStore.load({ signer: s, relays: r });
    expect((await again.proofs(MINT)).map((p) => p.amount)).toEqual([16]);
  });

  it('on load: tokens superseded by `del` are dropped even without their deletion; another author’s and undecryptable events are ignored; duplicate proofs count once; mints are separate', async () => {
    const s = await signer();
    const intruder = await signer();
    const me = await s.getPublicKey();
    const r = relay();
    const token = async (who: LocalSigner, body: unknown): Promise<NostrEvent> => {
      const e = await who.signEvent({
        kind: NostrKind.WalletToken,
        created_at: 1,
        tags: [],
        content: await who.nip44Encrypt(me, JSON.stringify(body)),
      });
      r.events.push(e);
      return e;
    };
    const old = await token(s, { mint: MINT, proofs: [proof(1, 4)] });
    await token(s, { mint: MINT, proofs: [proof(2, 8), proof(2, 8)], del: [old.id] });
    await token(s, { mint: OTHER_MINT, proofs: [proof(3, 2)] });
    await token(intruder, { mint: MINT, proofs: [proof(9, 1000)] }); // encrypted TO me, but not BY me
    r.events.push({
      ...(await s.signEvent({
        kind: NostrKind.WalletToken,
        created_at: 2,
        tags: [],
        content: 'not nip44',
      })),
    });
    const store = await Nip60ProofStore.load({ signer: s, relays: r });
    expect((await store.proofs(MINT)).map((p) => [p.secret, p.amount])).toEqual([['secret-2', 8]]);
    expect((await store.proofs(OTHER_MINT)).map((p) => p.amount)).toEqual([2]);
    expect([...(await store.mints())].sort()).toEqual([MINT, OTHER_MINT].sort());
  });

  it('a kind-5 deletion (k=7375) by the author supersedes a token; one by anyone else does not', async () => {
    const s = await signer();
    const other = await signer();
    const me = await s.getPublicKey();
    const r = relay();
    const t = await s.signEvent({
      kind: NostrKind.WalletToken,
      created_at: 1,
      tags: [],
      content: await s.nip44Encrypt(me, JSON.stringify({ mint: MINT, proofs: [proof(1, 4)] })),
    });
    r.events.push(t);
    r.events.push(
      await other.signEvent({
        kind: 5,
        created_at: 2,
        tags: [
          ['e', t.id],
          ['k', '7375'],
        ],
        content: '',
      }),
    );
    expect(await (await Nip60ProofStore.load({ signer: s, relays: r })).proofs(MINT)).toHaveLength(
      1,
    );
    r.events.push(
      await s.signEvent({
        kind: 5,
        created_at: 3,
        tags: [
          ['e', t.id],
          ['k', '7375'],
        ],
        content: '',
      }),
    );
    expect(await (await Nip60ProofStore.load({ signer: s, relays: r })).proofs(MINT)).toHaveLength(
      0,
    );
  });
});

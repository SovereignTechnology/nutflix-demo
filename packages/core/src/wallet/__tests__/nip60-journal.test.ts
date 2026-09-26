/**
 * Issue #8 (a), core half: the desktop journal at rest (ADR 0014 amendment).
 *
 *   SealedJournal   the sealed file: a round trip, nothing in clear, and every way a file can be
 *                   wrong (not JSON, another format, extra fields, another identity, a key the
 *                   signer cannot unwrap, a tampered body or header, a malformed entry, a forged
 *                   outbox event, oversize) refuses the open — and never writes, so the file is
 *                   kept; a closed journal refuses to save.
 *   Nip60ProofStore with a journal: every transition is durable before `commit` resolves (the
 *                   begin before its request), a failed write fails the commit and changes nothing,
 *                   the outbox rides in the same write (a relay outage plus a crash loses nothing),
 *                   superseded unpublished tokens are compacted away, and a restart restores the
 *                   entries and publishes what was never published.
 */
import { describe, expect, it } from 'vitest';

import type {
  CashuProof,
  MintUrl,
  NostrEvent,
  NostrFilter,
  NostrPubkey,
  Sats,
  UnixSeconds,
} from '../../contracts/index.js';
import { minimumCost } from '../../signer/keyfile.js';
import { LocalSigner } from '../../signer/local.js';
import {
  Nip60ProofStore,
  compactOutbox,
  type Nip60JournalState,
  type Nip60Relays,
} from '../nip60.js';
import {
  JOURNAL_FORMAT,
  JournalError,
  MAX_JOURNAL_BYTES,
  SealedJournal,
  type JournalFile,
} from '../nip60-journal.js';
import type { PendingOp } from '../store.js';

const MINT = 'https://mint.journal.example' as MintUrl;

function proof(n: number, amount = 1): CashuProof {
  return {
    id: '00aa',
    amount,
    secret: `secret-${String(n)}`,
    C: `02${String(n).padStart(64, '0')}`,
  };
}

function op(n: number, spends: CashuProof[] = []): PendingOp {
  const b = `02${String(n).padStart(2, '0').repeat(32)}`;
  return {
    id: b,
    kind: spends.length > 0 ? 'send' : 'receive',
    mint: MINT,
    key: [`k-${String(n)}`],
    keep: [
      {
        blindedMessage: { amount: '2', B_: b, id: '00aa' },
        blindingFactor: '123456789',
        secret: 'ab'.repeat(32),
      },
    ],
    send: [],
    spends,
    created: 1_900_000_000 as UnixSeconds,
  };
}

/** An in-memory JournalFile that records what was written. */
function memFile(initial: string | null = null): JournalFile & {
  text: string | null;
  writes: number;
  failNext: boolean;
} {
  const f = {
    text: initial,
    writes: 0,
    failNext: false,
    read: () => Promise.resolve(f.text),
    write: (t: string) => {
      if (f.failNext) {
        f.failNext = false;
        return Promise.reject(new Error('disk full'));
      }
      f.writes++;
      f.text = t;
      return Promise.resolve();
    },
  };
  return f;
}

function relay(): Nip60Relays & {
  events: NostrEvent[];
  down: boolean;
  reject: ((e: NostrEvent) => boolean) | null;
} {
  const r = {
    events: [] as NostrEvent[],
    down: false,
    /** Refuse some events while up (a size limit, a policy). */
    reject: null as ((e: NostrEvent) => boolean) | null,
    publish: (e: NostrEvent) => {
      if (r.down) return Promise.reject(new Error('relay down'));
      if (r.reject?.(e) === true) return Promise.reject(new Error('blocked: event too large'));
      r.events.push(e);
      return Promise.resolve();
    },
    query: (f: NostrFilter) =>
      Promise.resolve(
        r.down
          ? []
          : r.events.filter(
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
      passphrase: new TextEncoder().encode('journal pw pw'),
      cost: minimumCost(),
    })
  ).signer;
}

async function opened(s: LocalSigner, file: JournalFile): Promise<SealedJournal> {
  return SealedJournal.open({ file, signer: s, pubkey: await s.getPublicKey() });
}

const unreadable = (p: Promise<unknown>): Promise<void> =>
  expect(p).rejects.toThrow(/^journal-unreadable: /);

describe('SealedJournal (the journal at rest)', () => {
  it('starts a file at open (the key wrap is paid then), and round-trips entries and events', async () => {
    const s = await signer();
    const file = memFile();
    const j = await opened(s, file);
    expect(file.writes).toBe(1);
    expect(j.initial).toEqual({ ops: [], outbox: [] });
    const ev = await s.signEvent({ kind: 7376, created_at: 1, tags: [], content: 'x' });
    const state: Nip60JournalState = { ops: [op(1, [proof(9, 4)])], outbox: [ev] };
    await j.save(state);
    const again = await opened(s, file);
    expect(again.initial.ops).toEqual(state.ops);
    expect(again.initial.outbox.map((e) => e.id)).toEqual([ev.id]);
    // Nothing in clear: not the output's secret or blinding factor, not the spent proof.
    const text = file.text ?? '';
    for (const needle of ['ab'.repeat(32), '123456789', 'secret-9', `k-1`])
      expect(text).not.toContain(needle);
    expect(JSON.parse(text)).toMatchObject({ format: JOURNAL_FORMAT, v: 1 });
  });

  it('every save uses a fresh nonce', async () => {
    const s = await signer();
    const file = memFile();
    const j = await opened(s, file);
    const first = JSON.parse(file.text ?? '{}') as { nonce: string };
    await j.save({ ops: [], outbox: [] });
    const second = JSON.parse(file.text ?? '{}') as { nonce: string };
    expect(second.nonce).not.toBe(first.nonce);
  });

  it('a damaged or foreign file is refused loudly and never overwritten', async () => {
    const s = await signer();
    const other = await signer();
    const good = memFile();
    await (await opened(s, good)).save({ ops: [op(1)], outbox: [] });
    const text = good.text ?? '';
    const env = JSON.parse(text) as Record<string, string | number>;
    const flip = (h: string): string => (h.startsWith('0') ? '1' : '0') + h.slice(1);
    const cases: [string, string][] = [
      ['not JSON', 'nope'],
      ['an array', '[]'],
      ['another format', JSON.stringify({ ...env, format: 'something-else' })],
      ['another version', JSON.stringify({ ...env, v: 2 })],
      ['an extra field', JSON.stringify({ ...env, extra: 1 })],
      ['a tampered body', JSON.stringify({ ...env, box: flip(String(env['box'])) })],
      ['a tampered nonce', JSON.stringify({ ...env, nonce: flip(String(env['nonce'])) })],
      ['a truncated body', JSON.stringify({ ...env, box: String(env['box']).slice(0, 30) })],
      ['a key that does not unwrap', JSON.stringify({ ...env, wrap: 'AAAA' })],
    ];
    for (const [what, body] of cases) {
      const f = memFile(body);
      await unreadable(opened(s, f)).catch((e: unknown) => {
        throw new Error(`${what}: ${String(e)}`);
      });
      expect(f.writes, what).toBe(0);
      expect(f.text, what).toBe(body);
    }
    // Another identity: its pubkey is not ours; and a file renamed onto ours does not open.
    const f = memFile(text);
    await unreadable(opened(other, f));
    expect(f.writes).toBe(0);
    // A header re-labelled to the other identity fails the associated data (and the unwrap).
    const relabelled = memFile(JSON.stringify({ ...env, pubkey: await other.getPublicKey() }));
    await unreadable(opened(other, relabelled));
    expect(relabelled.writes).toBe(0);
    // The header is bound to the body (associated data): the SAME key under a fresh wrap — valid,
    // but not the header this body was sealed with — does not open it.
    const me = await s.getPublicKey();
    const rewrapped = memFile(
      JSON.stringify({
        ...env,
        wrap: await s.nip44Encrypt(me, await s.nip44Decrypt(me, String(env['wrap']))),
      }),
    );
    await unreadable(opened(s, rewrapped));
    expect(rewrapped.writes).toBe(0);
    // Too large to be a journal.
    const huge = memFile('x'.repeat(MAX_JOURNAL_BYTES + 1));
    await unreadable(opened(s, huge));
  });

  it('a body this build cannot read exactly — a malformed entry, a duplicate, a forged event — is refused, not dropped', async () => {
    const s = await signer();
    const me = await s.getPublicKey();
    const other = await signer();
    const good = await s.signEvent({ kind: 7375, created_at: 1, tags: [], content: 'c' });
    const foreign = await other.signEvent({ kind: 7375, created_at: 1, tags: [], content: 'c' });
    const wrongKind = await s.signEvent({ kind: 1, created_at: 1, tags: [], content: 'c' });
    const bodies: [string, Nip60JournalState][] = [
      [
        'a malformed entry',
        { ops: [{ ...op(1), kind: 'teleport' } as unknown as PendingOp], outbox: [] },
      ],
      [
        'an entry with a bad output',
        { ops: [{ ...op(1), keep: [{ nope: 1 }] } as unknown as PendingOp], outbox: [] },
      ],
      ['a duplicate entry', { ops: [op(1), op(1)], outbox: [] }],
      ['a forged event', { ops: [], outbox: [{ ...good, content: 'tampered' }] }],
      ['another author’s event', { ops: [], outbox: [foreign] }],
      ['an event of another kind', { ops: [], outbox: [wrongKind] }],
    ];
    for (const [what, body] of bodies) {
      const f = memFile();
      const j = await SealedJournal.open({ file: f, signer: s, pubkey: me });
      await j.save(body);
      const before = f.writes;
      await expect(SealedJournal.open({ file: f, signer: s, pubkey: me }), what).rejects.toThrow(
        JournalError,
      );
      expect(f.writes, what).toBe(before);
    }
  });

  it('a signer that is not there is not a damaged journal: its error goes up as it is, the file untouched', async () => {
    const s = await signer();
    const me = await s.getPublicKey();
    const file = memFile();
    await opened(s, file);
    const before = file.text;
    const away = {
      nip44Encrypt: (pk: NostrPubkey, t: string) => s.nip44Encrypt(pk, t),
      nip44Decrypt: () => Promise.reject(new Error('remote-signer: the bunker did not answer')),
    };
    await expect(SealedJournal.open({ file, signer: away, pubkey: me })).rejects.toThrow(
      /^remote-signer: /,
    );
    expect(file.text).toBe(before);
    // Any other refusal to unwrap is the journal's problem, and says so.
    const wrong = { ...away, nip44Decrypt: () => Promise.reject(new Error('nip44: bad mac')) };
    await unreadable(SealedJournal.open({ file, signer: wrong, pubkey: me }));
  });

  it('a closed journal refuses to save (a commit then fails before its request)', async () => {
    const s = await signer();
    const j = await opened(s, memFile());
    j.close();
    j.close();
    await expect(j.save({ ops: [], outbox: [] })).rejects.toThrow(/journal-unreadable|closed/);
  });
});

describe('Nip60ProofStore with a journal (durable entries and outbox)', () => {
  async function store(
    o: { file?: ReturnType<typeof memFile>; r?: ReturnType<typeof relay> } = {},
  ) {
    const s = await signer();
    const file = o.file ?? memFile();
    const r = o.r ?? relay();
    const journal = await opened(s, file);
    const st = await Nip60ProofStore.load({ signer: s, relays: r, journal });
    return { s, file, r, journal, st };
  }

  it('a begin is on disk before commit resolves; settle removes it in the same write as the proofs', async () => {
    const { s, file, r, st } = await store();
    const me: NostrPubkey = await s.getPublicKey();
    const before = file.writes;
    await st.commit({ mint: MINT, spent: [], added: [], begin: op(1) });
    expect(file.writes).toBe(before + 1);
    // What is on disk now: reopen it independently.
    const disk = await SealedJournal.open({ file, signer: s, pubkey: me });
    expect(disk.initial.ops.map((o) => o.id)).toEqual([op(1).id]);
    r.down = true; // the result cannot reach a relay: it must ride in the journal write
    await st.commit({
      mint: MINT,
      spent: [],
      added: [proof(1, 2)],
      history: { direction: 'in', amount: 2 as Sats },
      settle: [op(1).id],
    });
    const after = await SealedJournal.open({ file, signer: s, pubkey: me });
    expect(after.initial.ops).toEqual([]);
    expect(after.initial.outbox.map((e) => e.kind)).toEqual([7375, 7376]);
  });

  it('a journal write that fails fails the commit and changes nothing', async () => {
    const { file, st } = await store();
    file.failNext = true;
    await expect(st.commit({ mint: MINT, spent: [], added: [], begin: op(2) })).rejects.toThrow(
      'disk full',
    );
    expect(await st.pending(MINT)).toEqual([]);
    file.failNext = true;
    await expect(
      st.commit({
        mint: MINT,
        spent: [],
        added: [proof(3, 8)],
        history: { direction: 'in', amount: 8 as Sats },
      }),
    ).rejects.toThrow('disk full');
    expect(await st.proofs(MINT)).toEqual([]);
    expect(await st.history()).toEqual([]);
    // …and the next commit works.
    await st.commit({ mint: MINT, spent: [], added: [], begin: op(2) });
    expect(await st.pending(MINT)).toHaveLength(1);
  });

  it('a crash during a relay outage loses nothing: the restart restores entries and proofs, then publishes', async () => {
    const r = relay();
    const file = memFile();
    const s = await signer();
    const st = await Nip60ProofStore.load({ signer: s, relays: r, journal: await opened(s, file) });
    r.down = true;
    await st.commit({ mint: MINT, spent: [], added: [], begin: op(4) });
    await st.commit({
      mint: MINT,
      spent: [],
      added: [proof(5, 16)],
      history: { direction: 'in', amount: 16 as Sats },
    });
    expect(r.events).toHaveLength(0);
    // "Crash": the process and its memory are gone; relays are still down.
    const again = await Nip60ProofStore.load({
      signer: s,
      relays: r,
      journal: await opened(s, file),
    });
    expect((await again.pending(MINT)).map((o) => o.id)).toEqual([op(4).id]);
    expect((await again.proofs(MINT)).map((p) => p.amount)).toEqual([16]);
    expect((await again.history()).map((h) => h.amount)).toEqual([16]);
    // Relays back: the next start publishes what never left, and the journal shrinks.
    r.down = false;
    const third = await Nip60ProofStore.load({
      signer: s,
      relays: r,
      journal: await opened(s, file),
    });
    expect(r.events.map((e) => e.kind)).toEqual([7375, 7376]);
    expect(third.unsynced()).toBe(0);
    const disk = await opened(s, file);
    expect(disk.initial.outbox).toEqual([]);
    expect(disk.initial.ops.map((o) => o.id)).toEqual([op(4).id]);
    // A plain reload from the relays alone now has the proofs too.
    const plain = await Nip60ProofStore.load({ signer: s, relays: r });
    expect((await plain.proofs(MINT)).map((p) => p.amount)).toEqual([16]);
  });

  it('superseded unpublished token events are compacted away; the newest carries the proofs', async () => {
    const { s, file, r, st } = await store();
    r.down = true;
    await st.commit({
      mint: MINT,
      spent: [],
      added: [proof(1, 8), proof(2, 4)],
      history: { direction: 'in', amount: 12 as Sats },
    });
    for (let i = 3; i < 8; i++)
      await st.commit({
        mint: MINT,
        spent: [proof(i - 1, i === 3 ? 4 : 1)],
        added: [proof(i, 1)],
        history: { direction: 'out', amount: 1 as Sats },
      });
    const disk = await SealedJournal.open({ file, signer: s, pubkey: await s.getPublicKey() });
    const tokens = disk.initial.outbox.filter((e) => e.kind === 7375);
    expect(tokens).toHaveLength(1); // not six
    r.down = false;
    await st.sync();
    const plain = await Nip60ProofStore.load({ signer: s, relays: r });
    expect((await plain.proofs(MINT)).map((p) => p.secret).sort()).toEqual(
      ['secret-1', 'secret-7'].sort(),
    );
  });

  it('a drain that fails on the compacted token has sent no deletion ahead of it: the relays never lose its proofs (review finding 3)', async () => {
    const s = await signer();
    const r = relay();
    const st = await Nip60ProofStore.load({
      signer: s,
      relays: r,
      journal: await opened(s, memFile()),
    });
    // T1 reaches the relays.
    await st.commit({
      mint: MINT,
      spent: [],
      added: [proof(1, 8), proof(2, 4)],
      history: { direction: 'in', amount: 12 as Sats },
    });
    expect(r.events.filter((e) => e.kind === 7375)).toHaveLength(1);
    r.down = true;
    // B spends from T1 (published): [T2, K5(T1), H]. C spends from T2 (never published): T2 is
    // compacted into T3, which carries T1's unspent proof.
    await st.commit({
      mint: MINT,
      spent: [proof(2, 4)],
      added: [proof(3, 2)],
      history: { direction: 'out', amount: 2 as Sats },
    });
    await st.commit({
      mint: MINT,
      spent: [proof(3, 2)],
      added: [proof(4, 1)],
      history: { direction: 'out', amount: 1 as Sats },
    });
    // The relays are back, but refuse token events for now.
    r.down = false;
    r.reject = (e) => e.kind === 7375;
    await st.sync();
    // T1 is not deleted on the relays while no published token carries secret-1.
    const plain = await Nip60ProofStore.load({ signer: s, relays: r });
    expect((await plain.proofs(MINT)).map((p) => p.secret)).toContain('secret-1');
    // Once the relays take everything, the state is exact.
    r.reject = null;
    await st.sync();
    expect(st.unsynced()).toBe(0);
    const after = await Nip60ProofStore.load({ signer: s, relays: r });
    expect((await after.proofs(MINT)).map((p) => p.secret).sort()).toEqual([
      'secret-1',
      'secret-4',
    ]);
  });

  it('compactOutbox: the new token takes the first replaced token’s place; nothing else moves', () => {
    const ev = (id: string, kind: number): NostrEvent =>
      ({ id, kind, pubkey: '', created_at: 0, tags: [], content: '', sig: '' }) as never;
    const T2 = ev('t2', 7375);
    const K1 = ev('k1', 5);
    const H1 = ev('h1', 7376);
    const X = ev('x', 7375); // another mint's token, not replaced
    const T3 = ev('t3', 7375);
    const K2 = ev('k2', 5);
    const H2 = ev('h2', 7376);
    expect(compactOutbox([X, T2, K1, H1], [{ id: 't2' }], [T3, K2, H2]).map((e) => e.id)).toEqual([
      'x',
      't3',
      'k1',
      'h1',
      'k2',
      'h2',
    ]);
    // Nothing replaced in the outbox: appended, as before.
    expect(compactOutbox([X], [{ id: 'published' }], [T3, K2, H2]).map((e) => e.id)).toEqual([
      'x',
      't3',
      'k2',
      'h2',
    ]);
    // Everything spent (no new token): the rest follow what is left.
    expect(compactOutbox([T2, K1, H1], [{ id: 't2' }], [K2, H2]).map((e) => e.id)).toEqual([
      'k1',
      'h1',
      'k2',
      'h2',
    ]);
  });

  it('proofs listed by two token events count once', async () => {
    const s = await signer();
    const me = await s.getPublicKey();
    const r = relay();
    for (const body of [
      { mint: MINT, proofs: [proof(1, 8)] },
      { mint: MINT, proofs: [proof(1, 8), proof(2, 4)] },
    ])
      r.events.push(
        await s.signEvent({
          kind: 7375,
          created_at: 1,
          tags: [],
          content: await s.nip44Encrypt(me, JSON.stringify(body)),
        }),
      );
    const st = await Nip60ProofStore.load({ signer: s, relays: r });
    expect((await st.proofs(MINT)).map((p) => p.amount).sort()).toEqual([4, 8]);
  });
});

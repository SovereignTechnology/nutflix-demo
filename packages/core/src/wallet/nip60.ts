/**
 * Nip60ProofStore — the wallet's state as NIP-60 events on the user's relays (docs/vendor/
 * NIP-60.md), so one wallet follows the user between the desktop app and the web portal.
 *
 *   kind 7375  token event: nip44(self, { mint, unit, proofs, del }) — unspent proofs
 *   kind 5     NIP-09 deletion of spent token events, tagged ['k', '7375']
 *   kind 7376  history: nip44(self, [[direction], [amount], [unit], [e … created|destroyed], [memo]])
 *
 * A transition is applied to the in-memory state first (it is authoritative for this process),
 * then published in this order: the NEW token event (so proofs are never unrecorded), the
 * deletion of the old ones, the history line. A publish that fails leaves the transition in an
 * outbox that is retried on the next commit or `sync()` — a relay outage must not lose proofs
 * the mint already swapped. On load, token events superseded by a `del` list or a kind-5
 * deletion (by the same author) are dropped, and proofs are deduplicated by secret.
 *
 * The journal (ADR 0014; amendment for issue #8). With a `Nip60Journal` (the desktop host's
 * sealed file, `nip60-journal.ts`) the pending operations AND the outbox are durable: every
 * transition is written to it — and fsynced — before `commit` resolves, so an operation's entry is
 * on disk before its request reaches the mint, and its result (the new token event, still
 * unpublished) and the entry's removal land in the SAME write. After a crash, `load` re-reads
 * both: the entries are settled by `Wallet.recoverPending` (NUT-09), the unpublished events are
 * merged into what the relays hold and published again. Superseded unpublished token events are
 * dropped from the outbox as it grows (the newer token carries their proofs, and takes the first
 * one's place, ahead of every deletion it covers: `compactOutbox`). Without a journal the entries
 * and the outbox stay in memory, as before. The outbox is otherwise unbounded: a long relay outage
 * grows the journal by about 3 KB an operation, every save rewrites it, and at
 * `MAX_JOURNAL_BYTES` commits fail closed until the relays take the events (review finding 6).
 *
 * Everything is encrypted to self with the signer's NIP-44; nothing is logged.
 */
import type {
  CashuProof,
  MintUrl,
  NostrEvent,
  NostrEventId,
  NostrFilter,
  NostrPubkey,
  Sats,
  Signer,
  UnixSeconds,
  WalletHistoryEntry,
} from '../contracts/index.js';
import { NostrKind } from '../contracts/index.js';
import { verifyIncoming } from '../nostr/event.js';
import type { PendingOp, ProofStore, WalletTx } from './store.js';

/** The two relay operations this store needs (the host's relay pool implements them). */
export interface Nip60Relays {
  publish(event: NostrEvent): Promise<void>;
  /** Events come back signature-VERIFIED (the data layer's `verifyIncoming`). */
  query(filter: NostrFilter): Promise<readonly NostrEvent[]>;
}

/** The durable half of the store: its journal entries and its unpublished events. */
export interface Nip60JournalState {
  readonly ops: readonly PendingOp[];
  readonly outbox: readonly NostrEvent[];
}

/**
 * Where the store keeps `Nip60JournalState` across a crash (ADR 0014 amendment). `save` must be
 * durable when it resolves (fsync, atomic rename) and must REJECT rather than keep a state only in
 * memory: the store then fails the commit, before any request that depends on it.
 */
export interface Nip60Journal {
  /** What the last `save` left, read when the journal was opened (entries already validated). */
  readonly initial: Nip60JournalState;
  save(state: Nip60JournalState): Promise<void>;
}

interface TokenEvent {
  readonly id: NostrEventId;
  readonly mint: MintUrl;
  readonly proofs: readonly CashuProof[];
}

function isProof(x: unknown): x is CashuProof {
  if (typeof x !== 'object' || x === null) return false;
  const p = x as Record<string, unknown>;
  return (
    typeof p['id'] === 'string' &&
    Number.isSafeInteger(p['amount']) &&
    (p['amount'] as number) > 0 &&
    typeof p['secret'] === 'string' &&
    typeof p['C'] === 'string'
  );
}

function cloneOp(o: PendingOp): PendingOp {
  return JSON.parse(JSON.stringify(o)) as PendingOp;
}

function cleanProof(p: CashuProof): CashuProof {
  const d = p.dleq;
  return {
    id: p.id,
    amount: p.amount,
    secret: p.secret,
    C: p.C,
    ...(d === undefined
      ? {}
      : { dleq: { s: d.s, e: d.e, ...(d.r === undefined ? {} : { r: d.r }) } }),
    ...(p.witness === undefined ? {} : { witness: p.witness }),
  };
}

/**
 * The outbox after a transition whose events are `out` (its token event, then its deletion and
 * history). An unpublished token event the new one supersedes need never leave: the new token
 * carries its unspent proofs, and the deletion still names it (NIP-60 `del`, kind 5).
 *
 * The new token event then takes the place of the FIRST token it replaced (issue #8 review,
 * finding 3). Every deletion in the outbox follows the token that carries the deleted event's
 * unspent proofs; appended at the end, the new carrier would follow the earlier deletions its
 * predecessor preceded. A drain that published those and then failed on the token (a relay error,
 * a size limit) would leave the relays with the old token deleted and no token holding its
 * proofs.
 */
export function compactOutbox(
  outbox: readonly NostrEvent[],
  affected: readonly { readonly id: string }[],
  out: readonly NostrEvent[],
): NostrEvent[] {
  const superseded = new Set<string>(affected.map((t) => t.id));
  const kept: NostrEvent[] = [];
  let slot = -1;
  for (const ev of outbox) {
    if (ev.kind === NostrKind.WalletToken && superseded.has(ev.id)) {
      if (slot < 0) slot = kept.length;
      continue;
    }
    kept.push(ev);
  }
  if (slot < 0) return [...kept, ...out];
  const token = out.filter((ev) => ev.kind === NostrKind.WalletToken);
  const rest = out.filter((ev) => ev.kind !== NostrKind.WalletToken);
  return [...kept.slice(0, slot), ...token, ...kept.slice(slot), ...rest];
}

export class Nip60ProofStore implements ProofStore {
  private readonly tokens = new Map<NostrEventId, TokenEvent>();
  private readonly hist: WalletHistoryEntry[] = [];
  /** Unpublished events, in order (replaced, never mutated, by a transition). */
  private outbox: NostrEvent[] = [];
  /**
   * The journal (ADR 0014): NIP-60 has no event for it, and a relay round trip before every
   * payment is too slow. Durable in `journal` when there is one (the desktop's sealed file);
   * otherwise in memory, recovering a lost answer within the session only.
   */
  private ops = new Map<string, PendingOp>();
  /** Transitions apply (and are written to the journal) one at a time, in call order. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Publishing runs one drain at a time, so events leave in order. */
  private syncing: Promise<void> = Promise.resolve();
  /** Events were published since the journal was last written (it holds a stale outbox). */
  private journalStale = false;

  private constructor(
    private readonly signer: Signer,
    private readonly me: NostrPubkey,
    private readonly relays: Nip60Relays,
    private readonly now: () => UnixSeconds,
    private readonly journal: Nip60Journal | undefined,
  ) {}

  /**
   * Read the user's token and history events and rebuild the state — with a `journal`, its
   * entries and its unpublished events too (published again before this resolves, best effort).
   */
  static async load(opts: {
    readonly signer: Signer;
    readonly relays: Nip60Relays;
    readonly now?: () => UnixSeconds;
    readonly journal?: Nip60Journal;
  }): Promise<Nip60ProofStore> {
    const me = await opts.signer.getPublicKey();
    const store = new Nip60ProofStore(
      opts.signer,
      me,
      opts.relays,
      opts.now ?? ((): UnixSeconds => Math.floor(Date.now() / 1000) as UnixSeconds),
      opts.journal,
    );
    const initial = opts.journal?.initial;
    if (initial !== undefined) {
      store.ops = new Map(initial.ops.map((op) => [op.id, cloneOp(op)]));
      store.outbox = [...initial.outbox];
    }
    await store.reload();
    if (store.outbox.length > 0) await store.sync();
    return store;
  }

  private async reload(): Promise<void> {
    const raw = await this.relays.query({
      kinds: [NostrKind.WalletToken, NostrKind.Deletion, NostrKind.WalletHistory],
      authors: [this.me],
    });
    // Re-verified here whatever the relay layer promised (security review F23): a forged
    // kind-5 "from us" would otherwise hide proofs, and the check costs ~1 ms an event. Our own
    // unpublished events (a journal's outbox) count as if the relays had them.
    const events: NostrEvent[] = [];
    const ids = new Set<string>();
    for (const ev of [...raw, ...this.outbox]) {
      const ok = verifyIncoming(ev);
      if (ok === null || ids.has(ok.id)) continue;
      ids.add(ok.id);
      events.push(ok);
    }
    const superseded = new Set<string>();
    const parsed: TokenEvent[] = [];
    for (const ev of events) {
      if (ev.pubkey !== this.me) continue;
      if (ev.kind === NostrKind.Deletion && ev.tags.some((t) => t[0] === 'k' && t[1] === '7375')) {
        for (const t of ev.tags) if (t[0] === 'e' && typeof t[1] === 'string') superseded.add(t[1]);
      }
    }
    for (const ev of events) {
      if (ev.pubkey !== this.me || ev.kind !== NostrKind.WalletToken) continue;
      const token = await this.decryptToken(ev);
      if (token === null) continue;
      for (const d of token.del) superseded.add(d);
      parsed.push(token.token);
    }
    this.tokens.clear();
    const seen = new Set<string>();
    for (const t of parsed) {
      if (superseded.has(t.id)) continue;
      const proofs: CashuProof[] = [];
      for (const p of t.proofs) {
        if (seen.has(p.secret)) continue; // a proof exists once, however many events list it
        seen.add(p.secret);
        proofs.push(p);
      }
      this.tokens.set(t.id, { ...t, proofs });
    }
    this.hist.length = 0;
    for (const ev of events) {
      if (ev.pubkey !== this.me || ev.kind !== NostrKind.WalletHistory) continue;
      const entry = await this.decryptHistory(ev);
      if (entry !== null) this.hist.push(entry);
    }
    this.hist.sort((a, b) => a.at - b.at);
  }

  private async decryptToken(
    ev: NostrEvent,
  ): Promise<{ token: TokenEvent; del: readonly string[] } | null> {
    let obj: unknown;
    try {
      obj = JSON.parse(await this.signer.nip44Decrypt(this.me, ev.content));
    } catch {
      return null;
    }
    if (typeof obj !== 'object' || obj === null) return null;
    const o = obj as Record<string, unknown>;
    const mint = o['mint'];
    const unit = o['unit'] ?? 'sat';
    const proofs = o['proofs'];
    const del = Array.isArray(o['del'])
      ? o['del'].filter((x): x is string => typeof x === 'string')
      : [];
    if (typeof mint !== 'string' || unit !== 'sat' || !Array.isArray(proofs)) return null;
    return {
      token: { id: ev.id, mint: mint as MintUrl, proofs: proofs.filter(isProof).map(cleanProof) },
      del,
    };
  }

  private async decryptHistory(ev: NostrEvent): Promise<WalletHistoryEntry | null> {
    let rows: unknown;
    try {
      rows = JSON.parse(await this.signer.nip44Decrypt(this.me, ev.content));
    } catch {
      return null;
    }
    if (!Array.isArray(rows)) return null;
    const get = (k: string): string | undefined => {
      const r = rows.find((x: unknown) => Array.isArray(x) && x[0] === k) as unknown[] | undefined;
      return typeof r?.[1] === 'string' ? r[1] : undefined;
    };
    const direction = get('direction');
    const amount = Number(get('amount'));
    const mint = get('mint');
    if (
      (direction !== 'in' && direction !== 'out') ||
      !Number.isSafeInteger(amount) ||
      mint === undefined
    )
      return null;
    const refs = (marker: string): NostrEventId[] =>
      rows
        .filter(
          (x: unknown) =>
            Array.isArray(x) && x[0] === 'e' && x[3] === marker && typeof x[1] === 'string',
        )
        .map((x: unknown[]) => x[1] as NostrEventId);
    const memo = get('memo');
    return {
      id: ev.id,
      direction,
      amount: amount as Sats,
      mint: mint as MintUrl,
      at: ev.created_at as UnixSeconds,
      ...(memo === undefined ? {} : { memo }),
      created: refs('created'),
      destroyed: refs('destroyed'),
    };
  }

  mints(): Promise<readonly MintUrl[]> {
    return Promise.resolve([
      ...new Set([
        ...[...this.tokens.values()].map((t) => t.mint),
        ...[...this.ops.values()].map((o) => o.mint),
      ]),
    ]);
  }

  pending(mint: MintUrl): Promise<readonly PendingOp[]> {
    return Promise.resolve(
      [...this.ops.values()].filter((o) => o.mint === mint).map((o) => cloneOp(o)),
    );
  }

  /** A proof exists once, however many token events list it (a relay may hold stale copies). */
  proofs(mint: MintUrl): Promise<readonly CashuProof[]> {
    const out: CashuProof[] = [];
    const seen = new Set<string>();
    for (const t of this.tokens.values()) {
      if (t.mint !== mint) continue;
      for (const p of t.proofs) {
        if (seen.has(p.secret)) continue;
        seen.add(p.secret);
        out.push(cleanProof(p));
      }
    }
    return Promise.resolve(out);
  }

  /** Transitions whose events have not reached a relay yet. */
  unsynced(): number {
    return this.outbox.length;
  }

  async commit(tx: WalletTx): Promise<WalletHistoryEntry | null> {
    // Journal only: nothing for the relays (but durable before this resolves, with a journal).
    if (tx.spent.length === 0 && tx.added.length === 0 && tx.history === undefined) {
      await this.apply(tx, { affected: [], out: [], created: undefined, keep: [], entry: null });
      return null;
    }
    const spent = new Set(tx.spent.map((p) => p.secret));
    const affected = [...this.tokens.values()].filter(
      (t) => t.mint === tx.mint && t.proofs.some((p) => spent.has(p.secret)),
    );
    const keep = new Map<string, CashuProof>();
    for (const t of affected)
      for (const p of t.proofs) if (!spent.has(p.secret)) keep.set(p.secret, p);
    for (const p of tx.added) keep.set(p.secret, cleanProof(p));

    const at = this.now();
    const out: NostrEvent[] = [];
    let created: NostrEventId | undefined;
    if (keep.size > 0 || affected.length > 0) {
      if (keep.size > 0) {
        const token = await this.signer.signEvent({
          kind: NostrKind.WalletToken,
          created_at: at,
          tags: [],
          content: await this.signer.nip44Encrypt(
            this.me,
            JSON.stringify({
              mint: tx.mint,
              unit: 'sat',
              proofs: [...keep.values()],
              del: affected.map((t) => t.id),
            }),
          ),
        });
        created = token.id;
        out.push(token);
      }
      if (affected.length > 0) {
        out.push(
          await this.signer.signEvent({
            kind: NostrKind.Deletion,
            created_at: at,
            tags: [...affected.map((t) => ['e', t.id]), ['k', '7375']],
            content: '',
          }),
        );
      }
    }
    let entry: WalletHistoryEntry | null = null;
    if (tx.history !== undefined) {
      const rows: string[][] = [
        ['direction', tx.history.direction],
        ['amount', String(tx.history.amount)],
        ['unit', 'sat'],
        ['mint', tx.mint],
        ...(created === undefined ? [] : [['e', created, '', 'created']]),
        ...affected.map((t) => ['e', t.id, '', 'destroyed']),
        ...(tx.history.memo === undefined ? [] : [['memo', tx.history.memo]]),
      ];
      const hist = await this.signer.signEvent({
        kind: NostrKind.WalletHistory,
        created_at: at,
        tags: [],
        content: await this.signer.nip44Encrypt(this.me, JSON.stringify(rows)),
      });
      out.push(hist);
      entry = {
        id: hist.id,
        direction: tx.history.direction,
        amount: tx.history.amount,
        mint: tx.mint,
        at,
        ...(tx.history.memo === undefined ? {} : { memo: tx.history.memo }),
        created: created === undefined ? [] : [created],
        destroyed: affected.map((t) => t.id),
      };
    }

    // Local state first (durable first, with a journal): this process never forgets proofs it
    // holds, and a crash never forgets proofs the mint handed over.
    await this.apply(tx, { affected, out, created, keep: [...keep.values()], entry });
    await this.sync();
    return entry;
  }

  /**
   * One transition, in call order: the next journal entries and outbox (superseded unpublished
   * token events compacted away) are written to the journal — durably — and only then become the
   * live state, with the token and history changes. A journal write that fails rejects and
   * changes nothing.
   */
  private apply(
    tx: WalletTx,
    c: {
      readonly affected: readonly TokenEvent[];
      readonly out: readonly NostrEvent[];
      readonly created: NostrEventId | undefined;
      readonly keep: readonly CashuProof[];
      readonly entry: WalletHistoryEntry | null;
    },
  ): Promise<void> {
    const run = this.chain.then(async () => {
      const ops = new Map(this.ops);
      for (const id of tx.settle ?? []) ops.delete(id);
      if (tx.begin !== undefined) ops.set(tx.begin.id, cloneOp(tx.begin));
      const outbox = compactOutbox(this.outbox, c.affected, c.out);
      if (this.journal !== undefined) {
        await this.journal.save({ ops: [...ops.values()], outbox });
        this.journalStale = false;
      }
      this.ops = ops;
      this.outbox = outbox;
      for (const t of c.affected) this.tokens.delete(t.id);
      if (c.created !== undefined)
        this.tokens.set(c.created, { id: c.created, mint: tx.mint, proofs: [...c.keep] });
      if (c.entry !== null) this.hist.push(c.entry);
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Publish whatever is in the outbox, in order; stops at the first failure (kept for later).
   * With a journal, the published events then leave it too (best effort: a stale copy is only
   * published again, which relays ignore).
   */
  sync(): Promise<void> {
    const run = this.syncing.then(() => this.drain());
    this.syncing = run.catch(() => undefined);
    return run;
  }

  private async drain(): Promise<void> {
    for (;;) {
      const ev = this.outbox[0];
      if (ev === undefined) break;
      try {
        await this.relays.publish(ev);
      } catch {
        break;
      }
      // By identity: a transition may have replaced the outbox meanwhile.
      const i = this.outbox.indexOf(ev);
      if (i >= 0) this.outbox = [...this.outbox.slice(0, i), ...this.outbox.slice(i + 1)];
      this.journalStale = true;
    }
    const journal = this.journal;
    if (journal === undefined || !this.journalStale) return;
    const shrink = this.chain.then(async () => {
      if (!this.journalStale) return;
      await journal.save({ ops: [...this.ops.values()], outbox: this.outbox });
      this.journalStale = false;
    });
    this.chain = shrink.catch(() => undefined);
    await shrink.catch(() => undefined);
  }

  history(opts?: {
    readonly limit?: number;
    readonly mint?: MintUrl;
  }): Promise<readonly WalletHistoryEntry[]> {
    let h = [...this.hist].reverse();
    if (opts?.mint !== undefined) h = h.filter((e) => e.mint === opts.mint);
    if (opts?.limit !== undefined) h = h.slice(0, opts.limit);
    return Promise.resolve(h);
  }
}

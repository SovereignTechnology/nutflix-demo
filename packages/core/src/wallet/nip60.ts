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
import type { ProofStore, WalletTx } from './store.js';

/** The two relay operations this store needs (the host's relay pool implements them). */
export interface Nip60Relays {
  publish(event: NostrEvent): Promise<void>;
  /** Events come back signature-VERIFIED (the data layer's `verifyIncoming`). */
  query(filter: NostrFilter): Promise<readonly NostrEvent[]>;
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

export class Nip60ProofStore implements ProofStore {
  private readonly tokens = new Map<NostrEventId, TokenEvent>();
  private readonly hist: WalletHistoryEntry[] = [];
  private readonly outbox: NostrEvent[] = [];

  private constructor(
    private readonly signer: Signer,
    private readonly me: NostrPubkey,
    private readonly relays: Nip60Relays,
    private readonly now: () => UnixSeconds,
  ) {}

  /** Read the user's token and history events and rebuild the state. */
  static async load(opts: {
    readonly signer: Signer;
    readonly relays: Nip60Relays;
    readonly now?: () => UnixSeconds;
  }): Promise<Nip60ProofStore> {
    const me = await opts.signer.getPublicKey();
    const store = new Nip60ProofStore(
      opts.signer,
      me,
      opts.relays,
      opts.now ?? ((): UnixSeconds => Math.floor(Date.now() / 1000) as UnixSeconds),
    );
    await store.reload();
    return store;
  }

  private async reload(): Promise<void> {
    const events = await this.relays.query({
      kinds: [NostrKind.WalletToken, NostrKind.Deletion, NostrKind.WalletHistory],
      authors: [this.me],
    });
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
    return Promise.resolve([...new Set([...this.tokens.values()].map((t) => t.mint))]);
  }

  proofs(mint: MintUrl): Promise<readonly CashuProof[]> {
    const out: CashuProof[] = [];
    for (const t of this.tokens.values())
      if (t.mint === mint) out.push(...t.proofs.map(cleanProof));
    return Promise.resolve(out);
  }

  /** Transitions whose events have not reached a relay yet. */
  unsynced(): number {
    return this.outbox.length;
  }

  async commit(tx: WalletTx): Promise<WalletHistoryEntry | null> {
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
      this.hist.push(entry);
    }

    // Local state first: this process never forgets proofs it holds.
    for (const t of affected) this.tokens.delete(t.id);
    if (created !== undefined)
      this.tokens.set(created, { id: created, mint: tx.mint, proofs: [...keep.values()] });
    this.outbox.push(...out);
    await this.sync();
    return entry;
  }

  /** Publish whatever is in the outbox, in order; stops at the first failure (kept for later). */
  async sync(): Promise<void> {
    for (;;) {
      const ev = this.outbox[0];
      if (ev === undefined) return;
      try {
        await this.relays.publish(ev);
      } catch {
        return;
      }
      this.outbox.shift();
    }
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

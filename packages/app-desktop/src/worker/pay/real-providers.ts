/**
 * The worker's REAL payment providers (Stage 3, ADR 0012), used when the host's money plane is
 * live (`WorkerInit.payments`). The worker never holds anything it can spend on its own:
 *
 *   viewer   every PAY is built by the host (`pay.build`) for the play session whose blocks it
 *            covers — the host checks the session, the range, the manifest terms and the
 *            session's budget. Two sessions of one core (a rendition switch, two windows) each
 *            pay their own blocks (fix round 5). A tail a seeder reports owed (lane
 *            P2-owed-viewer) is paid under the id of the session it was recorded for: the host
 *            checks that session while it is open, and its persisted tail authorisation after;
 *   HELLO    signed by the host over this connection's `pay/1` challenge (`pay.hello`); the price
 *            it states is a ceiling (the highest price among the cores we serve now:
 *            `servedPriceCeiling`) and each core's own price follows as `PRICE` on its first block
 *            (always, contracts v6 amendment);
 *   seeder   `RealPaymentEngine` runs HERE (its upload accounting is synchronous), with every
 *            money step asked of the host: keysets, redeem (swap into the NIP-60 wallet), NUT-07
 *            checks, nutzaps. Accepted-but-unflushed PAYs are kept in `<storage>/payments/
 *            pending.jsonl`, the daemon's append-only journal (`PendingJournalCore`, ADR 0011
 *            §12: appended and fsynced before the ACK, compacted as it grows; an old
 *            `pending.json` is migrated), and accepted secrets in `seen.jsonl`. The proofs in
 *            both are P2PK-locked to our wallet key or the creator's, so a copy of the files
 *            spends nothing. At `WORKER_MAX_PENDING_PAYS` queued PAYs (a mint down) the
 *            worker stops serving until a flush drains the queue. A PAY's DLEQ checks run
 *            off this event loop (security review F5, issue #8 d): on a `Bare.Thread`
 *            (`dleq-thread.ts`), or inline in small chunks where there is none.
 */
import type {
  BlockRange,
  CoreKeyHex,
  MintKeyset,
  MintUrl,
  NostrEvent,
  PricePolicy,
  Sats,
  UnixSeconds,
} from '@sovit/core';
import { DEFAULT_WINDOW_BLOCKS, payProtocol, payment } from '@sovit/core';
import { JournalReadError, PendingJournalCore, replayJournal } from '@sovit/seeder';
import type { Logger } from '@sovit/seeder';

import type { SessionId } from '../../ipc/protocol.js';
import type { HostMethod, HostMethodTable, WorkerInit } from '../../ipc/worker-protocol.js';
import type { StateFs } from '../runtime.js';
import type { WorkerProviders } from '../providers.js';
import { dleqVerifier, type DleqVerifier, type SpawnDleqThread } from './dleq-thread.js';

export type HostRequester = <M extends HostMethod>(
  m: M,
  a: HostMethodTable[M][0],
) => Promise<HostMethodTable[M][1]>;

/** Secrets kept in memory (~300 B each): older replays are caught at the mint. */
export const WORKER_SEEN_CAPACITY = 100_000;

/**
 * Accepted-but-unflushed PAYs the worker holds before it stops serving (one user's node; the
 * daemon's cap is 4096). Nothing redeems while a mint is down, and each PAY in the queue is
 * proofs held in memory and on disk.
 */
export const WORKER_MAX_PENDING_PAYS = 1024;

export interface RealProviderOptions {
  readonly payments: NonNullable<WorkerInit['payments']>;
  /** `<storage>/payments` (created 0700). */
  readonly dir: string;
  readonly join: (...p: string[]) => string;
  readonly state: StateFs;
  readonly request: HostRequester;
  /**
   * Fix round 5: the play sessions whose blocks cover all of `range` — open ones first, then those
   * closing (their tail being paid) — in the order to ask the host (it pays only for a session,
   * and only within that session's blob). Empty: nothing may pay for these blocks.
   */
  readonly sidsFor: (range: BlockRange) => readonly SessionId[];
  /** The highest per-block price among the cores this node serves (HELLO's ceiling). */
  readonly priceCeiling: () => Sats;
  readonly logger: Logger;
  /** The serving cap (default `WORKER_MAX_PENDING_PAYS`; 0 never serves — fails closed). */
  readonly maxPendingPays?: number;
  /** The runtime's DLEQ thread (issue #8 d); without one the checks run inline, chunked. */
  readonly dleqThread?: SpawnDleqThread;
}

/** What HELLO's ceiling is read from: the worker's `Seeder`. */
export interface ServedPrices {
  corePolicyMap(): ReadonlyMap<CoreKeyHex, PricePolicy>;
  readonly blobs: { openCores(): readonly { readonly keyHex: CoreKeyHex }[] };
}

/**
 * HELLO's ceiling (ADR 0012 §4): the highest per-block price among the cores this node serves
 * NOW — the cores open in this run (the seeder gates and prices exactly those), each at its own
 * policy. 0 before the seeder exists, or with nothing priced open.
 *
 * F54 (the round-8 verifier): it was the highest price in `corePolicyMap()`, which since lane
 * W8b-p2p also holds the policies of earlier runs (`core-policies.json`, up to 16 384 cores — kept
 * so a core sold before a restart is never marked free). The ceiling then never came down: one
 * 5-sat video played once, or one hostile manifest at any price, fixed it until 16 384 newer
 * policies pushed it out. A kept policy still refuses free (`setFreeCore`); it only stops
 * counting here while its core is not open.
 */
export function servedPriceCeiling(seeder: ServedPrices | null): Sats {
  let max = 0;
  if (seeder === null) return max as Sats;
  const policies = seeder.corePolicyMap();
  for (const sc of seeder.blobs.openCores()) {
    const p = policies.get(sc.keyHex);
    if (p !== undefined) max = Math.max(max, p.satsPerBlock);
  }
  return max as Sats;
}

/** What a failed redeem looks like to the engine: `code: 'spent'` marks a double-spend. */
class RedeemError extends Error {
  constructor(readonly code: 'spent' | 'redeem-failed') {
    super(code === 'spent' ? 'spent: the mint reports a proof as already spent' : 'redeem failed');
  }
}

/** The seen-secret log: JSON lines, rotated to `.1` every `capacity` lines (two generations). */
function seenLog(
  state: StateFs,
  path: string,
  capacity: number,
  log: Logger,
): { load: () => string[]; append: (s: readonly string[]) => void } {
  let lines = 0;
  const read = (p: string): { secrets: string[]; lines: number } => {
    const text = state.readText(p);
    if (text === null) return { secrets: [], lines: 0 };
    const rows = text.split('\n').filter((l) => l.length > 0);
    const secrets: string[] = [];
    for (const r of rows) {
      try {
        const v: unknown = JSON.parse(r);
        if (typeof v === 'string' && v.length > 0) secrets.push(v);
      } catch {
        // a torn last line; the mint still catches a replay
      }
    }
    return { secrets, lines: rows.length };
  };
  const rotate = (): void => {
    state.rename(path, `${path}.1`);
    lines = 0;
  };
  return {
    load: () => {
      const older = read(`${path}.1`);
      const current = read(path);
      lines = current.lines;
      if (lines >= capacity) rotate();
      return [...older.secrets, ...current.secrets].slice(-capacity);
    },
    append: (secrets) => {
      try {
        state.append(path, secrets.map((x) => JSON.stringify(x)).join('\n') + '\n');
        lines += secrets.length;
        if (lines >= capacity) rotate();
      } catch (err) {
        log.error('seen-secrets append failed (a cache: the mint still catches replays)', {
          error: err,
        });
      }
    },
  };
}

function loadPending(state: StateFs, path: string): payment.PendingPay[] {
  const text = state.readText(path);
  if (text === null) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  const o = raw as { v?: unknown; items?: unknown } | null;
  if (o?.v !== 1 || !Array.isArray(o.items))
    throw new Error('the pending-PAY file is unreadable — payments stay off rather than drop them');
  // Each item is re-checked by `restorePending` (untrusted input there).
  return o.items as payment.PendingPay[];
}

export interface RealProviders extends WorkerProviders {
  readonly engine: payment.RealPaymentEngine;
  /** The seller engine's off-loop DLEQ checks (issue #8 d). */
  readonly dleq: DleqVerifier;
}

/** Build the real providers. Throws when the pending-PAY file cannot be trusted. */
export function realProviders(o: RealProviderOptions): RealProviders {
  const log = o.logger.child({ component: 'payments' });
  o.state.mkdirp(o.dir);
  const journalPath = o.join(o.dir, 'pending.jsonl');
  const legacyPath = o.join(o.dir, 'pending.json');
  const text = o.state.readText(journalPath);
  let pending: payment.PendingPay[];
  if (text !== null) {
    try {
      pending = replayJournal(text);
    } catch (err) {
      if (!(err instanceof JournalReadError)) throw err;
      throw new Error(
        'the pending-PAY journal is unreadable — payments stay off rather than drop them',
        { cause: err },
      );
    }
  } else pending = loadPending(o.state, legacyPath);
  const journal = new PendingJournalCore(
    {
      append: (t) => {
        o.state.appendDurable(journalPath, t);
      },
      rewrite: (t) => {
        o.state.writeAtomic(journalPath, t);
      },
    },
    pending,
  );
  // A fresh journal of what was loaded, before anything else is accepted; then the old file goes.
  journal.compact();
  o.state.remove(legacyPath);
  const seenFile = seenLog(o.state, o.join(o.dir, 'seen.jsonl'), WORKER_SEEN_CAPACITY, log);
  const seen = new payment.SeenSecrets({
    capacity: WORKER_SEEN_CAPACITY,
    persist: seenFile.append,
  });
  seen.restore(seenFile.load());

  const { payments, request } = o;
  // F5 on the desktop (issue #8 d): a PAY's DLEQ checks leave this event loop, which serves
  // every peer's blocks and pay/1; a thread failure means chunked inline checks, never acceptance.
  const dleq = dleqVerifier({
    spawn: o.dleqThread,
    verify: (proof, keyset) => payment.proofDleqOk(proof, keyset),
    logger: log,
  });
  const engine = new payment.RealPaymentEngine({
    config: {
      windowBlocks: DEFAULT_WINDOW_BLOCKS,
      acceptedMints: [...payments.mints],
      ownP2pk: payments.p2pk,
      ownPubkey: payments.pubkey,
      flushEveryBlocks: 64,
      flushEveryMs: 60_000,
    },
    seen,
    dleq: dleq.verify,
    keyset: async (mint: MintUrl, id: string): Promise<MintKeyset | undefined> =>
      (await request('seller.keyset', { mint, id })) ?? undefined,
    redeem: async (set) => {
      const r = await request('seller.redeem', { mint: set.mint, proofs: set.proofs });
      if (r.ok) return r.sats;
      throw new RedeemError(r.spent ? 'spent' : 'redeem-failed');
    },
    checkSpent: (set) => request('seller.checkSpent', { mint: set.mint, proofs: set.proofs }),
    spentByUs: (set) => request('seller.spentByUs', { mint: set.mint, proofs: set.proofs }),
    nutzap: async (set, ctx) => {
      await request('seller.nutzap', { set, core: ctx.core });
    },
    persistPending: (items) => {
      try {
        journal.persist(items);
      } catch (err) {
        log.error('pending-PAY write failed: accepted payments are in memory only', {
          error: err,
        });
        throw err;
      }
    },
  });
  engine.restorePending(pending);
  if (pending.length > 0) log.info('restored accepted PAYs', { pending: engine.pendingCount() });

  // The host signs our HELLO; it sees only the challenge (and signs nothing else for us).
  const hostSigner = {
    signEvent: async (t: {
      kind: number;
      created_at: number;
      tags: string[][];
      content: string;
    }): Promise<NostrEvent> => {
      const challenge = t.tags.find((x) => x[0] === 'challenge')?.[1];
      if (challenge === undefined) throw new Error('invalid-argument: HELLO without a challenge');
      const r = await request('pay.hello', { challenge });
      return {
        ...t,
        pubkey: r.pubkey,
        created_at: r.createdAt,
        sig: r.signature,
        id: '',
      } as unknown as NostrEvent;
    },
  };

  return {
    engine,
    dleq,
    seederEngine: engine,
    accepting: () => engine.pendingCount() < (o.maxPendingPays ?? WORKER_MAX_PENDING_PAYS),
    pay: async (range, seeder, policy: PricePolicy, opts) => {
      // The carry of this channel's chain for the core (the payer always passes it). Without it
      // the host would split with a guess, and a seeder holding another carry refuses the PAY
      // `malformed` after the proofs were spent (independent review, lane P2-owed-viewer, HIGH):
      // refused here, before the host is asked.
      const carryIn = opts?.carryIn;
      if (carryIn === undefined)
        throw new Error('internal: a PAY without the carry of its chain is never built');
      const sids = o.sidsFor(range);
      if (sids.length === 0) throw new Error('session-closed: no play session covers these blocks');
      // Fix round 5: a session's refusal ('forbidden', 'session-closed') is not the last word
      // while another session covering the same blocks may take the PAY. Anything else (no
      // balance, the host busy) would fail alike for every session: it goes back to the payer.
      let refusal: unknown;
      for (const sid of sids) {
        try {
          return await request('pay.build', {
            sid,
            range,
            seeder,
            policy,
            carryIn,
          });
        } catch (err) {
          const code = (err as { code?: unknown } | null)?.code;
          if (code !== 'forbidden' && code !== 'session-closed') throw err;
          refusal = err;
        }
      }
      throw refusal;
    },
    // Lane P2-owed-viewer: the recorded session's id — never another session's (the host pays a
    // tail only under its own authorisation, like any PAY).
    payOwed: (sid, range, seeder, policy, carryIn) =>
      request('pay.build', { sid: sid as SessionId, range, seeder, policy, carryIn }),
    viewerMints: payments.mints,
    payWiring: {
      protocol: () =>
        new payProtocol.PayChannel({
          onProtocolError: (why) => {
            log.info('pay/1 protocol error', { why });
          },
        }),
      hello: async (binding) => {
        if (binding === null) throw new Error('no Noise handshake on this connection');
        return payProtocol.buildHello(
          hostSigner,
          binding,
          {
            acceptedMints: [...payments.mints],
            satsPerBlock: o.priceCeiling(),
            split: { seeder: 50, creator: 50 },
            p2pk: payments.p2pk,
            windowBlocks: DEFAULT_WINDOW_BLOCKS,
          },
          () => Math.floor(Date.now() / 1000) as UnixSeconds,
        );
      },
    },
    pubkey: payments.pubkey,
    creditBlocks: DEFAULT_WINDOW_BLOCKS,
    loopbackOnly: false,
    close: () => {
      // Never blocks: the thread is joined in the background once it says it is leaving.
      void dleq.close();
    },
  };
}

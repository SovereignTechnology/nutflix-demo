/**
 * Blossom request authorisation (Stage 2 PART A step 5): kind 24242 tokens for BUD-02 upload,
 * BUD-04 mirror and the BUD-01/BUD-12 `get`/`list`/`delete` verbs, and the BUD-09 report event.
 *
 * The signature check is `@sovit/core`'s verification boundary (`nostr.classifyIncoming`, T9):
 * it rebuilds the event from primitives and hands it to nostr-tools, so nothing here touches a
 * curve or a hash. Everything after it is policy on an authentic event, checked in this order:
 *
 *   1. `Authorization: Nostr <base64 JSON>` — strict base64, UTF-8, ≤ MAX_EVENT_BYTES
 *   2. signature (malformed / bad-signature)
 *   3. kind — 24242, or 1984 for the `report` verb (ADR 0010 item 4)
 *   4. time — `created_at` not in the future (CLOCK_SKEW_SEC), not older than `maxAgeSec`;
 *      exactly one `expiration` tag (optional for a report), strictly after `now`
 *   5. verb — exactly one `t` tag naming the verb; `mirror` takes the original `upload` token
 *      (BUD-04); a report carries no `t`
 *   6. hash — the requested sha256 among the `x` tags, exact string equality
 *   7. server — when this gateway knows its host and the token names servers (`server` tags,
 *      as nostr-tools' Blossom client writes them), its host must be one of them
 *   8. deny / allow lists (403)
 *   9. replay — an event id is accepted at most once, remembered until the token could no longer
 *      pass step 4; a rejected event is never consumed
 *
 * Allow list: `allow()` on any pubkey switches the instance to allow-list mode, where only allowed
 * pubkeys pass — except for reports, which anyone not denied may file. `allow()` also lifts a
 * deny and `deny()` removes an allow; the later call wins.
 *
 * The replay memory is bounded (`capacity`). When it is full of tokens that are still live the
 * answer is 503 `busy`, never an eviction: evicting a live token re-opens it to replay.
 *
 * Nothing here logs, and a rejection carries only `{ ok, status, reason }` — never the token.
 */
import { nostr } from '@sovit/core';
import type { NostrEvent, NostrPubkey, Sha256Hex } from '@sovit/core';

import type {
  BlossomAuth,
  BlossomAuthReason,
  BlossomAuthRequest,
  BlossomAuthResult,
  BlossomVerb,
} from './index.js';

export const KIND_BLOSSOM_AUTH = 24242;
/** NIP-56 report — the body of BUD-09 `PUT /report`, passed here under the `report` verb. */
export const KIND_REPORT = 1984;
/** Largest decoded event accepted (a kind 24242 token is a few hundred bytes). */
export const MAX_EVENT_BYTES = 64 * 1024;
/** How far in the future `created_at` may be (the signer's clock may run a little fast). */
export const CLOCK_SKEW_SEC = 60;
/** Default ceiling on a token's age, whatever its `expiration` says (nostr-tools' default life). */
export const DEFAULT_MAX_AGE_SEC = 3600;
export const DEFAULT_REPLAY_CAPACITY = 200_000;

const HEX64 = /^[0-9a-f]{64}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,14})$/;
const SCHEME = /^nostr /i;
/** Replay entries are kept this long past their last possible use (tolerates a clock step). */
const SWEEP_MARGIN_SEC = 300;
const BUCKET_SEC = 60;

export interface BlossomAuthOptions {
  /**
   * This gateway's host as clients name it (`new URL(publicUrl).hostname`). Tokens carrying
   * `server` tags must name it. Omitted = `server` tags are not checked.
   */
  readonly serverHost?: string;
  /** Ceiling on `now − created_at` (default DEFAULT_MAX_AGE_SEC). */
  readonly maxAgeSec?: number;
  /** Most tokens remembered for replay protection (default DEFAULT_REPLAY_CAPACITY). */
  readonly capacity?: number;
}

type Failure = Extract<BlossomAuthResult, { ok: false }>;

const STATUS: Readonly<Record<BlossomAuthReason, Failure['status']>> = {
  malformed: 401,
  'bad-signature': 401,
  'wrong-kind': 401,
  expired: 401,
  'wrong-verb': 401,
  'wrong-hash': 401,
  'wrong-server': 401,
  replayed: 401,
  denied: 403,
  busy: 503,
};

const fail = (reason: BlossomAuthReason): Failure => ({
  ok: false,
  status: STATUS[reason],
  reason,
});

/** Verbs whose request names a blob: the token must carry its hash. */
const TARGETS_BLOB: Readonly<Record<BlossomVerb, boolean>> = {
  upload: true,
  delete: true,
  mirror: true,
  report: true,
  get: false, // only when the request carries a hash
  list: false,
};

/** Decode `Nostr <base64>` into untrusted JSON, or `undefined` if it is not that shape. */
function decodeHeader(header: string): unknown {
  if (typeof header !== 'string' || !SCHEME.test(header)) return undefined;
  const b64 = header.slice(6);
  // Base64 length bound first: 4 chars per 3 bytes.
  if (b64.length === 0 || b64.length > Math.ceil(MAX_EVENT_BYTES / 3) * 4) return undefined;
  const url = !B64.test(b64);
  if (url && !B64URL.test(b64)) return undefined;
  const bytes = Buffer.from(b64, url ? 'base64url' : 'base64');
  if (bytes.length === 0 || bytes.length > MAX_EVENT_BYTES) return undefined;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeHost(s: string): string {
  const v = s.trim().toLowerCase();
  try {
    return new URL(v.includes('://') ? v : `https://${v}`).hostname;
  } catch {
    return v;
  }
}

function tagValuesNamed(ev: NostrEvent, name: string): string[] {
  const out: string[] = [];
  for (const t of ev.tags) if (t[0] === name) out.push(t[1] ?? '');
  return out;
}

export class BlossomAuthImpl implements BlossomAuth {
  private readonly serverHost: string | null;
  private readonly maxAgeSec: number;
  private readonly capacity: number;
  private readonly allowed = new Set<NostrPubkey>();
  private readonly denied = new Set<NostrPubkey>();
  /** Accepted event id → the last second at which it could pass the time checks. */
  private readonly seen = new Map<string, number>();
  /** `floor(until / BUCKET_SEC)` → ids, so a sweep drops whole buckets. */
  private readonly buckets = new Map<number, string[]>();
  private lastSweep = Number.NEGATIVE_INFINITY;

  constructor(opts: BlossomAuthOptions = {}) {
    this.serverHost =
      opts.serverHost !== undefined && opts.serverHost !== ''
        ? normalizeHost(opts.serverHost)
        : null;
    this.maxAgeSec = opts.maxAgeSec ?? DEFAULT_MAX_AGE_SEC;
    this.capacity = opts.capacity ?? DEFAULT_REPLAY_CAPACITY;
    if (!Number.isSafeInteger(this.maxAgeSec) || this.maxAgeSec <= 0)
      throw new TypeError('invalid-argument: maxAgeSec must be a positive integer');
    if (!Number.isSafeInteger(this.capacity) || this.capacity <= 0)
      throw new TypeError('invalid-argument: capacity must be a positive integer');
  }

  allow(pubkey: NostrPubkey): void {
    if (!HEX64.test(pubkey)) throw new TypeError('invalid-argument: pubkey must be 64 hex');
    this.denied.delete(pubkey);
    this.allowed.add(pubkey);
  }

  deny(pubkey: NostrPubkey): void {
    if (!HEX64.test(pubkey)) throw new TypeError('invalid-argument: pubkey must be 64 hex');
    this.allowed.delete(pubkey);
    this.denied.add(pubkey);
  }

  /** Tokens currently remembered (tests, metrics). */
  remembered(): number {
    return this.seen.size;
  }

  verify(req: BlossomAuthRequest): Promise<BlossomAuthResult> {
    return Promise.resolve(this.check(req));
  }

  private check(req: BlossomAuthRequest): BlossomAuthResult {
    const now = req.now;
    if (!Number.isSafeInteger(now) || now < 0) return fail('malformed');

    // 1–2: shape and signature, through the core verification boundary.
    const raw = decodeHeader(req.header);
    if (raw === undefined || typeof raw !== 'object' || raw === null || Array.isArray(raw))
      return fail('malformed');
    const verdict = nostr.classifyIncoming(raw);
    if (verdict.event === null)
      return fail(verdict.reason === 'bad-signature' ? 'bad-signature' : 'malformed');
    const ev = verdict.event;

    // 3: kind.
    const isReport = req.verb === 'report';
    if (ev.kind !== (isReport ? KIND_REPORT : KIND_BLOSSOM_AUTH)) return fail('wrong-kind');

    // 4: time.
    const createdAt = ev.created_at;
    if (createdAt > now + CLOCK_SKEW_SEC) return fail('expired');
    if (now - createdAt > this.maxAgeSec) return fail('expired');
    const expirations = tagValuesNamed(ev, 'expiration');
    if (expirations.length > 1) return fail('malformed');
    let expiration = Number.POSITIVE_INFINITY;
    const [expRaw] = expirations;
    if (expRaw === undefined) {
      if (!isReport) return fail('expired');
    } else {
      if (!DECIMAL.test(expRaw)) return fail('malformed');
      expiration = Number(expRaw);
      if (expiration <= now) return fail('expired');
    }

    // 5: verb.
    if (!isReport) {
      const ts = tagValuesNamed(ev, 't');
      if (ts.length > 1) return fail('malformed');
      const want = req.verb === 'mirror' ? 'upload' : req.verb;
      if (ts[0] !== want) return fail('wrong-verb');
    }

    // 6: hash.
    if (TARGETS_BLOB[req.verb] || (req.verb === 'get' && req.sha256 !== undefined)) {
      const sha: Sha256Hex | undefined = req.sha256;
      if (sha === undefined || !tagValuesNamed(ev, 'x').includes(sha)) return fail('wrong-hash');
    }

    // 7: server scope.
    if (!isReport && this.serverHost !== null) {
      const servers = tagValuesNamed(ev, 'server');
      if (servers.length > 0 && !servers.some((s) => normalizeHost(s) === this.serverHost))
        return fail('wrong-server');
    }

    // 8: lists.
    const pubkey = ev.pubkey;
    if (this.denied.has(pubkey)) return fail('denied');
    if (!isReport && this.allowed.size > 0 && !this.allowed.has(pubkey)) return fail('denied');

    // 9: replay, then consume.
    if (this.seen.has(ev.id)) return fail('replayed');
    this.sweep(now, this.seen.size >= this.capacity);
    if (this.seen.size >= this.capacity) return fail('busy');
    this.remember(ev.id, Math.min(expiration - 1, createdAt + this.maxAgeSec));
    return { ok: true, pubkey, event: ev };
  }

  private remember(id: string, until: number): void {
    this.seen.set(id, until);
    const b = Math.floor(until / BUCKET_SEC);
    const bucket = this.buckets.get(b);
    if (bucket === undefined) this.buckets.set(b, [id]);
    else bucket.push(id);
  }

  /** Forget tokens that can no longer pass the time checks. At most once a minute unless full. */
  private sweep(now: number, force: boolean): void {
    if (!force && now - this.lastSweep < BUCKET_SEC) return;
    this.lastSweep = now;
    const horizon = now - SWEEP_MARGIN_SEC;
    for (const [b, ids] of this.buckets) {
      if ((b + 1) * BUCKET_SEC > horizon) continue;
      for (const id of ids) this.seen.delete(id);
      this.buckets.delete(b);
    }
  }
}

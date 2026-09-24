/**
 * Blossom request authorisation — kind 24242 verification for BUD-02/04/09 (and the BUD-01/12
 * `get`/`list`/`delete` verbs), replay protection, expiry, allow/deny lists. The implementation
 * is `BlossomAuthImpl` (`blossom-auth.ts`); SECURITY.md §locked covered this directory until
 * Stage 2.
 */
import type { NostrEvent, NostrPubkey, Sha256Hex } from '@sovit/core';

export type BlossomVerb = 'upload' | 'delete' | 'list' | 'get' | 'mirror' | 'report';

export interface BlossomAuthRequest {
  readonly verb: BlossomVerb;
  /**
   * Raw `Authorization: Nostr <base64 event>` header value. For `report` it is the BUD-09 body
   * (the signed NIP-56 kind 1984 event) in the same encoding (ADR 0010 item 4).
   */
  readonly header: string;
  /** sha256 the request is about, when the verb targets a blob. */
  readonly sha256?: Sha256Hex;
  /** The request's clock, unix seconds. */
  readonly now: number;
}

export type BlossomAuthReason =
  | 'malformed'
  | 'bad-signature'
  | 'wrong-kind'
  | 'expired'
  | 'wrong-verb'
  | 'wrong-hash'
  /** The token names `server`s and this gateway is not one of them. */
  | 'wrong-server'
  | 'replayed'
  | 'denied'
  /** Replay memory is full of live tokens; retry later (503). */
  | 'busy';

export type BlossomAuthResult =
  | { readonly ok: true; readonly pubkey: NostrPubkey; readonly event: NostrEvent }
  | {
      readonly ok: false;
      readonly status: 401 | 403 | 503;
      readonly reason: BlossomAuthReason;
    };

export interface BlossomAuth {
  verify(req: BlossomAuthRequest): Promise<BlossomAuthResult>;
  allow(pubkey: NostrPubkey): void;
  deny(pubkey: NostrPubkey): void;
}

export { BlossomAuthImpl } from './blossom-auth.js';
export type { BlossomAuthOptions } from './blossom-auth.js';

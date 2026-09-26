/**
 * Fix round 5 (the verifier of fix round 4, HIGH): which play session pays which blocks.
 *
 * Every rendition of an upload lives in the uploader's one core (`Seeder.putFile` with no core),
 * each as its own blob, stored side by side. A rendition switch opens the new session BEFORE it
 * closes the old one, and two windows may play one core. The host builds a PAY for ONE session
 * and only within that session's blob, so:
 *
 *   - a PAY is built for a session whose blob covers ALL of its range — open sessions first, then
 *     those closing (their tail being paid; the host revokes them only once that is done);
 *   - a PAY never crosses a session's blob boundary: two renditions side by side would otherwise
 *     merge into one run that no session covers, and both tails would be given up.
 */
import type { BlockRange, CoreKeyHex } from '@sovit/core';

import type { SessionId } from '../../ipc/protocol.js';

/** What these rules need of a worker play session. */
export interface SessionSpan {
  readonly sid: SessionId;
  readonly core: CoreKeyHex;
  /** The first and last block of its rendition's blob in `core`. */
  readonly first: number;
  readonly last: number;
  /** Closed to the host, its tail being paid. */
  readonly closed: boolean;
}

/** The sessions whose blob covers all of `range`, open ones first, then closing ones. */
export function sessionsCovering(range: BlockRange, sessions: Iterable<SessionSpan>): SessionId[] {
  const open: SessionId[] = [];
  const closing: SessionId[] = [];
  for (const s of sessions)
    if (s.core === range.core && s.first <= range.fromBlock && range.toBlock <= s.last)
      (s.closed ? closing : open).push(s.sid);
  return [...open, ...closing];
}

/**
 * The longest prefix of `range` that stays on one side of every session's blob boundary in its
 * core (a session starting inside it, or one ending inside it, ends the prefix).
 */
export function boundToSessions(range: BlockRange, sessions: Iterable<SessionSpan>): BlockRange {
  let to = range.toBlock;
  for (const s of sessions) {
    if (s.core !== range.core) continue;
    if (s.first > range.fromBlock && s.first <= to) to = s.first - 1;
    if (s.last >= range.fromBlock && s.last < to) to = s.last;
  }
  return to === range.toBlock ? range : { ...range, toBlock: to };
}

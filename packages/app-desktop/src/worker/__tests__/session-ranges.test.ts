/**
 * Fix round 5 (the verifier of fix round 4, HIGH): which play session pays which blocks, when two
 * sessions share a core (a rendition switch opens the new one before it closes the old one; two
 * windows). `sessionsCovering` names the sessions a PAY may be built for; `boundToSessions` keeps
 * one PAY from crossing a rendition's end.
 */
import type { CoreKeyHex } from '@sovit/core';
import { describe, expect, it } from 'vitest';

import type { SessionId } from '../../ipc/protocol.js';
import type { SessionSpan } from '../pay/session-ranges.js';
import { boundToSessions, sessionsCovering } from '../pay/session-ranges.js';

const CORE = 'c1'.repeat(32) as CoreKeyHex;
const OTHER = 'c2'.repeat(32) as CoreKeyHex;
const sid = (c: string) => c.repeat(32) as SessionId;
const span = (
  s: string,
  first: number,
  last: number,
  closed = false,
  core = CORE,
): SessionSpan => ({
  sid: sid(s),
  core,
  first,
  last,
  closed,
});
const r = (fromBlock: number, toBlock: number, core = CORE) => ({ core, fromBlock, toBlock });

describe('sessionsCovering', () => {
  // The verifier's case: A (blocks 30..36) closing, B (37..60) the new rendition, open. By core
  // alone the open B was named for A's tail.
  const A = span('a', 30, 36, true);
  const B = span('b', 37, 60);

  it('names the session whose blob covers the range — the closing one for its own tail, not the open one beside it', () => {
    expect(sessionsCovering(r(36, 36), [A, B])).toEqual([sid('a')]);
    expect(sessionsCovering(r(37, 40), [A, B])).toEqual([sid('b')]);
  });

  it('open sessions first, then closing ones (two windows on one blob)', () => {
    const closing = span('c', 30, 36, true);
    const open1 = span('d', 30, 36);
    const open2 = span('e', 30, 36);
    expect(sessionsCovering(r(31, 33), [closing, open1, open2])).toEqual([
      sid('d'),
      sid('e'),
      sid('c'),
    ]);
  });

  it('nobody for a range no single session covers, another core, or blocks outside every blob', () => {
    expect(sessionsCovering(r(35, 38), [A, B])).toEqual([]);
    expect(sessionsCovering(r(36, 36, OTHER), [A, B])).toEqual([]);
    expect(sessionsCovering(r(61, 61), [A, B])).toEqual([]);
    expect(sessionsCovering(r(29, 30), [A, B])).toEqual([]);
    expect(sessionsCovering(r(36, 36), [])).toEqual([]);
  });
});

describe('boundToSessions', () => {
  const A = span('a', 30, 36, true);
  const B = span('b', 37, 60);

  it('a run across two renditions side by side stops at the first one’s end; the rest starts the next PAY', () => {
    expect(boundToSessions(r(35, 40), [A, B])).toEqual(r(35, 36));
    expect(boundToSessions(r(37, 40), [A, B])).toEqual(r(37, 40));
  });

  it('a run from outside every blob stops where a session starts', () => {
    expect(boundToSessions(r(25, 33), [A])).toEqual(r(25, 29));
    expect(boundToSessions(r(61, 70), [A, B])).toEqual(r(61, 70));
  });

  it('inside one blob, or another core: unchanged (the same object)', () => {
    const inside = r(31, 34);
    expect(boundToSessions(inside, [A, B])).toBe(inside);
    const other = r(35, 40, OTHER);
    expect(boundToSessions(other, [A, B])).toBe(other);
    expect(boundToSessions(r(35, 40), [])).toEqual(r(35, 40));
  });

  it('several boundaries inside the run: the nearest one wins', () => {
    const C = span('c', 38, 39);
    expect(boundToSessions(r(35, 45), [B, C, A])).toEqual(r(35, 36));
    expect(boundToSessions(r(37, 45), [B, C, A])).toEqual(r(37, 37));
    expect(boundToSessions(r(38, 45), [B, C, A])).toEqual(r(38, 39));
  });
});

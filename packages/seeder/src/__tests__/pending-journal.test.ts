/**
 * The runtime-neutral pending-PAY journal (`PendingJournalCore`), shared by the daemon and the
 * desktop worker: only changes are appended, it compacts itself, and it replays to what it holds.
 */
import type { payment } from '@sovit/core';
import { describe, expect, it } from 'vitest';

import {
  JOURNAL_COMPACT_FACTOR,
  JournalReadError,
  PendingJournalCore,
  journalText,
  replayJournal,
} from '../payment/pending-journal.js';

type PendingPay = payment.PendingPay;

function pay(n: number, stage: PendingPay['stage'] = 'redeem'): PendingPay {
  return {
    peer: 'ab'.repeat(32),
    stage,
    msg: {
      range: { core: 'cd'.repeat(32), fromBlock: n * 4, toBlock: n * 4 + 3 },
      seederProofs: { proofs: [{ secret: `s${String(n)}` }] },
      creatorProofs: { proofs: [{ secret: `c${String(n)}` }] },
    },
  } as unknown as PendingPay;
}

function memory() {
  let disk = '';
  const io = {
    append: (t: string) => {
      disk += t;
    },
    rewrite: (t: string) => {
      disk = t;
    },
  };
  return { io, disk: () => disk };
}

describe('PendingJournalCore', () => {
  it('appends only what changed, and replays to the live queue', () => {
    const m = memory();
    const j = new PendingJournalCore(m.io, []);
    j.compact();
    j.persist([pay(1), pay(2)]);
    j.persist([pay(2), pay(3)]); // 1 gone, 3 added: two lines, not a rewrite
    expect(m.disk().trim().split('\n')).toHaveLength(1 + 2 + 2);
    expect(replayJournal(m.disk()).map((p) => p.msg.range.fromBlock)).toEqual([8, 12]);
    j.persist([pay(2, 'nutzap'), pay(3)]); // a stage change: one removal + one addition
    expect(replayJournal(m.disk()).map((p) => p.stage)).toEqual(['redeem', 'nutzap']);
    expect(j.size).toBe(2);
  });

  it('compacts once it holds more than JOURNAL_COMPACT_FACTOR lines per live PAY', () => {
    const m = memory();
    const j = new PendingJournalCore(m.io, []);
    j.compact();
    let worst = 0;
    for (let i = 0; i < 300; i++) {
      j.persist([pay(i), pay(i + 1)]);
      worst = Math.max(worst, m.disk().trim().split('\n').length);
    }
    expect(worst).toBeLessThanOrEqual(Math.max(64, JOURNAL_COMPACT_FACTOR * 2) + 1 + 2);
    expect(m.disk().startsWith(journalText([]).trim())).toBe(true);
  });

  it('a torn last line is skipped; any other damage throws JournalReadError', () => {
    const good = journalText([pay(1)]);
    expect(replayJournal(`${good}{"a":{"pe`)).toHaveLength(1);
    expect(() => replayJournal(`${good}{"a":{"pe\n`)).toThrow(JournalReadError);
    expect(() => replayJournal('{"format":"other","v":1}\n')).toThrow(JournalReadError);
    expect(() => replayJournal('')).toThrow(JournalReadError);
  });
});

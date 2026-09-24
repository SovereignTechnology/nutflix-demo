/**
 * Every cheating mode `MockPaymentEngine` exposes, each asserting the specific
 * `RejectReason` the interface promises. The mode list is `ALL_MODES` in provider.mts,
 * which is checked exhaustive against `MockPaymentMode` at compile time — adding a mode to
 * the mock without adding a row here fails `tsc`, not just this test.
 *
 * `honest` is the control: it must be accepted on every scenario the cheats are run on.
 */
import { describe, expect, it, vi } from 'vitest';
import * as fc from 'fast-check';

import type { RejectReason } from '../../contracts/index.js';
import {
  ALL_MODES,
  CHEATING_MODES,
  CORE_A,
  CORE_B,
  POLICY,
  SEEDER_INFO,
  VIEWER,
  WIDE_WINDOW,
  expectedSequence,
  expectedShares,
  getPair,
  policyWith,
  range,
  sats,
  sumProofs,
  upload,
  type CheatingMode,
} from './provider.mjs';

// The seam returns the REAL engine over real ecash (Stage 2): every property run mints and
// DLEQ-verifies real proofs (~30 ms each in pure JS), so these files need more than the default
// 5 s per test. The number of runs is unchanged.
vi.setConfig({ testTimeout: 240_000 });

/**
 * Mode → the SECURITY.md row it exercises → the reason offline `verify` must return.
 * `double-spend` replays the PREVIOUS PAY's proofs, so its first PAY is honest and only the
 * second is the cheat (`replay: true`). Before v5 offline verification accepted the replay and
 * the swap batch caught it; since v5 `verify` sees the reused secrets itself (ADR 0010).
 */
const EXPECTED: Record<CheatingMode, { row: string; offline: RejectReason; replay?: true }> = {
  'stiff-creator': { row: 'T4', offline: 'wrong-p2pk-target' },
  'stiff-seeder': { row: 'T3', offline: 'missing-seeder-set' },
  'double-spend': { row: 'T5 / INV6', offline: 'double-spend', replay: true },
  forge: { row: 'T7', offline: 'bad-dleq' },
  overpay: { row: 'INV2', offline: 'overpay' },
  underpay: { row: 'INV2', offline: 'wrong-amount' },
};

function shareTotals(s: { readonly seeder: number; readonly creator: number }): {
  readonly swapped: number;
  readonly nutzapped: number;
} {
  return { swapped: s.seeder, nutzapped: s.creator };
}

describe('MockPaymentEngine cheating modes (each mode, each reason)', () => {
  it('enumerates every mode the mock exposes', () => {
    expect([...ALL_MODES].sort()).toEqual(
      [
        'honest',
        'stiff-creator',
        'stiff-seeder',
        'double-spend',
        'forge',
        'overpay',
        'underpay',
      ].sort(),
    );
    expect(CHEATING_MODES).toHaveLength(ALL_MODES.length - 1);
    expect(Object.keys(EXPECTED).sort()).toEqual([...CHEATING_MODES].sort());
  });

  it('honest (control): accepted and credited exactly', async () => {
    const { viewer, seeder } = getPair('honest');
    upload(seeder, VIEWER, 4);
    const msg = await viewer.pay(range(0, 3), SEEDER_INFO, POLICY);
    const shares = expectedShares(4, POLICY);
    expect(await seeder.verify(VIEWER, msg, POLICY)).toEqual({
      ok: true,
      credited: shares.total,
      blocks: 4,
    });
    expect(seeder.window(VIEWER)).toMatchObject({
      uploaded: 4,
      paid: 4,
      outstanding: 0,
      banned: false,
    });
    expect(await seeder.flush()).toEqual({
      swapped: shares.seeder,
      nutzapped: shares.creator,
      failed: 0,
    });
  });

  for (const mode of CHEATING_MODES) {
    const { row, offline, replay } = EXPECTED[mode];
    if (replay !== true) {
      it(`${row}: mode=${mode} → offline verify rejects with '${offline}' and credits nothing`, async () => {
        const { viewer, seeder } = getPair(mode);
        upload(seeder, VIEWER, 4);
        const msg = await viewer.pay(range(0, 3), SEEDER_INFO, POLICY);
        const res = await seeder.verify(VIEWER, msg, POLICY);
        expect(res).toMatchObject({ ok: false, reason: offline });
        expect(seeder.window(VIEWER)).toMatchObject({ uploaded: 4, paid: 0, outstanding: 4 });
        // Nothing reached the swap batch.
        expect(await seeder.flush()).toEqual({ swapped: 0, nutzapped: 0, failed: 0 });
        // Whether a rejected cheat also bans the peer is left to the implementation (SECURITY.md
        // mandates a ban only for window-exceeded and double-spend); what is pinned is that
        // nothing is ever credited.
      });
    } else {
      it(`${row}: mode=${mode} → the first PAY is honest; the replay is refused at verify with '${offline}', the peer is banned, and only the first PAY is swapped`, async () => {
        const { viewer, seeder } = getPair(mode, WIDE_WINDOW);
        upload(seeder, VIEWER, 8);
        const first = await viewer.pay(range(0, 3), SEEDER_INFO, POLICY);
        expect(await seeder.verify(VIEWER, first, POLICY)).toMatchObject({ ok: true });
        const second = await viewer.pay(range(4, 7), SEEDER_INFO, POLICY);
        expect(await seeder.verify(VIEWER, second, POLICY)).toMatchObject({
          ok: false,
          reason: offline,
        });
        expect(seeder.isBanned(VIEWER)).toBe(true);
        expect(seeder.bans().map((b) => b.pubkey)).toEqual([VIEWER]);
        expect(seeder.window(VIEWER)).toMatchObject({ paid: 4 });
        const r = await seeder.flush();
        expect(r).toEqual({ ...shareTotals(expectedShares(4, POLICY)), failed: 0 });
      });
    }
  }

  it('every cheating mode is rejected across arbitrary prices, splits and ranges; honest is always accepted and the creator carry chains across its PAYs', async () => {
    const scenario = fc
      .record({
        blocks: fc.integer({ min: 1, max: 10 }),
        satsPerBlock: fc.integer({ min: 1, max: 16 }),
        seederPct: fc.integer({ min: 1, max: 99 }),
        from: fc.nat(30),
      })
      .map((s) => ({
        ...s,
        policy: policyWith({
          satsPerBlock: sats(s.satsPerBlock),
          split: { seeder: s.seederPct, creator: 100 - s.seederPct },
        }),
      }))
      .filter(({ blocks, policy }) => {
        // Both honest shares must be ≥ 2 sat so `underpay` (−1 on the creator side) and
        // `stiff-*` remain distinguishable from an empty set, for the first PAY and for the
        // second, whose split the carry can move by one sat. See docs/lanes/L10.md §edge.
        const one = expectedShares(blocks, policy);
        const two = expectedShares(blocks, policy, one.carryOut);
        return Math.min(one.seeder, one.creator, two.seeder, two.creator) >= 2;
      });

    await fc.assert(
      fc.asyncProperty(
        scenario,
        fc.constantFrom(...ALL_MODES),
        async ({ blocks, from, policy }, mode) => {
          const { viewer, seeder } = getPair(mode, WIDE_WINDOW);
          upload(seeder, VIEWER, from + 2 * blocks);
          const r1 = range(from, from + blocks - 1);
          const r2 = range(from + blocks, from + 2 * blocks - 1);
          const m1 = await viewer.pay(r1, SEEDER_INFO, policy);
          const v1 = await seeder.verify(VIEWER, m1, policy);
          // The payer's side of the carry rule: the second PAY is split with the carry the
          // seeder holds, i.e. advanced only if the first PAY was accepted (ADR 0010 §viewer).
          const carry = v1.ok ? expectedShares(blocks, policy).carryOut : 0;
          const m2 = await viewer.pay(r2, SEEDER_INFO, policy, { carryIn: carry });
          const v2 = await seeder.verify(VIEWER, m2, policy);
          const flush = await seeder.flush();
          const one = expectedShares(blocks, policy);
          const both = expectedSequence([blocks, blocks], policy);

          if (mode === 'honest') {
            expect(v1).toEqual({ ok: true, credited: one.total, blocks });
            expect(v2).toEqual({ ok: true, credited: one.total, blocks });
            expect(flush).toEqual({ swapped: both.seeder, nutzapped: both.creator, failed: 0 });
            expect(seeder.isBanned(VIEWER)).toBe(false);
            return;
          }
          const expected = EXPECTED[mode];
          if (expected.replay === true) {
            // double-spend: first PAY honest, second replays its proofs → refused at verify.
            // When the carry moved the split by a sat, the replayed amounts no longer match
            // either, and the amount check (which runs first) is what refuses it.
            expect(v1).toMatchObject({ ok: true });
            const sameSplit = expectedShares(blocks, policy, carry).creator === one.creator;
            if (sameSplit) {
              expect(v2).toMatchObject({ ok: false, reason: 'double-spend' });
              expect(seeder.isBanned(VIEWER)).toBe(true);
            } else {
              expect(v2.ok).toBe(false);
              if (!v2.ok) expect(['wrong-amount', 'overpay']).toContain(v2.reason);
            }
            expect(flush).toEqual({ swapped: one.seeder, nutzapped: one.creator, failed: 0 });
          } else {
            expect(v1).toMatchObject({ ok: false, reason: expected.offline });
            // A forged DLEQ against a known keyset bans the peer at once (the real engine's
            // choice — the suite leaves bans on rejection to the implementation), so its next
            // PAY is `peer-banned`; every other cheat is refused with the same reason again.
            expect(v2).toMatchObject({
              ok: false,
              reason: expected.offline === 'bad-dleq' ? 'peer-banned' : expected.offline,
            });
            if (expected.offline === 'bad-dleq') expect(seeder.isBanned(VIEWER)).toBe(true);
            expect(flush).toEqual({ swapped: 0, nutzapped: 0, failed: 0 });
            expect(seeder.window(VIEWER)?.paid).toBe(0);
          }
          // Whatever the cheat, the seeder never credits more than the honest amount.
          expect(flush.swapped).toBeLessThanOrEqual(both.seeder);
          expect(flush.nutzapped).toBeLessThanOrEqual(both.creator);
        },
      ),
      { numRuns: 120 },
    );
  });

  it('the cheating PAYs really are cheats on the wire (the mock produces the attack it claims)', async () => {
    // Guards against a mode silently becoming honest, which would make the rejections above
    // vacuous. Each mode's message must differ from the honest one in the documented way.
    const honestMsg = await getPair('honest').viewer.pay(range(0, 3), SEEDER_INFO, POLICY);
    const shares = expectedShares(4, POLICY);
    for (const mode of CHEATING_MODES) {
      const { viewer } = getPair(mode);
      const a = await viewer.pay(range(0, 3), SEEDER_INFO, POLICY);
      switch (mode) {
        case 'stiff-creator':
          expect(a.creatorProofs.lockedTo).toBe(SEEDER_INFO.p2pk);
          expect(a.creatorProofs.lockedTo).not.toBe(honestMsg.creatorProofs.lockedTo);
          break;
        case 'stiff-seeder':
          expect(a.seederProofs.proofs).toHaveLength(0);
          expect(sumProofs(a.creatorProofs.proofs)).toBe(shares.creator);
          break;
        case 'forge':
          expect(a.seederProofs.proofs.every((p) => p.dleq?.s === 'FORGED')).toBe(true);
          break;
        case 'overpay':
          expect(sumProofs(a.seederProofs.proofs)).toBe(shares.seeder + 1);
          break;
        case 'underpay':
          expect(sumProofs(a.creatorProofs.proofs)).toBe(shares.creator - 1);
          break;
        case 'double-spend': {
          const b = await viewer.pay(range(4, 7), SEEDER_INFO, POLICY);
          expect(b.seederProofs.proofs.map((p) => p.secret)).toEqual(
            a.seederProofs.proofs.map((p) => p.secret),
          );
          expect(b.range).not.toEqual(a.range);
          break;
        }
      }
    }
  });

  it('v3 (ADR 0004 c): naming a core is not a bypass — every cheating mode is rejected with the same reason when the PAY carries `range.core`; honest with a core is accepted; `pay()` passes `core` through unchanged in every mode', async () => {
    for (const mode of ALL_MODES) {
      const { viewer, seeder } = getPair(mode, WIDE_WINDOW);
      upload(seeder, VIEWER, 4, { core: CORE_A });
      upload(seeder, VIEWER, 4, { core: CORE_B });
      const rangeA = range(0, 3, CORE_A);
      const rangeB = range(0, 3, CORE_B);
      const a = await viewer.pay(rangeA, SEEDER_INFO, POLICY);
      const b = await viewer.pay(rangeB, SEEDER_INFO, POLICY);
      // The wire carries exactly the core the viewer was handed — for cheats too.
      expect(a.range, mode).toEqual(rangeA);
      expect(b.range, mode).toEqual(rangeB);

      const va = await seeder.verify(VIEWER, a, POLICY);
      const vb = await seeder.verify(VIEWER, b, POLICY);
      const flush = await seeder.flush();
      const shares = expectedShares(4, POLICY);

      if (mode === 'honest') {
        expect(va, mode).toEqual({ ok: true, credited: shares.total, blocks: 4 });
        expect(vb, mode).toEqual({ ok: true, credited: shares.total, blocks: 4 });
        expect(flush, mode).toEqual({
          swapped: 2 * shares.seeder,
          nutzapped: 2 * shares.creator,
          failed: 0,
        });
        expect(seeder.window(VIEWER), mode).toMatchObject({ uploaded: 8, paid: 8 });
        continue;
      }
      const { offline, replay } = EXPECTED[mode];
      if (replay === true) {
        // double-spend: the second PAY (core B) replays the first's proofs — a different
        // core is not a different proof, and `verify` refuses it (v5).
        expect(va, mode).toMatchObject({ ok: true });
        expect(vb, mode).toMatchObject({ ok: false, reason: offline });
        expect(flush.failed, mode).toBe(0);
        expect(flush.swapped + flush.nutzapped, mode).toBe(shares.total);
        expect(seeder.isBanned(VIEWER), mode).toBe(true);
      } else {
        expect(va, mode).toMatchObject({ ok: false, reason: offline });
        // A forgery bans (see the property above): the second PAY is then `peer-banned`.
        expect(vb, mode).toMatchObject({
          ok: false,
          reason: offline === 'bad-dleq' ? 'peer-banned' : offline,
        });
        expect(flush, mode).toEqual({ swapped: 0, nutzapped: 0, failed: 0 });
        expect(seeder.window(VIEWER)?.paid, mode).toBe(0);
      }
    }
  });
});

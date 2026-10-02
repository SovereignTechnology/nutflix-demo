/**
 * R5-R1 (Cameron, 2026-10-02): resuming auto top-ups past a held one is confirmed in main's
 * native dialog. The host sends data only (`isConfirmForm`); main holds every word, says the hold
 * is waived (still watched), and for money that may still arrive says the mint could be topped
 * up twice.
 */
import type { MintUrl, Sats } from '@sovit/core';
import { describe, expect, it } from 'vitest';

import { isConfirmForm } from '../../ipc/guards.js';
import type { ConfirmForm, TopUpHoldReason } from '../../ipc/protocol.js';
import { describeHostConfirm } from '../host-confirm.js';

const TARGET = 'https://mint.example.com:3338/path' as MintUrl;
const form = (reason: TopUpHoldReason, o: Partial<ConfirmForm> = {}): ConfirmForm =>
  ({ kind: 'topup-resume', target: TARGET, amount: 2_000 as Sats, reason, ...o }) as ConfirmForm;

describe('topup-resume: main words the dialog (R5-R1)', () => {
  it('names the mint by its host, the amount, and that the earlier top-up is still watched', () => {
    const p = describeHostConfirm(form('waiting'));
    expect(p.title).toBe('Auto top-up paused');
    expect(p.message).toBe('Resume auto top-ups into mint.example.com:3338?');
    expect(p.detail).toContain('2,000');
    expect(p.detail).toContain('The earlier one is not cancelled');
    expect(p.detail).toContain('if the mint pays it, the sats are added to your wallet');
    expect(p.confirmLabel).toBe('Resume top-ups');
  });

  it('every reason has its own words; owed warns of a second top-up, unreadable of a signer offline', () => {
    const reasons: TopUpHoldReason[] = ['checking', 'unreadable', 'unreachable', 'owed', 'waiting'];
    const details = reasons.map((r) => describeHostConfirm(form(r)).detail);
    expect(new Set(details).size).toBe(reasons.length);
    expect(describeHostConfirm(form('owed')).detail).toContain('could be topped up twice');
    expect(describeHostConfirm(form('unreadable')).detail).toContain(
      'Your signer may simply be offline',
    );
  });

  it('a look-alike host is shown as its ASCII (IDNA) form', () => {
    const p = describeHostConfirm(form('waiting', { target: 'https://mіnt.example' as MintUrl }));
    expect(p.message).toContain('xn--');
  });
});

describe('topup-resume: the form is data only (isConfirmForm)', () => {
  it('accepts the form the host sends', () => {
    for (const r of ['checking', 'unreadable', 'unreachable', 'owed', 'waiting'] as const)
      expect(isConfirmForm(form(r))).toBe(true);
  });

  it.each([
    ['an unknown reason', { reason: 'later' }],
    ['no amount', { amount: 0 }],
    ['a fractional amount', { amount: 1.5 }],
    ['a target that is not a mint URL', { target: 'javascript:alert(1)' }],
    ['words of its own', { message: 'Click yes' }],
  ])('refuses %s', (_why, patch) => {
    expect(isConfirmForm({ ...form('waiting'), ...patch })).toBe(false);
  });
});

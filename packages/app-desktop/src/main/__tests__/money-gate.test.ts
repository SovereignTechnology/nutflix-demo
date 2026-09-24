/**
 * The confirm gate's pure half (security review F7, F8): what main asks before money moves, a
 * money-relevant setting changes, or a file is published — and that it fails closed.
 */
import { describe, expect, it } from 'vitest';

import { mocks } from '@sovit/core';

import {
  bolt11AmountSats,
  createMoneyGate,
  describeMoneyCall,
  describeSettingsPatch,
  describeUpload,
} from '../money-gate.js';

/** A complete `Settings` value (the shape the host returns). */
const SETTINGS = {
  relays: [],
  defaultMints: [],
  seeding: { enabled: false, diskCapBytes: 0 },
  prefetchSeconds: 30,
  hoverPreview: false,
  theme: 'system',
} as const;

const MINT = mocks.MINTS.a;
const OTHER = mocks.MINTS.b;
const VIDEO = mocks.VIDEOS[0]!.id;

describe('bolt11AmountSats (human-readable part only)', () => {
  it('reads m/u/n/p multipliers and whole BTC; sub-sat, amountless and non-invoices are null', () => {
    expect(bolt11AmountSats('lnbc1500n1pj9x7ac')).toBe(150);
    expect(bolt11AmountSats('lnbc10u1pqqqq')).toBe(1000);
    expect(bolt11AmountSats('LNBC1M1PQQQQ')).toBe(100_000);
    expect(bolt11AmountSats('lntb20m1pqqqq')).toBe(2_000_000);
    expect(bolt11AmountSats('lnbc21pqqqq')).toBe(200_000_000); // 2 BTC: the separator is the LAST '1'
    expect(bolt11AmountSats('lnbc1p1pqqqq')).toBeNull(); // 0.1 msat
    expect(bolt11AmountSats('lnbc1500n1pj9x7abc')).toBeNull(); // 'b' is not bech32
  });

  it('refuses what is not an invoice', () => {
    for (const s of [
      '',
      'lnbc',
      'lnbc1',
      'bitcoin:bc1q',
      'lnbc1500n',
      'lnbc0n1pqqqq',
      'lnbc1500x1pqqqq',
    ])
      expect(bolt11AmountSats(s), s).toBeNull();
    expect(bolt11AmountSats('lnbc1pqqqq')).toBeNull(); // no amount
  });
});

describe('describeMoneyCall', () => {
  it('seeder.melt: the amount comes from the invoice; an invoice without one is refused unasked', () => {
    expect(describeMoneyCall({ wc: 1, method: 'seeder.melt', args: [MINT, 'lnbc1pqqqq'] })).toEqual(
      {
        kind: 'refuse',
        reason: 'the invoice names no whole-sat amount',
      },
    );
    const d = describeMoneyCall({
      wc: 1,
      method: 'seeder.melt',
      args: [MINT, 'lnbc1500n1pqqqqqqqqq'],
    });
    expect(d).toMatchObject({ kind: 'ask', prompt: { confirmLabel: 'Pay 150 sats' } });
  });

  it('wallet.melt and nutzap name the amount and the mint host', () => {
    const melt = describeMoneyCall({
      wc: 1,
      method: 'wallet.melt',
      args: [{ mint: MINT, quoteId: 'q', amount: 1000, feeReserve: 4, expiry: 0, state: 'UNPAID' }],
    });
    expect(melt).toMatchObject({
      kind: 'ask',
      prompt: { message: 'Pay 1,000 sats from your wallet?' },
    });
    const zap = describeMoneyCall({ wc: 1, method: 'nutzap', args: [VIDEO, 1 as never, MINT] });
    expect(zap).toMatchObject({ kind: 'ask', prompt: { confirmLabel: 'Send 1 sat' } });
    if (zap.kind === 'ask') expect(zap.prompt.detail).toContain(new URL(MINT).host);
  });
});

describe('describeSettingsPatch (F4/F8)', () => {
  const known = { ...SETTINGS, defaultMints: [MINT] };

  it('asks only when mints are ADDED or an auto top-up is switched on or changed', () => {
    expect(describeSettingsPatch({ theme: 'light' }, known)).toEqual({ kind: 'allow' });
    expect(describeSettingsPatch({ defaultMints: [] }, known)).toEqual({ kind: 'allow' }); // removal
    expect(describeSettingsPatch({ defaultMints: [MINT] }, known)).toEqual({ kind: 'allow' });
    const add = describeSettingsPatch({ defaultMints: [MINT, OTHER] }, known);
    expect(add).toMatchObject({ kind: 'ask' });
    if (add.kind === 'ask') {
      expect(add.prompt.detail).toContain(OTHER);
      expect(add.prompt.detail).not.toContain(`• ${MINT}`);
    }
    expect(
      describeSettingsPatch({ autoTopUp: { belowSats: 0 as never, fromMint: MINT } }, known),
    ).toEqual({ kind: 'allow' }); // switching it off
    expect(
      describeSettingsPatch({ autoTopUp: { belowSats: 500 as never, fromMint: MINT } }, known),
    ).toMatchObject({ kind: 'ask' });
  });

  it('without known settings every listed mint counts as added', () => {
    expect(describeSettingsPatch({ defaultMints: [MINT] }, undefined)).toMatchObject({
      kind: 'ask',
    });
  });

  it('an unchanged auto top-up is not asked again', () => {
    const on = { ...SETTINGS, autoTopUp: { belowSats: 500 as never, fromMint: MINT } };
    expect(
      describeSettingsPatch({ autoTopUp: { belowSats: 500 as never, fromMint: MINT } }, on),
    ).toEqual({ kind: 'allow' });
  });
});

describe('describeUpload (F7)', () => {
  it('names the file main resolved, strips control and bidi-override characters, bounds the length', () => {
    const d = describeUpload({ name: 'holiday‮gpj.exe\u0007', size: 3 * 1024 * 1024 });
    expect(d).toMatchObject({ kind: 'ask', prompt: { confirmLabel: 'Publish' } });
    if (d.kind === 'ask') {
      expect(d.prompt.message).toBe('Publish “holidaygpj.exe” to the network?');
      expect(d.prompt.detail).toContain('3.0 MiB');
    }
    const long = describeUpload({ name: 'x'.repeat(500), size: 1 });
    if (long.kind === 'ask') expect(long.prompt.message.length).toBeLessThan(160);
  });
});

describe('createMoneyGate — fails closed', () => {
  const zap = { wc: 1, method: 'nutzap', args: [VIDEO, 21, MINT] } as const;
  const upload = { wc: 1, method: 'studio.upload', file: { name: 'a.mp4', size: 1 } } as const;

  it('no dialog available → every question is refused; a refusal decision is never asked', async () => {
    const asked: string[] = [];
    const gate = createMoneyGate({ devMocks: false });
    expect(await gate.confirm(zap as never)).toBe(false);
    const withAsk = createMoneyGate({
      devMocks: false,
      ask: (_wc, p) => {
        asked.push(p.title);
        return Promise.resolve(true);
      },
    });
    expect(
      await withAsk.confirm({ wc: 1, method: 'seeder.melt', args: [MINT, 'lnbc1pqqqq'] }),
    ).toBe(false);
    expect(asked).toEqual([]);
    expect(await withAsk.confirm(zap as never)).toBe(true);
    expect(
      await withAsk.confirm({ wc: 1, method: 'updateSettings', args: [{ theme: 'dark' }] }),
    ).toBe(true);
    expect(asked).toEqual(['Zap the creator']); // the theme change asked nothing
  });

  it('a throwing or non-boolean dialog is a refusal', async () => {
    const throws = createMoneyGate({ devMocks: false, ask: () => Promise.reject(new Error('x')) });
    expect(await throws.confirm(zap as never)).toBe(false);
    const weird = createMoneyGate({ devMocks: false, ask: () => Promise.resolve(1 as never) });
    expect(await weird.confirm(zap as never)).toBe(false);
  });

  it('--dev-mocks skips money and settings questions (mock sats) but never the file question', async () => {
    const asked: string[] = [];
    const gate = createMoneyGate({
      devMocks: true,
      ask: (_wc, p) => {
        asked.push(p.title);
        return Promise.resolve(false);
      },
    });
    expect(await gate.confirm(zap as never)).toBe(true);
    expect(await gate.confirm(upload as never)).toBe(false);
    expect(asked).toEqual(['Publish a video']);
  });
});

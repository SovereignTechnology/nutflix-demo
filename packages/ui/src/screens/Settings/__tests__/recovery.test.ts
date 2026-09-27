/**
 * Settings › Recovery phrase (ADR 0016) under jsdom: every state's copy, the actions each state
 * offers, a restore's progress and per-mint report, a setup's amounts, cancel is silent, the web
 * shell says "not covered". The section only ever calls the shell's action methods — no word
 * goes in or comes out of this screen.
 */
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mocks } from '@sovit/core';
import type { MintUrl, NetworkAdapter, Sats } from '@sovit/core';
import { click, render, type Rendered } from '../../../components/testing/render.js';
import type { Route } from '../../shared/route.js';
import type {
  RecoveryControls,
  RecoveryProgressView,
  RecoveryRestoreView,
  RecoverySetupView,
  RecoveryStatusView,
} from '../RecoverySection.js';
import { SETTINGS_SECTIONS, Settings } from '../Settings.js';

const { MockNetworkAdapter } = mocks;
const MINT_A = 'https://mint-a.example/cashu' as MintUrl;
const MINT_B = 'https://mint-b.example' as MintUrl;

async function flush(rounds = 10): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

const rendered: Rendered[] = [];
afterEach(() => {
  for (const r of rendered.splice(0)) r.unmount();
  vi.restoreAllMocks();
});

function asPlatform(base: NetworkAdapter, platform: NetworkAdapter['platform']): NetworkAdapter {
  return new Proxy(base, {
    get(target, prop, receiver): unknown {
      if (prop === 'platform') return platform;
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

interface Fake extends RecoveryControls {
  readonly calls: string[];
  st: RecoveryStatusView;
  setupResult: RecoverySetupView | Error;
  restoreResult: RecoveryRestoreView | Error;
  showResult: undefined | Error;
  progress?: ((p: RecoveryProgressView) => void) | undefined;
  hold?: Promise<void>;
}

function controls(st: RecoveryStatusView): Fake {
  const f: Fake = {
    calls: [],
    st,
    setupResult: { status: st, reissuedSats: 0 as Sats, feeSats: 0 as Sats, reissueFailed: 0 },
    restoreResult: { phrases: 0, reports: [] },
    showResult: undefined,
    status: () => {
      f.calls.push('status');
      return Promise.resolve(f.st);
    },
    setup: async () => {
      f.calls.push('setup');
      await f.hold;
      if (f.setupResult instanceof Error) throw f.setupResult;
      return f.setupResult;
    },
    show: async () => {
      f.calls.push('show');
      await f.hold;
      if (f.showResult instanceof Error) throw f.showResult;
      return f.showResult;
    },
    restore: async () => {
      f.calls.push('restore');
      await f.hold;
      if (f.restoreResult instanceof Error) throw f.restoreResult;
      return f.restoreResult;
    },
    onProgress: (cb) => {
      f.progress = cb;
      return () => {
        f.progress = undefined;
      };
    },
  };
  return f;
}

async function mount(
  recovery: RecoveryControls | undefined,
  adapter: NetworkAdapter = new MockNetworkAdapter(),
): Promise<Rendered> {
  const navigate = vi.fn<(to: Route) => void>();
  const r = render(createElement(Settings, { adapter, navigate, recovery }));
  rendered.push(r);
  await flush();
  return r;
}

function section(r: Rendered): HTMLElement {
  const h = r.all('h2').find((e) => e.textContent === 'Recovery phrase');
  if (!h) throw new Error('no Recovery phrase section');
  return h.closest('section')!;
}
function button(s: HTMLElement, text: string): HTMLButtonElement {
  const b = Array.from(s.querySelectorAll('button')).find((e) => e.textContent === text);
  if (!b) throw new Error(`no button ${text}`);
  return b;
}

const COVERED: RecoveryStatusView = { state: 'covered', reissuePending: false, relayCopy: true };

describe('Settings › Recovery phrase', () => {
  it('is a section of its own, right after "Mints and top-up"', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(ids.indexOf('recovery')).toBe(ids.indexOf('mints') + 1);
    expect(SETTINGS_SECTIONS.find((s) => s.id === 'recovery')?.label).toBe('Recovery phrase');
  });

  it('web shell: says it is not covered, offers nothing', async () => {
    const r = await mount(undefined, asPlatform(new MockNetworkAdapter(), 'web'));
    const s = section(r);
    expect(s.textContent).toMatch(/Not covered\. The web app keeps no recovery phrase/);
    expect(s.querySelectorAll('button')).toHaveLength(0);
  });

  it('a desktop without the flows (dev mocks): not available in this mode', async () => {
    const r = await mount(undefined);
    expect(section(r).textContent).toMatch(/not available in this mode/);
  });

  it('covered: the state, the relay copy, "Replace phrase", "Show again", "Restore"', async () => {
    const f = controls(COVERED);
    const r = await mount(f);
    const s = section(r);
    expect(s.textContent).toMatch(/Covered\. This device's recovery phrase is here/);
    expect(s.textContent).toMatch(/An encrypted copy is on your relays/);
    for (const b of ['Replace phrase', 'Show again', 'Restore'])
      expect(button(s, b).disabled).toBe(false);
    expect(s.textContent).toMatch(/only ever shown or typed in Nutflix's own window, never here/);
  });

  it('not on this device: only "Set up recovery phrase"; restore needs the phrase first', async () => {
    const f = controls({ state: 'not-on-device', reissuePending: false, relayCopy: false });
    const r = await mount(f);
    const s = section(r);
    expect(s.textContent).toMatch(/Not on this device\. Ecash made here is not covered/);
    expect(button(s, 'Set up recovery phrase').disabled).toBe(false);
    expect(button(s, 'Show again').disabled).toBe(true);
    expect(button(s, 'Restore').disabled).toBe(true);
    expect(s.textContent).toMatch(/Restore needs this device’s own phrase first/);
  });

  it('not confirmed + reissue pending: "Finish backup", and both warnings; no relay copy said so', async () => {
    const f = controls({ state: 'not-confirmed', reissuePending: true, relayCopy: false });
    const r = await mount(f);
    const s = section(r);
    expect(s.textContent).toMatch(/Not confirmed\./);
    expect(s.textContent).toMatch(/Part of your balance is not under the phrase yet/);
    expect(s.textContent).toMatch(/did not reach your relays/);
    expect(button(s, 'Finish backup').disabled).toBe(false);
  });

  it.each([
    ['unreadable', /cannot be opened right now/],
    ['unavailable', /signer/],
  ] as const)('%s: explained, no action', async (state, re) => {
    const f = controls({ state, reissuePending: false, relayCopy: false });
    const r = await mount(f);
    const s = section(r);
    expect(s.textContent).toMatch(re);
    for (const b of s.querySelectorAll('button')) expect(b.disabled).toBe(true);
  });

  it('setup: calls the action only, then says what moved and re-reads the status', async () => {
    const f = controls({ state: 'not-on-device', reissuePending: false, relayCopy: false });
    f.setupResult = {
      status: COVERED,
      reissuedSats: 1_498 as Sats,
      feeSats: 2 as Sats,
      reissueFailed: 1,
    };
    const r = await mount(f);
    const s = section(r);
    f.st = COVERED;
    click(button(s, 'Set up recovery phrase'));
    await flush();
    expect(f.calls.filter((c) => c !== 'status')).toEqual(['setup']);
    expect(s.textContent).toMatch(
      /Recovery phrase saved on this device\. 1,498 sats moved under it \(fee 2 sats\)\./,
    );
    expect(s.textContent).toMatch(/The balance at 1 mint is not covered yet/);
    expect(s.textContent).toMatch(/Covered\./);
  });

  it('while one flow runs every button waits; a second click does nothing', async () => {
    const f = controls(COVERED);
    let release: () => void = () => undefined;
    f.hold = new Promise((res) => {
      release = res;
    });
    const r = await mount(f);
    const s = section(r);
    click(button(s, 'Show again'));
    await flush(2);
    for (const b of s.querySelectorAll('button')) expect(b.disabled).toBe(true);
    click(button(s, 'Restore'));
    release();
    await flush();
    expect(f.calls.filter((c) => c !== 'status')).toEqual(['show']);
  });

  it('a closed window (cancelled) says nothing; other errors say what, rate limits in words', async () => {
    const f = controls(COVERED);
    f.showResult = new Error('cancelled: the passphrase was not given');
    const r = await mount(f);
    const s = section(r);
    click(button(s, 'Show again'));
    await flush();
    expect(s.querySelector('[role=alert]')).toBeNull();
    f.showResult = new Error('forbidden: wrong passphrase');
    click(button(s, 'Show again'));
    await flush();
    expect(s.querySelector('[role=alert]')?.textContent).toBe('wrong passphrase');
    f.restoreResult = new Error('rate-limited: too many dismissed prompts: try again in a minute');
    click(button(s, 'Restore'));
    await flush();
    expect(s.querySelector('[role=alert]')?.textContent).toMatch(/Try again in a minute/);
  });

  it('restore: progress while it runs (hosts only), then one row per mint', async () => {
    const f = controls(COVERED);
    let release: () => void = () => undefined;
    f.hold = new Promise((res) => {
      release = res;
    });
    f.restoreResult = {
      phrases: 3,
      reports: [
        { mint: MINT_A, outcome: 'restored', restoredSats: 42 as Sats },
        { mint: MINT_B, outcome: 'unsupported', restoredSats: 0 as Sats },
      ],
    };
    const r = await mount(f);
    const s = section(r);
    click(button(s, 'Restore'));
    await flush(2);
    act(() => {
      f.progress?.({ phrase: 2, phrases: 3, mint: MINT_A, keysetsDone: 1, keysets: 4 });
    });
    expect(s.querySelector('[role=status]')?.textContent).toBe(
      'Phrase 2 of 3 · mint-a.example · 1 of 4 keysets',
    );
    release();
    await flush();
    expect(f.progress).toBeUndefined(); // unsubscribed once done
    expect(s.textContent).toMatch(/Scanned 3 phrases\./);
    const rows = Array.from(s.querySelectorAll('li')).map((li) => li.textContent);
    expect(rows).toEqual([
      'mint-a.example: 42 sats restored',
      'mint-b.example: cannot restore here (the mint does not support it)',
    ]);
    expect(s.textContent).not.toMatch(/\/cashu/);
  });
});

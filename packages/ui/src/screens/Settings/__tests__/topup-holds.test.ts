// @vitest-environment jsdom
/**
 * R5-R1 (Cameron, 2026-10-02): Settings › Mints and top-up lists auto top-ups held back for a mint
 * (shell-provided), each with Resume; the page names the held top-up only — main's native dialog
 * says what resuming means. No controls (web, mocks) or no hold: nothing is shown.
 */
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mocks } from '@sovit/core';
import type { MintUrl, Sats } from '@sovit/core';
import { click, render, type Rendered } from '../../../components/testing/render.js';
import type { Route } from '../../shared/route.js';
import { Settings } from '../Settings.js';
import type { TopUpHoldControls, TopUpHoldView } from '../TopUpHolds.js';

const { MockNetworkAdapter } = mocks;
const MINT = 'https://mint-target.example/cashu' as MintUrl;
const HOLD: TopUpHoldView = {
  id: '0123456789abcdef',
  target: MINT,
  amount: 2_000 as Sats,
  reason: 'owed',
};

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

async function mount(topUpHolds: TopUpHoldControls | undefined): Promise<Rendered> {
  const navigate = vi.fn<(to: Route) => void>();
  const r = render(
    createElement(Settings, { adapter: new MockNetworkAdapter(), navigate, topUpHolds }),
  );
  rendered.push(r);
  await flush();
  return r;
}

const holdsEl = (r: Rendered): HTMLElement | null =>
  r.container.querySelector('.nf-settings__holds');
const resumeButton = (el: HTMLElement): HTMLButtonElement => {
  const b = Array.from(el.querySelectorAll('button')).find((e) => e.textContent === 'Resume');
  if (!b) throw new Error('no Resume button');
  return b;
};

function fake(answer: boolean | Error, list: TopUpHoldView[] = [HOLD]) {
  let holds = [...list];
  const resumed: string[] = [];
  const controls: TopUpHoldControls = {
    holds: () => Promise.resolve(holds),
    resume: (id) => {
      resumed.push(id);
      if (answer instanceof Error) return Promise.reject(answer);
      if (answer) holds = holds.filter((h) => h.id !== id);
      return Promise.resolve(answer);
    },
  };
  return { controls, resumed };
}

describe('Settings › Mints and top-up › held auto top-ups (R5-R1)', () => {
  it('no controls, or no hold: nothing is shown', async () => {
    expect(holdsEl(await mount(undefined))).toBeNull();
    expect(holdsEl(await mount(fake(true, []).controls))).toBeNull();
  });

  it('a hold names its mint, amount and reason, with Resume', async () => {
    const r = await mount(fake(true).controls);
    const el = holdsEl(r)!;
    expect(el.textContent).toContain('Auto top-up paused for');
    expect(el.textContent).toContain('mint-target.example');
    expect(el.textContent).toContain('the payment left your other mint and has not arrived yet');
    expect(resumeButton(el)).toBeTruthy();
  });

  it('Resume names the held top-up only; confirmed: it is gone and the page says so', async () => {
    const f = fake(true);
    const r = await mount(f.controls);
    act(() => {
      click(resumeButton(holdsEl(r)!));
    });
    await flush();
    expect(f.resumed).toEqual([HOLD.id]);
    const el = holdsEl(r)!;
    expect(el.querySelector('[role="status"]')?.textContent).toBe(
      'Auto top-ups into mint-target.example run again.',
    );
    expect(el.querySelector('button')).toBeNull();
  });

  it('not confirmed in main: still listed, nothing said; an error is shown without its code', async () => {
    const no = fake(false);
    const r = await mount(no.controls);
    act(() => {
      click(resumeButton(holdsEl(r)!));
    });
    await flush();
    expect(holdsEl(r)!.querySelector('[role="status"]')).toBeNull();
    expect(resumeButton(holdsEl(r)!)).toBeTruthy();

    const bad = fake(new Error('not-found: no such held auto top-up'));
    const r2 = await mount(bad.controls);
    act(() => {
      click(resumeButton(holdsEl(r2)!));
    });
    await flush();
    expect(holdsEl(r2)!.querySelector('[role="alert"]')?.textContent).toBe(
      'no such held auto top-up',
    );
  });
});

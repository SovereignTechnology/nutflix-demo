// @vitest-environment jsdom
/**
 * The shell in jsdom with the real `@sovit/ui` screens over `MockNetworkAdapter` (design §4,
 * §6 L6-A): Watch→Watch, Watch→Home, Shorts-over-mini-player (≤ 1 unpaused session, none
 * leaked — counted at the MOCK, where a session lives until closed), expand/dismiss, theme at
 * boot and on change, the header chip, back/forward.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mocks } from '@sovit/core';
import type { NostrEventId } from '@sovit/core';
import type { FfmpegStatus, Route } from '@sovit/ui';
import { Shell } from '../App.js';
import { createShellModel, type ShellModel } from '../model.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { MockNetworkAdapter, VIDEOS } = mocks;

function must<T>(x: T | undefined, what: string): T {
  if (x === undefined) throw new Error(`fixture missing: ${what}`);
  return x;
}
const V1 = must(
  VIDEOS.find((v) => v.kind === 21),
  'a kind-21 video',
).id;
const V2 = must(VIDEOS.filter((v) => v.kind === 21)[1], 'a second kind-21 video').id;

interface Mounted extends ShellModel {
  readonly container: HTMLElement;
  readonly root: Root;
  readonly base: InstanceType<typeof MockNetworkAdapter>;
  /** Open sessions at the MOCK (each holds a tick driver until closed). */
  live(): number;
  tick(): void;
  playSpy: ReturnType<typeof vi.fn>;
  probe: ReturnType<typeof vi.fn>;
}

let mounted: Mounted[] = [];
/** `<video>.pause()` calls (jsdom has no media playback; both methods are stubbed). */
let mediaPauses = 0;

beforeEach(() => {
  mediaPauses = 0;
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {
    mediaPauses += 1;
  });
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  for (const m of mounted) {
    act(() => {
      m.root.unmount();
    });
    m.container.remove();
  }
  mounted = [];
  vi.restoreAllMocks();
});

async function flush(rounds = 12): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) {
      await new Promise<void>((r) => {
        setTimeout(r, 0);
      });
    }
  });
}

async function mount(
  initial: Route = { name: 'home' },
  opts: { theme?: 'dark' | 'light' } = {},
): Promise<Mounted> {
  const ticks = new Set<() => void>();
  const base = new MockNetworkAdapter({
    setInterval: (fn) => {
      ticks.add(fn);
      return () => ticks.delete(fn);
    },
  });
  if (opts.theme !== undefined) await base.updateSettings({ theme: opts.theme });
  const playSpy = vi.fn();
  const origPlay = base.play.bind(base);
  base.play = (id: NostrEventId, r?: string) => {
    playSpy(id, r);
    return origPlay(id, r);
  };
  const model = createShellModel(base, initial);
  const probe = vi.fn((recheck: boolean): Promise<FfmpegStatus> =>
    Promise.resolve({
      found: true,
      path: '/usr/bin/ffmpeg',
      version: recheck ? '8.1.3' : '8.1.2',
      os: 'linux',
    }),
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <Shell
        adapter={model.adapter}
        coordinator={model.coordinator}
        router={model.router}
        probeFfmpeg={probe}
      />,
    );
  });
  const m: Mounted = {
    ...model,
    container,
    root,
    base,
    live: () => ticks.size,
    tick: () => {
      act(() => {
        for (const t of [...ticks]) t();
      });
    },
    playSpy,
    probe,
  };
  mounted.push(m);
  await flush();
  return m;
}

function q(m: Mounted, sel: string): HTMLElement {
  const el = m.container.querySelector<HTMLElement>(sel);
  if (el === null) throw new Error(`no element matches ${sel}`);
  return el;
}

async function click(el: HTMLElement): Promise<void> {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function go(m: Mounted, to: Route): Promise<void> {
  act(() => {
    m.router.navigate(to);
  });
  await flush();
}

async function playWatch(m: Mounted): Promise<void> {
  await click(q(m, 'button[aria-label^="Play — costs"]'));
}

/** The SE-2/SE-3 invariant, checked after every step. */
function invariant(m: Mounted): void {
  const s = m.coordinator.snapshot();
  expect(s.unpaused).toBeLessThanOrEqual(1);
  // Nothing open at the adapter that the coordinator does not know about.
  expect(m.live()).toBe(s.open);
}

describe('Watch → Home (mini-player on navigate)', () => {
  it('hands the paying session to the mini-player; dismiss closes it', async () => {
    const m = await mount({ name: 'watch', videoId: V1 });
    await playWatch(m);
    expect(m.live()).toBe(1);
    expect(m.coordinator.snapshot()).toMatchObject({ open: 1, unpaused: 1 });
    invariant(m);

    await go(m, { name: 'home' });
    const mini = q(m, 'aside[aria-label="Mini-player"]');
    expect(mini.querySelector('video')?.getAttribute('src')).toMatch(/^fixture:\/\/video\//);
    expect(m.coordinator.snapshot().mini?.handoff.videoId).toBe(V1);
    expect(m.live()).toBe(1);
    invariant(m);

    await click(q(m, 'button[aria-label="Close mini-player"]'));
    expect(m.container.querySelector('aside[aria-label="Mini-player"]')).toBeNull();
    expect(m.live()).toBe(0);
    invariant(m);
  });

  it('expand gives the session back to Watch without a new play() or price', async () => {
    const m = await mount({ name: 'watch', videoId: V1 });
    await playWatch(m);
    await go(m, { name: 'library' });
    expect(m.coordinator.snapshot().mini).not.toBeNull();
    await click(q(m, 'button[aria-label="Expand"]'));
    expect(m.router.current.route).toEqual({ name: 'watch', videoId: V1 });
    expect(m.coordinator.snapshot().mini).toBeNull();
    expect(m.playSpy).toHaveBeenCalledTimes(1);
    expect(m.live()).toBe(1);
    expect(m.container.querySelector('button[aria-label^="Play — costs"]')).toBeNull();
    invariant(m);
    // Leaving again hands it off again — still one session.
    await go(m, { name: 'home' });
    expect(m.coordinator.snapshot().mini?.handoff.videoId).toBe(V1);
    expect(m.live()).toBe(1);
    invariant(m);
  });

  it("navigating to the mini-player's own video expands it too", async () => {
    const m = await mount({ name: 'watch', videoId: V1 });
    await playWatch(m);
    await go(m, { name: 'home' });
    await go(m, { name: 'watch', videoId: V1 });
    expect(m.coordinator.snapshot().mini).toBeNull();
    expect(m.playSpy).toHaveBeenCalledTimes(1);
    expect(m.live()).toBe(1);
    invariant(m);
  });

  it('back to an old watch entry never re-adopts a session that was closed', async () => {
    const m = await mount({ name: 'watch', videoId: V1 });
    await playWatch(m);
    await go(m, { name: 'home' });
    await click(q(m, 'button[aria-label="Expand"]'));
    await go(m, { name: 'settings' });
    await click(q(m, 'button[aria-label="Close mini-player"]'));
    expect(m.live()).toBe(0);
    act(() => {
      m.router.back();
    });
    await flush();
    expect(m.router.current.route).toEqual({ name: 'watch', videoId: V1 });
    expect(m.live()).toBe(0);
    expect(m.container.querySelector('button[aria-label^="Play — costs"]')).not.toBeNull();
    invariant(m);
  });
});

describe('Watch → Watch', () => {
  it("closes the old video's session (no remount, no hand-off); exactly one session after playing the next", async () => {
    const m = await mount({ name: 'watch', videoId: V1 });
    await playWatch(m);
    await go(m, { name: 'watch', videoId: V2 });
    expect(m.coordinator.snapshot().mini).toBeNull();
    expect(m.live()).toBe(0);
    await playWatch(m);
    expect(m.live()).toBe(1);
    expect(m.coordinator.snapshot()).toMatchObject({ open: 1, unpaused: 1 });
    invariant(m);
  });

  it('with the mini-player holding V1, playing V2 pauses the mini; leaving V2 replaces the mini', async () => {
    const m = await mount({ name: 'watch', videoId: V1 });
    await playWatch(m);
    await go(m, { name: 'home' });
    await go(m, { name: 'watch', videoId: V2 });
    expect(m.coordinator.snapshot().mini?.handoff.videoId).toBe(V1);
    await playWatch(m);
    expect(m.coordinator.snapshot().mini?.paused).toBe(true);
    expect(m.coordinator.snapshot()).toMatchObject({ open: 2, unpaused: 1 });
    invariant(m);
    await go(m, { name: 'home' });
    expect(m.coordinator.snapshot().mini?.handoff.videoId).toBe(V2);
    expect(m.live()).toBe(1);
    invariant(m);
  });
});

describe('Shorts over the mini-player (SE-3)', () => {
  it('a short starting pauses the mini-player: never two sessions paying', async () => {
    const m = await mount({ name: 'watch', videoId: V1 });
    await playWatch(m);
    await go(m, { name: 'shorts' });
    expect(m.coordinator.snapshot().mini).not.toBeNull();
    const before = mediaPauses;
    await click(q(m, '.nf-shorts button[aria-label^="Play — "]'));
    expect(m.coordinator.snapshot().mini?.paused).toBe(true);
    expect(m.coordinator.snapshot()).toMatchObject({ open: 2, unpaused: 1 });
    // The mini's <video> element followed its (now paused) session.
    expect(mediaPauses).toBeGreaterThan(before);
    invariant(m);
    await click(q(m, 'button[aria-label="Close mini-player"]'));
    expect(m.live()).toBe(1);
    invariant(m);
    // Leaving Shorts closes the short (no hand-off from Shorts).
    await go(m, { name: 'home' });
    expect(m.live()).toBe(0);
    invariant(m);
  });

  it('resuming the mini-player pauses the short', async () => {
    const m = await mount({ name: 'watch', videoId: V1 });
    await playWatch(m);
    await go(m, { name: 'shorts' });
    await click(q(m, '.nf-shorts button[aria-label^="Play — "]'));
    await click(q(m, 'aside[aria-label="Mini-player"] button[aria-label="Play"]'));
    expect(m.coordinator.snapshot().mini?.paused).toBe(false);
    expect(m.coordinator.snapshot()).toMatchObject({ open: 2, unpaused: 1 });
    invariant(m);
  });
});

describe('theme (ADR 0005; the screens never touch the document)', () => {
  it('applies Settings.theme at boot', async () => {
    await mount({ name: 'home' }, { theme: 'light' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('applies it again on every Settings change (light → device)', async () => {
    const m = await mount({ name: 'settings' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    const radio = (label: string): HTMLInputElement => {
      const l = [...m.container.querySelectorAll('label')].find((x) =>
        x.textContent.includes(label),
      );
      const input = l?.htmlFor ? m.container.ownerDocument.getElementById(l.htmlFor) : null;
      if (!(input instanceof HTMLInputElement)) throw new Error(`no radio "${label}"`);
      return input;
    };
    await click(radio('Light theme'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    await click(radio('Use device theme'));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect((await m.base.settings()).theme).toBe('system');
  });
});

describe('chrome', () => {
  it('the WalletChip shows the total and, while a session pays, its rate', async () => {
    const m = await mount({ name: 'watch', videoId: V1 });
    const chip = (): string => q(m, '.nf-shell__header-end').textContent;
    expect(chip()).toContain('2,100');
    await playWatch(m);
    m.tick();
    await flush();
    expect(chip()).toMatch(/\/min/);
    expect(m.coordinator.snapshot().ratePerMin).toBeGreaterThan(0);
  });

  it('search submits the search route; the sidebar marks the current section', async () => {
    const m = await mount();
    const input = q(m, 'input[aria-label="Search videos"]') as HTMLInputElement;
    act(() => {
      // React tracks `value` on the instance; set it through the prototype like a user would.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'ceramics',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(m.router.current.route).toEqual({ name: 'search', q: 'ceramics' });
    await go(m, { name: 'library' });
    expect(q(m, '.nf-shell__nav-item[aria-current="page"]').textContent).toContain('Library');
  });

  it('Alt+← / Alt+→ and the mouse back/forward buttons move through history', async () => {
    const m = await mount();
    await go(m, { name: 'library' });
    await go(m, { name: 'wallet' });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true }));
    });
    expect(m.router.current.route.name).toBe('library');
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { button: 3 }));
    });
    expect(m.router.current.route.name).toBe('home');
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { button: 4 }));
    });
    expect(m.router.current.route.name).toBe('library');
    await flush();
  });

  it('Studio gets the ffmpeg probe (desktop.ffmpeg) and keeps it across tabs', async () => {
    const m = await mount({ name: 'studio' });
    expect(m.probe).toHaveBeenCalledWith(false);
    expect(m.container.textContent).toContain('Transcoding with ffmpeg 8.1.2');
    await go(m, { name: 'studio', tab: 'videos' });
    await go(m, { name: 'studio', tab: 'upload' });
    expect(m.probe).toHaveBeenCalledTimes(1);
  });
});

/**
 * The desktop shell (design §4): header, sidebar, the routed screen, the mini-player and ONE
 * shell `ToastStack`. Every prop the screens expect from a shell (docs/status.md "Shell
 * contract the screens expect") is wired here:
 *
 *   Home      `tab`, `hoverPreview` from Settings
 *   Watch     `videoId`, `startAtSec` (route `t`), `onMiniPlayer` → coordinator, `resumeSession`
 *             (expand / back to a handed-off video), `playlist` (extras)
 *   Shorts    `videoId`, `onPlaybackStart` → pause the mini-player (SE-3)
 *   Channel   `pubkey`, `tab`; `seedingVideos` deliberately undefined in Stage 1 (v5 lookup)
 *   Search    `q`, `filters` + `onFiltersChange` kept in the history entry
 *   Library   `tab`, `playlistId` (extras); Library keeps its own toast stack (no `onToast` prop)
 *   Studio    `tab`, `resolveFile` = identity (SE-1: the preload tokenises the File),
 *             `ffmpeg` + `onRecheckFfmpeg` from `desktop.ffmpeg`; kept mounted across tabs
 *   Wallet    `intent` (extras)
 *   Settings  `onSettingsChange` → theme + hoverPreview, `onToast` → shell stack;
 *             `onChangeSigner` omitted (no signer flow in Stage 1)
 *
 * Screens are keyed by route NAME only: Watch is not remounted watch → watch, Shorts not
 * shorts → shorts, Studio not across tabs. The coordinator learns the mounted screen in a
 * layout effect (before any screen effect can call `play()`) and sweeps unowned sessions in a
 * passive effect after every commit (after unmounted screens handed off).
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import type { NetworkAdapter, Settings as SettingsData } from '@sovit/core';
import {
  Channel,
  Home,
  Library,
  Search,
  Settings,
  Shorts,
  Studio,
  ToastStack,
  Wallet,
  Watch,
  applyTheme,
  isTextEntryTarget,
} from '@sovit/ui';
import type { FfmpegStatus, SearchFilterState, ToastItem } from '@sovit/ui';
import type { PlaybackCoordinator } from './coordinator.js';
import type { Router } from './router.js';
import { Header } from './shell/Header.js';
import { MiniPlayer } from './shell/MiniPlayer.js';
import { Sidebar } from './shell/Sidebar.js';
import { useCoordinator, useIdentity, useRouterState, useWalletTotal } from './shell/hooks.js';

export const MAX_SHELL_TOASTS = 3;

export interface ShellProps {
  /** The coordinator-wrapped adapter (stable identity for the app's lifetime). */
  readonly adapter: NetworkAdapter;
  readonly coordinator: PlaybackCoordinator;
  readonly router: Router;
  /** `desktop.ffmpeg` (pre-v5 stand-in for `studio.ffmpeg()`); absent = Studio learns on upload. */
  readonly probeFfmpeg?: ((recheck: boolean) => Promise<FfmpegStatus>) | undefined;
}

/** Studio's `resolveFile`: the File itself — the preload, never the page, turns it into a token. */
const identityFile = (file: File): File => file;

/** Pause the page's own `<video>`s (never the mini-player's). */
export function pauseScreenMedia(doc: Document = document): void {
  for (const v of doc.querySelectorAll('video')) {
    if (v.closest('.nf-shell__mini') !== null) continue;
    try {
      v.pause();
    } catch {
      // no media support
    }
  }
}

/** Wires router ⇄ coordinator: navigation requests, and "watch the mini's video" = expand. */
export function connectRouter(router: Router, coordinator: PlaybackCoordinator): void {
  router.onRequest = (route) => {
    coordinator.routeRequested(route);
  };
  router.intercept = (entry) => {
    const mini = coordinator.snapshot().mini;
    if (entry.route.name !== 'watch' || mini?.handoff.videoId !== entry.route.videoId) {
      return entry;
    }
    const handoff = coordinator.expandMini();
    return handoff === null
      ? entry
      : { ...entry, extras: { ...entry.extras, resumeSession: handoff } };
  };
}

export function Shell({ adapter, coordinator, router, probeFfmpeg }: ShellProps): ReactElement {
  const rs = useRouterState(router);
  const { route, extras } = rs.entry;
  const play = useCoordinator(coordinator);
  const identity = useIdentity(adapter);
  const balance = useWalletTotal(adapter, identity.status === 'signed-in');
  const navigate = router.navigate;

  // ---- settings: theme at boot and on every change; hoverPreview for Home ------------------
  const [settings, setSettings] = useState<SettingsData | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    adapter.settings().then(
      (s) => {
        if (!alive) return;
        applyTheme(s.theme);
        setSettings(s);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [adapter]);
  const onSettingsChange = useCallback((s: SettingsData): void => {
    applyTheme(s.theme);
    setSettings(s);
  }, []);

  // ---- toasts --------------------------------------------------------------------------------
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const toastSeq = useRef(0);
  const pushToast = useCallback((t: ToastItem): void => {
    toastSeq.current += 1;
    const item: ToastItem = { ...t, id: `shell-${String(toastSeq.current)}` };
    setToasts((prev) => [...prev, item].slice(-MAX_SHELL_TOASTS));
  }, []);
  const dismissToast = useCallback((id: string): void => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // ---- ffmpeg probe for Studio -------------------------------------------------------------
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus | undefined>(undefined);
  const probing = useRef(false);
  const probe = useCallback(
    (recheck: boolean): void => {
      if (probeFfmpeg === undefined || probing.current) return;
      probing.current = true;
      probeFfmpeg(recheck).then(
        (s) => {
          probing.current = false;
          setFfmpeg(s);
        },
        () => {
          probing.current = false;
        },
      );
    },
    [probeFfmpeg],
  );
  const onStudio = route.name === 'studio';
  useEffect(() => {
    if (onStudio && ffmpeg === undefined) probe(false);
  }, [onStudio, ffmpeg, probe]);
  const recheckFfmpeg = useCallback((): void => {
    probe(true);
  }, [probe]);

  // ---- screen identity + coordinator hooks ------------------------------------------------
  const keyRef = useRef({ name: route.name, key: 1 });
  if (keyRef.current.name !== route.name) {
    keyRef.current = { name: route.name, key: keyRef.current.key + 1 };
  }
  const screenKey = keyRef.current.key;
  useLayoutEffect(() => {
    coordinator.screenMounted(screenKey);
  }, [coordinator, screenKey]);
  useEffect(() => {
    coordinator.routeCommitted(route);
    // `rs.version` changes on every navigation, including in-place extras updates.
  }, [coordinator, route, rs.version]);

  // ---- back / forward: Alt+←/→ and the mouse's back/forward buttons -------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || isTextEntryTarget(e.target)) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        router.back();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        router.forward();
      }
    };
    const onMouse = (e: MouseEvent): void => {
      if (e.button === 3) {
        e.preventDefault();
        router.back();
      } else if (e.button === 4) {
        e.preventDefault();
        router.forward();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mouseup', onMouse);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mouseup', onMouse);
    };
  }, [router]);

  const onFiltersChange = useCallback(
    (f: SearchFilterState): void => {
      router.updateExtras({ searchFilters: f });
    },
    [router],
  );

  // ---- the screen ---------------------------------------------------------------------------
  const common = { adapter, navigate } as const;
  let screen: ReactElement;
  switch (route.name) {
    case 'home':
      screen = <Home {...common} tab={route.tab} hoverPreview={settings?.hoverPreview} />;
      break;
    case 'watch': {
      const handed = extras.resumeSession;
      const resume =
        handed?.videoId === route.videoId && coordinator.canResume(handed.session)
          ? handed
          : undefined;
      screen = (
        <Watch
          {...common}
          videoId={route.videoId}
          startAtSec={route.t}
          onMiniPlayer={coordinator.handOff}
          resumeSession={resume}
          playlist={extras.watchPlaylist}
        />
      );
      break;
    }
    case 'channel':
      screen = (
        <Channel {...common} pubkey={route.pubkey} tab={route.tab} seedingVideos={undefined} />
      );
      break;
    case 'search':
      screen = (
        <Search
          {...common}
          q={route.q}
          filters={extras.searchFilters}
          onFiltersChange={onFiltersChange}
        />
      );
      break;
    case 'shorts':
      screen = (
        <Shorts {...common} videoId={route.videoId} onPlaybackStart={coordinator.pauseMini} />
      );
      break;
    case 'library':
      screen = <Library {...common} tab={route.tab} playlistId={extras.playlistId} />;
      break;
    case 'studio':
      screen = (
        <Studio
          {...common}
          tab={route.tab}
          resolveFile={identityFile}
          ffmpeg={ffmpeg}
          onRecheckFfmpeg={probeFfmpeg === undefined ? undefined : recheckFfmpeg}
        />
      );
      break;
    case 'wallet':
      screen = <Wallet {...common} intent={extras.walletIntent} />;
      break;
    case 'settings':
      screen = <Settings {...common} onSettingsChange={onSettingsChange} onToast={pushToast} />;
      break;
  }

  return (
    <div className="nf-shell" data-route={route.name}>
      <Header
        route={route}
        navigate={navigate}
        canBack={rs.canBack}
        canForward={rs.canForward}
        onBack={router.back}
        onForward={router.forward}
        identity={identity}
        balance={balance}
        ratePerMin={play.ratePerMin}
      />
      <div className="nf-shell__body">
        <Sidebar route={route} navigate={navigate} />
        <main className="nf-shell__main" key={screenKey}>
          {screen}
        </main>
      </div>
      {play.mini !== null ? (
        <MiniPlayer
          mini={play.mini}
          coordinator={coordinator}
          navigate={navigate}
          ratePerMin={play.mini.paused ? 0 : play.ratePerMin}
        />
      ) : null}
      <ToastStack toasts={toasts} onDismiss={dismissToast} className="nf-shell__toasts" />
    </div>
  );
}

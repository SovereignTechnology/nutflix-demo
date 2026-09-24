/**
 * The one app window (design §3 row 1). The security posture is written out as LITERALS in
 * the constructor call so a reviewer — and `scripts/electron-security-lint.mjs`, which scans
 * `new BrowserWindow({ … webPreferences: { … } })` — can read it: context isolation on, the
 * Chromium sandbox on, no Node in the page or its workers/subframes. `webSecurity` stays at
 * its default (on) and `webviewTag` at its default (off); neither is mentioned, so neither can
 * be flipped by a typo.
 *
 * The constructor is a parameter (main passes Electron's `BrowserWindow`) so the tests can
 * capture the options without launching Electron (D4).
 */
import type {
  BrowserWindow as ElectronBrowserWindow,
  BrowserWindowConstructorOptions,
} from 'electron';

export type BrowserWindowCtor = new (
  options: BrowserWindowConstructorOptions,
) => ElectronBrowserWindow;

export function createMainWindow(
  BrowserWindow: BrowserWindowCtor,
  preload: string,
): ElectronBrowserWindow {
  return new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 360,
    minHeight: 480,
    show: false,
    title: 'Nutflix',
    backgroundColor: '#0f0f0f',
    autoHideMenuBar: true,
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      spellcheck: false,
      safeDialogs: true,
      navigateOnDragDrop: false,
    },
  });
}

/**
 * ADR 0013: main's trusted prompt window — where passphrases, an nsec or a bunker URI are typed,
 * never in the app window. Modal to the app window, small and fixed, at its own origin
 * (`app://prompt`, see `schemes.ts`), with its own preload (two calls, nothing else). The same
 * literal posture as the app window, written out for the lint and the reviewer; devtools off.
 */
export function createPromptWindow(
  BrowserWindow: BrowserWindowCtor,
  preload: string,
  parent: ElectronBrowserWindow | undefined,
): ElectronBrowserWindow {
  return new BrowserWindow({
    ...(parent === undefined ? {} : { parent, modal: true }),
    width: 460,
    height: 480,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'Nutflix',
    backgroundColor: '#0f0f0f',
    autoHideMenuBar: true,
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      spellcheck: false,
      safeDialogs: true,
      navigateOnDragDrop: false,
      devTools: false,
    },
  });
}

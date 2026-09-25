/**
 * Window-level security controls (design §3), installed for EVERY webContents from
 * `app.on('web-contents-created')` and for the session before the window exists:
 *
 *   - `setWindowOpenHandler` → deny, always; the URL goes to `onWindowOpen` (security review
 *     F25: main asks, in its trusted prompt window, whether to open an https link in the browser);
 *   - `will-navigate`, `will-frame-navigate`, `will-redirect`, `will-attach-webview` →
 *     `preventDefault()` (the app is one document; programmatic `loadURL` does not emit them);
 *   - permissions: deny everything except `fullscreen` and `clipboard-sanitized-write`, and
 *     those only for the top frame of `app://nutflix`;
 *   - no device/HID/serial/USB grants, no downloads, no spell-check dictionary downloads.
 *
 * Structural types only (no runtime `electron` import) so the tests drive fakes.
 */
import { isAppOrigin, isAppUrl } from './schemes.js';

/** The only permissions the renderer may have (Watch fullscreen; Wallet "Copy invoice"). */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'fullscreen',
  'clipboard-sanitized-write',
]);

interface PreventableEvent {
  preventDefault(): void;
}

/** The `webContents` members `hardenWebContents` uses. */
export interface HardenableWebContents {
  readonly id: number;
  setWindowOpenHandler(handler: (details: unknown) => { action: 'deny' }): void;
  on(
    event: 'will-navigate' | 'will-frame-navigate' | 'will-redirect' | 'will-attach-webview',
    listener: (event: PreventableEvent, ...rest: unknown[]) => void,
  ): unknown;
}

/** Called from `app.on('web-contents-created')` for every webContents, devtools included. */
export function hardenWebContents(
  wc: HardenableWebContents,
  onWindowOpen?: (url: unknown, webContentsId: number) => void,
): void {
  wc.setWindowOpenHandler((details) => {
    try {
      onWindowOpen?.((details as { url?: unknown } | null)?.url, wc.id);
    } catch {
      // the answer is deny either way
    }
    return { action: 'deny' };
  });
  const block = (e: PreventableEvent): void => {
    e.preventDefault();
  };
  wc.on('will-navigate', block);
  wc.on('will-frame-navigate', block);
  wc.on('will-redirect', block);
  wc.on('will-attach-webview', block);
}

/** `session.setPermissionRequestHandler`'s decision. */
export function allowPermissionRequest(
  permission: string,
  details: { readonly isMainFrame: boolean; readonly requestingUrl?: string | undefined },
): boolean {
  return (
    ALLOWED_PERMISSIONS.has(permission) &&
    details.isMainFrame &&
    isAppUrl(details.requestingUrl ?? '')
  );
}

/** `session.setPermissionCheckHandler`'s decision. */
export function allowPermissionCheck(
  permission: string,
  requestingOrigin: string,
  details: { readonly isMainFrame: boolean; readonly embeddingOrigin?: string | undefined },
): boolean {
  return (
    ALLOWED_PERMISSIONS.has(permission) &&
    details.isMainFrame &&
    details.embeddingOrigin === undefined &&
    isAppOrigin(requestingOrigin)
  );
}

/** The `session` members `installSessionPolicy` uses. */
export interface PolicySession {
  setPermissionRequestHandler(
    handler: (
      wc: unknown,
      permission: string,
      callback: (granted: boolean) => void,
      details: { readonly isMainFrame: boolean; readonly requestingUrl?: string },
    ) => void,
  ): void;
  setPermissionCheckHandler(
    handler: (
      wc: unknown,
      permission: string,
      requestingOrigin: string,
      details: { readonly isMainFrame: boolean; readonly embeddingOrigin?: string },
    ) => boolean,
  ): void;
  setDevicePermissionHandler(handler: () => boolean): void;
  setSpellCheckerEnabled(enabled: boolean): void;
  on(event: 'will-download', listener: (event: PreventableEvent) => void): unknown;
}

export function installSessionPolicy(ses: PolicySession): void {
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(allowPermissionRequest(permission, details));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin, details) =>
    allowPermissionCheck(permission, origin, details),
  );
  ses.setDevicePermissionHandler(() => false);
  // Chromium's spell checker downloads dictionaries from a Google CDN; the window also sets
  // `spellcheck: false`.
  ses.setSpellCheckerEnabled(false);
  ses.on('will-download', (e) => {
    e.preventDefault();
  });
}

/** Never `--no-sandbox` (D4): main refuses to start when the switch is present. */
export const SANDBOX_BYPASS_SWITCHES = ['no-sandbox', 'disable-gpu-sandbox', 'no-zygote'] as const;

export function sandboxBypassSwitch(commandLine: {
  hasSwitch(name: string): boolean;
}): string | undefined {
  return SANDBOX_BYPASS_SWITCHES.find((s) => commandLine.hasSwitch(s));
}

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

/**
 * Never `--no-sandbox` (D4): main refuses to start, in EVERY build, when a switch is present
 * that turns a Chromium sandbox layer off or runs sandboxed code inside the unsandboxed browser
 * process. The first three were D4's; the cross-lane review (round 4) found the rest of
 * Chromium's list (sandbox/policy/switches.cc and content_switches.cc) still accepted, e.g.
 * `Exec=nutflix --disable-seccomp-filter-sandbox`. Every name here is a string in Electron
 * 44.2.0's Linux binary (checked with `strings`). The e2e harness passes none of them (it
 * asserts six of them absent, e2e/support.ts).
 */
export const SANDBOX_BYPASS_SWITCHES = [
  'no-sandbox', // every process type
  'disable-gpu-sandbox', // the GPU process
  'no-zygote', // renderers forked without the zygote, so without its sandbox
  'no-zygote-sandbox', // the zygote itself starts unsandboxed (Linux)
  'disable-seccomp-filter-sandbox', // no seccomp-bpf filter in renderers (Linux)
  'disable-namespace-sandbox', // no user/PID/network namespaces (Linux)
  'disable-setuid-sandbox', // no setuid helper (Linux)
  'disable-landlock-sandbox', // no Landlock layer (Linux)
  'allow-sandbox-debugging', // sandboxed children stay dumpable/ptrace-able by the same user
  'gpu-sandbox-allow-sysv-shm', // loosens the GPU sandbox policy
  'disable-webnn-compiler-sandbox', // the WebNN compiler process's sandbox
  'single-process', // the renderer runs inside the (unsandboxed) browser process
  'in-process-gpu', // the GPU code runs inside the browser process
] as const;

export function sandboxBypassSwitch(commandLine: {
  hasSwitch(name: string): boolean;
}): string | undefined {
  return SANDBOX_BYPASS_SWITCHES.find((s) => commandLine.hasSwitch(s));
}

/**
 * Chromium's DevTools-protocol switches (independent review of the packaging lane, issue #6).
 * The fuses close Node's `--inspect` and `NODE_OPTIONS` (ADR 0017 §4), but not these: with
 * either, a wrapper script or an edited `.desktop` line exposes CDP, which drives the renderer
 * holding the preload API and the prompt window. A PACKAGED build refuses them in main (exit
 * 78) before Chromium reads them (main runs before the DevTools server starts). A dev build
 * keeps them: the e2e harness (Playwright) attaches through `--remote-debugging-port`.
 */
export const REMOTE_DEBUGGING_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
] as const;

export function remoteDebuggingSwitch(commandLine: {
  hasSwitch(name: string): boolean;
}): string | undefined {
  return REMOTE_DEBUGGING_SWITCHES.find((s) => commandLine.hasSwitch(s));
}

/**
 * Cross-lane review (round 4), same reasoning as the remote-debugging switches: a wrapper script
 * or an edited `.desktop` line must not be able to change what runs in, or around, a packaged
 * build's processes. A PACKAGED build refuses these (exit 78), checked after the dev flags and
 * the remote-debugging switches; a dev build keeps them (a developer wraps a renderer in gdb
 * with `--renderer-cmd-prefix`, or passes `--js-flags`).
 *
 * Chromium may already have started its zygote and GPU process when main runs, so a prefix on
 * those has already run once. The refusal means the app never goes on with them: no window, no
 * host, no worker, no secret typed.
 *
 * Left out on purpose: debug pauses (`*-startup-dialog`, `wait-for-debugger*`) pause a process
 * and widen nothing; `--enable-features`/`--disable-features` carry a list, and refusing them
 * outright breaks Wayland users: they are checked name by name instead (below, ADR 0017 open
 * question 11).
 */
export const PACKAGED_REFUSED_SWITCHES = [
  'renderer-cmd-prefix', // a program around every renderer
  'utility-cmd-prefix', // … around every utility process, the host (money plane) among them
  'gpu-launcher', // … around the GPU process
  'zygote-cmd-prefix', // … around the zygote
  'browser-subprocess-path', // another executable AS every child process
  'js-flags', // V8 flags for main's isolate and every renderer's
  'disable-site-isolation-trials', // the prompt and app windows could share a renderer process
  'disable-web-security', // Chromium's same-origin-policy switch
  // ADR 0017 Q12 (Cameron, 2026-10-03): the other ways to switch Chromium features, refused
  // outright (no packaged user needs them; ask, and an allow-list follows, as for Q11).
  'enable-blink-features', // web-platform features on…
  'disable-blink-features', // … or off
  'force-fieldtrials', // a forced field trial can turn a feature on without --enable-features
  'force-fieldtrial-params', // … and set its parameters
] as const;

export function packagedRefusedSwitch(commandLine: {
  hasSwitch(name: string): boolean;
}): string | undefined {
  return PACKAGED_REFUSED_SWITCHES.find((s) => commandLine.hasSwitch(s));
}

/**
 * ADR 0017 open question 11 (Cameron, 2026-10-02: an allow-list). Some Chromium features are
 * sandbox layers (the network service's sandbox, for one), so `--enable-features=…` or
 * `--disable-features=…` on an edited `.desktop` line could weaken a packaged build, while
 * Wayland users need `--enable-features=UseOzonePlatform,WaylandWindowDecorations`. A PACKAGED
 * build accepts the two switches only when every feature they name is one of these; anything
 * else refuses the launch (exit 78). A dev build keeps them all.
 */
export const PACKAGED_ALLOWED_FEATURES = ['UseOzonePlatform', 'WaylandWindowDecorations'] as const;

export const FEATURE_LIST_SWITCHES = ['enable-features', 'disable-features'] as const;

/** One switch as it may appear in argv: `--name=value`, `-name=value`, `/name=value` (Windows). */
const FEATURE_ARG = /^(?:--?|\/)(enable-features|disable-features)(?:=([\s\S]*))?$/i;

/**
 * The first feature entry a packaged build refuses, or `undefined`. Fails closed: each
 * comma-separated entry must be exactly an allowed name, so a field-trial suffix
 * (`Feature<Trial:param/value`), a `*` default override, an empty name, or any other spelling is
 * refused. Every occurrence in argv is read, as well as the value Chromium reports, so a repeated
 * switch cannot slip a name past whichever occurrence wins.
 */
export function packagedRefusedFeature(
  commandLine: { hasSwitch(name: string): boolean; getSwitchValue(name: string): string },
  argv: readonly string[],
): string | undefined {
  const values: string[] = [];
  for (const sw of FEATURE_LIST_SWITCHES)
    if (commandLine.hasSwitch(sw)) values.push(commandLine.getSwitchValue(sw));
  for (const a of argv) {
    const m = FEATURE_ARG.exec(a);
    if (m !== null) values.push(m[2] ?? '');
  }
  const allowed: readonly string[] = PACKAGED_ALLOWED_FEATURES;
  for (const v of values)
    for (const entry of v.split(',')) {
      const name = entry.trim();
      if (!allowed.includes(name)) return name === '' ? '(empty)' : name;
    }
  return undefined;
}

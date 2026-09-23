/**
 * Design §3 rows 1, 4, 5: window-open deny and navigation `preventDefault` on a fake
 * webContents; permission request/check handlers (only `fullscreen` and
 * `clipboard-sanitized-write`, top-frame `app://nutflix` only); session policy; the window's
 * literal webPreferences; and `scripts/electron-security-lint.mjs` over this package.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserWindowConstructorOptions } from 'electron';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_PERMISSIONS,
  SANDBOX_BYPASS_SWITCHES,
  allowPermissionCheck,
  allowPermissionRequest,
  hardenWebContents,
  installSessionPolicy,
  sandboxBypassSwitch,
  type HardenableWebContents,
  type PolicySession,
} from '../security.js';
import { createMainWindow, type BrowserWindowCtor } from '../window.js';
import { isAppOrigin, isAppUrl, privilegedSchemes } from '../schemes.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..', '..');

type Listener = (event: { preventDefault(): void }, ...rest: unknown[]) => void;

class FakeWebContents implements HardenableWebContents {
  openHandler: ((details: unknown) => { action: 'deny' }) | undefined;
  readonly listeners = new Map<string, Listener[]>();
  setWindowOpenHandler(h: (details: unknown) => { action: 'deny' }): void {
    this.openHandler = h;
  }
  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  /** Emits like Electron: returns whether any listener called preventDefault. */
  emit(event: string): boolean {
    let prevented = false;
    for (const l of this.listeners.get(event) ?? []) {
      l(
        {
          preventDefault: () => {
            prevented = true;
          },
        },
        'https://evil.example/',
      );
    }
    return prevented;
  }
}

const ALL_PERMISSIONS = [
  'ar',
  'clipboard-read',
  'clipboard-sanitized-write',
  'display-capture',
  'fullscreen',
  'geolocation',
  'hid',
  'idle-detection',
  'local-fonts',
  'media',
  'mediaKeySystem',
  'midi',
  'midiSysex',
  'notifications',
  'openExternal',
  'pointerLock',
  'serial',
  'storage-access',
  'usb',
  'window-management',
  'unknown',
];

describe('hardenWebContents', () => {
  it('denies every window.open (a Markdown _blank link opens nothing)', () => {
    const wc = new FakeWebContents();
    hardenWebContents(wc);
    expect(wc.openHandler?.({ url: 'https://example.com/', disposition: 'new-window' })).toEqual({
      action: 'deny',
    });
  });

  it.each(['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview'])(
    'prevents %s',
    (event) => {
      const wc = new FakeWebContents();
      hardenWebContents(wc);
      expect(wc.emit(event)).toBe(true);
    },
  );
});

describe('permissions', () => {
  const app = 'app://nutflix/index.html';

  it('grants only fullscreen and clipboard-sanitized-write, only to the app top frame', () => {
    expect([...ALLOWED_PERMISSIONS].sort()).toEqual(['clipboard-sanitized-write', 'fullscreen']);
    for (const p of ALL_PERMISSIONS) {
      const want = ALLOWED_PERMISSIONS.has(p);
      expect(allowPermissionRequest(p, { isMainFrame: true, requestingUrl: app })).toBe(want);
      expect(allowPermissionCheck(p, 'app://nutflix', { isMainFrame: true })).toBe(want);
    }
  });

  it.each([
    ['a subframe', { isMainFrame: false, requestingUrl: app }],
    ['another origin', { isMainFrame: true, requestingUrl: 'https://evil.example/' }],
    ['no url', { isMainFrame: true }],
    ['a look-alike', { isMainFrame: true, requestingUrl: 'app://nutflix.evil/' }],
  ])('refuses fullscreen to %s', (_n, details) => {
    expect(allowPermissionRequest('fullscreen', details)).toBe(false);
  });

  it('check handler refuses subframes, embedded origins and other origins', () => {
    expect(allowPermissionCheck('fullscreen', 'app://nutflix', { isMainFrame: false })).toBe(false);
    expect(
      allowPermissionCheck('fullscreen', 'app://nutflix', {
        isMainFrame: true,
        embeddingOrigin: 'https://x',
      }),
    ).toBe(false);
    expect(allowPermissionCheck('fullscreen', 'https://evil.example', { isMainFrame: true })).toBe(
      false,
    );
  });

  it('installSessionPolicy wires both handlers, refuses devices, downloads and spell-check downloads', () => {
    const calls: string[] = [];
    let request: Parameters<PolicySession['setPermissionRequestHandler']>[0] | undefined;
    let check: Parameters<PolicySession['setPermissionCheckHandler']>[0] | undefined;
    let device: (() => boolean) | undefined;
    let download: ((e: { preventDefault(): void }) => void) | undefined;
    const ses: PolicySession = {
      setPermissionRequestHandler: (h) => {
        request = h;
      },
      setPermissionCheckHandler: (h) => {
        check = h;
      },
      setDevicePermissionHandler: (h) => {
        device = h;
      },
      setSpellCheckerEnabled: (on) => {
        calls.push(`spell:${String(on)}`);
      },
      on: (_event, l) => {
        download = l;
      },
    };
    installSessionPolicy(ses);
    const granted: boolean[] = [];
    request?.({}, 'geolocation', (g) => granted.push(g), {
      isMainFrame: true,
      requestingUrl: 'app://nutflix/',
    });
    request?.({}, 'fullscreen', (g) => granted.push(g), {
      isMainFrame: true,
      requestingUrl: 'app://nutflix/',
    });
    expect(granted).toEqual([false, true]);
    expect(check?.({}, 'notifications', 'app://nutflix', { isMainFrame: true })).toBe(false);
    expect(device?.()).toBe(false);
    expect(calls).toEqual(['spell:false']);
    let prevented = false;
    download?.({
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
  });
});

describe('schemes', () => {
  it('registers app and nf-media as standard + secure + stream, and nothing more', () => {
    expect(privilegedSchemes()).toEqual([
      { scheme: 'app', privileges: { standard: true, secure: true, stream: true } },
      { scheme: 'nf-media', privileges: { standard: true, secure: true, stream: true } },
    ]);
  });

  it('recognises the app origin exactly', () => {
    expect(isAppUrl('app://nutflix/index.html')).toBe(true);
    for (const u of ['app://nutflix.x/', 'app://x/', 'http://nutflix/', 'app://a@nutflix/', 42]) {
      expect(isAppUrl(u)).toBe(false);
    }
    expect(isAppOrigin('app://nutflix')).toBe(true);
    expect(isAppOrigin('app://nutflix/')).toBe(false);
  });
});

describe('the window (design §3 row 1)', () => {
  it('uses literal contextIsolation/sandbox/nodeIntegration and never touches webSecurity/webviewTag', () => {
    let seen: BrowserWindowConstructorOptions | undefined;
    const Ctor = function (this: unknown, o: BrowserWindowConstructorOptions) {
      seen = o;
    } as unknown as BrowserWindowCtor;
    createMainWindow(Ctor, '/app/dist/preload.cjs');
    const wp = seen?.webPreferences;
    expect(wp).toMatchObject({
      preload: '/app/dist/preload.cjs',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      spellcheck: false,
    });
    expect(wp && 'webSecurity' in wp).toBe(false);
    expect(wp && 'webviewTag' in wp).toBe(false);
    expect(wp && 'allowRunningInsecureContent' in wp).toBe(false);
    expect(wp && 'experimentalFeatures' in wp).toBe(false);
  });

  it('scripts/electron-security-lint.mjs passes on this package and sees the window', () => {
    const r = spawnSync(
      process.execPath,
      [join(repo, 'scripts', 'electron-security-lint.mjs'), join(repo, 'packages', 'app-desktop')],
      { encoding: 'utf8' },
    );
    expect(r.stdout).toBe('');
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(
      /[1-9]\d* window constructor\(s\), [1-9]\d* webPreferences object\(s\), 0 violations/,
    );
  });
});

describe('never --no-sandbox (D4)', () => {
  it('detects every sandbox bypass switch', () => {
    for (const s of SANDBOX_BYPASS_SWITCHES) {
      expect(sandboxBypassSwitch({ hasSwitch: (n) => n === s })).toBe(s);
    }
    expect(sandboxBypassSwitch({ hasSwitch: () => false })).toBeUndefined();
  });
});

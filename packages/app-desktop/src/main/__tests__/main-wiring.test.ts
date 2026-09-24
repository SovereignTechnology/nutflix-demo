/**
 * `main.ts` wiring against a fake `electron` module (Electron cannot launch here, D4): the order
 * of the before-ready steps, the sandbox refusal (`app.commandLine` never gets `no-sandbox`, and
 * main exits when it is present), the protocols, the three IPC channels, the host spawn, the
 * window, and one message through each path (renderer call → host, host media-link → nf-media).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mocks } from '@sovit/core';

interface FakeChild {
  posted: unknown[];
  listeners: Map<string, ((x: unknown) => void)[]>;
  killed: boolean;
}

const fx = vi.hoisted(() => {
  const state = {
    order: [] as string[],
    switches: new Set<string>(),
    appended: [] as string[],
    exitCode: undefined as number | undefined,
    appListeners: new Map<string, ((...a: unknown[]) => void)[]>(),
    protocols: new Map<string, (req: Request) => Promise<Response>>(),
    ipc: new Map<string, (e: unknown, raw: unknown) => Promise<unknown>>(),
    forks: [] as { path: string; args: string[]; opts: unknown }[],
    children: [] as FakeChild[],
    windows: [] as { options: Record<string, unknown>; url?: string }[],
    fetches: [] as { url: string; init: unknown }[],
    paths: new Map<string, string>(),
    ready: undefined as undefined | (() => void),
    /** `app.requestSingleInstanceLock()`'s answer. */
    primary: true,
    dialogs: [] as unknown[],
    dialogAnswer: 0,
    /** ADR 0013: `safeStorage` — off (a Linux box with no keyring) unless a test turns it on. */
    keychain: false,
    keychainBackend: 'gnome_libsecret',
  };
  return state;
});

vi.mock('electron', () => {
  const on =
    (m: Map<string, ((...a: unknown[]) => void)[]>) =>
    (event: string, fn: (...a: unknown[]) => void) => {
      m.set(event, [...(m.get(event) ?? []), fn]);
    };
  class BrowserWindow {
    static all: BrowserWindow[] = [];
    readonly webContents = {
      id: 1,
      on: () => undefined,
      once: () => undefined,
      reload: () => {
        fx.order.push('reload');
      },
    };
    private destroyed = false;
    private readonly closedListeners: (() => void)[] = [];
    constructor(options: Record<string, unknown>) {
      fx.windows.push({ options });
      // Per boot: the app window is webContents 1, a prompt window 2, …
      this.webContents.id = fx.windows.length;
      BrowserWindow.all.push(this);
    }
    once(event?: string, fn?: () => void): void {
      if (event === 'closed' && fn !== undefined) this.closedListeners.push(fn);
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    close(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      const w = fx.windows[this.webContents.id - 1];
      if (w) (w as { closed?: boolean }).closed = true;
      for (const l of this.closedListeners.splice(0)) l();
    }
    show(): void {
      return undefined;
    }
    loadURL(url: string): Promise<void> {
      const w = fx.windows.at(-1);
      if (w) w.url = url;
      return Promise.resolve();
    }
    static getAllWindows(): BrowserWindow[] {
      return BrowserWindow.all;
    }
  }
  return {
    app: {
      commandLine: {
        hasSwitch: (s: string) => fx.switches.has(s),
        appendSwitch: (s: string) => {
          fx.appended.push(s);
        },
      },
      enableSandbox: () => {
        fx.order.push('enableSandbox');
      },
      setPath: (k: string, v: string) => {
        fx.paths.set(k, v);
      },
      getPath: (k: string) => fx.paths.get(k) ?? `/tmp/nf-${k}`,
      on: on(fx.appListeners),
      exit: (code: number) => {
        fx.exitCode = code;
      },
      quit: () => {
        fx.order.push('quit');
      },
      requestSingleInstanceLock: () => fx.primary,
      whenReady: () =>
        new Promise<void>((r) => {
          fx.ready = () => {
            fx.order.push('ready');
            r();
          };
        }),
    },
    BrowserWindow,
    safeStorage: {
      isEncryptionAvailable: () => fx.keychain,
      getSelectedStorageBackend: () => fx.keychainBackend,
      encryptStringAsync: (t: string) => Promise.resolve(Buffer.from(`sealed:${t}`)),
      decryptStringAsync: (b: Buffer) =>
        Promise.resolve({ result: b.toString().replace(/^sealed:/, ''), shouldReEncrypt: false }),
    },
    dialog: {
      showMessageBox: (...a: unknown[]) => {
        fx.dialogs.push(a.at(-1));
        return Promise.resolve({ response: fx.dialogAnswer });
      },
    },
    webContents: { fromId: () => undefined },
    Menu: { setApplicationMenu: () => undefined, buildFromTemplate: () => ({}) },
    ipcMain: {
      handle: (channel: string, fn: (e: unknown, raw: unknown) => Promise<unknown>) => {
        fx.ipc.set(channel, fn);
      },
    },
    net: {
      fetch: (url: string, init: unknown) => {
        fx.fetches.push({ url, init });
        return Promise.resolve(
          new Response(new Uint8Array([1, 2, 3]), {
            status: 206,
            headers: { 'content-range': 'bytes 0-2/3' },
          }),
        );
      },
    },
    protocol: {
      registerSchemesAsPrivileged: () => {
        fx.order.push('registerSchemes');
      },
      handle: (scheme: string, fn: (req: Request) => Promise<Response>) => {
        fx.protocols.set(scheme, fn);
      },
    },
    session: {
      defaultSession: {
        setPermissionRequestHandler: () => undefined,
        setPermissionCheckHandler: () => undefined,
        setDevicePermissionHandler: () => undefined,
        setSpellCheckerEnabled: () => undefined,
        on: () => undefined,
      },
    },
    utilityProcess: {
      fork: (path: string, args: string[], opts: unknown) => {
        fx.forks.push({ path, args, opts });
        const child: FakeChild = { posted: [], listeners: new Map(), killed: false };
        fx.children.push(child);
        return {
          // parentPort clones: main may wipe its buffers after posting.
          postMessage: (m: unknown) => child.posted.push(structuredClone(m)),
          on: (e: string, l: (x: unknown) => void) => {
            child.listeners.set(e, [...(child.listeners.get(e) ?? []), l]);
          },
          kill: () => {
            child.killed = true;
            return true;
          },
        };
      },
    },
  };
});

const argv = process.argv;
/** Everything main logged (stderr is captured, not printed). */
let logged: string[] = [];

beforeEach(() => {
  logged = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    logged.push(String(chunk));
    return true;
  });
  vi.resetModules();
  fx.order.length = 0;
  fx.switches.clear();
  fx.appended.length = 0;
  fx.exitCode = undefined;
  fx.primary = true;
  fx.dialogs.length = 0;
  fx.dialogAnswer = 0;
  fx.keychain = false;
  fx.keychainBackend = 'gnome_libsecret';
  fx.appListeners.clear();
  fx.protocols.clear();
  fx.ipc.clear();
  fx.forks.length = 0;
  fx.children.length = 0;
  fx.windows.length = 0;
  fx.fetches.length = 0;
  fx.paths.clear();
  fx.ready = undefined;
});

afterEach(() => {
  process.argv = argv;
  vi.restoreAllMocks();
  // The redacting logger: fixed event names and scalars only — no token, link, path or id.
  for (const line of logged) {
    expect(line).toMatch(
      /^\[nutflix-main\] (debug|info|warn|error) [a-z.-]+( [A-Za-z]+=[A-Za-z0-9.-]+)*\n$/,
    );
    expect(line).not.toMatch(/tok0123|127\.0\.0\.1|\/tmp\/|evil|nutflix\/index/);
  }
});

async function boot(extraArgs: string[] = []): Promise<void> {
  process.argv = [argv[0] ?? 'node', 'dist/main/main.js', ...extraArgs];
  await import('../main.js');
  fx.ready?.();
  await new Promise<void>((r) => {
    setTimeout(r, 0);
  });
}

describe('main.ts wiring (fake electron)', () => {
  it('before ready: sandbox forced on, schemes registered; nothing ever appends a switch', async () => {
    await boot();
    expect(fx.order.slice(0, 3)).toEqual(['enableSandbox', 'registerSchemes', 'ready']);
    expect(fx.appended).toEqual([]);
    expect(fx.exitCode).toBeUndefined();
  });

  it.each(['no-sandbox', 'disable-gpu-sandbox', 'no-zygote'])(
    'refuses to start with --%s (exit 78, nothing registered)',
    async (sw) => {
      fx.switches.add(sw);
      process.argv = [argv[0] ?? 'node', 'dist/main/main.js'];
      await expect(import('../main.js')).rejects.toThrow(/sandbox/);
      expect(fx.exitCode).toBe(78);
      expect(fx.order).toEqual([]);
      expect(fx.protocols.size).toBe(0);
    },
  );

  it('registers the two protocols, the three IPC channels + the two prompt ones, one window at app://nutflix/', async () => {
    await boot();
    expect([...fx.protocols.keys()].sort()).toEqual(['app', 'nf-media']);
    expect([...fx.ipc.keys()].sort()).toEqual([
      'nf-prompt:answer',
      'nf-prompt:init',
      'nf:call',
      'nf:grant-file',
      'nf:sub',
    ]);
    expect(fx.windows).toHaveLength(1);
    expect(fx.windows[0]?.url).toBe('app://nutflix/index.html');
    const wp = fx.windows[0]?.options['webPreferences'] as Record<string, unknown>;
    expect(wp).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false });
    expect(String(wp['preload'])).toMatch(/[\\/]preload\.cjs$/);
  });

  it('spawns the host utilityProcess with userData and forwards only the dev flags', async () => {
    await boot([
      '--dev-mocks',
      '--dev-fixtures',
      '--user-data-dir',
      '/tmp/e2e-ud',
      '--no-such-flag',
    ]);
    expect(fx.paths.get('userData')).toBe('/tmp/e2e-ud');
    expect(fx.forks).toHaveLength(1);
    expect(fx.forks[0]?.path).toMatch(/[\\/]host[\\/]main\.js$/);
    // The worker entry is resolved next to main's own `dist/` (the sibling of `main/`).
    const distDir = dirname(dirname(fx.forks[0]?.path ?? ''));
    expect(fx.forks[0]?.args).toEqual([
      '--user-data-dir=/tmp/e2e-ud',
      `--worker-entry=${join(distDir, 'worker', 'entry.js')}`,
      '--dev-mocks',
      '--dev-fixtures',
    ]);
    // …and the host's real parser accepts exactly that argv (another project, by path).
    const path = '../../host/flags.js';
    const flags = (await import(/* @vite-ignore */ path)) as {
      parseHostArgs(a: readonly string[]): {
        userData: string;
        workerEntry: string;
        flags: Record<string, unknown>;
      };
    };
    expect(flags.parseHostArgs(fx.forks[0]?.args ?? [])).toEqual({
      userData: '/tmp/e2e-ud',
      workerEntry: join(distDir, 'worker', 'entry.js'),
      flags: { devMocks: true, devFixtures: true },
    });
  });

  it('hardens every webContents created', async () => {
    await boot();
    let denied: unknown;
    const prevented: string[] = [];
    const wc = {
      id: 9,
      setWindowOpenHandler: (h: (d: unknown) => unknown) => {
        denied = h({});
      },
      on: (event: string, l: (e: { preventDefault(): void }) => void) => {
        if (event.startsWith('will-')) l({ preventDefault: () => prevented.push(event) });
      },
      once: () => undefined,
    };
    for (const l of fx.appListeners.get('web-contents-created') ?? []) l({}, wc);
    expect(denied).toEqual({ action: 'deny' });
    expect(prevented.sort()).toEqual([
      'will-attach-webview',
      'will-frame-navigate',
      'will-navigate',
      'will-redirect',
    ]);
  });

  // Security review F22.
  it('a second instance on the same userData quits without a window, a host or IPC handlers', async () => {
    fx.primary = false;
    await boot(['--user-data-dir=/tmp/nf-one']);
    expect(fx.order).toContain('quit');
    expect(fx.order).not.toContain('ready');
    expect(fx.windows).toHaveLength(0);
    expect(fx.forks).toHaveLength(0);
    expect(fx.ipc.size).toBe(0);
  });

  // Security review F8: the money gate is a native dialog in main, not a stub.
  it('a nutzap from the window asks with a native dialog: Cancel is forbidden and never reaches the host, confirm relays', async () => {
    await boot();
    const call = fx.ipc.get('nf:call');
    const child = fx.children[0];
    const event = {
      sender: { id: 1, isDestroyed: () => false, send: () => undefined },
      senderFrame: { url: 'app://nutflix/index.html', parent: null },
    };
    const nutzap = (id: number): unknown => ({
      v: 1,
      id,
      method: 'nutzap',
      args: [mocks.VIDEOS[0]!.id, 21, mocks.MINTS.a],
    });
    fx.dialogAnswer = 0; // Cancel
    await expect(call?.(event, nutzap(1))).resolves.toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(fx.dialogs).toHaveLength(1);
    expect(fx.dialogs[0]).toMatchObject({
      type: 'question',
      buttons: ['Cancel', 'Send 21 sats'],
      defaultId: 0,
      cancelId: 0,
      message: 'Send 21 sats to the creator of this video?',
    });
    expect(child?.posted.filter((m) => (m as { kind?: string }).kind === 'call')).toHaveLength(0);
    fx.dialogAnswer = 1; // confirm
    void call?.(event, nutzap(2));
    await new Promise<void>((r) => {
      setTimeout(r, 0);
    });
    expect(child?.posted.filter((m) => (m as { kind?: string }).kind === 'call')).toHaveLength(1);
  });

  it('a renderer call from the window reaches the host; a host media-link feeds nf-media', async () => {
    await boot();
    const call = fx.ipc.get('nf:call');
    const child = fx.children[0];
    expect(call).toBeDefined();
    const pending = call?.(
      {
        sender: { id: 1, isDestroyed: () => false, send: () => undefined },
        senderFrame: { url: 'app://nutflix/index.html', parent: null },
      },
      { v: 1, id: 1, method: 'video', args: [mocks.VIDEOS[0]!.id] },
    );
    await Promise.resolve();
    expect(child?.posted).toEqual([
      { kind: 'call', wc: 1, msg: { v: 1, id: 1, method: 'video', args: [mocks.VIDEOS[0]!.id] } },
    ]);
    const onMessage = child?.listeners.get('message')?.[0];
    onMessage?.({ kind: 'reply', wc: 1, msg: { v: 1, id: 1, ok: true, result: null } });
    await expect(pending).resolves.toEqual({ v: 1, id: 1, ok: true, result: null });

    onMessage?.({
      kind: 'media-link',
      token: 'tok0123456789abcdef',
      url: 'http://127.0.0.1:41000/x',
    });
    const media = fx.protocols.get('nf-media');
    const res = await media?.(
      new Request('nf-media://play/tok0123456789abcdef', { headers: { range: 'bytes=0-2' } }),
    );
    expect(res?.status).toBe(206);
    expect(fx.fetches).toEqual([
      {
        url: 'http://127.0.0.1:41000/x',
        init: { method: 'GET', headers: { range: 'bytes=0-2' }, redirect: 'error' },
      },
    ]);
  });

  it('--e2e-hooks: nf-media status counts and 206 Range starts, numbers only; absent without the flag', async () => {
    const E2E_KEY = Symbol.for('nutflix.e2e');
    const g = globalThis as Record<symbol, unknown>;
    Reflect.deleteProperty(g, E2E_KEY);
    await boot();
    expect(g[E2E_KEY]).toBeUndefined();

    vi.resetModules();
    await boot(['--e2e-hooks']);
    const hooks = g[E2E_KEY] as {
      mediaStatuses(): Record<number, number>;
      mediaRangeStarts(): number[];
      mediaLinks(): number;
    };
    expect(hooks).toBeDefined();
    const child = fx.children.at(-1);
    child?.listeners.get('message')?.[0]?.({
      kind: 'media-link',
      token: 'tok0123456789abcdef',
      url: 'http://127.0.0.1:41000/x',
    });
    const media = fx.protocols.get('nf-media');
    for (const range of ['bytes=0-', 'bytes=1048576-']) {
      const res = await media?.(
        new Request('nf-media://play/tok0123456789abcdef', { headers: { range } }),
      );
      expect(res?.status).toBe(206);
    }
    expect((await media?.(new Request('nf-media://play/unknown-token-0000')))?.status).toBe(404);
    expect(hooks.mediaStatuses()).toEqual({ 206: 2, 404: 1 });
    expect(hooks.mediaRangeStarts()).toEqual([0, 1_048_576]);
    expect(hooks.mediaLinks()).toBe(1);
    Reflect.deleteProperty(g, E2E_KEY);
  });

  it('drops host messages that fail isHostOut (a non-loopback media link never registers)', async () => {
    await boot();
    const onMessage = fx.children[0]?.listeners.get('message')?.[0];
    onMessage?.({
      kind: 'media-link',
      token: 'tok0123456789abcdef',
      url: 'http://evil.example:80/x',
    });
    const res = await fx.protocols.get('nf-media')?.(
      new Request('nf-media://play/tok0123456789abcdef'),
    );
    expect(res?.status).toBe(404);
    expect(fx.fetches).toHaveLength(0);
  });

  it('a host crash fails calls in flight (backend-down), respawns and reloads the window', async () => {
    await boot();
    const call = fx.ipc.get('nf:call');
    const pending = call?.(
      {
        sender: { id: 1, isDestroyed: () => false, send: () => undefined },
        senderFrame: { url: 'app://nutflix/index.html', parent: null },
      },
      { v: 1, id: 2, method: 'me', args: [] },
    );
    await Promise.resolve();
    for (const l of fx.children[0]?.listeners.get('exit') ?? []) l(1);
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'backend-down' } });
    expect(fx.forks).toHaveLength(2);
    expect(fx.order).toContain('reload');
  });

  it('before-quit kills the host and it is not respawned', async () => {
    await boot();
    for (const l of fx.appListeners.get('before-quit') ?? []) l();
    expect(fx.children[0]?.killed).toBe(true);
    for (const l of fx.children[0]?.listeners.get('exit') ?? []) l(0);
    expect(fx.forks).toHaveLength(1);
  });

  it('ADR 0013: --keychain is forwarded only for a real keychain (never basic_text)', async () => {
    fx.keychain = true;
    await boot();
    expect(fx.forks[0]?.args).toContain('--keychain');
    vi.resetModules();
    fx.forks.length = 0;
    fx.keychainBackend = 'basic_text';
    await boot();
    expect(fx.forks[0]?.args).not.toContain('--keychain');
  });

  it('ADR 0013: a host prompt opens the prompt window; only that window may read it or answer', async () => {
    await boot();
    const child = fx.children[0];
    const deliver = (m: unknown): void => {
      for (const l of child?.listeners.get('message') ?? []) l(m);
    };
    deliver({ kind: 'prompt', req: 5, form: { kind: 'unlock-passphrase', retry: false } });
    expect(fx.windows).toHaveLength(2);
    const pw = fx.windows[1];
    expect(pw?.url).toBe('app://prompt/prompt.html');
    expect(pw?.options['modal']).toBe(true);
    const wp = pw?.options['webPreferences'] as Record<string, unknown>;
    expect(String(wp['preload'])).toMatch(/[\\/]prompt-preload\.cjs$/);
    expect(wp).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false });
    const init = fx.ipc.get('nf-prompt:init');
    const answer = fx.ipc.get('nf-prompt:answer');
    const ev = (id: number, url = 'app://prompt/prompt.html', parent: unknown = null): unknown => ({
      sender: { id },
      senderFrame: { url, parent },
    });
    // The app window (webContents 1), a subframe, the wrong origin: nothing.
    expect(await init?.(ev(1, 'app://nutflix/index.html'), undefined)).toBeNull();
    expect(await init?.(ev(2, 'app://prompt/prompt.html', {}), undefined)).toBeNull();
    expect(await init?.(ev(2, 'app://nutflix/index.html'), undefined)).toBeNull();
    expect(await answer?.(ev(1, 'app://nutflix/index.html'), { kind: 'secret', value: 'x' })).toBe(
      false,
    );
    expect(await init?.(ev(2), undefined)).toEqual({ kind: 'unlock-passphrase', retry: false });
    expect(await answer?.(ev(2), { kind: 'secret', value: 'the passphrase' })).toBe(true);
    const posted = child?.posted.find((m) => (m as { kind?: string }).kind === 'prompt-answer') as
      { req: number; answer: { kind: string; value: Uint8Array } } | undefined;
    expect(posted?.req).toBe(5);
    expect(new TextDecoder().decode(posted?.answer.value)).toBe('the passphrase');
    expect((pw as { closed?: boolean }).closed).toBe(true);
    // A host cancel for a question that is gone changes nothing; a new one opens a new window.
    deliver({ kind: 'prompt-cancel', req: 5 });
    deliver({ kind: 'prompt', req: 6, form: { kind: 'create-wallet' } });
    expect(fx.windows).toHaveLength(3);
    deliver({ kind: 'prompt-cancel', req: 6 });
    expect((fx.windows[2] as { closed?: boolean }).closed).toBe(true);
    expect(
      child?.posted.filter((m) => (m as { kind?: string }).kind === 'prompt-answer'),
    ).toHaveLength(1);
  });

  it('ADR 0013: keychain requests are answered through safeStorage, in a private userData dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nf-main-kc-'));
    try {
      fx.keychain = true;
      await boot(['--user-data-dir', dir]);
      const child = fx.children[0];
      const deliver = (m: unknown): void => {
        for (const l of child?.listeners.get('message') ?? []) l(m);
      };
      const results = (): { req: number; ok: boolean; value: Uint8Array | null }[] =>
        (child?.posted ?? []).filter(
          (m) => (m as { kind?: string }).kind === 'keychain-result',
        ) as { req: number; ok: boolean; value: Uint8Array | null }[];
      deliver({
        kind: 'keychain',
        req: 1,
        op: 'put',
        slot: 'passphrase',
        value: new TextEncoder().encode('sealed pass'),
      });
      await vi.waitFor(() => {
        expect(results()).toHaveLength(1);
      });
      expect(results()[0]).toEqual({ kind: 'keychain-result', req: 1, ok: true, value: null });
      const onDisk = await readFile(join(dir, 'keychain', 'passphrase.sealed'), 'utf8');
      expect(onDisk.startsWith('sealed:')).toBe(true); // what the fake safeStorage wrote
      deliver({ kind: 'keychain', req: 2, op: 'get', slot: 'passphrase' });
      await vi.waitFor(() => {
        expect(results()).toHaveLength(2);
      });
      expect(new TextDecoder().decode(results()[1]?.value ?? new Uint8Array())).toBe('sealed pass');
      deliver({ kind: 'keychain', req: 3, op: 'forget', slot: 'passphrase' });
      await vi.waitFor(() => {
        expect(results()).toHaveLength(3);
      });
      expect(results()[2]?.ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

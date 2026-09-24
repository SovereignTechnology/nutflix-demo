/**
 * ADR 0013 — main's trusted prompt window in the REAL Electron. NEVER part of `npm test`.
 *
 *   NUTFLIX_E2E=1 NUTFLIX_E2E_APPARMOR_PROFILE=1 node --test packages/app-desktop/e2e/signer.e2e.ts
 *
 * Same prerequisites as stage1.e2e.ts (docs/lanes/L6-A.md "Running the Electron suites"). The app
 * runs with `--dev-mocks` (no public network), which refuses the signer flow itself, so the suite
 * opens the prompt window through main's `--e2e-hooks` (`openPrompt`): the same `PromptService`,
 * window, preload, page and IPC checks the host's questions use. It asserts what the unit tests
 * can only emulate:
 *
 *   - the prompt loads at its own origin `app://prompt`, in its OWN renderer process (not the app
 *     window's), sandboxed (seccomp-bpf, own PID namespace), modal to the app window;
 *   - its page has `window.nutflixPrompt` with exactly two calls, no `window.nutflix`, no Node;
 *   - the page raises no CSP violation, and the CSP blocks an injected inline script there too;
 *   - a typed passphrase reaches main (as bytes: the hook reports only kind + length), and the
 *     window closes; Escape and closing the window are cancels; "Not now" is the default answer
 *     to "create a wallet".
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ElectronApplication, Page } from 'playwright-core';
import { E2E, PKG, electronBinary, launch, sandboxReady } from './support.ts';

interface PromptHooks {
  openPrompt(form: unknown): number;
  promptAnswer(req: number): { kind: string; bytes: number } | null | 'pending' | undefined;
  promptWindowId(): number | null;
}

const hooks = <R>(
  app: ElectronApplication,
  f: (h: PromptHooks, arg: unknown) => R,
  arg?: unknown,
) =>
  app.evaluate(
    (_electron, [src, a]) => {
      const h = (globalThis as Record<symbol, unknown>)[Symbol.for('nutflix.e2e')] as PromptHooks;
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- test-only, our own source
      return (new Function('h', 'a', `return (${src})(h, a)`) as (h: PromptHooks, a: unknown) => R)(
        h,
        a,
      );
    },
    [f.toString(), arg] as const,
  );

async function until<T>(what: string, get: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await get();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out after ${String(ms)} ms waiting for ${what}`);
}

async function openPrompt(
  app: ElectronApplication,
  form: unknown,
): Promise<{ req: number; page: Page }> {
  const next = app.waitForEvent('window', { timeout: 20_000 });
  const req = await hooks(app, (h, f) => h.openPrompt(f), form);
  assert.ok(req > 0, 'the hook refused the form');
  const page = await next;
  await page.waitForSelector('form', { timeout: 20_000 });
  return { req, page };
}

const answerOf = (app: ElectronApplication, req: number) =>
  until(`the answer to ${String(req)}`, async () => {
    const a = await hooks(app, (h, r) => h.promptAnswer(r as number), req);
    return a === 'pending' || a === undefined ? undefined : { value: a };
  });

void describe(
  'the trusted prompt window (ADR 0013)',
  { skip: E2E ? false : 'set NUTFLIX_E2E=1 to run (Electron, D4)' },
  () => {
    let dir = '';
    let app: ElectronApplication;
    let main: Page;
    const csp: string[] = [];

    before(async () => {
      const sandbox = sandboxReady(electronBinary());
      assert.ok(sandbox.ok, sandbox.why);
      dir = mkdtempSync(join(tmpdir(), 'nf-e2e-signer-'));
      const launched = await launch(join(PKG, 'dist', 'main', 'main.js'), [
        '--dev-mocks',
        '--user-data-dir',
        join(dir, 'user-data'),
        '--e2e-hooks',
      ]);
      app = launched.app;
      main = launched.page;
      await main.waitForSelector('.nf-shell', { timeout: 30_000 });
    });

    after(async () => {
      await app.close().catch(() => undefined);
      if (dir !== '') rmSync(dir, { recursive: true, force: true });
    });

    void it('opens at app://prompt in its own sandboxed process, modal, with only its two calls', async () => {
      const { req, page } = await openPrompt(app, { kind: 'new-passphrase' });
      page.on('console', (m) => {
        if (/Content[- ]Security[- ]Policy/i.test(m.text())) csp.push(m.text());
      });
      assert.equal(page.url(), 'app://prompt/prompt.html');
      const surface = await page.evaluate(() => ({
        nutflix: typeof (window as unknown as { nutflix?: unknown }).nutflix,
        prompt: Object.keys(
          (window as unknown as { nutflixPrompt?: object }).nutflixPrompt ?? {},
        ).sort(),
        require: typeof (globalThis as { require?: unknown }).require,
        process: typeof (globalThis as { process?: unknown }).process,
      }));
      assert.deepEqual(surface, {
        nutflix: 'undefined',
        prompt: ['answer', 'question'],
        require: 'undefined',
        process: 'undefined',
      });
      const layout = await app.evaluate(({ BrowserWindow }) => {
        const all = BrowserWindow.getAllWindows();
        const prompt = all.find((w) => w.getParentWindow() !== null);
        const parent = prompt?.getParentWindow();
        return {
          windows: all.length,
          modal: prompt?.isModal() ?? false,
          parentIsApp: parent?.getParentWindow() === null,
          pids: all.map((w) => w.webContents.getOSProcessId()),
          promptPid: prompt?.webContents.getOSProcessId() ?? 0,
        };
      });
      assert.equal(layout.windows, 2);
      assert.equal(layout.modal, true);
      assert.equal(layout.parentIsApp, true);
      assert.equal(new Set(layout.pids).size, 2, 'the prompt must not share the app renderer');
      if (process.platform === 'linux') {
        const status = readFileSync(`/proc/${String(layout.promptPid)}/status`, 'utf8');
        assert.match(status, /^Seccomp:\s*2$/m, 'the prompt renderer has no seccomp-bpf filter');
        const nspid = /^NSpid:\s*(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/) ?? [];
        assert.ok(nspid.length >= 2, 'the prompt renderer shares the PID namespace');
      }
      // CSP: the page itself raised no violation; an injected inline script does not run.
      assert.deepEqual(csp, []);
      const ran = await page.evaluate(() => {
        const s = document.createElement('script');
        s.textContent = 'window.__inline = 1';
        document.head.appendChild(s);
        return (window as unknown as { __inline?: number }).__inline ?? 0;
      });
      assert.equal(ran, 0);
      await until('the CSP report', () => Promise.resolve(csp.length > 0 ? true : undefined));
      assert.equal(csp.length, 1);
      assert.match(csp.join('\n'), /inline script/);

      // A too-short passphrase stays on the page; a good one reaches main as bytes.
      await page.fill('#pass', 'short');
      await page.fill('#pass2', 'short');
      await page.click('button.primary');
      await page.waitForSelector('.error:not([hidden])');
      assert.equal(await hooks(app, (h, r) => h.promptAnswer(r as number), req), 'pending');
      const pass = 'an e2e passphrase';
      await page.fill('#pass', pass);
      await page.fill('#pass2', pass);
      await page.click('button.primary');
      const { value } = await answerOf(app, req);
      assert.deepEqual(value, { kind: 'secret', bytes: Buffer.byteLength(pass) });
      await until('the prompt to close', async () => {
        const n = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
        return n === 1 ? true : undefined;
      });
      assert.equal(await hooks(app, (h) => h.promptWindowId()), null);
    });

    void it('"create a wallet" defaults to Not now; Escape and closing the window cancel', async () => {
      const w = await openPrompt(app, { kind: 'create-wallet' });
      assert.equal(await w.page.evaluate(() => document.activeElement?.textContent), 'Not now');
      // The answer closes the window mid-keypress; that is the expected effect.
      await w.page.keyboard.press('Enter').catch(() => undefined);
      assert.deepEqual((await answerOf(app, w.req)).value, {
        kind: 'create-wallet:false',
        bytes: 0,
      });

      const e = await openPrompt(app, { kind: 'import-nsec' });
      await e.page.keyboard.press('Escape').catch(() => undefined);
      assert.equal((await answerOf(app, e.req)).value, null);

      const c = await openPrompt(app, { kind: 'unlock-passphrase', retry: false });
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((x) => x.getParentWindow() !== null)
          ?.close();
      });
      assert.equal((await answerOf(app, c.req)).value, null);
    });

    void it("removing the key and a remote signer's approval link default to the safe answer", async () => {
      const r = await openPrompt(app, { kind: 'remove-key' });
      assert.equal(await r.page.evaluate(() => document.activeElement?.textContent), 'Keep it');
      assert.equal(await r.page.locator('button.danger').textContent(), 'Delete key');
      await r.page.keyboard.press('Escape').catch(() => undefined);
      assert.deepEqual((await answerOf(app, r.req)).value, { kind: 'remove-key:false', bytes: 0 });

      // Never "Open in browser" here: it would launch the system browser.
      const a = await openPrompt(app, {
        kind: 'bunker-auth',
        url: 'https://auth.bunker.example/approve?t=e2e',
      });
      assert.equal(await a.page.locator('.host code').textContent(), 'auth.bunker.example');
      assert.equal(await a.page.evaluate(() => document.activeElement?.textContent), 'Not now');
      await a.page.keyboard.press('Enter').catch(() => undefined);
      assert.deepEqual((await answerOf(app, a.req)).value, { kind: 'bunker-auth:false', bytes: 0 });
    });
  },
);

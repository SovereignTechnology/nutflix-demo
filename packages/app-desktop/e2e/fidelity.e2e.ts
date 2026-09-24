/**
 * Day-1 fidelity spike (design risk 5) — NEVER part of `npm test`.
 *
 *   NUTFLIX_E2E=1 node --test packages/app-desktop/e2e/fidelity.e2e.ts
 *
 * Needs D4 (Cameron's AppArmor `userns` profile: run with NUTFLIX_E2E_APPARMOR_PROFILE=1) and an
 * X11 display (see support.ts `displayStrategies`); needs no L6-B/C code. Bundles
 * `e2e/fidelity/*` with esbuild into a temp dir, launches Electron 44 on it, and records what
 * the real runtime does — the assumptions the unit tests encode by emulation:
 *
 *   1. `contextBridge` and Maps: does a `Map` arrive as a `Map`? (shell sends `$map` either way)
 *   2. Errors: is a custom `.code` dropped, is the `"<code>: "` message prefix kept?
 *   3. Functions in results (a PlaySession) and callbacks (onSpend → unsubscribe) are proxied.
 *   4. `webUtils.getPathForFile` in a SANDBOXED preload: a picked file → its path; a
 *      page-constructed `File` → `''` (SE-1 relies on this).
 *   5. Seeking through `protocol.handle` + `net.fetch`: `<video src="nf-media://…">` plays, a
 *      seek produces a Range request answered 206.
 *   6. An ESM `utilityProcess` starts and spawns Bare via `bare-sidecar` (echo over IPC).
 *   7. The CSP response header blocks an inline script; the page has no `require`.
 *
 * The findings are printed as JSON; copy them into docs/lanes/L6-A.md ("Fidelity findings").
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { build } from 'esbuild';
import type { ElectronApplication, Page } from 'playwright-core';
import {
  E2E,
  FIXTURE,
  PKG,
  electronBinary,
  hasFfmpeg,
  launch,
  makeFixtureMp4,
  sandboxReady,
} from './support.ts';

/**
 * Where the seek probe jumps: far past what Chromium has buffered from `bytes=0-` (it reads
 * ~10 s ahead, then defers), so the seek genuinely needs a NEW Range request answered 206.
 */
const SEEK_TO = Math.round(FIXTURE.seconds * (2 / 3));

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>fidelity</title>
<script>window.__inline = 1;</script>
<script type="module" src="page.js"></script></head>
<body><input id="pick" type="file"><video id="v" src="nf-media://play/fixture" muted playsinline></video></body></html>`;

const BARE_ECHO = `Bare.IPC.on('data', (d) => { Bare.IPC.write(d) })\n`;

async function findings(app: ElectronApplication): Promise<Record<string, unknown>> {
  return app.evaluate(
    () => (globalThis as Record<string, unknown>)['__fidelity'] as Record<string, unknown>,
  );
}

async function until<T>(what: string, get: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await get();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out after ${String(ms)} ms waiting for ${what}`);
}

void describe(
  'fidelity spike (risk 5)',
  { skip: E2E ? false : 'set NUTFLIX_E2E=1 to run (Electron, D4)' },
  () => {
    let dir = '';
    let app: ElectronApplication;
    let page: Page;
    let launchInfo: Record<string, unknown> = {};
    let fixtureSize = 0;

    before(async () => {
      const sandbox = sandboxReady(electronBinary());
      assert.ok(sandbox.ok, sandbox.why);
      assert.ok(hasFfmpeg(), 'system ffmpeg is required for the seek probe');
      dir = mkdtempSync(join(tmpdir(), 'nf-fidelity-'));
      const src = join(PKG, 'e2e', 'fidelity');
      const common = {
        bundle: true,
        absWorkingDir: PKG,
        logLevel: 'warning' as const,
        target: 'chrome152',
      };
      await build({
        ...common,
        entryPoints: [join(src, 'main.ts')],
        outfile: join(dir, 'main.mjs'),
        format: 'esm',
        platform: 'node',
        external: ['electron'],
      });
      await build({
        ...common,
        entryPoints: [join(src, 'preload.ts')],
        outfile: join(dir, 'preload.cjs'),
        format: 'cjs',
        platform: 'browser',
        external: ['electron'],
      });
      await build({
        ...common,
        entryPoints: [join(src, 'page.ts')],
        outfile: join(dir, 'page.js'),
        format: 'esm',
        platform: 'browser',
      });
      await build({
        ...common,
        entryPoints: [join(src, 'utility.ts')],
        outfile: join(dir, 'utility.mjs'),
        format: 'esm',
        platform: 'node',
        external: ['electron', 'bare-sidecar'],
      });
      writeFileSync(join(dir, 'index.html'), HTML);
      writeFileSync(join(dir, 'bare-echo.js'), BARE_ECHO);
      makeFixtureMp4(join(dir, 'fixture.mp4'), 'testsrc');
      fixtureSize = statSync(join(dir, 'fixture.mp4')).size;
      const launched = await launch(join(dir, 'main.mjs'), [], {
        NUTFLIX_FIDELITY_MP4: join(dir, 'fixture.mp4'),
        NUTFLIX_FIDELITY_PKG: PKG,
      });
      app = launched.app;
      page = launched.page;
      launchInfo = { display: launched.display, sandbox: launched.sandbox };
    });

    after(async () => {
      const f = await findings(app).catch(() => ({}));
      process.stdout.write(
        `\nFIDELITY FINDINGS ${JSON.stringify({ ...f, launch: launchInfo }, null, 2)}\n`,
      );
      await app.close().catch(() => undefined);
      if (dir !== '') rmSync(dir, { recursive: true, force: true });
    });

    void it('contextBridge: Maps, bytes, errors, functions, callbacks (findings 1–3)', async () => {
      const p = await until(
        'the page report',
        async () => (await findings(app))['page'] as Record<string, unknown> | undefined,
      );
      // Recorded, not asserted: the shell never relies on Maps crossing (it sends $map).
      process.stdout.write(`mapIsMap=${String(p['mapIsMap'])} mapShape=${String(p['mapShape'])}\n`);
      assert.deepEqual(p['wireMap'], { $map: [['https://mint.example', 21]] });
      assert.equal(p['bytesIsUint8Array'], true);
      assert.match(String(p['errorMessage']), /no-seeders: nobody is seeding/);
      assert.equal(p['sessionSid'], 'a'.repeat(32));
      assert.equal(p['sessionPause'], 'paused');
      assert.equal(p['callbackValue'], 7);
      assert.equal(p['unsubscribe'], 'unsubscribed');
    });

    void it('webUtils.getPathForFile in a sandboxed preload (finding 4, SE-1)', async () => {
      const p0 = (await findings(app))['page'] as Record<string, unknown>;
      assert.equal(p0['constructedFilePath'], '');
      // Recorded: the preload checks File/Blob by shape, so either answer works.
      process.stdout.write(`kinds=${JSON.stringify(p0['kinds'])}\n`);
      await page.setInputFiles('#pick', join(dir, 'fixture.mp4'));
      const picked = await until('the picked path', async () => {
        const p = (await findings(app))['page'] as Record<string, unknown> | undefined;
        return p?.['pickedPath'] as string | undefined;
      });
      assert.equal(picked, join(dir, 'fixture.mp4'));
    });

    void it('seeking through protocol.handle + net.fetch (finding 5)', async () => {
      // Playing first (the element starts reading at `bytes=0-`), then a seek far ahead.
      await page.evaluate(async () => {
        const v = document.getElementById('v') as HTMLVideoElement;
        await v.play().catch(() => undefined);
      });
      await page.waitForFunction(
        () => (document.getElementById('v') as HTMLVideoElement).currentTime > 0.5,
        undefined,
        { timeout: 20_000 },
      );
      const before = ((await findings(app))['rangeRequests'] as string[]).length;
      await page.evaluate((t) => {
        (document.getElementById('v') as HTMLVideoElement).currentTime = t;
      }, SEEK_TO);
      const seeked = await until('seeked', async () => {
        const p = (await findings(app))['page'] as Record<string, unknown> | undefined;
        return p?.['seekedTo'] as number | undefined;
      });
      assert.ok(seeked >= SEEK_TO - 0.1, `seeked to ${String(seeked)}, asked ${String(SEEK_TO)}`);
      const f = await findings(app);
      const ranges = f['rangeRequests'] as string[];
      assert.ok((f['statuses'] as number[]).includes(206), 'a 206 came back through nf-media:');
      // The seek's own request: near SEEK_TO (CBR; keyframes every 2 s). Chromium also
      // re-requests near the start by itself (`bytes=524288-` …), which must not count.
      const from = Math.floor((SEEK_TO - 4) * (fixtureSize / FIXTURE.seconds));
      assert.ok(
        ranges.slice(before).some((r) => Number(/^bytes=(\d+)-/.exec(r)?.[1] ?? -1) >= from),
        `the seek made a new Range request from ≥ ${String(from)} (all: ${JSON.stringify(ranges)})`,
      );
    });

    void it('ESM utilityProcess + bare-sidecar (finding 6)', async () => {
      const u = await until('the utility report', async () => {
        const x = (await findings(app))['utility'] as Record<string, unknown> | undefined;
        return x?.['bare'] !== undefined ? x : undefined;
      });
      assert.equal(u['esm'], true);
      assert.equal(u['bare'], 'ping');
    });

    void it('CSP header blocks inline script; no Node in the page; sandbox posture (finding 7)', async () => {
      const f = await findings(app);
      const p = f['page'] as Record<string, unknown>;
      assert.equal(p['inlineScriptRan'], false);
      assert.equal(p['hasRequire'], 'undefined');
      assert.equal(f['noSandboxSwitch'], false);
      assert.equal((f['webPreferences'] as Record<string, unknown>)['sandbox'], true);
    });
  },
);

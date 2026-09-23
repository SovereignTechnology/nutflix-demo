/**
 * Shared plumbing for the Electron end-to-end suites (never run by `npm test`; see
 * docs/lanes/L6-A.md "Running the Electron suites"). Runs under plain Node 24 with type
 * stripping: only erasable TypeScript, relative imports with `.ts` extensions.
 *
 * Nothing here weakens the sandbox (D4): `sandboxReady()` only REPORTS whether Chromium's
 * sandbox can start on this machine, and the suites stop with Cameron's fix if it cannot.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';

export const E2E = process.env['NUTFLIX_E2E'] === '1';
export const PKG = dirname(dirname(fileURLToPath(import.meta.url)));

/** The Electron binary `node node_modules/electron/install.js` extracted. */
export function electronBinary(): string {
  const req = createRequire(import.meta.url);
  const p = req('electron') as unknown;
  if (typeof p !== 'string' || !existsSync(p)) {
    throw new Error(
      'Electron binary missing: run `node node_modules/electron/install.js` (uses the cached zip)',
    );
  }
  return p;
}

/**
 * Whether Chromium's sandbox can start here (D4). One of:
 *   - `chrome-sandbox` next to the binary is root-owned and mode 4755 (SUID sandbox), or
 *   - unprivileged user namespaces are allowed (`kernel.apparmor_restrict_unprivileged_userns`
 *     is 0 or absent), or
 *   - Cameron installed an AppArmor profile granting `userns` to this binary and says so with
 *     `NUTFLIX_E2E_APPARMOR_PROFILE=1` (a profile cannot be detected without root).
 * Never `--no-sandbox`.
 */
export function sandboxReady(binary: string): { ok: boolean; why: string } {
  const helper = join(dirname(binary), 'chrome-sandbox');
  try {
    const st = statSync(helper);
    if (st.uid === 0 && (st.mode & 0o4755) === 0o4755)
      return { ok: true, why: 'SUID chrome-sandbox' };
  } catch {
    // no helper: fall through
  }
  let restricted: string;
  try {
    restricted = readFileSync(
      '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
      'utf8',
    ).trim();
  } catch {
    restricted = '0';
  }
  if (restricted === '0') return { ok: true, why: 'unprivileged user namespaces allowed' };
  if (process.env['NUTFLIX_E2E_APPARMOR_PROFILE'] === '1')
    return { ok: true, why: 'AppArmor userns profile (declared)' };
  return {
    ok: false,
    why:
      `Chromium's sandbox cannot start (D4): ${helper} is not root-owned 4755 and ` +
      'kernel.apparmor_restrict_unprivileged_userns=1. Cameron: either\n' +
      `  sudo chown root:root ${helper} && sudo chmod 4755 ${helper}\n` +
      'or install an AppArmor profile allowing `userns` for that electron binary, then rerun with ' +
      'NUTFLIX_E2E_APPARMOR_PROFILE=1. Never --no-sandbox.',
  };
}

export function hasFfmpeg(): boolean {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

/** A 6 s H.264 + faststart MP4 from lavfi (design §5b). */
export function makeFixtureMp4(out: string, source: 'testsrc' | 'testsrc2'): void {
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `${source}=size=640x360:rate=30`,
      '-t',
      '6',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-y',
      out,
    ],
    { stdio: 'inherit', timeout: 120_000 },
  );
}

/**
 * Display strategies, in the order design §5b asks for: Ozone headless first, then the
 * session's Wayland, then X11 (`DISPLAY`, e.g. under `xvfb-run`).
 */
export function displayStrategies(): { name: string; switches: string[] }[] {
  const out = [{ name: 'ozone-headless', switches: ['--ozone-platform=headless'] }];
  if (process.env['WAYLAND_DISPLAY'] !== undefined) {
    out.push({ name: 'wayland', switches: ['--ozone-platform=wayland'] });
  }
  if (process.env['DISPLAY'] !== undefined)
    out.push({ name: 'x11', switches: ['--ozone-platform=x11'] });
  return out;
}

/**
 * Launches `script` (a main-process entry) with each display strategy until one shows a
 * window. Throws with every strategy's failure otherwise.
 */
export async function launch(
  script: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ app: ElectronApplication; page: Page; display: string }> {
  const binary = electronBinary();
  const failures: string[] = [];
  for (const d of displayStrategies()) {
    let app: ElectronApplication | undefined;
    try {
      app = await _electron.launch({
        executablePath: binary,
        args: [...d.switches, script, ...args],
        env: { ...(process.env as Record<string, string>), ...env },
        timeout: 30_000,
      });
      const page = await app.firstWindow({ timeout: 30_000 });
      return { app, page, display: d.name };
    } catch (e: unknown) {
      failures.push(
        `${d.name}: ${e instanceof Error ? (e.message.split('\n')[0] ?? '') : String(e)}`,
      );
      await app?.close().catch(() => undefined);
    }
  }
  throw new Error(`no display strategy worked:\n  ${failures.join('\n  ')}`);
}

/** The recursive own-key tree of an object as dotted names (for the preload allowlist). */
export const KEY_TREE_SOURCE = `(() => {
  const walk = (o, p) => Object.keys(o).flatMap((k) => {
    const n = p === '' ? k : p + '.' + k;
    const v = o[k];
    return v !== null && typeof v === 'object' ? [n, ...walk(v, n)] : [n];
  });
  return walk(window.nutflix, '').sort();
})()`;

/**
 * What a finished package must look like (issue #6, ADR 0017), checked on every packaged output
 * before it counts (Forge `postPackage`), alongside the fuse read-back:
 *
 *   - `resources/app.asar` exists and there is no `resources/app/` folder (OnlyLoadAppFromAsar
 *     would refuse to start from one anyway);
 *   - main, the host and the renderer are PACKED (inside the archive, so on macOS/Windows the
 *     integrity fuse covers the code that holds the wallet and the signer);
 *   - the worker boot module and bundle, and bare-sidecar's runtime for this target, are
 *     UNPACKED real files, and the runtime is executable (the host refuses it otherwise);
 *   - no other platform's `bare` runtime was shipped.
 */
import { accessSync, constants, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { statFile } from '@electron/asar';

import {
  PACKAGED_WORKER_BUNDLE,
  PACKAGED_WORKER_ENTRY,
  PRELOAD_FILES,
  PROMPT_FILES,
  RENDERER_FILES,
} from './identity.ts';

export function resourcesDir(outputDir: string, platform: string, productName: string): string {
  return platform === 'darwin' || platform === 'mas'
    ? join(outputDir, `${productName}.app`, 'Contents', 'Resources')
    : join(outputDir, 'resources');
}

/**
 * Files that must be packed (read from app.asar, covered by its header hash): everything main
 * loads or serves — its own bundle, the host, both preloads, and every file of the app window
 * and the prompt window (ADR 0013), derived from the same lists the staging step copies, so a
 * file added there is checked here too (independent review of the packaging lane).
 */
export const PACKED: readonly string[] = [
  'package.json',
  'main/main.js',
  'host/main.js',
  ...PRELOAD_FILES,
  ...RENDERER_FILES.map((f) => `renderer/${f}`),
  ...PROMPT_FILES.map((f) => `prompt/${f}`),
];

export function layoutProblems(
  outputDir: string,
  platform: string,
  arch: string,
  productName: string,
): string[] {
  const res = resourcesDir(outputDir, platform, productName);
  const asar = join(res, 'app.asar');
  const unpacked = join(res, 'app.asar.unpacked');
  const problems: string[] = [];
  if (!existsSync(asar)) return [`${asar} is missing`];
  if (existsSync(join(res, 'app')))
    problems.push(`${join(res, 'app')} exists (only app.asar may hold the app)`);
  for (const f of PACKED) {
    try {
      const e = statFile(asar, f) as { unpacked?: boolean; size?: number };
      if (e.unpacked === true) problems.push(`${f} is unpacked; it must be inside app.asar`);
    } catch {
      problems.push(`${f} is not in app.asar`);
    }
  }
  for (const f of [PACKAGED_WORKER_ENTRY, PACKAGED_WORKER_BUNDLE])
    if (!existsSync(join(unpacked, f))) problems.push(`${f} is not unpacked`);
  const prebuilds = join(unpacked, 'node_modules', 'bare-sidecar', 'prebuilds');
  const bin = join(prebuilds, `${platform}-${arch}`, platform === 'win32' ? 'bare.exe' : 'bare');
  if (!existsSync(bin)) problems.push(`the Bare runtime for ${platform}-${arch} is missing`);
  else if (platform !== 'win32' && process.platform !== 'win32') {
    try {
      accessSync(bin, constants.X_OK);
    } catch {
      problems.push(`${bin} is not executable`);
    }
  }
  if (existsSync(prebuilds)) {
    const extra = readdirSync(prebuilds).filter(
      (d) => d !== `${platform}-${arch}` && !(platform === 'darwin' && d === 'darwin-universal'),
    );
    if (extra.length > 0)
      problems.push(`other platforms' Bare runtimes shipped: ${extra.join(', ')}`);
  }
  return problems;
}

export function assertLayout(
  outputDir: string,
  platform: string,
  arch: string,
  productName: string,
): void {
  const p = layoutProblems(outputDir, platform, arch, productName);
  if (p.length > 0) throw new Error(`packaged layout wrong in ${outputDir}:\n  ${p.join('\n  ')}`);
}

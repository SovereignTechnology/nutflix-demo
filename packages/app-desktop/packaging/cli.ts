/**
 * Packaging driver (issue #6, ADR 0017). Stages the app (stage.ts), registers the Forge config
 * for the staged directory, and runs Electron Forge. Everything lands under
 * `packages/app-desktop/out/` (gitignored). Needs `npm run build` first.
 *
 *   node packaging/cli.ts stage   [--platform p] [--arch a]
 *   node packaging/cli.ts package [--platform p] [--arch a]
 *   node packaging/cli.ts make    [--platform p] [--arch a] [--targets deb,appimage,…]
 *
 * Options: `--out <dir>` (default out/), `--appimage-runtime-dir <dir>` (default
 * out/appimage-runtime; holds the pinned runtime file, placed by hand — maker-appimage.ts).
 *
 * After `package`/`make`: the fuses of every packaged binary were read back and match
 * fuses.ts, and the layout matches layout.ts (a mismatch fails the run). Then run
 * `node ../../scripts/release-manifest.mjs out/make` for the sha256 manifest and the UNSIGNED
 * Nostr event (signed later through Bunker46 — never here).
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { api, utils } from '@electron-forge/core';
import type { ForgeArch, ForgePlatform } from '@electron-forge/shared-types';

import { TARGETS, forgeConfig, type Target } from './forge-config.ts';
import { pinnedRuntime } from './maker-appimage.ts';
import { PKG_DIR, REPO_ROOT, stageApp } from './stage.ts';

const PLATFORMS: readonly ForgePlatform[] = ['linux', 'win32', 'darwin'];
const ARCHES: readonly ForgeArch[] = ['x64', 'arm64'];

export interface CliOptions {
  readonly command: 'stage' | 'package' | 'make';
  readonly platform: ForgePlatform;
  readonly arch: ForgeArch;
  readonly out: string;
  readonly appImageRuntimeDir: string;
  readonly targets: readonly Target[] | undefined;
}

export function parseCli(argv: readonly string[]): CliOptions {
  const [command, ...rest] = argv;
  if (command !== 'stage' && command !== 'package' && command !== 'make')
    throw new Error('usage: cli.ts <stage|package|make> [--platform p] [--arch a] [--targets t,…]');
  const opts = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i] ?? '';
    const v = rest[i + 1];
    if (
      !['--platform', '--arch', '--out', '--appimage-runtime-dir', '--targets'].includes(k) ||
      v === undefined
    )
      throw new Error(`unknown or incomplete option ${k}`);
    opts.set(k, v);
  }
  const platform = (opts.get('--platform') ?? process.platform) as ForgePlatform;
  const arch = (opts.get('--arch') ?? process.arch) as ForgeArch;
  if (!PLATFORMS.includes(platform))
    throw new Error(`--platform must be one of ${PLATFORMS.join(', ')}`);
  if (!ARCHES.includes(arch)) throw new Error(`--arch must be one of ${ARCHES.join(', ')}`);
  const out = resolve(opts.get('--out') ?? join(PKG_DIR, 'out'));
  const targetsArg = opts.get('--targets');
  let targets: Target[] | undefined;
  if (targetsArg !== undefined) {
    targets = [];
    for (const t of targetsArg.split(',')) {
      if (!(TARGETS as readonly string[]).includes(t))
        throw new Error(`unknown target ${t} (known: ${TARGETS.join(', ')})`);
      targets.push(t as Target);
    }
  }
  return {
    command,
    platform,
    arch,
    out,
    appImageRuntimeDir: resolve(
      opts.get('--appimage-runtime-dir') ?? join(out, 'appimage-runtime'),
    ),
    targets,
  };
}

export async function runCli(o: CliOptions): Promise<string[]> {
  // Fail before minutes of packaging when the AppImage maker would refuse anyway.
  if (o.command === 'make' && o.platform === 'linux' && (o.targets ?? TARGETS).includes('appimage'))
    pinnedRuntime(o.appImageRuntimeDir, o.arch);
  const stageDir = join(o.out, `stage-${o.platform}-${o.arch}`);
  const staged = await stageApp({ out: stageDir, platform: o.platform, arch: o.arch });
  process.stdout.write(
    `staged ${staged.out}: ${String(staged.packages.length)} packages, ${String(staged.files)} files, ${(staged.bytes / 1e6).toFixed(1)} MB\n`,
  );
  if (o.command === 'stage') return [staged.out];
  const checksums = JSON.parse(
    readFileSync(join(REPO_ROOT, 'node_modules', 'electron', 'checksums.json'), 'utf8'),
  ) as Record<string, string>;
  utils.registerForgeConfigForDirectory(
    stageDir,
    forgeConfig({
      electronChecksums: checksums,
      appImageRuntimeDir: o.appImageRuntimeDir,
      ...(o.targets === undefined ? {} : { targets: o.targets }),
    }),
  );
  try {
    if (o.command === 'package') {
      const r = await api.package({
        dir: stageDir,
        interactive: false,
        platform: o.platform,
        arch: o.arch,
        outDir: o.out,
      });
      return r.map((x) => x.packagedPath);
    }
    const made = await api.make({
      dir: stageDir,
      interactive: false,
      platform: o.platform,
      arch: o.arch,
      outDir: o.out,
    });
    return made.flatMap((m) => m.artifacts);
  } finally {
    utils.unregisterForgeConfigForDirectory(stageDir);
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(PKG_DIR, 'packaging', 'cli.ts')
) {
  // Whatever the caller's umask, created files are 0644 and directories 0755 (app.asar, the
  // installers); stage.ts normalises what it copies.
  process.umask(0o022);
  let o: CliOptions;
  try {
    o = parseCli(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`packaging: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
  runCli(o).then(
    (paths) => {
      for (const p of paths) process.stdout.write(`${p}\n`);
    },
    (err: unknown) => {
      process.stderr.write(`packaging: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}

/**
 * An AppImage maker for Electron Forge, in-repo (issue #6, ADR 0017). Why not a published one:
 *   - `pear-electron-forge-maker-appimage` 2.0.1 (Holepunch) writes an `AppRun` that adds
 *     `--no-sandbox` on Ubuntu ≥ 24 — main refuses that switch (D4), so the app would not start,
 *     and the sandbox is not negotiable; it also pulls electron-builder's `app-builder-lib`.
 *   - `@reforged/maker-appimage` 5.3.1 downloads the AppImage runtime from a MOVING release tag
 *     (`continuous`) at build time, unverified, and pins Forge 7's maker-base, whose tree carries
 *     advisories (critical `tar`, `extract-zip`) the CI advisory gate refuses.
 * What an AppImage is: the type-2 runtime (a static ELF) followed by a squashfs image of an AppDir.
 * This maker builds the AppDir (`AppRun` → the Electron binary itself, no wrapper script; a
 * desktop entry), squashes it with the system `mksquashfs`, and prepends the runtime — a runtime
 * file placed by hand whose sha256 must equal the pin below, or the build fails. Nothing is
 * downloaded here.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
  copyFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { MakerBase, type MakerOptions } from '@electron-forge/maker-base';
import type { ForgePlatform } from '@electron-forge/shared-types';

const run = promisify(execFile);

export interface RuntimePin {
  /** File name of the release asset (and of the file expected in `runtimeDir`). */
  readonly asset: string;
  readonly sha256: string;
}

/**
 * AppImage/type2-runtime release `20251108` (an immutable dated tag, not `continuous`):
 * https://github.com/AppImage/type2-runtime/releases/tag/20251108. The digests were read from
 * GitHub's release asset listing on 2026-09-25; the release also ships `.sig` files and the
 * signing key (`signing-pubkey.asc`). A wrong pin fails the build closed, never open.
 */
export const APPIMAGE_RUNTIME_RELEASE =
  'https://github.com/AppImage/type2-runtime/releases/tag/20251108';
export const APPIMAGE_RUNTIMES: Readonly<Record<string, RuntimePin>> = {
  x64: {
    asset: 'runtime-x86_64',
    sha256: '2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d',
  },
  arm64: {
    asset: 'runtime-aarch64',
    sha256: '00cbdfcf917cc6c0ff6d3347d59e0ca1f7f45a6df1a428a0d6d8a78664d87444',
  },
};

export interface MakerAppImageConfig {
  /** Directory holding the pinned runtime file(s) (`runtime-x86_64`, …). */
  readonly runtimeDir: string;
  /** Binary name inside the packaged app (packager's `executableName`). */
  readonly executableName: string;
  readonly productName: string;
  readonly comment: string;
  readonly categories: readonly string[];
  /** A PNG icon; optional (the repo has no brand icon yet — ADR 0017). */
  readonly icon?: string;
  /** Tests only: other pins (e.g. a fixture runtime). */
  readonly runtimes?: Readonly<Record<string, RuntimePin>>;
}

export class AppImageError extends Error {
  override readonly name = 'AppImageError' as const;
}

/** The runtime bytes for `arch`, refused unless present and equal to the pin. */
export function pinnedRuntime(
  runtimeDir: string,
  arch: string,
  pins: Readonly<Record<string, RuntimePin>> = APPIMAGE_RUNTIMES,
): Uint8Array {
  const pin = pins[arch];
  if (pin === undefined) throw new AppImageError(`no pinned AppImage runtime for ${arch}`);
  const file = join(runtimeDir, pin.asset);
  if (!existsSync(file))
    throw new AppImageError(
      `AppImage runtime missing: ${file}. Download ${pin.asset} from ${APPIMAGE_RUNTIME_RELEASE}, ` +
        `check its sha256 is ${pin.sha256} (and its .sig), and put it there. Nothing is downloaded by the build.`,
    );
  const bytes = readFileSync(file);
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== pin.sha256)
    throw new AppImageError(
      `AppImage runtime ${file} has sha256 ${got}, pinned ${pin.sha256}: refused`,
    );
  return bytes;
}

/** The AppDir's desktop entry. `Exec` is the binary itself: no wrapper, no extra switches. */
export function desktopEntry(c: {
  productName: string;
  executableName: string;
  comment: string;
  categories: readonly string[];
  version: string;
  icon: boolean;
}): string {
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${c.productName}`,
    `Comment=${c.comment}`,
    `Exec=${c.executableName} %U`,
    ...(c.icon ? [`Icon=${c.executableName}`] : []),
    'Terminal=false',
    `Categories=${c.categories.map((x) => `${x};`).join('')}`,
    `X-AppImage-Version=${c.version}`,
  ];
  for (const l of lines)
    if (/[\r\n]/.test(l)) throw new AppImageError('desktop entry values must be single lines');
  return `${lines.join('\n')}\n`;
}

/** `mksquashfs` argv: root-owned, no xattrs, fixed timestamps when SOURCE_DATE_EPOCH is set. */
export function mksquashfsArgs(src: string, dst: string, epoch: string | undefined): string[] {
  const args = [
    src,
    dst,
    '-root-owned',
    '-noappend',
    '-no-xattrs',
    '-comp',
    'gzip',
    '-quiet',
    '-no-progress',
  ];
  if (epoch !== undefined && /^\d+$/.test(epoch))
    args.push('-mkfs-time', epoch, '-all-time', epoch);
  return args;
}

export class MakerAppImage extends MakerBase<MakerAppImageConfig> {
  name = 'appimage';
  defaultPlatforms: ForgePlatform[] = ['linux'];
  override requiredExternalBinaries = ['mksquashfs'];

  override isSupportedOnCurrentPlatform(): boolean {
    return process.platform === 'linux';
  }

  override async make({ dir, makeDir, targetArch, packageJSON }: MakerOptions): Promise<string[]> {
    const c = this.config;
    const v = (packageJSON as { version?: unknown }).version;
    const version = typeof v === 'string' ? v : '0.0.0';
    const runtime = pinnedRuntime(c.runtimeDir, targetArch, c.runtimes);
    const work = join(makeDir, 'appimage', targetArch);
    const appDir = join(work, 'AppDir');
    const image = join(work, 'image.squashfs');
    const outFile = join(work, `${c.productName}-${version}-${targetArch}.AppImage`);
    rmSync(work, { recursive: true, force: true });
    const lib = join(appDir, 'usr', 'lib', c.executableName);
    mkdirSync(lib, { recursive: true });
    // Modes are kept (the Electron binary, chrome-sandbox, the unpacked `bare`).
    cpSync(dir, lib, { recursive: true, verbatimSymlinks: true });
    symlinkSync(join('usr', 'lib', c.executableName, c.executableName), join(appDir, 'AppRun'));
    writeFileSync(
      join(appDir, `${c.executableName}.desktop`),
      desktopEntry({ ...c, version, icon: c.icon !== undefined }),
    );
    if (c.icon !== undefined) {
      copyFileSync(c.icon, join(appDir, `${c.executableName}.png`));
      symlinkSync(`${c.executableName}.png`, join(appDir, '.DirIcon'));
    }
    await run('mksquashfs', mksquashfsArgs(appDir, image, process.env['SOURCE_DATE_EPOCH']));
    writeFileSync(outFile, Buffer.concat([runtime, readFileSync(image)]));
    chmodSync(outFile, 0o755);
    rmSync(appDir, { recursive: true, force: true });
    rmSync(image, { force: true });
    return [outFile];
  }
}

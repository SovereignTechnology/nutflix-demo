/**
 * A .dmg maker for Electron Forge, in-repo (issue #6, ADR 0017), using only macOS's own tools
 * (`ditto`, `hdiutil`). `@electron-forge/maker-dmg` goes through `electron-installer-dmg` →
 * `appdmg` → `image-size`, which carries a high advisory the CI gate refuses, and needs two
 * native modules built by hand (`macos-alias`, `fs-xattr`) under `ignore-scripts`. A compressed
 * read-only image holding the app and an `/Applications` link is all the release needs; the
 * unsigned app shows Gatekeeper's warning (accepted for now, Cameron 2026-09-24).
 *
 * Runs on macOS only; configured and unit-tested here, never built on Linux.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { MakerBase, type MakerOptions } from '@electron-forge/maker-base';
import type { ForgePlatform } from '@electron-forge/shared-types';

const run = promisify(execFile);

export interface MakerDmgConfig {
  readonly productName: string;
  /** Tests only: runs each command instead of `execFile` (the config in forge-config.ts never sets it). */
  readonly exec?: (cmd: string, args: readonly string[]) => Promise<unknown>;
}

export interface Command {
  readonly cmd: string;
  readonly args: readonly string[];
}

/** The argv of each step (no shell anywhere): copy the bundle, then make the image. */
export function dmgCommands(o: {
  app: string;
  srcFolder: string;
  volumeName: string;
  out: string;
}): Command[] {
  if (/[/\\\0]/.test(o.volumeName)) throw new Error('volume name must not contain / \\ or NUL');
  return [
    { cmd: 'ditto', args: [o.app, join(o.srcFolder, `${o.volumeName}.app`)] },
    {
      cmd: 'hdiutil',
      args: [
        'create',
        '-volname',
        o.volumeName,
        '-srcfolder',
        o.srcFolder,
        '-fs',
        'HFS+',
        '-format',
        'UDZO',
        '-ov',
        o.out,
      ],
    },
  ];
}

export class MakerDmg extends MakerBase<MakerDmgConfig> {
  name = 'dmg';
  defaultPlatforms: ForgePlatform[] = ['darwin'];
  override requiredExternalBinaries = ['ditto', 'hdiutil'];

  override isSupportedOnCurrentPlatform(): boolean {
    return process.platform === 'darwin';
  }

  override async make({ dir, makeDir, targetArch, packageJSON }: MakerOptions): Promise<string[]> {
    const name = this.config.productName;
    const v = (packageJSON as { version?: unknown }).version;
    const version = typeof v === 'string' ? v : '0.0.0';
    const outDir = join(makeDir, 'dmg', targetArch);
    // Emptied first, as Forge's own makers do (squirrel, deb): an older .dmg left here would
    // otherwise sit beside this one in out/make (independent review of the packaging lane).
    await this.ensureDirectory(outDir);
    const out = join(outDir, `${name}-${version}-${targetArch}.dmg`);
    const srcFolder = mkdtempSync(join(outDir, '.dmg-src-'));
    const exec =
      this.config.exec ?? ((cmd: string, args: readonly string[]) => run(cmd, [...args]));
    try {
      symlinkSync('/Applications', join(srcFolder, 'Applications'));
      for (const c of dmgCommands({
        app: join(dir, `${name}.app`),
        srcFolder,
        volumeName: name,
        out,
      }))
        await exec(c.cmd, c.args);
    } finally {
      rmSync(srcFolder, { recursive: true, force: true });
    }
    return [out];
  }
}

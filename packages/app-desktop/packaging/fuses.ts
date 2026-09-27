/**
 * Electron fuses (security review F21; Cameron, 2026-09-24, and the sixth 2026-09-26). Exactly six
 * are set; every other fuse keeps Electron's default. They are flipped on the packaged binary
 * after the app is copied in (before any signing, which would otherwise be invalidated) and READ
 * BACK from every packaged binary before a build counts: a mismatch fails the build.
 *
 *   RunAsNode off                              `ELECTRON_RUN_AS_NODE=1 nutflix …` is not a Node shell
 *   EnableNodeOptionsEnvironmentVariable off   `NODE_OPTIONS` / `NODE_EXTRA_CA_CERTS` are ignored
 *   EnableNodeCliInspectArguments off          `--inspect*` and SIGUSR1 open no debugger
 *   EnableEmbeddedAsarIntegrityValidation on   app.asar's header hash is checked (macOS, Windows;
 *                                              Electron has no Linux support — ADR 0017)
 *   OnlyLoadAppFromAsar on                     no `resources/app/` folder or loose `default_app`
 *   GrantFileProtocolExtraPrivileges off       `file://` pages get no extra privileges (the app
 *                                              never loads `file://`: defence in depth, 2026-09-26)
 *
 * None of these can be done at runtime: they act before main's first line runs.
 */
import { join, resolve } from 'node:path';

import {
  FuseState,
  FuseV1Options,
  FuseVersion,
  flipFuses,
  getCurrentFuseWire,
  type FuseV1Config,
} from '@electron/fuses';

export const FUSES = {
  RunAsNode: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  GrantFileProtocolExtraPrivileges: false,
} as const satisfies Partial<Record<keyof typeof FuseV1Options, boolean>>;

type FuseName = keyof typeof FUSES;

/** The `flipFuses` config: the six settings above, nothing else. */
export function fuseConfig(resetAdHocDarwinSignature: boolean): FuseV1Config {
  const cfg: FuseV1Config = { version: FuseVersion.V1, resetAdHocDarwinSignature };
  for (const [name, on] of Object.entries(FUSES) as [FuseName, boolean][])
    cfg[FuseV1Options[name]] = on;
  return cfg;
}

/** The fuse wire a binary reports (`getCurrentFuseWire`), keyed by option index. */
export type FuseWire = Readonly<Partial<Record<number, FuseState>>>;

/** Every way `wire` differs from `FUSES` (empty = correct). A missing fuse is a mismatch. */
export function fuseMismatches(wire: FuseWire): string[] {
  const out: string[] = [];
  for (const [name, on] of Object.entries(FUSES) as [FuseName, boolean][]) {
    const want = on ? FuseState.ENABLE : FuseState.DISABLE;
    const got = wire[FuseV1Options[name]];
    if (got !== want)
      out.push(`${name}: expected ${on ? 'on' : 'off'}, binary has ${stateName(got)}`);
  }
  return out;
}

function stateName(s: FuseState | undefined): string {
  switch (s) {
    case FuseState.ENABLE:
      return 'on';
    case FuseState.DISABLE:
      return 'off';
    case FuseState.INHERIT:
      return 'inherit (never set)';
    case FuseState.REMOVED:
      return 'removed';
    case undefined:
      return 'no such fuse';
  }
}

export type TargetPlatform = 'linux' | 'win32' | 'darwin' | 'mas';

/**
 * The Electron binary inside a build path, while Forge's `packageAfterCopy` runs (before
 * packager renames it): `buildPath` is `<app>/resources/app` (Linux, Windows) or
 * `<X>.app/Contents/Resources/app` (macOS). Same rule as @electron-forge/plugin-fuses.
 */
export function electronBinaryInBuild(buildPath: string, platform: TargetPlatform): string {
  const base = resolve(buildPath, '..', '..');
  if (platform === 'darwin' || platform === 'mas') return join(base, 'MacOS', 'Electron');
  return join(base, platform === 'win32' ? 'electron.exe' : 'electron');
}

/** The executable of a finished package directory (what `electron-fuses read --app` takes). */
export function packagedBinary(
  outputDir: string,
  platform: TargetPlatform,
  executableName: string,
  productName: string,
): string {
  if (platform === 'darwin' || platform === 'mas') return join(outputDir, `${productName}.app`);
  return join(outputDir, platform === 'win32' ? `${executableName}.exe` : executableName);
}

/** Forge `packageAfterCopy`: flip the six fuses (ad-hoc re-sign only for unsigned arm64 macOS). */
export async function flipAppFuses(
  buildPath: string,
  platform: TargetPlatform,
  arch: string,
  signed: boolean,
): Promise<void> {
  const reset = !signed && (platform === 'darwin' || platform === 'mas') && arch === 'arm64';
  await flipFuses(electronBinaryInBuild(buildPath, platform), fuseConfig(reset));
}

/** Reads a packaged binary's fuses back; throws unless they are exactly `FUSES`. */
export async function assertAppFuses(binary: string): Promise<void> {
  const wire = (await getCurrentFuseWire(binary)) as unknown as FuseWire;
  const bad = fuseMismatches(wire);
  if (bad.length > 0) throw new Error(`fuses wrong on ${binary}:\n  ${bad.join('\n  ')}`);
}

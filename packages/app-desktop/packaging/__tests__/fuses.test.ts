/**
 * Issue #6 / security review F21: exactly five fuses, flipped on the packaged binary and read
 * back. The flip and the read-back run for real against a synthetic "binary" that carries
 * Electron's fuse sentinel and a 9-fuse wire (the layout @electron/fuses scans for), so no
 * Electron download is needed.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FuseState, FuseV1Options, FuseVersion, getCurrentFuseWire } from '@electron/fuses';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FUSES,
  assertAppFuses,
  electronBinaryInBuild,
  flipAppFuses,
  fuseConfig,
  fuseMismatches,
  packagedBinary,
  type FuseWire,
} from '../fuses.ts';

const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';

/** Bytes around a fuse wire in Electron 44's default state (ENABLE/DISABLE per upstream). */
function fakeBinary(): Buffer {
  const wire = [
    FuseState.ENABLE, // RunAsNode
    FuseState.DISABLE, // EnableCookieEncryption
    FuseState.ENABLE, // EnableNodeOptionsEnvironmentVariable
    FuseState.ENABLE, // EnableNodeCliInspectArguments
    FuseState.DISABLE, // EnableEmbeddedAsarIntegrityValidation
    FuseState.DISABLE, // OnlyLoadAppFromAsar
    FuseState.DISABLE, // LoadBrowserProcessSpecificV8Snapshot
    FuseState.ENABLE, // GrantFileProtocolExtraPrivileges
    FuseState.ENABLE, // WasmTrapHandlers
  ];
  return Buffer.concat([
    Buffer.alloc(4096, 0x90),
    Buffer.from(SENTINEL),
    Buffer.from([1, wire.length, ...wire]),
    Buffer.alloc(4096, 0x90),
  ]);
}

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nf-fuses-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('FUSES', () => {
  it('is exactly the five settings Cameron chose (2026-09-24)', () => {
    expect(FUSES).toEqual({
      RunAsNode: false,
      EnableNodeOptionsEnvironmentVariable: false,
      EnableNodeCliInspectArguments: false,
      EnableEmbeddedAsarIntegrityValidation: true,
      OnlyLoadAppFromAsar: true,
    });
  });

  it('fuseConfig sets those five by wire index and nothing else', () => {
    const cfg = fuseConfig(false) as unknown as Record<string, unknown>;
    expect(cfg).toEqual({
      version: FuseVersion.V1,
      resetAdHocDarwinSignature: false,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    });
  });
});

describe('fuseMismatches', () => {
  const good: FuseWire = {
    [FuseV1Options.RunAsNode]: FuseState.DISABLE,
    [FuseV1Options.EnableCookieEncryption]: FuseState.DISABLE,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FuseState.DISABLE,
    [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.DISABLE,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FuseState.ENABLE,
    [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.ENABLE,
  };

  it('accepts the right wire (other fuses are not its business)', () => {
    expect(fuseMismatches(good)).toEqual([]);
  });

  it.each(Object.keys(FUSES))('reports %s when flipped, inherited, removed or absent', (name) => {
    const idx = FuseV1Options[name as keyof typeof FuseV1Options];
    const want = good[idx];
    const flipped = want === FuseState.ENABLE ? FuseState.DISABLE : FuseState.ENABLE;
    for (const bad of [flipped, FuseState.INHERIT, FuseState.REMOVED, undefined]) {
      const at: number = idx;
      const wire: Record<number, FuseState> = {};
      for (const [k, v] of Object.entries(good))
        if (Number(k) !== at && v !== undefined) wire[Number(k)] = v;
      if (bad !== undefined) wire[idx] = bad;
      const m = fuseMismatches(wire);
      expect(m).toHaveLength(1);
      expect(m[0]).toMatch(new RegExp(`^${name}:`));
    }
  });
});

describe('flip + read-back on a (synthetic) binary', () => {
  it('flipAppFuses writes exactly the five; assertAppFuses then passes; the untouched wire fails', async () => {
    // packager's layout while `packageAfterCopy` runs: <app>/electron next to resources/app.
    const buildPath = join(root, 'Nutflix-linux-x64', 'resources', 'app');
    mkdirSync(buildPath, { recursive: true });
    const bin = electronBinaryInBuild(buildPath, 'linux');
    expect(bin).toBe(join(root, 'Nutflix-linux-x64', 'electron'));
    writeFileSync(bin, fakeBinary());
    const pristine = join(root, 'pristine');
    writeFileSync(pristine, fakeBinary());
    await expect(assertAppFuses(pristine)).rejects.toThrow(
      /RunAsNode: expected off, binary has on/,
    );

    await flipAppFuses(buildPath, 'linux', 'x64', false);
    await expect(assertAppFuses(bin)).resolves.toBeUndefined();
    const wire = (await getCurrentFuseWire(bin)) as unknown as Record<number, FuseState>;
    // The two fuses nobody asked about keep Electron's defaults.
    expect(wire[FuseV1Options.EnableCookieEncryption]).toBe(FuseState.DISABLE);
    expect(wire[FuseV1Options.GrantFileProtocolExtraPrivileges]).toBe(FuseState.ENABLE);
    // Only the wire bytes changed.
    const before = fakeBinary();
    const after = readFileSync(bin);
    const diff = [...after].flatMap((b, i) => (b === before[i] ? [] : [i]));
    expect(diff.length).toBe(5);
  });
});

describe('paths', () => {
  it('electronBinaryInBuild follows packager (and @electron-forge/plugin-fuses)', () => {
    expect(electronBinaryInBuild('/o/X-win32-x64/resources/app', 'win32')).toBe(
      join('/o/X-win32-x64', 'electron.exe'),
    );
    expect(electronBinaryInBuild('/t/Electron.app/Contents/Resources/app', 'darwin')).toBe(
      join('/t/Electron.app/Contents', 'MacOS', 'Electron'),
    );
  });

  it('packagedBinary names the finished executable per platform', () => {
    expect(packagedBinary('/o/N-linux-x64', 'linux', 'nutflix', 'Nutflix')).toBe(
      join('/o/N-linux-x64', 'nutflix'),
    );
    expect(packagedBinary('/o/N-win32-x64', 'win32', 'nutflix', 'Nutflix')).toBe(
      join('/o/N-win32-x64', 'nutflix.exe'),
    );
    expect(packagedBinary('/o/N-darwin-arm64', 'darwin', 'nutflix', 'Nutflix')).toBe(
      join('/o/N-darwin-arm64', 'Nutflix.app'),
    );
  });
});

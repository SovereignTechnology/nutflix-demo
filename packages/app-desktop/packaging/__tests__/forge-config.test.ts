/**
 * Issue #6 (ADR 0017): the Forge config, its two hooks (flip fuses + strip the staging-only
 * devDependencies after copy; read the fuses back + check the layout after packaging), the
 * layout rules, the CLI's argument parser, and the constants that must agree with the app.
 */
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPackageWithOptions } from '@electron/asar';
import type { ResolvedForgeConfig } from '@electron-forge/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseCli } from '../cli.ts';
import { TARGETS, forgeConfig, makers } from '../forge-config.ts';
import { assertAppFuses } from '../fuses.ts';
import {
  NOT_SHIPPED,
  PACKAGED_WORKER_ENTRY,
  PRELOAD_FILES,
  PROMPT_FILES,
  RENDERER_FILES,
  UNPACKED_DIRS,
} from '../identity.ts';
import { layoutProblems } from '../layout.ts';
import { PKG_DIR } from '../stage.ts';

const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
const fakeElectron = (): Buffer =>
  Buffer.concat([
    Buffer.alloc(64),
    Buffer.from(SENTINEL),
    Buffer.from([1, 9, 49, 48, 49, 49, 48, 48, 48, 49, 49]),
    Buffer.alloc(64),
  ]);

const cfg = forgeConfig({
  electronChecksums: { 'electron-v44.2.0-linux-x64.zip': 'ab'.repeat(32) },
  appImageRuntimeDir: '/rt',
});
const resolved = cfg as unknown as ResolvedForgeConfig;

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nf-forge-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('forgeConfig', () => {
  it('packages from app.asar with the worker and node_modules unpacked, unsigned, nothing rebuilt', () => {
    const p = cfg.packagerConfig ?? {};
    expect(p.asar).toEqual({ unpackDir: '{worker,node_modules}' });
    expect(UNPACKED_DIRS).toEqual(['worker', 'node_modules']);
    expect(p.prune).toBe(false);
    expect(p.executableName).toBe('nutflix');
    expect(p.name).toBe('Nutflix');
    // Every Electron zip checked against the lockfile-pinned electron package's sha256 list.
    expect(p.download).toEqual({
      checksums: { 'electron-v44.2.0-linux-x64.zip': 'ab'.repeat(32) },
    });
    // Platform signing is deliberately absent (ADR 0017): releases are Nostr-signed instead.
    for (const k of ['osxSign', 'osxNotarize', 'windowsSign']) expect(p).not.toHaveProperty(k);
    expect(cfg.rebuildConfig).toEqual({ onlyModules: [] });
    expect(cfg.plugins).toEqual([]);
  });

  it('has one maker per target, each on its own platform', () => {
    const m = makers({ electronChecksums: {}, appImageRuntimeDir: '/rt' }) as unknown as {
      name: string;
      platforms: string[];
    }[];
    expect(m.map((x) => [x.name, x.platforms])).toEqual([
      ['squirrel', ['win32']],
      ['dmg', ['darwin']],
      ['deb', ['linux']],
      ['appimage', ['linux']],
    ]);
    expect(TARGETS).toEqual(['squirrel', 'dmg', 'deb', 'appimage']);
    const only = makers({
      electronChecksums: {},
      appImageRuntimeDir: '/rt',
      targets: ['deb'],
    }) as unknown as { name: string }[];
    expect(only.map((x) => x.name)).toEqual(['deb']);
  });

  it('the .deb has no maintainer scripts (sandbox setup is a decision, ADR 0017)', async () => {
    const deb = makers({
      electronChecksums: {},
      appImageRuntimeDir: '/rt',
      targets: ['deb'],
    })[0] as unknown as {
      config: { options: Record<string, unknown> };
    };
    await (deb as unknown as { prepareConfig(a: string): Promise<void> }).prepareConfig('x64');
    expect(deb.config.options).not.toHaveProperty('scripts');
    expect(deb.config.options['bin']).toBe('nutflix');
  });

  it('packageAfterCopy flips the five fuses and drops the staging-only devDependencies', async () => {
    const app = join(root, 'Nutflix-linux-x64');
    const buildPath = join(app, 'resources', 'app');
    mkdirSync(buildPath, { recursive: true });
    writeFileSync(join(app, 'electron'), fakeElectron());
    writeFileSync(
      join(buildPath, 'package.json'),
      JSON.stringify({
        name: 'nutflix',
        main: 'main/main.js',
        devDependencies: { electron: '44.2.0' },
      }),
    );
    const hook = cfg.hooks?.packageAfterCopy;
    await hook?.(resolved, buildPath, '44.2.0', 'linux', 'x64');
    expect(JSON.parse(readFileSync(join(buildPath, 'package.json'), 'utf8'))).toEqual({
      name: 'nutflix',
      main: 'main/main.js',
    });
    await expect(assertAppFuses(join(app, 'electron'))).resolves.toBeUndefined();
    // …and postPackage accepts that binary in a correctly laid-out package.
    const out = await fakeOutput();
    copyFileSync(join(app, 'electron'), join(out, 'nutflix'));
    await expect(
      cfg.hooks?.postPackage?.(resolved, { platform: 'linux', arch: 'x64', outputPaths: [out] }),
    ).resolves.toBeUndefined();
  });

  it('postPackage refuses a binary whose fuses were never flipped', async () => {
    const out = join(root, 'Nutflix-linux-x64');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'nutflix'), fakeElectron());
    await expect(
      cfg.hooks?.postPackage?.(resolved, { platform: 'linux', arch: 'x64', outputPaths: [out] }),
    ).rejects.toThrow(/fuses wrong/);
  });
});

/** A small packaged output: app.asar (+ .unpacked) laid out the way the real one is. */
async function fakeOutput(
  mutate: (src: string) => void = () => undefined,
  name = 'Nutflix-linux-x64',
): Promise<string> {
  const src = join(root, 'src');
  for (const f of [
    'package.json',
    'main/main.js',
    'host/main.js',
    'preload.cjs',
    'renderer/app.js',
    'worker/boot.mjs',
    'worker/worker.mjs',
  ]) {
    mkdirSync(join(src, f, '..'), { recursive: true });
    writeFileSync(join(src, f), f);
  }
  const bin = join(src, 'node_modules', 'bare-sidecar', 'prebuilds', 'linux-x64');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'bare'), '#!/bin/sh\n');
  chmodSync(join(bin, 'bare'), 0o755);
  mutate(src);
  const out = join(root, 'packaged', name);
  mkdirSync(join(out, 'resources'), { recursive: true });
  await createPackageWithOptions(src, join(out, 'resources', 'app.asar'), {
    unpackDir: '{worker,node_modules}',
  });
  return out;
}

describe('layoutProblems', () => {
  it('accepts code packed, worker + runtime unpacked and executable', async () => {
    expect(layoutProblems(await fakeOutput(), 'linux', 'x64', 'Nutflix')).toEqual([]);
  });

  it('flags a non-executable runtime, another platform’s runtime, a missing boot module, an app/ folder', async () => {
    const out = await fakeOutput((src) => {
      chmodSync(join(src, 'node_modules', 'bare-sidecar', 'prebuilds', 'linux-x64', 'bare'), 0o644);
      mkdirSync(join(src, 'node_modules', 'bare-sidecar', 'prebuilds', 'win32-x64'));
      writeFileSync(
        join(src, 'node_modules', 'bare-sidecar', 'prebuilds', 'win32-x64', 'bare.exe'),
        'x',
      );
      rmSync(join(src, 'worker', 'boot.mjs'));
    });
    mkdirSync(join(out, 'resources', 'app'));
    const p = layoutProblems(out, 'linux', 'x64', 'Nutflix').join('\n');
    expect(p).toMatch(/not executable/);
    expect(p).toMatch(/other platforms' Bare runtimes shipped: win32-x64/);
    expect(p).toMatch(/worker\/boot\.mjs is not unpacked/);
    expect(p).toMatch(/resources[\\/]app exists/);
  });

  it('flags host code outside the archive', async () => {
    const src = join(root, 'src2');
    mkdirSync(join(src, 'host'), { recursive: true });
    writeFileSync(join(src, 'host', 'main.js'), 'x');
    const out = join(root, 'Out');
    mkdirSync(join(out, 'resources'), { recursive: true });
    await createPackageWithOptions(src, join(out, 'resources', 'app.asar'), { unpackDir: 'host' });
    const p = layoutProblems(out, 'linux', 'x64', 'Nutflix').join('\n');
    expect(p).toMatch(/host\/main\.js is unpacked; it must be inside app\.asar/);
    expect(p).toMatch(/main\/main\.js is not in app\.asar/);
    expect(layoutProblems(join(root, 'none'), 'linux', 'x64', 'Nutflix')[0]).toMatch(
      /app\.asar is missing/,
    );
  });
});

describe('parseCli', () => {
  it('parses the three commands and defaults to this machine', () => {
    const o = parseCli([
      'make',
      '--targets',
      'deb,appimage',
      '--platform',
      'linux',
      '--arch',
      'x64',
    ]);
    expect(o).toMatchObject({
      command: 'make',
      platform: 'linux',
      arch: 'x64',
      targets: ['deb', 'appimage'],
    });
    expect(o.out).toBe(join(PKG_DIR, 'out'));
    expect(o.appImageRuntimeDir).toBe(join(PKG_DIR, 'out', 'appimage-runtime'));
    expect(parseCli(['stage']).targets).toBeUndefined();
  });

  it('refuses unknown commands, options, platforms, arches and targets', () => {
    expect(() => parseCli([])).toThrow(/usage/);
    expect(() => parseCli(['publish'])).toThrow(/usage/);
    expect(() => parseCli(['make', '--sign', 'yes'])).toThrow(
      /unknown or incomplete option --sign/,
    );
    expect(() => parseCli(['make', '--platform'])).toThrow(/incomplete/);
    expect(() => parseCli(['make', '--platform', 'freebsd'])).toThrow(/--platform/);
    expect(() => parseCli(['make', '--arch', 'ia32'])).toThrow(/--arch/);
    expect(() => parseCli(['make', '--targets', 'deb,snap'])).toThrow(/unknown target snap/);
  });
});

describe('constants that must agree with the app (this code cannot import it at runtime)', () => {
  it('the packaged worker entry, the renderer/prompt file lists', async () => {
    const argsPath = join(PKG_DIR, 'src', 'main', 'args.ts');
    const args = (await import(/* @vite-ignore */ argsPath)) as { PACKAGED_WORKER_ENTRY: string };
    expect(PACKAGED_WORKER_ENTRY).toBe(args.PACKAGED_WORKER_ENTRY);
    const protoPath = join(PKG_DIR, 'src', 'main', 'app-protocol.ts');
    const proto = (await import(/* @vite-ignore */ protoPath)) as {
      APP_FILES: readonly string[];
      PROMPT_FILES: readonly string[];
    };
    expect([...RENDERER_FILES]).toEqual([...proto.APP_FILES]);
    expect([...PROMPT_FILES]).toEqual([...proto.PROMPT_FILES]);
    expect(PRELOAD_FILES).toEqual(['preload.cjs', 'prompt-preload.cjs']);
  });

  it('NOT_SHIPPED names real dependencies, and no runtime source imports pear-runtime', () => {
    const pj = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    for (const n of Object.keys(NOT_SHIPPED)) expect(pj.dependencies, n).toHaveProperty([n]);
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== '__tests__') walk(p);
        } else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) {
          if (/(?:from|import\(|require\()\s*['"]pear-runtime['"]/.test(readFileSync(p, 'utf8')))
            offenders.push(p);
        }
      }
    };
    walk(join(PKG_DIR, 'src'));
    expect(offenders).toEqual([]);
  });
});

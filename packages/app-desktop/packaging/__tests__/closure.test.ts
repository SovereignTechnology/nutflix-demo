/**
 * Issue #6 (ADR 0017): the packaged `node_modules` is the lockfile runtime closure of
 * @sovit/app-desktop — npm's nearest-node_modules resolution, workspace packages as real
 * directories, fail-closed on anything the lockfile cannot explain.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ClosureError,
  keepPrebuild,
  matchesPlatform,
  resolveFrom,
  runtimeClosure,
  type Lockfile,
} from '../closure.ts';
import { NOT_SHIPPED } from '../identity.ts';
import { REPO_ROOT } from '../stage.ts';

const base = { workspace: 'packages/app', exclude: [], platform: 'linux', arch: 'x64' } as const;

function lock(packages: Lockfile['packages']): Lockfile {
  return { lockfileVersion: 3, packages };
}

describe('resolveFrom (npm nearest node_modules)', () => {
  const l = lock({
    'node_modules/a': { version: '1.0.0' },
    'node_modules/a/node_modules/b': { version: '2.0.0' },
    'node_modules/b': { version: '1.0.0' },
    'node_modules/@s/c': { version: '1.0.0' },
    'packages/app/node_modules/b': { version: '3.0.0' },
  });
  it('prefers the innermost copy and walks up', () => {
    expect(resolveFrom(l, 'node_modules/a', 'b')).toBe('node_modules/a/node_modules/b');
    expect(resolveFrom(l, 'node_modules/a/node_modules/b', 'b')).toBe(
      'node_modules/a/node_modules/b',
    );
    expect(resolveFrom(l, 'node_modules/@s/c', 'b')).toBe('node_modules/b');
    expect(resolveFrom(l, 'packages/app', 'b')).toBe('packages/app/node_modules/b');
    expect(resolveFrom(l, 'packages/app', '@s/c')).toBe('node_modules/@s/c');
    expect(resolveFrom(l, 'node_modules/a', 'zzz')).toBeUndefined();
  });
});

describe('runtimeClosure', () => {
  it('follows dependencies, nested copies and workspace links; maps workspace-nested copies', () => {
    const l = lock({
      'packages/app': { dependencies: { a: '1', '@s/core': '0' } },
      'node_modules/@s/core': { link: true, resolved: 'packages/core' },
      'packages/core': { name: '@s/core', version: '0.0.0', dependencies: { b: '2' } },
      'packages/core/node_modules/b': { version: '2.0.0' },
      'node_modules/a': { version: '1.0.0', dependencies: { b: '1' } },
      'node_modules/b': { version: '1.0.0' },
    });
    const c = runtimeClosure(l, base);
    expect(c.map((e) => [e.source, e.target, e.version, e.workspace])).toEqual(
      [
        ['packages/core', 'node_modules/@s/core', '0.0.0', true],
        ['packages/core/node_modules/b', 'node_modules/@s/core/node_modules/b', '2.0.0', false],
        ['node_modules/a', 'node_modules/a', '1.0.0', false],
        ['node_modules/b', 'node_modules/b', '1.0.0', false],
      ].sort((x, y) => (x[1]! < y[1]! ? -1 : 1)),
    );
  });

  it('skips optional dependencies that are absent or for another platform; keeps matching ones', () => {
    const l = lock({
      'packages/app': { dependencies: { a: '1' } },
      'node_modules/a': {
        version: '1.0.0',
        optionalDependencies: { gone: '1', mac: '1', lin: '1', musl: '1' },
      },
      'node_modules/mac': { version: '1.0.0', optional: true, os: ['darwin'] },
      'node_modules/lin': { version: '1.0.0', optional: true, os: ['linux'], cpu: ['x64'] },
      'node_modules/musl': { version: '1.0.0', optional: true, os: ['linux'], libc: ['musl'] },
    });
    expect(runtimeClosure(l, base).map((e) => e.name)).toEqual(['a', 'lin']);
    expect(
      runtimeClosure(l, { ...base, platform: 'darwin', arch: 'arm64' }).map((e) => e.name),
    ).toEqual(['a', 'mac']);
  });

  it('follows required peers but not optional ones (dev tooling stays out)', () => {
    const l = lock({
      'packages/app': { dependencies: { a: '1' } },
      'node_modules/a': {
        version: '1.0.0',
        peerDependencies: { p: '1', typescript: '6' },
        peerDependenciesMeta: { typescript: { optional: true } },
      },
      'node_modules/p': { version: '1.0.0' },
      'node_modules/typescript': { version: '6.0.0' },
    });
    expect(runtimeClosure(l, base).map((e) => e.name)).toEqual(['a', 'p']);
  });

  it('excludes the named root dependencies (and only real ones)', () => {
    const l = lock({
      'packages/app': { dependencies: { a: '1', react: '19' } },
      'node_modules/a': { version: '1.0.0' },
      'node_modules/react': { version: '19.0.0' },
    });
    expect(runtimeClosure(l, { ...base, exclude: ['react'] }).map((e) => e.name)).toEqual(['a']);
    expect(() => runtimeClosure(l, { ...base, exclude: ['nope'] })).toThrow(ClosureError);
  });

  it('fails closed: a missing required dependency, a dev-only entry, a required package for another platform', () => {
    expect(() =>
      runtimeClosure(lock({ 'packages/app': { dependencies: { a: '1' } } }), base),
    ).toThrow(/needs a, which is not in package-lock.json/);
    expect(() =>
      runtimeClosure(
        lock({
          'packages/app': { dependencies: { a: '1' } },
          'node_modules/a': { version: '1', dev: true },
        }),
        base,
      ),
    ).toThrow(/dev-only/);
    expect(() =>
      runtimeClosure(
        lock({
          'packages/app': { dependencies: { a: '1' } },
          'node_modules/a': { version: '1', os: ['win32'] },
        }),
        base,
      ),
    ).toThrow(/does not install on linux-x64/);
    expect(() => runtimeClosure({ lockfileVersion: 1, packages: {} }, base)).toThrow(/v2\+/);
  });

  it('on the real lockfile: ships the runtime, never dev tooling or pear-runtime', () => {
    const real = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8')) as Lockfile;
    const c = runtimeClosure(real, {
      workspace: 'packages/app-desktop',
      exclude: Object.keys(NOT_SHIPPED),
      platform: 'linux',
      arch: 'x64',
    });
    const names = new Set(c.map((e) => e.name));
    for (const n of [
      '@sovit/core',
      '@sovit/seeder',
      '@sovit/gateway',
      'bare-sidecar',
      'bare-encoding',
      'sodium-native',
      'hypercore',
      'hyperswarm',
    ])
      expect(names.has(n), n).toBe(true);
    for (const n of [
      'electron',
      'esbuild',
      'typescript',
      'vitest',
      'react',
      'react-dom',
      '@sovit/ui',
      'pear-runtime',
      'pear-runtime-updater',
      'hyperdrive',
      'msix-manager',
      '@electron-forge/core',
    ])
      expect(names.has(n), n).toBe(false);
    expect(c.filter((e) => e.workspace).map((e) => e.target)).toEqual([
      'node_modules/@sovit/core',
      'node_modules/@sovit/gateway',
      'node_modules/@sovit/seeder',
    ]);
  });
});

describe('platform filters', () => {
  it('matchesPlatform honours os/cpu lists, negations and glibc on Linux', () => {
    expect(matchesPlatform({}, 'linux', 'x64')).toBe(true);
    expect(matchesPlatform({ os: ['!win32'] }, 'linux', 'x64')).toBe(true);
    expect(matchesPlatform({ os: ['!linux'] }, 'linux', 'x64')).toBe(false);
    expect(matchesPlatform({ cpu: ['arm64'] }, 'linux', 'x64')).toBe(false);
    expect(matchesPlatform({ libc: ['glibc'] }, 'linux', 'x64')).toBe(true);
    expect(matchesPlatform({ libc: ['musl'] }, 'linux', 'x64')).toBe(false);
    expect(matchesPlatform({ libc: ['musl'] }, 'darwin', 'arm64')).toBe(true);
  });

  it('keepPrebuild keeps only the target (and darwin-universal on macOS)', () => {
    expect(keepPrebuild('linux-x64', 'linux', 'x64')).toBe(true);
    for (const d of [
      'linux-arm64',
      'linux-x64-musl',
      'darwin-x64',
      'win32-x64',
      'android-arm64',
      'darwin-universal',
    ])
      expect(keepPrebuild(d, 'linux', 'x64'), d).toBe(false);
    expect(keepPrebuild('darwin-universal', 'darwin', 'arm64')).toBe(true);
    expect(keepPrebuild('darwin-arm64', 'darwin', 'arm64')).toBe(true);
  });
});

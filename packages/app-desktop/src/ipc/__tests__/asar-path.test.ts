/**
 * Issue #6 (ADR 0017): `asarUnpacked` maps a path inside the packaged app's archive to the same
 * path in the unpacked tree beside it — the worker entry main hands the host, and where the
 * host loads `bare-sidecar` (and so the `bare` binary) from.
 *
 * Independent review of the packaging lane: the mapping used to key on the FIRST `*.asar` path
 * segment, so an install under a directory named `x.asar` mapped into the wrong tree. It now
 * keys on the app's own archive, `<resourcesPath>/app.asar` (`appArchive`); the old
 * "first segment" case below now asserts the opposite, on purpose.
 */
import { describe, expect, it } from 'vitest';

import { APP_ARCHIVE, appArchive, asarUnpacked } from '../asar-path.js';

const ARCHIVE = '/opt/Nutflix/resources/app.asar';

describe('appArchive', () => {
  it('is <resourcesPath>/app.asar, with the platform’s separator', () => {
    expect(APP_ARCHIVE).toBe('app.asar');
    expect(appArchive('/opt/Nutflix/resources')).toBe(ARCHIVE);
    expect(appArchive('/opt/Nutflix/resources/')).toBe(ARCHIVE);
    expect(appArchive('C:\\Program Files\\Nutflix\\resources')).toBe(
      'C:\\Program Files\\Nutflix\\resources\\app.asar',
    );
    expect(appArchive('\\\\host\\share\\Nutflix\\resources')).toBe(
      '\\\\host\\share\\Nutflix\\resources\\app.asar',
    );
  });

  it('resolves the archive path through symlinks (import.meta.url paths are resolved)', () => {
    // macOS app translocation: /var is a symlink to /private/var.
    const real = (p: string): string => p.replace(/^\/var\//, '/private/var/');
    expect(
      appArchive('/var/folders/x/AppTranslocation/y/d/Nutflix.app/Contents/Resources', real),
    ).toBe('/private/var/folders/x/AppTranslocation/y/d/Nutflix.app/Contents/Resources/app.asar');
    // A symlinked archive resolves to its target (where the loader says main lives).
    const linked = (p: string): string =>
      p === '/opt/Nutflix/resources/app.asar' ? '/srv/builds/7/app.asar' : p;
    expect(appArchive('/opt/Nutflix/resources', linked)).toBe('/srv/builds/7/app.asar');
    // Unresolvable (no archive in a dev Electron, vanished, permission): the path as given.
    const broken = (): string => {
      throw new Error('ENOENT');
    };
    expect(appArchive('/opt/Nutflix/resources', broken)).toBe(ARCHIVE);
  });

  it('is undefined without a resources path (plain Node, tests, tools)', () => {
    for (const r of [undefined, null, '', '/', 42, {}])
      expect(appArchive(r), JSON.stringify(r)).toBe(undefined);
  });
});

describe('asarUnpacked', () => {
  it('maps a path inside the app archive to app.asar.unpacked (POSIX)', () => {
    expect(asarUnpacked(`${ARCHIVE}/host/main.js`, ARCHIVE)).toBe(
      '/opt/Nutflix/resources/app.asar.unpacked/host/main.js',
    );
  });

  it('maps the archive itself (main’s dist directory in a packaged build)', () => {
    expect(asarUnpacked(ARCHIVE, ARCHIVE)).toBe('/opt/Nutflix/resources/app.asar.unpacked');
  });

  it('maps Windows paths, case-insensitively as the filesystem compares them', () => {
    const win = 'C:\\Users\\u\\AppData\\Local\\nutflix\\app-0.1.0\\resources\\app.asar';
    expect(asarUnpacked(`${win}\\host\\main.js`, win)).toBe(
      'C:\\Users\\u\\AppData\\Local\\nutflix\\app-0.1.0\\resources\\app.asar.unpacked\\host\\main.js',
    );
    expect(
      asarUnpacked(`c:\\users\\U\\AppData\\Local\\nutflix\\app-0.1.0\\resources\\app.asar\\x`, win),
    ).toBe(`${win}.unpacked\\x`);
  });

  it('keys on the app’s own archive, not the first *.asar segment', () => {
    // An install under a directory named `x.asar`: the app archive is further down.
    const odd = '/opt/tools.asar/Nutflix/resources/app.asar';
    expect(asarUnpacked(`${odd}/host/main.js`, odd)).toBe(
      '/opt/tools.asar/Nutflix/resources/app.asar.unpacked/host/main.js',
    );
    // An archive nested inside the app archive is just a path inside it.
    expect(asarUnpacked(`${ARCHIVE}/node_modules/x/inner.asar/y`, ARCHIVE)).toBe(
      `${ARCHIVE}.unpacked/node_modules/x/inner.asar/y`,
    );
    // Another archive (the dev Electron's default_app.asar, a second app) is never mapped.
    expect(asarUnpacked('/opt/Other/resources/app.asar/host/main.js', ARCHIVE)).toBeUndefined();
    expect(
      asarUnpacked('/opt/Nutflix/resources/default_app.asar/main.js', ARCHIVE),
    ).toBeUndefined();
  });

  it('returns undefined outside the archive: a dev build, an unpacked path, look-alike names', () => {
    for (const p of [
      '/home/u/nutflix/packages/app-desktop/dist/host/main.js',
      '/opt/Nutflix/resources/app.asar.unpacked/worker/boot.mjs',
      '/opt/Nutflix/resources/app.asarx/host/main.js',
      '/opt/Nutflix/resources/app.asar\\host/main.js',
      '/opt/Nutflix/resources/myasar/host/main.js',
      '/opt/Nutflix/resources',
      'app.asar/host/main.js',
      '',
    ])
      expect(asarUnpacked(p, ARCHIVE), p).toBeUndefined();
  });

  it('never maps without an archive, or with something that is not one', () => {
    expect(asarUnpacked(`${ARCHIVE}/host/main.js`, undefined)).toBeUndefined();
    expect(asarUnpacked('/opt/Nutflix/resources/host/main.js', '/opt/Nutflix/resources')).toBe(
      undefined,
    );
    expect(asarUnpacked('.asar/x', '.asar')).toBeUndefined();
  });
});

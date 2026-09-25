/**
 * Issue #6 (ADR 0017): `asarUnpacked` maps a path inside the packaged app's archive to the same
 * path in the unpacked tree beside it — the worker entry main hands the host, and where the
 * host loads `bare-sidecar` (and so the `bare` binary) from.
 */
import { describe, expect, it } from 'vitest';

import { asarUnpacked } from '../asar-path.js';

describe('asarUnpacked', () => {
  it('maps a path inside resources/app.asar to app.asar.unpacked (POSIX)', () => {
    expect(asarUnpacked('/opt/Nutflix/resources/app.asar/host/main.js')).toBe(
      '/opt/Nutflix/resources/app.asar.unpacked/host/main.js',
    );
  });

  it('maps the archive itself (main’s dist directory in a packaged build)', () => {
    expect(asarUnpacked('/opt/Nutflix/resources/app.asar')).toBe(
      '/opt/Nutflix/resources/app.asar.unpacked',
    );
  });

  it('maps Windows paths', () => {
    expect(
      asarUnpacked(
        'C:\\Users\\u\\AppData\\Local\\nutflix\\app-0.1.0\\resources\\app.asar\\host\\main.js',
      ),
    ).toBe(
      'C:\\Users\\u\\AppData\\Local\\nutflix\\app-0.1.0\\resources\\app.asar.unpacked\\host\\main.js',
    );
  });

  it('uses the FIRST archive segment only', () => {
    expect(asarUnpacked('/r/app.asar/node_modules/x/inner.asar/y')).toBe(
      '/r/app.asar.unpacked/node_modules/x/inner.asar/y',
    );
  });

  it('returns undefined outside an archive: a dev build, an unpacked path, look-alike names', () => {
    for (const p of [
      '/home/u/nutflix/packages/app-desktop/dist/host/main.js',
      '/opt/Nutflix/resources/app.asar.unpacked/worker/boot.mjs',
      '/opt/Nutflix/resources/app.asarx/host/main.js',
      '/opt/Nutflix/resources/myasar/host/main.js',
      '/opt/Nutflix/resources/.asar',
      'app.asar/host/main.js',
      '',
    ])
      expect(asarUnpacked(p), p).toBeUndefined();
  });
});

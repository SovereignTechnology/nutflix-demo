import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MintUrl, RelayUrl, Sats, Settings } from '@sovit/core';

import { memoryLogger } from '../log.js';
import {
  DEFAULT_SETTINGS,
  SETTINGS_FILE,
  SettingsStore,
  autoTopUpDue,
  loadDesktopConfig,
  parseStoredSettings,
} from '../settings/settings.js';

const MINT = 'https://mint.example' as MintUrl;
const OTHER = 'https://other.example' as MintUrl;

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nf-l6b-settings-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SettingsStore (atomic JSON in userData)', () => {
  it('starts from defaults on a first run, persists an update, and reads it back', async () => {
    const log = memoryLogger();
    const a = new SettingsStore(dir, log);
    expect(await a.load()).toEqual(DEFAULT_SETTINGS);
    expect(log.lines).toEqual([]); // a missing file is not an error
    const next = await a.update({ theme: 'light', prefetchSeconds: 12 });
    expect(next).toEqual({ ...DEFAULT_SETTINGS, theme: 'light', prefetchSeconds: 12 });
    const b = new SettingsStore(dir, memoryLogger());
    expect(await b.load()).toEqual(next);
    const raw = JSON.parse(await readFile(join(dir, SETTINGS_FILE), 'utf8')) as unknown;
    expect(raw).toEqual({ v: 1, settings: next });
    if (process.platform !== 'win32')
      expect((await stat(join(dir, SETTINGS_FILE))).mode & 0o777).toBe(0o600);
  });

  it('a corrupt file means defaults + a logged warning + the file moved aside — never a crash', async () => {
    for (const body of ['{not json', '[]', '{"v":1,"settings":{"theme":"neon"}}', '{"v":2}', '']) {
      await writeFile(join(dir, SETTINGS_FILE), body);
      const log = memoryLogger();
      const s = new SettingsStore(dir, log);
      expect(await s.load(), body).toEqual(DEFAULT_SETTINGS);
      expect(log.lines.map((l) => [l.level, l.msg])).toEqual([
        ['warn', 'state file is corrupt; using defaults'],
      ]);
      expect(await readFile(join(dir, `${SETTINGS_FILE}.corrupt`), 'utf8')).toBe(body);
    }
  });

  it('unknown keys (a newer build) are ignored; missing keys take their defaults', () => {
    const parsed = parseStoredSettings({
      v: 1,
      settings: { theme: 'dark', ffmpegPath: '/usr/bin/ffmpeg', futureThing: { a: 1 } },
    });
    expect(parsed?.settings).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark' });
  });

  it('refuses an invalid patch and keeps the old settings (nothing written)', async () => {
    const s = new SettingsStore(dir, memoryLogger());
    await s.load();
    await expect(
      s.update({ relays: [{ url: 'ws://insecure' as RelayUrl, read: true, write: true }] }),
    ).rejects.toThrow(TypeError);
    await expect(s.update({ prefetchSeconds: -1 })).rejects.toThrow(TypeError);
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
    expect(await readdir(dir)).toEqual([]);
  });

  it('serialises concurrent saves and leaves no temp files behind', async () => {
    const s = new SettingsStore(dir, memoryLogger());
    await s.load();
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.update({ prefetchSeconds: i + 1 })));
    expect(await readdir(dir)).toEqual([SETTINGS_FILE]);
    const reread = new SettingsStore(dir, memoryLogger());
    expect((await reread.load()).prefetchSeconds).toBe(s.get().prefetchSeconds);
  });

  it('SE-4: accepts the v4 "off" sentinel belowSats: 0', async () => {
    const s = new SettingsStore(dir, memoryLogger());
    await s.load();
    const next = await s.update({ autoTopUp: { belowSats: 0 as Sats, fromMint: MINT } });
    expect(next.autoTopUp).toEqual({ belowSats: 0, fromMint: MINT });
  });
});

describe('autoTopUpDue (SE-4)', () => {
  const withTopUp = (belowSats: number, fromMint = MINT): Settings => ({
    ...DEFAULT_SETTINGS,
    autoTopUp: { belowSats: belowSats as Sats, fromMint },
  });

  it('is false whenever belowSats <= 0 — the "off" sentinel — whatever the balance', () => {
    for (const below of [0, -1, -1_000_000, Number.NaN, Number.NEGATIVE_INFINITY])
      for (const balance of [0, 1, 100])
        expect(autoTopUpDue(withTopUp(below), MINT, balance as Sats), `${below}/${balance}`).toBe(
          false,
        );
  });

  it('is false with no autoTopUp at all', () => {
    expect(autoTopUpDue(DEFAULT_SETTINGS, MINT, 0 as Sats)).toBe(false);
  });

  it('triggers strictly below the threshold (never <=), only for fromMint', () => {
    expect(autoTopUpDue(withTopUp(100), MINT, 99 as Sats)).toBe(true);
    expect(autoTopUpDue(withTopUp(100), MINT, 0 as Sats)).toBe(true);
    expect(autoTopUpDue(withTopUp(100), MINT, 100 as Sats)).toBe(false);
    expect(autoTopUpDue(withTopUp(100), MINT, 101 as Sats)).toBe(false);
    expect(autoTopUpDue(withTopUp(100), OTHER, 0 as Sats)).toBe(false);
  });
});

describe('desktop.json', () => {
  it('reads the ffmpeg paths; missing or corrupt → {}', async () => {
    expect(await loadDesktopConfig(dir, memoryLogger())).toEqual({});
    await writeFile(
      join(dir, 'desktop.json'),
      JSON.stringify({ v: 1, ffmpeg: { ffmpeg: '/usr/bin/ffmpeg', ffprobe: '/usr/bin/ffprobe' } }),
    );
    expect(await loadDesktopConfig(dir, memoryLogger())).toEqual({
      ffmpeg: { ffmpeg: '/usr/bin/ffmpeg', ffprobe: '/usr/bin/ffprobe' },
    });
    await writeFile(
      join(dir, 'desktop.json'),
      JSON.stringify({ v: 1, ffmpeg: { ffmpeg: 'ffmpeg', ffprobe: '/usr/bin/ffprobe' } }),
    );
    expect(await loadDesktopConfig(dir, memoryLogger())).toEqual({});
  });
});

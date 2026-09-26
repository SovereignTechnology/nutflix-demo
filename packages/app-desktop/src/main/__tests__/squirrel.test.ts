/**
 * Issue #6 (ADR 0017 §5; independent review of the packaging lane): the Squirrel.Windows
 * lifecycle. Squirrel launches the installed app with `--squirrel-*` first; a packaged win32
 * build makes or removes its shortcuts through Squirrel's own `..\Update.exe` (fixed argv, no
 * shell) and exits, instead of starting the whole app from an installer hook.
 */
import { describe, expect, it } from 'vitest';

import {
  SQUIRREL_UPDATE_TIMEOUT_MS,
  squirrelEvent,
  squirrelStartup,
  type SquirrelStartup,
} from '../squirrel.js';

const EXE = 'C:\\Users\\u\\AppData\\Local\\nutflix\\app-0.1.0\\nutflix.exe';
const UPDATE = 'C:\\Users\\u\\AppData\\Local\\nutflix\\Update.exe';

function start(argv: string[], over: Partial<SquirrelStartup> = {}) {
  const runs: { file: string; args: readonly string[] }[] = [];
  const outcome = squirrelStartup({
    platform: 'win32',
    packaged: true,
    argv,
    execPath: EXE,
    run: (file, args) => {
      runs.push({ file, args: [...args] });
    },
    ...over,
  });
  return { outcome, runs };
}

describe('squirrelEvent', () => {
  it('reads the first argument only', () => {
    expect(squirrelEvent(['--squirrel-install', '0.1.0'])).toBe('install');
    expect(squirrelEvent(['--squirrel-updated', '0.1.1'])).toBe('updated');
    expect(squirrelEvent(['--squirrel-uninstall', '0.1.0'])).toBe('uninstall');
    expect(squirrelEvent(['--squirrel-obsolete', '0.1.0'])).toBe('obsolete');
    expect(squirrelEvent(['--squirrel-firstrun'])).toBe('firstrun');
    expect(squirrelEvent([])).toBeUndefined();
    expect(squirrelEvent(['--user-data-dir=/x', '--squirrel-install'])).toBeUndefined();
    expect(squirrelEvent(['--squirrel-install=1'])).toBeUndefined();
    expect(squirrelEvent(['toString'])).toBeUndefined();
    expect(squirrelEvent(['__proto__'])).toBeUndefined();
  });
});

describe('squirrelStartup (packaged win32)', () => {
  it('install and updated: Update.exe --createShortcut=<exe>, then exit', () => {
    for (const [flag, event] of [
      ['--squirrel-install', 'install'],
      ['--squirrel-updated', 'updated'],
    ] as const) {
      const { outcome, runs } = start([flag, '0.1.0']);
      expect(outcome).toEqual({ exit: true, event, ok: true });
      expect(runs).toEqual([{ file: UPDATE, args: ['--createShortcut=nutflix.exe'] }]);
    }
  });

  it('uninstall: Update.exe --removeShortcut=<exe>, then exit', () => {
    const { outcome, runs } = start(['--squirrel-uninstall', '0.1.0']);
    expect(outcome).toEqual({ exit: true, event: 'uninstall', ok: true });
    expect(runs).toEqual([{ file: UPDATE, args: ['--removeShortcut=nutflix.exe'] }]);
  });

  it('obsolete: exit without running anything', () => {
    const { outcome, runs } = start(['--squirrel-obsolete', '0.1.0']);
    expect(outcome).toEqual({ exit: true, event: 'obsolete', ok: true });
    expect(runs).toEqual([]);
  });

  it('firstrun and ordinary launches start normally', () => {
    for (const argv of [['--squirrel-firstrun'], [], ['--user-data-dir=C:\\x']]) {
      const { outcome, runs } = start(argv);
      expect(outcome, argv.join(' ')).toEqual({ exit: false });
      expect(runs).toEqual([]);
    }
  });

  it('a failing Update.exe still exits (never start the app from an installer hook)', () => {
    const { outcome } = start(['--squirrel-install', '0.1.0'], {
      run: () => {
        throw new Error('spawnSync Update.exe ENOENT');
      },
    });
    expect(outcome).toEqual({ exit: true, event: 'install', ok: false });
  });

  it('outside Squirrel’s app-<version> layout it runs no Update.exe (a portable copy in Downloads)', () => {
    for (const execPath of [
      'C:\\Users\\u\\Downloads\\Nutflix\\nutflix.exe',
      'C:\\nutflix.exe',
      'C:\\x\\app-\\nutflix.exe',
    ]) {
      const { outcome, runs } = start(['--squirrel-install', '0.1.0'], { execPath });
      expect(outcome, execPath).toEqual({ exit: true, event: 'install', ok: false });
      expect(runs).toEqual([]);
    }
  });

  it('refuses to name an executable that is not a plain .exe', () => {
    const { outcome, runs } = start(['--squirrel-install', '0.1.0'], {
      execPath: 'C:\\x\\app-0.1.0\\--evil=1',
    });
    expect(outcome).toEqual({ exit: true, event: 'install', ok: false });
    expect(runs).toEqual([]);
  });

  it('bounds Update.exe well inside Squirrel’s 15 s hook budget', () => {
    expect(SQUIRREL_UPDATE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(SQUIRREL_UPDATE_TIMEOUT_MS).toBeLessThan(15_000);
  });
});

describe('squirrelStartup elsewhere: ignored', () => {
  it('on Linux/macOS, or in a dev build, --squirrel-* is just an unknown flag', () => {
    for (const over of [
      { platform: 'linux' },
      { platform: 'darwin' },
      { platform: 'win32', packaged: false },
    ] as const) {
      const { outcome, runs } = start(['--squirrel-uninstall', '0.1.0'], over);
      expect(outcome, JSON.stringify(over)).toEqual({ exit: false });
      expect(runs).toEqual([]);
    }
  });
});

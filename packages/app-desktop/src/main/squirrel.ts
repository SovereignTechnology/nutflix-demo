/**
 * Squirrel.Windows lifecycle (issue #6, ADR 0017 §5; independent review of the packaging lane).
 *
 * The Windows `.exe` installer is Squirrel.Windows. It starts the installed app with one of
 * these as the FIRST argument, and expects it to do its part and exit quickly:
 *
 *   --squirrel-install <v>    first install     → `..\Update.exe --createShortcut=<exe>`, exit
 *   --squirrel-updated <v>    after an update   → `..\Update.exe --createShortcut=<exe>`, exit
 *   --squirrel-uninstall <v>  before uninstall  → `..\Update.exe --removeShortcut=<exe>`, exit
 *   --squirrel-obsolete <v>   an old version    → exit
 *   --squirrel-firstrun       first normal run  → start normally
 *
 * Without this the installer would start the whole app (window, host, worker, DHT) and create
 * no shortcut, and uninstall would launch it instead of cleaning up. main.ts runs this before
 * anything else — before the sandbox and dev-flag refusals, and before any window, host or
 * worker exists — and only on win32 in a packaged build. Update.exe is Squirrel's own binary
 * one directory above the versioned app directory (`%LocalAppData%\nutflix\Update.exe`); it is
 * run with a fixed argv and no shell. Pure: the runner is injected, so this is unit-tested on
 * any platform.
 */
import { win32 } from 'node:path';

export type SquirrelEvent = 'install' | 'updated' | 'uninstall' | 'obsolete' | 'firstrun';

const EVENTS: Readonly<Record<string, SquirrelEvent>> = {
  '--squirrel-install': 'install',
  '--squirrel-updated': 'updated',
  '--squirrel-uninstall': 'uninstall',
  '--squirrel-obsolete': 'obsolete',
  '--squirrel-firstrun': 'firstrun',
};

/** Squirrel kills a hook that runs longer than 15 s; Update.exe gets at most this long. */
export const SQUIRREL_UPDATE_TIMEOUT_MS = 10_000;

/** The Squirrel event in `argv` (main's argv after the executable). Squirrel puts it FIRST. */
export function squirrelEvent(argv: readonly string[]): SquirrelEvent | undefined {
  const first = argv[0];
  return first !== undefined && Object.hasOwn(EVENTS, first) ? EVENTS[first] : undefined;
}

/** A plain Windows executable name (what `--createShortcut=` names). */
const EXE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}\.exe$/i;
/** Squirrel installs each version in `<root>\app-<version>\`, with Update.exe in `<root>`. */
const SQUIRREL_APP_DIR = /^app-\d[0-9A-Za-z.+-]{0,63}$/;

export interface SquirrelStartup {
  /** `process.platform`. */
  readonly platform: string;
  /** `app.isPackaged`. */
  readonly packaged: boolean;
  /** `process.argv.slice(1)`: a packaged app's argv has no app path, so the flag is first. */
  readonly argv: readonly string[];
  /** `process.execPath`: `…\nutflix\app-<v>\nutflix.exe` under Squirrel. */
  readonly execPath: string;
  /** Runs `file` with exactly `args` (no shell) and waits for it; throws when it fails. */
  readonly run: (file: string, args: readonly string[]) => void;
}

export type SquirrelOutcome =
  | { readonly exit: false }
  | { readonly exit: true; readonly event: SquirrelEvent; readonly ok: boolean };

/**
 * What main must do for this launch: `exit: false` (start normally) unless this is a packaged
 * win32 build that Squirrel launched for a lifecycle event, which is handled here; the caller
 * then exits at once. `ok` is false when Update.exe could not be run (the caller still exits:
 * starting the app from an installer hook is never right).
 */
export function squirrelStartup(s: SquirrelStartup): SquirrelOutcome {
  if (s.platform !== 'win32' || !s.packaged) return { exit: false };
  const event = squirrelEvent(s.argv);
  if (event === undefined || event === 'firstrun') return { exit: false };
  if (event === 'obsolete') return { exit: true, event, ok: true };
  const exe = win32.basename(s.execPath);
  if (!EXE_NAME.test(exe)) return { exit: true, event, ok: false };
  // Not a Squirrel install (a copied or unzipped build): the directory above is not Squirrel's
  // root, and whatever `Update.exe` might sit there (a Downloads folder) is never run.
  if (!SQUIRREL_APP_DIR.test(win32.basename(win32.dirname(s.execPath))))
    return { exit: true, event, ok: false };
  const updateExe = win32.join(win32.dirname(s.execPath), '..', 'Update.exe');
  const flag = event === 'uninstall' ? '--removeShortcut' : '--createShortcut';
  try {
    s.run(updateExe, [`${flag}=${exe}`]);
    return { exit: true, event, ok: true };
  } catch {
    return { exit: true, event, ok: false };
  }
}

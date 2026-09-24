/**
 * Main's command line. Only these flags mean anything; everything else is ignored (Chromium
 * switches are Electron's business — except the sandbox bypasses, which `security.ts` refuses).
 *
 *   --dev-mocks        mock wallet/engine + loopback pay hub (D1); forwarded to the host
 *   --dev-fixtures     fixture catalogue (design §5a); forwarded to the host
 *   --user-data-dir D  (or `=D`) userData directory — the e2e runs against a temp dir
 *   --e2e-hooks        expose counters (never tokens or URLs) to the e2e harness, main process only
 */
export interface MainOptions {
  readonly devMocks: boolean;
  readonly devFixtures: boolean;
  readonly userDataDir: string | undefined;
  readonly e2eHooks: boolean;
}

export function parseMainArgs(argv: readonly string[]): MainOptions {
  let devMocks = false;
  let devFixtures = false;
  let e2eHooks = false;
  let userDataDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--dev-mocks') devMocks = true;
    else if (a === '--dev-fixtures') devFixtures = true;
    else if (a === '--e2e-hooks') e2eHooks = true;
    else if (a === '--user-data-dir') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        userDataDir = next;
        i++;
      }
    } else if (a.startsWith('--user-data-dir=')) {
      userDataDir = a.slice('--user-data-dir='.length);
    }
  }
  if (
    userDataDir !== undefined &&
    !userDataDir.startsWith('/') &&
    !/^[A-Za-z]:[\\/]/.test(userDataDir)
  ) {
    userDataDir = undefined; // relative paths are refused: they depend on the launcher's cwd
  }
  return { devMocks, devFixtures, userDataDir, e2eHooks };
}

/** Relative to `dist/`: the host `utilityProcess` entry (lane L6-B). */
export const HOST_ENTRY = 'host/main.js';

/**
 * Relative to `dist/`: the worker entry the host spawns with `bare-sidecar`. It is the `tsc`
 * output, never a bundle: a bundle hoists `@sovit/core` above `bare-encoding/global` and the
 * worker dies at load (D6, docs/lanes/L6-C.md).
 */
export const WORKER_ENTRY = 'worker/entry.js';

/** The absolute paths main hands the host. */
export interface HostPaths {
  /** Electron's `userData` directory. */
  readonly userData: string;
  /** `<dist>/` + `WORKER_ENTRY`, resolved from main's own location. */
  readonly workerEntry: string;
  /** ADR 0013: main found a real OS keychain (`keychainUsable`); the host may offer it. */
  readonly keychain?: boolean;
}

/**
 * The host's argv: exactly what the host's strict `parseHostArgs` (`src/host/flags.ts`)
 * accepts — `--user-data-dir=<abs>`, `--worker-entry=<abs>`, then only the dev flags. Anything
 * else makes the host exit 2 and main respawn it until its budget is spent (every respawn
 * reloads the window), so `host-link.test.ts` round-trips this through the host's real parser.
 */
export function hostArgs(opts: MainOptions, paths: HostPaths): string[] {
  const args = [`--user-data-dir=${paths.userData}`, `--worker-entry=${paths.workerEntry}`];
  if (paths.keychain === true) args.push('--keychain');
  if (opts.devMocks) args.push('--dev-mocks');
  if (opts.devFixtures) args.push('--dev-fixtures');
  return args;
}

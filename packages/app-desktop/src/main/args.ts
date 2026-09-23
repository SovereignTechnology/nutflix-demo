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

/** The host's argv (L6-B reads these). */
export function hostArgs(opts: MainOptions, userData: string): string[] {
  const args = [`--user-data=${userData}`];
  if (opts.devMocks) args.push('--dev-mocks');
  if (opts.devFixtures) args.push('--dev-fixtures');
  return args;
}

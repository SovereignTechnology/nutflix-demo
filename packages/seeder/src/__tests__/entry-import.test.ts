/**
 * Importing `@sovit/seeder` (the gateway does) must run nothing: `index.ts` only calls
 * `main()` when it is the process's main module. `main` is replaced by a spy for this file
 * (vi.mock is hoisted above the imports), then the entry is imported for real.
 */
import { describe, expect, it, vi } from 'vitest';

import type * as MainModule from '../cli/main.js';

const mainSpy = vi.hoisted(() => vi.fn(() => Promise.resolve(0)));
vi.mock('../cli/main.js', async (importOriginal) => ({
  ...(await importOriginal<typeof MainModule>()),
  main: mainSpy,
}));

describe('importing the package entry', () => {
  it('does not call main(), install signal handlers or set an exit code', async () => {
    const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
    const before = signals.map((s) => process.listenerCount(s));
    const exitCode = process.exitCode;
    const mod = await import('../index.js');
    expect(mainSpy).not.toHaveBeenCalled();
    expect(signals.map((s) => process.listenerCount(s))).toEqual(before);
    expect(process.exitCode).toBe(exitCode);
    // The CLI is exported for embedders/tests, and it IS the (mocked) module's main.
    expect(mod.main).toBe(mainSpy);
    expect(typeof mod.isMainModule).toBe('function');
    expect(typeof mod.Seeder.create).toBe('function');
  });
});

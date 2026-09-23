/**
 * How the seeder reads its `NUTFLIX_SEEDER_*` environment variables — shared by
 * `parseDaemonEnv()` (env-only config for embedders) and the daemon config file's env
 * overrides (`config-file.ts`), so both paths agree on what a value means.
 *
 * Pure and runtime-portable (reachable from `portable.ts`, the `bare` export condition):
 * no `node:` import, no `process` global.
 */

/** Env names the seeder honours. `parseDaemonEnv()` and the config-file overrides share them. */
export const ENV_DATA_DIR = 'NUTFLIX_SEEDER_DATA_DIR' as const;
export const ENV_DISK_CAP = 'NUTFLIX_SEEDER_DISK_CAP_BYTES' as const;
export const ENV_MAX_STREAMS = 'NUTFLIX_SEEDER_MAX_STREAMS' as const;

/** Default payload-byte cap when neither the file nor the env sets one (50 GiB). */
export const DEFAULT_DISK_CAP_BYTES = 50 * 1024 ** 3;

/**
 * The variable's value, with an empty assignment (`Environment=NAME=` in a unit, the usual
 * way to blank an inherited value) treated as unset.
 */
export function envValue(
  env: (name: string) => string | undefined,
  name: string,
): string | undefined {
  const v = env(name);
  return v === undefined || v === '' ? undefined : v;
}

/**
 * Decimal digits only → a number; anything else (`1e3`, `0x10`, `-1`, `1.5`, ` 5`) →
 * `undefined`. Not range-checked: callers still require `Number.isSafeInteger` and bounds.
 * (`Number()` alone accepts all of those, and `Number('')` is 0.)
 */
export function parseDecimal(raw: string): number | undefined {
  return /^[0-9]+$/.test(raw) ? Number(raw) : undefined;
}

/**
 * Packaging (issue #6, ADR 0017): a packaged build loads main, the host and the renderer from
 * `resources/app.asar`, and unpacks what must be real files next to it in
 * `resources/app.asar.unpacked/` — the Bare worker and every package it loads (Bare cannot read
 * an asar archive) and the prebuilt `bare` binary (a spawned binary cannot live in one either).
 *
 * The mapping is keyed on the app's OWN archive, `<resources>/app.asar` (`appArchive`, from
 * Electron's `resourcesPath`, which main and the host utilityProcess both have): only a path
 * that is that archive or lies inside it is mapped. It used to key on the first `*.asar`
 * segment of the path, so an install or a checkout under any directory named `x.asar` was
 * mapped to the wrong place (independent review of the packaging lane). String-only and
 * handed its inputs, so it runs in every process like the rest of `src/ipc`.
 */

/** The archive Electron loads a packaged app from, inside the resources directory. */
export const APP_ARCHIVE = 'app.asar';

const DRIVE = /^[A-Za-z]:[\\/]/;
/** A drive-letter or UNC (`\\host\share`) path: Windows separators, case-insensitive names. */
const isWindowsPath = (p: string): boolean => DRIVE.test(p) || p.startsWith('\\\\');

/**
 * `<resourcesPath>/app.asar`, the app's own archive, or `undefined` when there is no resources
 * path (plain Node: tests, tools). Windows-style paths get a backslash.
 *
 * `realpath` (callers pass `fs.realpathSync`) resolves the archive's path: the paths compared
 * against it come from `import.meta.url`, which Node's loader has already resolved through
 * symlinks, while `resourcesPath` need not be (a symlinked install directory or archive; macOS
 * app translocation under `/var` → `/private/var`). When it does not resolve (no archive: a dev
 * Electron) it is used as given.
 */
export function appArchive(
  resourcesPath: unknown,
  realpath?: (p: string) => string,
): string | undefined {
  if (typeof resourcesPath !== 'string' || resourcesPath === '') return undefined;
  const sep = isWindowsPath(resourcesPath) ? '\\' : '/';
  const base = resourcesPath.replace(/[\\/]+$/, '');
  if (base === '') return undefined;
  const archive = `${base}${sep}${APP_ARCHIVE}`;
  if (realpath === undefined) return archive;
  try {
    return realpath(archive);
  } catch {
    return archive;
  }
}

/**
 * Maps `p` — the archive itself, or a path inside it — to the same path under
 * `<archive>.unpacked`. Returns `undefined` when `p` is not inside `archive` (a dev build, a
 * path already under `.asar.unpacked`, a look-alike name) or when there is no archive.
 * Windows paths (drive letter or UNC) compare case-insensitively, as the filesystem does.
 */
export function asarUnpacked(p: string, archive: string | undefined): string | undefined {
  if (archive === undefined || !archive.endsWith('.asar') || archive.length <= '.asar'.length)
    return undefined;
  const windows = isWindowsPath(archive);
  const head = p.slice(0, archive.length);
  const same = windows ? head.toLowerCase() === archive.toLowerCase() : head === archive;
  if (!same) return undefined;
  const rest = p.slice(archive.length);
  if (rest !== '' && !rest.startsWith('/') && !(windows && rest.startsWith('\\'))) return undefined;
  return `${archive}.unpacked${rest}`;
}

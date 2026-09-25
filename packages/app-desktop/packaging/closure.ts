/**
 * Which installed packages the packaged app needs (issue #6, ADR 0017): the runtime closure of
 * @sovit/app-desktop's `dependencies`, computed from package-lock.json with npm's own
 * nearest-`node_modules` resolution — so the staged `node_modules` holds exactly the versions
 * the reviewed lockfile pins, and nothing is re-resolved against the registry.
 *
 * Electron's packager would normally prune `node_modules` itself, but it walks the app's OWN
 * directory, and this is an npm workspace: everything is hoisted to the repo root and the
 * workspace packages are symlinks. So the staging step copies this closure into a standalone
 * app directory instead (workspace packages as real directories), and packager's prune is off.
 *
 * Fail-closed: a required dependency that does not resolve, or that resolves to a lockfile entry
 * marked `dev`, is an error (the lockfile and the tree disagree); only optional dependencies may
 * be missing, and platform-restricted optional ones are kept only for the target platform.
 */

export interface LockEntry {
  readonly name?: string;
  readonly version?: string;
  readonly resolved?: string;
  readonly link?: boolean;
  readonly dev?: boolean;
  readonly optional?: boolean;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
  readonly os?: readonly string[];
  readonly cpu?: readonly string[];
  readonly libc?: readonly string[];
}

export interface Lockfile {
  readonly lockfileVersion: number;
  readonly packages: Readonly<Record<string, LockEntry>>;
}

export interface ClosureEntry {
  /** Lockfile location of the installed copy (`node_modules/a/node_modules/b`, or `packages/core`). */
  readonly source: string;
  /** Where it goes in the staged app (`node_modules/a/node_modules/b`, `node_modules/@sovit/core`). */
  readonly target: string;
  readonly name: string;
  readonly version: string;
  /** A workspace package (copied from its directory: package.json + its `files`). */
  readonly workspace: boolean;
}

export interface ClosureOptions {
  /** The workspace whose `dependencies` are the roots, e.g. `packages/app-desktop`. */
  readonly workspace: string;
  /** Root dependency names that are not shipped (bundled elsewhere, or unused at runtime). */
  readonly exclude: readonly string[];
  readonly platform: string;
  readonly arch: string;
}

export class ClosureError extends Error {
  override readonly name = 'ClosureError' as const;
}

const NM = 'node_modules/';

/** The package name at the end of a `…node_modules/<name>` location. */
export function nameAt(location: string): string {
  const i = location.lastIndexOf(NM);
  return i === -1 ? location : location.slice(i + NM.length);
}

/** The location a package at `location` resolves its dependencies' parents from. */
function parentOf(location: string): string | undefined {
  if (location === '') return undefined;
  const i = location.lastIndexOf(`/${NM}`);
  if (i !== -1) return location.slice(0, i);
  if (location.startsWith(NM)) return '';
  const slash = location.lastIndexOf('/');
  return slash === -1 ? '' : location.slice(0, slash);
}

/** npm's resolution: `<loc>/node_modules/<name>`, then each ancestor's, then the root's. */
export function resolveFrom(lock: Lockfile, from: string, name: string): string | undefined {
  for (let loc: string | undefined = from; loc !== undefined; loc = parentOf(loc)) {
    const candidate = `${loc === '' ? '' : `${loc}/`}${NM}${name}`;
    if (Object.hasOwn(lock.packages, candidate)) return candidate;
  }
  return undefined;
}

/** Whether a platform-restricted entry installs on the target (`!x` negations included). */
export function matchesPlatform(e: LockEntry, platform: string, arch: string): boolean {
  const ok = (list: readonly string[] | undefined, value: string): boolean => {
    if (list === undefined || list.length === 0) return true;
    const neg = list.filter((v) => v.startsWith('!')).map((v) => v.slice(1));
    if (neg.includes(value)) return false;
    const pos = list.filter((v) => !v.startsWith('!'));
    return pos.length === 0 || pos.includes(value);
  };
  // Packaged Linux targets are glibc builds: a musl-only package is not for them.
  const libc = platform === 'linux' ? 'glibc' : undefined;
  return ok(e.os, platform) && ok(e.cpu, arch) && (libc === undefined || ok(e.libc, libc));
}

export function runtimeClosure(lock: Lockfile, o: ClosureOptions): ClosureEntry[] {
  if (lock.lockfileVersion < 2) throw new ClosureError('package-lock.json v2+ is required');
  const ws = lock.packages[o.workspace];
  if (ws === undefined) throw new ClosureError(`${o.workspace} is not in package-lock.json`);
  // Workspace directory → its link location in the root node_modules.
  const linkOf = new Map<string, string>();
  for (const [key, e] of Object.entries(lock.packages))
    if (e.link === true && e.resolved !== undefined) linkOf.set(e.resolved, key);

  const target = (source: string): string => {
    for (const [dir, link] of linkOf)
      if (source.startsWith(`${dir}/${NM}`)) return `${link}${source.slice(dir.length)}`;
    return source;
  };

  const out = new Map<string, ClosureEntry>();
  const queue: { from: string; name: string; optional: boolean; via: string }[] = [];
  const exclude = new Set(o.exclude);
  for (const name of Object.keys(ws.dependencies ?? {}))
    if (!exclude.has(name))
      queue.push({ from: o.workspace, name, optional: false, via: o.workspace });
  for (const name of exclude)
    if (!Object.hasOwn(ws.dependencies ?? {}, name))
      throw new ClosureError(`excluded dependency ${name} is not a dependency of ${o.workspace}`);

  for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
    const found = resolveFrom(lock, job.from, job.name);
    if (found === undefined) {
      if (job.optional) continue;
      throw new ClosureError(`${job.via} needs ${job.name}, which is not in package-lock.json`);
    }
    let entry = lock.packages[found];
    let source = found;
    let workspace = false;
    if (entry?.link === true) {
      if (entry.resolved === undefined) throw new ClosureError(`${found}: link without a target`);
      source = entry.resolved;
      entry = lock.packages[source];
      workspace = true;
    }
    if (entry === undefined) throw new ClosureError(`${found}: no lockfile entry`);
    if (!matchesPlatform(entry, o.platform, o.arch)) {
      if (job.optional) continue;
      throw new ClosureError(
        `${job.via} needs ${job.name}, which does not install on ${o.platform}-${o.arch}`,
      );
    }
    if (entry.dev === true)
      throw new ClosureError(
        `${job.via} needs ${job.name}, but the lockfile marks ${found} dev-only`,
      );
    if (out.has(source)) continue;
    out.set(source, {
      source,
      target: workspace ? found : target(source),
      name: job.name,
      version: entry.version ?? '0.0.0',
      workspace,
    });
    const peersMeta = entry.peerDependenciesMeta ?? {};
    for (const name of Object.keys(entry.dependencies ?? {}))
      queue.push({ from: source, name, optional: false, via: source });
    for (const name of Object.keys(entry.optionalDependencies ?? {}))
      queue.push({ from: source, name, optional: true, via: source });
    // An OPTIONAL peer is only there if something else installs it (then that path reaches it);
    // following it would ship dev tooling (e.g. nostr-tools' optional `typescript` peer).
    for (const name of Object.keys(entry.peerDependencies ?? {}))
      if (peersMeta[name]?.optional !== true)
        queue.push({ from: source, name, optional: false, via: source });
  }
  return [...out.values()].sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
}

/**
 * Which top-level directories of a package's `prebuilds/` to keep for a target: only the
 * target's own `<platform>-<arch>` (plus `darwin-universal` on macOS). Everything else is
 * another platform's native code (bare-sidecar alone ships six ~70 MB runtimes).
 */
export function keepPrebuild(dir: string, platform: string, arch: string): boolean {
  return dir === `${platform}-${arch}` || (platform === 'darwin' && dir === 'darwin-universal');
}

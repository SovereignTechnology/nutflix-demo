/**
 * Packaging (issue #6, ADR 0017): a packaged build loads main, the host and the renderer from
 * `resources/app.asar`, and unpacks what must be real files next to it in
 * `resources/app.asar.unpacked/` — the Bare worker and every package it loads (Bare cannot read
 * an asar archive) and the prebuilt `bare` binary (a spawned binary cannot live in one either).
 *
 * `asarUnpacked(p)` maps a path inside the first `<name>.asar` directory segment of `p` to the
 * same path inside `<name>.asar.unpacked`, and returns `undefined` for a path that is not inside
 * an archive (a dev build, or a path already under `.asar.unpacked`). String-only, so it runs in
 * every process like the rest of `src/ipc`.
 */
export function asarUnpacked(p: string): string | undefined {
  const m = /^(.*?[\\/][^\\/]+\.asar)(?=[\\/]|$)/.exec(p);
  const archive = m?.[1];
  if (archive === undefined) return undefined;
  return `${archive}.unpacked${p.slice(archive.length)}`;
}

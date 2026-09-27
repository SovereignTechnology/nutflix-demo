/**
 * ADR 0016: the only npm code main's trusted prompt page may carry. `scripts/bundle.ts` refuses a
 * prompt bundle with any other input, and the stage (`stage.ts`) refuses a prompt bundle older
 * than the installed copies of these packages.
 *
 * Build-time only (imported by scripts/bundle.ts and packaging/stage.ts); nothing here ships.
 */

/**
 * The BIP-39 library whose English list the page shows words from and whose `validateMnemonic`
 * checks a typed phrase, and the two audited packages that library is built on.
 */
export const PROMPT_NPM = ['@scure/bip39', '@scure/base', '@noble/hashes'] as const;

/** What the page imports itself; the others are its dependencies, found through the lockfile. */
export const PROMPT_NPM_IMPORTS = ['@scure/bip39'] as const;

const NM = 'node_modules';

/**
 * Round 8 (the final panel): is `path`, an absolute bundle input, a file of one of `PROMPT_NPM`
 * installed in a `node_modules/` directly under one of `roots` (this package, the repo root)?
 *
 * Every package on the way from that `node_modules/` to the file must be one of `PROMPT_NPM`, and
 * the file itself lies in no further `node_modules/`:
 *
 *   <root>/node_modules/@scure/bip39/index.js                             yes
 *   <root>/node_modules/@scure/bip39/node_modules/@noble/hashes/sha2.js   yes (npm nested it)
 *   <root>/node_modules/@scure/bip39/node_modules/evil/index.js           no  (evil is not allowed)
 *   <root>/node_modules/evil/node_modules/@noble/hashes/sha2.js           no  (nor on the way)
 *   /elsewhere/node_modules/@scure/bip39/index.js                         no  (not under a root)
 *
 * The regex this replaces matched an allowed name anywhere in the path, so it admitted the two
 * `evil` cases: a dependency nested under bip39 would have been bundled into the trusted window
 * with no refusal.
 */
export function isPromptNpmInput(path: string, roots: readonly string[]): boolean {
  const p = path.split('\\').join('/');
  for (const root of roots) {
    const base = `${root.split('\\').join('/').replace(/\/+$/, '')}/`;
    if (p.startsWith(base) && allowedChain(p.slice(base.length).split('/'))) return true;
  }
  return false;
}

/** `node_modules/<allowed>` (repeated at least once), then a file path with no `node_modules`. */
function allowedChain(parts: readonly string[]): boolean {
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return false;
  const allowed: readonly string[] = PROMPT_NPM;
  let i = 0;
  let packages = 0;
  while (parts[i] === NM) {
    const first = parts[i + 1];
    if (first === undefined) return false;
    const scoped = first.startsWith('@');
    const second = parts[i + 2];
    if (scoped && second === undefined) return false;
    const name = scoped ? `${first}/${String(second)}` : first;
    if (!allowed.includes(name)) return false;
    i += scoped ? 3 : 2;
    packages++;
  }
  const file = parts.slice(i);
  return packages > 0 && file.length > 0 && !file.includes(NM);
}

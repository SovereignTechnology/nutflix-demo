/**
 * ADR 0016, round 8 (the final panel): the npm code main's trusted prompt page may carry.
 *
 *   - `isPromptNpmInput` — the allow-list `scripts/bundle.ts` checks every prompt-bundle input
 *     against. The regex it replaces matched an allowed name anywhere in the path, so a package
 *     nested under bip39 (or bip39's deps nested under anything) passed.
 *   - The script really uses it, for the prompt page, with this package and the repo root.
 *   - Pinned against the real prompt bundle's inputs.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import { nameAt } from '../closure.ts';
import { PROMPT_NPM, PROMPT_NPM_IMPORTS, isPromptNpmInput } from '../prompt-npm.ts';
import { PKG_DIR, REPO_ROOT } from '../stage.ts';

const ROOTS = ['/r', '/r/packages/app'];

describe('isPromptNpmInput', () => {
  it('admits the three packages’ files under a root’s node_modules, nested among themselves as npm places them', () => {
    for (const p of [
      '/r/node_modules/@scure/bip39/index.js',
      '/r/node_modules/@scure/bip39/wordlists/english.js',
      '/r/node_modules/@scure/bip39/node_modules/@noble/hashes/sha2.js',
      '/r/node_modules/@scure/bip39/node_modules/@scure/base/index.js',
      '/r/node_modules/@noble/hashes/utils.js',
      '/r/packages/app/node_modules/@scure/bip39/index.js',
      '/r/node_modules/@scure/bip39/node_modules/@noble/hashes/node_modules/@scure/base/x.js',
      // Windows separators, on the path and on the root.
      'C:\\r\\node_modules\\@scure\\bip39\\index.js',
    ])
      expect(isPromptNpmInput(p, [...ROOTS, 'C:\\r\\']), p).toBe(true);
  });

  it('refuses a package nested under an allowed one, and an allowed one nested under another (the finding’s probes)', () => {
    expect(isPromptNpmInput('/r/node_modules/@scure/bip39/node_modules/evil/index.js', ROOTS)).toBe(
      false,
    );
    expect(isPromptNpmInput('/r/node_modules/evil/node_modules/@noble/hashes/x.js', ROOTS)).toBe(
      false,
    );
    expect(
      isPromptNpmInput('/r/node_modules/@scure/bip39/node_modules/@evil/pkg/index.js', ROOTS),
    ).toBe(false);
  });

  it.each([
    ['outside every root', '/elsewhere/node_modules/@scure/bip39/index.js'],
    ['a root that is only a prefix', '/rr/node_modules/@scure/bip39/index.js'],
    ['another workspace’s node_modules', '/r/packages/other/node_modules/@scure/bip39/index.js'],
    ['our own source', '/r/packages/app/src/renderer/prompt/prompt.ts'],
    ['a look-alike name', '/r/node_modules/@scure/bip39-evil/index.js'],
    ['a longer name', '/r/node_modules/@scure/bip390/index.js'],
    ['an unscoped look-alike', '/r/node_modules/bip39/index.js'],
    ['a node_modules inside the package', '/r/node_modules/@scure/bip39/lib/node_modules/x.js'],
    ['a `..` segment', '/r/node_modules/@scure/bip39/../../evil/index.js'],
    ['a `.` segment', '/r/node_modules/@scure/./bip39/index.js'],
    ['an empty segment', '/r/node_modules//@scure/bip39/index.js'],
    ['the package directory, no file', '/r/node_modules/@scure/bip39'],
    ['a scope with no name', '/r/node_modules/@scure'],
    ['a bare node_modules', '/r/node_modules/'],
    ['an esbuild namespace', 'data:text/javascript,x'],
  ])('refuses %s', (_what, p) => {
    expect(isPromptNpmInput(p, ROOTS)).toBe(false);
  });

  it('the allowed list is exactly what ADR 0016 names, and the page imports only bip39 itself', () => {
    expect([...PROMPT_NPM]).toEqual(['@scure/bip39', '@scure/base', '@noble/hashes']);
    expect([...PROMPT_NPM_IMPORTS]).toEqual(['@scure/bip39']);
    const page = readFileSync(join(PKG_DIR, 'src', 'renderer', 'prompt', 'prompt.ts'), 'utf8');
    const imports = [...page.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    const npm = imports.filter((s) => s !== undefined && !s.startsWith('.'));
    const pkgOf = (s: string): string =>
      s
        .split('/')
        .slice(0, s.startsWith('@') ? 2 : 1)
        .join('/');
    expect([...new Set(npm.map((s) => pkgOf(s ?? '')))]).toEqual([...PROMPT_NPM_IMPORTS]);
  });
});

describe('scripts/bundle.ts uses it for the prompt page', () => {
  it('imports the allow-list and checks the prompt bundle’s inputs with this package and the repo root', () => {
    const script = readFileSync(join(PKG_DIR, 'scripts', 'bundle.ts'), 'utf8');
    expect(script).toMatch(
      /import \{[^}]*\bisPromptNpmInput\b[^}]*\} from '\.\.\/packaging\/prompt-npm\.ts';/,
    );
    const prompt = /async function bundlePrompt\(\)[\s\S]*?\n\}\n/.exec(script)?.[0] ?? '';
    expect(prompt).toContain("entryPoints: ['src/renderer/prompt/prompt.ts']");
    expect(prompt).toMatch(/isPromptNpmInput\(p, \[pkg, repo\]\)/);
    expect(script).toMatch(/const repo = resolve\(pkg, '\.\.', '\.\.'\);/);
    // The loose regex is gone.
    expect(script).not.toMatch(/PROMPT_NPM\s*=\s*\//);
  });

  it('every input of the real prompt bundle is its own source or passes the allow-list; all three packages are used', async () => {
    const r = await build({
      absWorkingDir: PKG_DIR,
      entryPoints: ['src/renderer/prompt/prompt.ts'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      tsconfig: 'tsconfig.renderer.json',
      metafile: true,
      logLevel: 'silent',
    });
    const own = join(PKG_DIR, 'src', 'renderer', 'prompt') + sep;
    const inputs = Object.keys(r.metafile.inputs).map((p) => resolve(PKG_DIR, p));
    const npm = inputs.filter((p) => !p.startsWith(own));
    expect(npm.length).toBeGreaterThan(0);
    expect(npm.filter((p) => !isPromptNpmInput(p, [PKG_DIR, REPO_ROOT]))).toEqual([]);
    const names = new Set(
      npm.map((p) => {
        const rel = p.slice(p.lastIndexOf(`${sep}node_modules${sep}`) + 1).split(sep);
        return nameAt(rel.slice(0, rel[1]?.startsWith('@') === true ? 3 : 2).join('/'));
      }),
    );
    expect([...names].sort()).toEqual([...PROMPT_NPM].sort());
  });
});

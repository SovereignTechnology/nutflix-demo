/**
 * Issue #6 (ADR 0017): the staged app — what Forge packs into app.asar and what it leaves
 * unpacked. (The staged worker actually booting under the real Bare, through the staged
 * bare-sidecar and the host's supervisor, is src/host/__tests__/packaged-worker.integration.test.ts.)
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PACKAGED_WORKER_BUNDLE,
  PACKAGED_WORKER_ENTRY,
  PRELOAD_FILES,
  PROMPT_FILES,
  RENDERER_FILES,
} from '../identity.ts';
import {
  REPO_ROOT,
  StageError,
  WORKER_BOOT_SOURCE,
  assertReplaceable,
  copyPackage,
  normalizeModes,
  npmFilter,
  stageApp,
  workspaceFilter,
  type StageReport,
} from '../stage.ts';

let tmp = '';
let a: StageReport;
let b: StageReport;

function walk(root: string): string[] {
  const out: string[] = [];
  const go = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) go(p);
      else out.push(relative(root, p).split('\\').join('/'));
    }
  };
  go(root);
  return out.sort();
}

function treeHash(root: string): string {
  const h = createHash('sha256');
  for (const f of walk(root)) {
    h.update(`${f}\0${(statSync(join(root, f)).mode & 0o777).toString(8)}\0`);
    h.update(readFileSync(join(root, f)));
  }
  return h.digest('hex');
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'nf-stage-'));
  a = await stageApp({ out: join(tmp, 'a'), platform: 'linux', arch: 'x64' });
  b = await stageApp({ out: join(tmp, 'b'), platform: 'linux', arch: 'x64' });
}, 120_000);

afterAll(() => {
  if (tmp !== '') rmSync(tmp, { recursive: true, force: true });
});

describe('stageApp', () => {
  it('is deterministic: two stagings are byte- and mode-identical', () => {
    expect(treeHash(a.out)).toBe(treeHash(b.out));
  });

  it('lays out main, host, renderer, prompt, preloads and the worker like dist/', () => {
    const top = readdirSync(a.out).sort();
    expect(top).toEqual(
      [
        'host',
        'main',
        'node_modules',
        'package.json',
        ...PRELOAD_FILES,
        'prompt',
        'renderer',
        'worker',
      ].sort(),
    );
    expect(readdirSync(join(a.out, 'renderer')).sort()).toEqual([...RENDERER_FILES].sort());
    expect(readdirSync(join(a.out, 'prompt')).sort()).toEqual([...PROMPT_FILES].sort());
    expect(readdirSync(join(a.out, 'main'))).toEqual(['main.js']);
    expect(readdirSync(join(a.out, 'host'))).toEqual(['main.js']);
    expect(readdirSync(join(a.out, 'worker')).sort()).toEqual(['boot.mjs', 'worker.mjs']);
    expect(PACKAGED_WORKER_ENTRY).toBe('worker/boot.mjs');
    expect(PACKAGED_WORKER_BUNDLE).toBe('worker/worker.mjs');
  });

  it('writes a minimal package.json (the Electron version only for Forge; no scripts, no deps)', () => {
    const pj = JSON.parse(readFileSync(join(a.out, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const electron = (
      JSON.parse(
        readFileSync(join(REPO_ROOT, 'node_modules', 'electron', 'package.json'), 'utf8'),
      ) as {
        version: string;
      }
    ).version;
    expect(Object.keys(pj).sort()).toEqual([
      'author',
      'description',
      'devDependencies',
      'license',
      'main',
      'name',
      'productName',
      'type',
      'version',
    ]);
    expect(pj).toMatchObject({
      name: 'nutflix',
      productName: 'Nutflix',
      main: 'main/main.js',
      type: 'module',
    });
    expect(pj['devDependencies']).toEqual({ electron });
  });

  it('the boot module is unbundled and imports bare-encoding/global FIRST (D6), then the bundle', () => {
    const boot = readFileSync(join(a.out, PACKAGED_WORKER_ENTRY), 'utf8');
    expect(boot).toBe(WORKER_BOOT_SOURCE);
    const lines = boot.split('\n').filter((l) => l.trim() !== '');
    expect(lines[0]).toBe("import 'bare-encoding/global'");
    expect(lines[1]).toBe("import('./worker.mjs').catch((e) => {");
  });

  it('the worker bundle holds our sources only; npm packages stay imports Bare resolves', () => {
    const w = readFileSync(join(a.out, PACKAGED_WORKER_BUNDLE), 'utf8');
    expect(w).toMatch(/from "@sovit\/seeder"/);
    expect(w).toMatch(/from "sodium-native"/);
    expect(w).not.toMatch(/node_modules/);
    expect(a.externals.worker).toContain('bare-encoding');
    expect(a.externals.worker).toContain('@sovit/core');
  });

  it('the host bundle inlines its npm code (inside app.asar) but leaves native packages and electron external', () => {
    const h = readFileSync(join(a.out, 'host', 'main.js'), 'utf8');
    expect(h).toMatch(/^import \{ createRequire as __nfCreateRequire \} from 'node:module';/);
    expect(h).toMatch(/node_modules\/nostr-tools\//); // esbuild's path comments of inlined code
    expect(a.externals.host).toEqual(expect.arrayContaining(['sodium-native']));
    expect(a.externals.host).not.toContain('nostr-tools');
    expect(a.externals.host).not.toContain('@sovit/core');
    const m = readFileSync(join(a.out, 'main', 'main.js'), 'utf8');
    expect(m).not.toMatch(/node_modules/);
  });

  it('node_modules: workspace packages as real dirs without tests/maps/types; one platform’s prebuilds; no pear-runtime', () => {
    const files = walk(join(a.out, 'node_modules'));
    const sovit = files.filter((f) => f.startsWith('@sovit/'));
    expect(sovit.length).toBeGreaterThan(10);
    for (const f of sovit) {
      expect(f).toMatch(/^@sovit\/(core|seeder|gateway)\/(package\.json|dist\/)/);
      expect(f).not.toMatch(/__tests__|\.map$|\.d\.ts$|\.tsbuildinfo$|\.test\.js$/);
    }
    const prebuildDirs = new Set(
      files.map((f) => /(?:^|\/)prebuilds\/([^/]+)\//.exec(f)?.[1]).filter(Boolean),
    );
    expect([...prebuildDirs]).toEqual(['linux-x64']);
    expect(files.some((f) => f.startsWith('pear-runtime/'))).toBe(false);
    expect(files.some((f) => f.startsWith('electron/') || f.startsWith('typescript/'))).toBe(false);
    expect(a.packages.length).toBeGreaterThan(100);
  });

  it('modes are normalised: dirs 0755, files 0644 or 0755 (the bare runtime stays executable)', () => {
    const bad: string[] = [];
    const go = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        const m = lstatSync(p).mode & 0o7777;
        if (e.isSymbolicLink()) bad.push(`symlink ${p}`);
        else if (e.isDirectory()) {
          if (m !== 0o755) bad.push(`${p} ${m.toString(8)}`);
          go(p);
        } else if (m !== 0o644 && m !== 0o755) bad.push(`${p} ${m.toString(8)}`);
      }
    };
    go(a.out);
    expect(bad).toEqual([]);
    expect(
      statSync(join(a.out, 'node_modules', 'bare-sidecar', 'prebuilds', 'linux-x64', 'bare')).mode &
        0o777,
    ).toBe(0o755);
  });

  it('never deletes a directory it did not make (absent, empty or a previous stage only)', async () => {
    const victim = join(tmp, 'precious');
    mkdirSync(victim);
    writeFileSync(join(victim, 'thesis.txt'), 'years of work');
    await expect(stageApp({ out: victim, platform: 'linux', arch: 'x64' })).rejects.toThrow(
      /refusing to delete/,
    );
    expect(readFileSync(join(victim, 'thesis.txt'), 'utf8')).toBe('years of work');
    expect(() => {
      assertReplaceable(join(tmp, 'absent'));
    }).not.toThrow();
    expect(() => {
      assertReplaceable(a.out);
    }).not.toThrow();
    writeFileSync(join(tmp, 'afile'), 'x');
    expect(() => {
      assertReplaceable(join(tmp, 'afile'));
    }).toThrow(/not a directory/);
  });

  it('refuses to stage without the renderer bundles', async () => {
    const pkg = mkdtempSync(join(tmp, 'pkg-'));
    await expect(
      stageApp({ out: join(tmp, 'c'), platform: 'linux', arch: 'x64', pkgDir: pkg }),
    ).rejects.toThrow(/npm run build/);
  });
});

describe('copyPackage / filters / normalizeModes', () => {
  it('refuses a symlink inside a shipped package', () => {
    const src = join(tmp, 'pkg-with-link');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'package.json'), '{}');
    symlinkSync('/etc/passwd', join(src, 'evil'));
    expect(() => {
      copyPackage(src, join(tmp, 'dst-link'), () => true, { files: 0, bytes: 0 });
    }).toThrow(StageError);
    expect(() => {
      copyPackage(src, join(tmp, 'dst-link2'), () => true, { files: 0, bytes: 0 });
    }).toThrow(/symlink in a shipped package is refused/);
  });

  it('npmFilter drops nested node_modules and other platforms’ prebuilds', () => {
    const f = npmFilter('linux', 'x64');
    expect(f('node_modules', true)).toBe(false);
    expect(f('lib/node_modules/x.js', false)).toBe(false);
    expect(f('prebuilds/linux-x64', true)).toBe(true);
    expect(f('prebuilds/win32-x64', true)).toBe(false);
    expect(f('prebuilds', true)).toBe(true);
    expect(f('index.js', false)).toBe(true);
  });

  it('workspaceFilter keeps package.json and `files`, never tests, maps or declarations', () => {
    const f = workspaceFilter(['dist']);
    expect(f('package.json', false)).toBe(true);
    expect(f('src', true)).toBe(false);
    expect(f('tsconfig.json', false)).toBe(false);
    expect(f('dist', true)).toBe(true);
    expect(f('dist/index.js', false)).toBe(true);
    for (const x of [
      'dist/__tests__',
      'dist/index.js.map',
      'dist/index.d.ts',
      'dist/a.test.js',
      'dist/node_modules',
    ])
      expect(f(x, x.endsWith('__tests__') || x.endsWith('node_modules')), x).toBe(false);
  });

  it('normalizeModes: 0775 dir → 0755, 0664 file → 0644, 0775 file → 0755', () => {
    const d = join(tmp, 'modes');
    mkdirSync(join(d, 'sub'), { recursive: true });
    writeFileSync(join(d, 'sub', 'f'), 'x');
    writeFileSync(join(d, 'sub', 'x'), 'x');
    chmodSync(join(d, 'sub'), 0o775);
    chmodSync(join(d, 'sub', 'f'), 0o664);
    chmodSync(join(d, 'sub', 'x'), 0o775);
    normalizeModes(d);
    expect(statSync(join(d, 'sub')).mode & 0o777).toBe(0o755);
    expect(statSync(join(d, 'sub', 'f')).mode & 0o777).toBe(0o644);
    expect(statSync(join(d, 'sub', 'x')).mode & 0o777).toBe(0o755);
  });
});

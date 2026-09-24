/**
 * Design §4 "Bundling": `scripts/bundle.ts` produces exactly the four files `app:` serves plus
 * the CJS preload; the page has nothing inline (CSP), references only those files, and the
 * bundles contain no `@sovit/core` runtime / Node builtins (renderer) and nothing but
 * `electron` as an external (preload). Runs the real script into a temp directory.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_FILES, PROMPT_FILES } from '../app-protocol.js';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const html = readFileSync(join(pkg, 'static', 'index.html'), 'utf8');
let out = '';
let result: ReturnType<typeof spawnSync> | undefined;

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'nf-l6a-bundle-'));
  result = spawnSync(process.execPath, [join(pkg, 'scripts', 'bundle.ts'), '--out', out], {
    cwd: pkg,
    encoding: 'utf8',
    timeout: 120_000,
  });
}, 150_000);

afterAll(() => {
  if (out !== '') rmSync(out, { recursive: true, force: true });
});

describe('static/index.html', () => {
  it('has nothing inline and no remote reference', () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/(?:https?:|wss?:)?\/\//i);
  });

  it('references exactly the other APP_FILES', () => {
    const refs = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]).sort();
    expect(refs).toEqual(APP_FILES.filter((f) => f !== 'index.html').sort());
    expect(html).toMatch(/<script type="module" src="app\.js"><\/script>/);
  });
});

describe('scripts/bundle.ts', () => {
  it('writes the four renderer files and the preload (+ the ADR 0013 prompt page), nothing else', () => {
    expect(result?.stderr).toBe('');
    expect(result?.status).toBe(0);
    expect(readdirSync(join(out, 'renderer')).sort()).toEqual([...APP_FILES].sort());
    expect(readdirSync(join(out, 'prompt')).sort()).toEqual([...PROMPT_FILES].sort());
    expect(readdirSync(out).sort()).toEqual([
      'preload.cjs',
      'prompt',
      'prompt-preload.cjs',
      'renderer',
    ]);
  });

  it('ADR 0013: the prompt page is plain DOM, and its preload exposes only its two calls', () => {
    const js = readFileSync(join(out, 'prompt', 'prompt.js'), 'utf8');
    expect(js).not.toMatch(/\brequire\(|from"node:|from "node:|nostr-tools|cashu|nutflix\b/);
    expect(js).toMatch(/nutflixPrompt/);
    const pre = readFileSync(join(out, 'prompt-preload.cjs'), 'utf8');
    expect(pre).toMatch(/exposeInMainWorld\("nutflixPrompt"/);
    expect(pre).toMatch(/nf-prompt:init/);
    expect(pre).toMatch(/nf-prompt:answer/);
    expect(pre).not.toMatch(/exposeInMainWorld\("nutflix"/);
    expect(pre).not.toMatch(/ipcRenderer\.(on|send)\b/);
    const html = readFileSync(join(out, 'prompt', 'prompt.html'), 'utf8');
    const refs = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]).sort();
    expect(refs).toEqual(PROMPT_FILES.filter((f) => f !== 'prompt.html').sort());
    expect(html).not.toMatch(/<script>|\sstyle=|\son[a-z]+=/i);
  });

  it('the renderer bundle is a browser ESM bundle with production React and no Node/core runtime', () => {
    const js = readFileSync(join(out, 'renderer', 'app.js'), 'utf8');
    expect(js).not.toMatch(/\brequire\(/);
    expect(js).not.toMatch(/from"node:|from "node:/);
    expect(js).not.toContain('nostr-tools');
    expect(js).not.toContain('MockNetworkAdapter');
    expect(js).not.toContain('react-dom.development');
    expect(js).toContain('nutflix');
  });

  it('the preload is CommonJS and requires only electron', () => {
    const cjs = readFileSync(join(out, 'preload.cjs'), 'utf8');
    const requires = [...cjs.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
    expect([...new Set(requires)]).toEqual(['electron']);
    expect(cjs).toContain('exposeInMainWorld');
    expect(cjs).not.toMatch(/\bimport\s/);
  });

  it('ui.css is copied from @sovit/ui, shell.css from src/renderer', () => {
    expect(readFileSync(join(out, 'renderer', 'shell.css'), 'utf8')).toBe(
      readFileSync(join(pkg, 'src', 'renderer', 'shell.css'), 'utf8'),
    );
    expect(readFileSync(join(out, 'renderer', 'ui.css'), 'utf8')).toContain('--nf-color-bg');
  });
});

/**
 * Design §3: the CSP header (exact string), and the `app:` handler's traversal guard — `..`,
 * encoded slash, unknown extension — plus the file allowlist and the real-path check, against a
 * real directory on disk.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_FILES, createAppProtocolHandler, resolveAppPath } from '../app-protocol.js';
import { APP_RESPONSE_HEADERS, CSP, MEDIA_RESPONSE_HEADERS } from '../csp.js';

/** Design §3, verbatim. */
const DESIGN_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' nf-media: data:; media-src nf-media:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'";

let base = '';
let root = '';

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'nf-l6a-app-'));
  root = join(base, 'dist', 'renderer');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>t</title>');
  writeFileSync(join(root, 'app.js'), 'export {}');
  writeFileSync(join(root, 'ui.css'), 'body{}');
  // tsc also emits renderer JS here; it must not be served.
  writeFileSync(join(root, 'main.js'), 'bad()');
  writeFileSync(join(base, 'secret.txt'), 'secret');
  // A planted symlink with an allowed name pointing out of the root.
  symlinkSync(join(base, 'secret.txt'), join(root, 'shell.css'));
});

afterAll(() => {
  if (base !== '') rmSync(base, { recursive: true, force: true });
});

function handler(): (req: Request) => Promise<Response> {
  return createAppProtocolHandler({
    root,
    readFile: async (p) => new Uint8Array(await readFile(p)),
    realpath: (p) => realpath(p),
  });
}

describe('CSP (design §3)', () => {
  it('is exactly the design string', () => {
    expect(CSP).toBe(DESIGN_CSP);
  });

  it('has no unsafe-*, no wildcard, no remote origin and no connect/frame capability', () => {
    expect(CSP).not.toMatch(/unsafe|\*|https?:|wss?:|blob:/);
    expect(CSP).toContain("connect-src 'none'");
    expect(CSP).toContain("frame-ancestors 'none'");
  });

  it('media responses are sandboxed documents if ever rendered', () => {
    expect(MEDIA_RESPONSE_HEADERS['content-security-policy']).toContain('sandbox');
    expect(MEDIA_RESPONSE_HEADERS['x-content-type-options']).toBe('nosniff');
  });
});

describe('resolveAppPath (traversal guard)', () => {
  it.each([
    ['app://nutflix/', 'index.html'],
    ['app://nutflix/index.html', 'index.html'],
    ['app://nutflix/app.js', 'app.js'],
    ['app://nutflix/ui.css?x=1#y', 'ui.css'],
  ])('%s → %s', (url, rel) => {
    expect(resolveAppPath(url)).toBe(rel);
  });

  it.each([
    'app://nutflix/../secret.txt',
    'app://nutflix/a/../../secret.txt',
    'app://nutflix/%2e%2e/secret.txt',
    'app://nutflix/%2E%2E%2Fsecret.txt',
    'app://nutflix/..%2fsecret.txt',
    'app://nutflix/..%5csecret.txt',
    'app://nutflix/a%2fb.js',
    'app://nutflix/a\\..\\b.js',
    'app://nutflix/.hidden.js',
    'app://nutflix/a//b.js',
    'app://nutflix/app.js%00.css',
    'app://nutflix/app.map',
    'app://nutflix/app.json',
    'app://nutflix/secret.txt',
    'app://nutflix/app',
    'app://evil/index.html',
    'app://nutflix.evil/index.html',
    'app://u@nutflix/index.html',
    'https://nutflix/index.html',
    'nf-media://nutflix/index.html',
    'not a url',
  ])('refuses %s', (url) => {
    expect(resolveAppPath(url)).toBeNull();
  });
});

describe('app: protocol handler', () => {
  it('serves index.html with the CSP header and hardening headers', async () => {
    const res = await handler()(new Request('app://nutflix/index.html'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(DESIGN_CSP);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    for (const [k, v] of Object.entries(APP_RESPONSE_HEADERS)) expect(res.headers.get(k)).toBe(v);
    expect(await res.text()).toContain('<title>t</title>');
  });

  it('serves the bundle with a JS type; HEAD has no body', async () => {
    const res = await handler()(new Request('app://nutflix/app.js'));
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    const head = await handler()(new Request('app://nutflix/app.js', { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('refuses methods other than GET/HEAD', async () => {
    const res = await handler()(
      new Request('app://nutflix/index.html', { method: 'POST', body: 'x' }),
    );
    expect(res.status).toBe(405);
  });

  it('serves only APP_FILES: tsc output next to the bundle is 404', async () => {
    expect(APP_FILES).toEqual(['index.html', 'app.js', 'ui.css', 'shell.css']);
    expect((await handler()(new Request('app://nutflix/main.js'))).status).toBe(404);
  });

  it('a symlink out of the root is 404 even with an allowed name', async () => {
    const res = await handler()(new Request('app://nutflix/shell.css'));
    expect(res.status).toBe(404);
  });

  it('traversal attempts are 404 and carry the CSP', async () => {
    for (const url of ['app://nutflix/..%2fsecret.txt', 'app://nutflix/%2e%2e/secret.txt']) {
      const res = await handler()(new Request(url));
      expect(res.status).toBe(404);
      expect(res.headers.get('content-security-policy')).toBe(DESIGN_CSP);
    }
  });

  it('a read failure is a 500, never a throw', async () => {
    const h = createAppProtocolHandler({
      root,
      readFile: () => Promise.reject(new Error('EIO')),
      realpath: (p) => realpath(p),
    });
    expect((await h(new Request('app://nutflix/index.html'))).status).toBe(500);
  });
});

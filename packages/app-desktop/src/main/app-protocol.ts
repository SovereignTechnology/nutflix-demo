/**
 * `app://nutflix/…` — serves the renderer's static files and nothing else (design §3); a second
 * instance serves main's prompt page at `app://prompt/…` from `dist/prompt/` (ADR 0013). Each
 * instance serves ONE host and its own file list: neither origin can load the other's files.
 *
 * Only `GET`/`HEAD`, only host `nutflix`, only the files the bundle writes (`APP_FILES`) in
 * `dist/renderer/`, only `.html`/`.js`/`.css`. The path guard refuses dot segments, hidden
 * files, empty segments, backslashes, NUL and ENCODED separators or dots (`%2f`, `%5c`, `%2e`,
 * `%00`) before decoding, and the resolved real path must still be inside the root (a
 * symlink planted in `dist/renderer/` cannot point out of it). Every response carries the CSP
 * header. Electron-free: `main.ts` passes `node:fs/promises` in, tests pass fakes.
 */
import { extname, join, sep } from 'node:path';
import { APP_RESPONSE_HEADERS } from './csp.js';
import { APP_HOST, APP_SCHEME } from './schemes.js';

/** What `scripts/bundle.ts` writes into `dist/renderer/`, and all that `app:` will serve. */
export const APP_FILES = ['index.html', 'app.js', 'ui.css', 'shell.css'] as const;
/** ADR 0013: what it writes into `dist/prompt/`, served at `app://prompt/` only. */
export const PROMPT_FILES = ['prompt.html', 'prompt.js', 'prompt.css'] as const;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export interface AppProtocolDeps {
  /** Absolute `dist/renderer` directory. */
  readonly root: string;
  /** Relative file names that may be served; default `APP_FILES`. */
  readonly files?: readonly string[];
  /** The one host this handler serves; default `APP_HOST` (`PROMPT_HOST` for the prompt page). */
  readonly host?: string;
  readFile(path: string): Promise<Uint8Array>;
  realpath(path: string): Promise<string>;
}

/**
 * The relative file an `app:` URL names, or `null` when the URL is refused. Pure; exported
 * for the tests.
 */
export function resolveAppPath(url: string, host: string = APP_HOST): string | null {
  // The raw path, before URL parsing normalises anything: refuse encoded separators and dots
  // outright (Chromium and WHATWG treat `%2e%2e` as `..`; a later decode must never create one).
  const rawPath = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/.exec(url)?.[1] ?? '';
  if (/%(?:2f|5c|2e|00)/i.test(rawPath) || rawPath.includes('\\')) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${APP_SCHEME}:` || u.host !== host || u.username !== '') return null;
  let path: string;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  if ((path === '/' || path === '') && host === APP_HOST) path = '/index.html';
  if (!path.startsWith('/') || path.includes('\\') || path.includes('\u0000')) return null;
  const segments = path.slice(1).split('/');
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..' || s.startsWith('.')) return null;
    // eslint-disable-next-line no-control-regex -- refusing control characters is the point
    if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  }
  const rel = segments.join('/');
  if (!(extname(rel) in CONTENT_TYPES)) return null;
  return rel;
}

function plain(status: number, extra: Readonly<Record<string, string>> = {}): Response {
  return new Response(null, { status, headers: { ...APP_RESPONSE_HEADERS, ...extra } });
}

/** The `protocol.handle('app', …)` handler. Never throws; failures are 4xx/5xx responses. */
export function createAppProtocolHandler(
  deps: AppProtocolDeps,
): (req: Request) => Promise<Response> {
  const allowed = new Set(deps.files ?? APP_FILES);
  let realRoot: Promise<string> | undefined;
  return async (req) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, { allow: 'GET, HEAD' });
      const rel = resolveAppPath(req.url, deps.host ?? APP_HOST);
      if (rel === null || !allowed.has(rel)) return plain(404);
      realRoot ??= deps.realpath(deps.root);
      const root = await realRoot;
      let real: string;
      try {
        real = await deps.realpath(join(root, ...rel.split('/')));
      } catch {
        return plain(404);
      }
      if (!real.startsWith(root + sep)) return plain(404);
      const body = await deps.readFile(real);
      const type = CONTENT_TYPES[extname(rel)] ?? 'application/octet-stream';
      return new Response(req.method === 'HEAD' ? null : new Uint8Array(body), {
        status: 200,
        headers: {
          ...APP_RESPONSE_HEADERS,
          'content-type': type,
          'content-length': String(body.byteLength),
        },
      });
    } catch {
      realRoot = undefined;
      return plain(500);
    }
  };
}

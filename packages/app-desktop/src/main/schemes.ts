/**
 * The two privileged schemes (design §1, §3) and the app origin. `registerSchemesAsPrivileged`
 * must run before `app.ready`; both schemes are standard (real origins, relative URLs, dot
 * segments canonicalised), secure (a secure context, like https) and stream (range requests
 * for `<video>`). Neither bypasses CSP, enables CORS, the fetch API or service workers.
 */
import type { CustomScheme } from 'electron';

export const APP_SCHEME = 'app';
export const APP_HOST = 'nutflix';
export const APP_ORIGIN = 'app://nutflix';
export const APP_URL = 'app://nutflix/index.html';
export const MEDIA_SCHEME = 'nf-media';

export function privilegedSchemes(): CustomScheme[] {
  return [
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, stream: true } },
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true } },
  ];
}

/** True for a URL whose origin is exactly `app://nutflix`. Never throws. */
export function isAppUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.length > 4096) return false;
  try {
    const u = new URL(url);
    return u.protocol === `${APP_SCHEME}:` && u.host === APP_HOST && u.username === '';
  } catch {
    return false;
  }
}

/** True for exactly the app origin string (`permission check` handlers get origins). */
export function isAppOrigin(origin: unknown): boolean {
  return origin === APP_ORIGIN;
}

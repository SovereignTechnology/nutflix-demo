/**
 * The renderer's Content-Security-Policy (design §3), sent as a RESPONSE HEADER by the `app:`
 * protocol handler on every file it serves (a `<meta>` tag cannot carry `frame-ancestors` and
 * is applied only after parsing starts). Static: no nonces, no hashes, nothing inline.
 *
 * - scripts/styles only from the app's own files (`'self'` = `app://nutflix`), no inline;
 * - images from the app, from main's `nf-media:` proxy (hash-checked by the host) and `data:`;
 * - media only through `nf-media:` (main proxies Range requests to the worker);
 * - no network at all from the page (`connect-src 'none'`), no frames, no plugins, no forms.
 */
export const CSP_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' nf-media: data:",
  'media-src nf-media:',
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
] as const;

export const CSP = CSP_DIRECTIVES.join('; ');

/** Headers on every `app:` response. */
export const APP_RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store',
});

/** Headers on every `nf-media:` response (bytes, never documents). */
export const MEDIA_RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'cross-origin-resource-policy': 'same-origin',
  // Should anything ever render one of these as a document, it gets no script and no origin.
  'content-security-policy': "sandbox; default-src 'none'",
});

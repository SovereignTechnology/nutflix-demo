/**
 * The money plane's mint transport (issue #8, fix round 2): `node:http(s)` under `@sovit/core`'s
 * `cashuRequestFn`, over core's `httpModuleRawHttp` — the implementation the seeder daemon and the
 * gateway use (`@sovit/seeder` `runtime/mint-http.ts`), reused rather than copied, and without
 * loading the seeder's whole Node entry (and its native modules) into the process that spends.
 *
 * SINGLE-ATTEMPT: each request is sent once — one answer or one error, never a retry. The wallet
 * depends on that (`spend.ts` `isDefinitive`: a coded answer is the mint's answer to our one
 * request). cashu-ts's own fetch transport, which `MoneyPlane` used before when given no
 * `mintRequest`, retries `/v1/swap`, `/v1/melt/bolt11` and `/v1/mint/bolt11` after a network error
 * or a 5xx, up to 9 times within the ttl, whenever the mint advertises NUT-19 (cdk-mintd does); a
 * 429 or a coded error on such a retry reads as a refusal of a request that may have executed.
 *
 * What cashu-ts's fetch transport gave, and what this keeps:
 *
 *   timeout     none by default (undici's 300 s header and body timeouts) → 30 s for the whole
 *               exchange, connect to last byte, except a melt (`POST …/v1/melt/{method}`), where
 *               the mint pays the invoice before it answers: 300 s, as before (fix round 3; a
 *               Lightning payment can take a minute or more, and a melt cut off early reads as
 *               unknown, or as failed with no change blanks, for an invoice that then gets paid);
 *               cashu-ts's `requestTimeout` wins when it passes one (it passes none for these);
 *   redirects   followed (fetch's default; refused only with auth headers) → never followed: a
 *               3xx is an error, so a mint cannot point the wallet at another host;
 *   size        unbounded → 4 MiB per response;
 *   schemes     whatever fetch takes (http, https, data, blob) → http(s) only; which mints are
 *               used at all is decided upstream (settings, manifests), as before;
 *   errors      the same cashu-ts classes (`cashuRequestFn`'s contract): `MintOperationError` for a
 *               coded 400, `RateLimitError` for 429, `HttpResponseError`, `NetworkError`;
 *   privacy     no cookies, cache or referrer either way; this sends no User-Agent (cashu-ts's
 *               sent "Mozilla/5.0").
 *
 * Nothing here logs.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { wallet as walletMod } from '@sovit/core';

import { MELT_REQUEST_TIMEOUT_MS, MINT_REQUEST_TIMEOUT_MS } from '../ipc/deadlines.js';

/** Raw HTTP to a mint: `node:http` for `http:` (a loopback dev mint), `node:https` otherwise. */
export const hostRawHttp: walletMod.RawHttp = walletMod.httpModuleRawHttp({
  http: { request: httpRequest },
  https: { request: httpsRequest },
});

/**
 * The cashu-ts request function every mint of the money plane uses (one attempt per request). Its
 * timeouts are the shared `ipc/deadlines.ts` numbers (core's defaults, named where the worker's
 * `pay.build` deadline is weighed against them): 30 s, and 300 s for a melt.
 */
export function hostMintRequest(): ReturnType<typeof walletMod.cashuRequestFn> {
  return walletMod.cashuRequestFn(hostRawHttp, {
    timeoutMs: MINT_REQUEST_TIMEOUT_MS,
    meltTimeoutMs: MELT_REQUEST_TIMEOUT_MS,
  });
}

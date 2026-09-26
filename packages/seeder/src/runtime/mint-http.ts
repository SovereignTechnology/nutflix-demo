/**
 * The daemon's mint transport: `node:http(s)` under `@sovit/core`'s `cashuRequestFn`, never the
 * global `fetch`. On Node 22 `fetch` is undici, whose HTTP parser is WebAssembly, and the unit runs
 * Node `--jitless` (no WebAssembly): the first mint request through `fetch` crashes the process
 * (verified on Node 22.22.0). `node:http` uses Node's native parser.
 *
 * Loaded through `createRequire`, like the gateway's `node:http` (security review F16): an ESM
 * import builds the builtin's facade by reading every export, lazy getters included.
 *
 * The implementation is `@sovit/core`'s `httpModuleRawHttp` (moved there in issue #8 fix round 2,
 * so the desktop host's money plane uses the same one): bounded — one timer for the whole exchange
 * (connect to last byte: 30 s, 300 s for a melt, where the mint pays the invoice before it
 * answers — `cashuRequestFn`, issue #8 fix round 3), a response size cap, no redirects (a 3xx
 * comes back as a status for `cashuRequestFn` to refuse) — and single-attempt: a request is sent
 * once, never retried (the wallet's rule for a coded answer depends on it, `spend.ts`
 * `isDefinitive`).
 */
import { createRequire } from 'node:module';
import type * as NodeHttp from 'node:http';
import type * as NodeHttps from 'node:https';

import { wallet as walletMod } from '@sovit/core';

const load = createRequire(import.meta.url);
const http = load('node:http') as typeof NodeHttp;
const https = load('node:https') as typeof NodeHttps;

export const nodeRawHttp: walletMod.RawHttp = walletMod.httpModuleRawHttp({ http, https });

/** The cashu-ts request function every mint of the daemon's wallet uses. */
export function nodeMintRequest(): ReturnType<typeof walletMod.cashuRequestFn> {
  return walletMod.cashuRequestFn(nodeRawHttp);
}

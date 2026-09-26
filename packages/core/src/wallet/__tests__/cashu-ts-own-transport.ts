/**
 * Test helper: cashu-ts's OWN fetch transport, NUT-19 retries and all — a cashu-ts `Mint` given no
 * `customRequest`. Since issue #8 fix round 3 `CashuMintConnections` never builds one (its default
 * is single-attempt), so the tests that show what that transport does, and that the wallet loses
 * nothing to it, build it here. Not exported from the package. (Core's vitest config runs every
 * file under `__tests__`, so the helper carries its own check, like `nostr/__tests__/helpers.ts`.)
 */
import { Mint, MintOperationError, Wallet as CashuTsWallet } from '@cashu/cashu-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MintUrl } from '../../contracts/index.js';
import { TestMint } from '../../mocks/test-mint.js';
import type { MintConnections } from '../spend.js';

export function cashuTsOwnTransport(): MintConnections {
  const wallets = new Map<MintUrl, Promise<CashuTsWallet>>();
  return {
    wallet: (mint) => {
      let w = wallets.get(mint);
      if (w === undefined) {
        const cashu = new CashuTsWallet(new Mint(mint), { unit: 'sat', requireSigDleq: true });
        w = cashu.loadMint().then(() => cashu);
        wallets.set(mint, w);
      }
      return w;
    },
  };
}

describe('cashuTsOwnTransport (test helper)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('one cashu-ts wallet per mint, loaded through the global fetch (cashu-ts’s own transport)', async () => {
    const url = 'https://mint.cashu-ts-own.example' as MintUrl;
    const mint = new TestMint({ url, seed: new Uint8Array(32).fill(0x6a) });
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit): Promise<Response> => {
      seen.push(`${(init?.method ?? 'GET').toUpperCase()} ${new URL(input).pathname}`);
      try {
        return new Response(JSON.stringify(await mint.request({ endpoint: input })), {
          status: 200,
        });
      } catch (e) {
        if (e instanceof MintOperationError)
          return new Response(JSON.stringify({ code: e.code, detail: e.message }), { status: 400 });
        throw e;
      }
    });
    const c = cashuTsOwnTransport();
    const a = await c.wallet(url);
    expect(await c.wallet(url)).toBe(a);
    expect(seen).toContain('GET /v1/info');
    expect(seen.length).toBe(mint.calls.length); // every request went through `fetch`
  });
});

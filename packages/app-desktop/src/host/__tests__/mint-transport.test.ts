/**
 * Issue #8, fix round 2 (independent verifier, HIGH): the desktop money plane reaches its mints
 * through a SINGLE-ATTEMPT transport by default. Before, `MoneyPlane` built its
 * `CashuMintConnections` with no request function in production, so cashu-ts used its own fetch
 * transport — which retries `/v1/swap`, `/v1/melt/bolt11` and `/v1/mint/bolt11` after a network
 * error or a 5xx, up to 9 times within the ttl, when the mint advertises NUT-19 (cdk-mintd does,
 * ttl 60). A retry's answer says nothing about the first attempt: a 429 or a coded error on the
 * retry of a swap that had executed dropped the journal entry and lost the outputs.
 *
 * Here the money plane is opened with NO `mintRequest` (what `createHost` does in production) over
 * real HTTP to a local mint (the in-process TestMint behind `node:http`) that advertises NUT-19
 * like cdk-mintd. The first POST /v1/swap executes and its connection drops before the answer; any
 * later one is answered 429. One attempt reaches the mint, never a retry, and the send completes
 * from the journal (NUT-09) — nothing lost.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPubKeyFromPrivKey, MintOperationError } from '@cashu/cashu-ts';
import type { CashuP2pkPubkey, MintUrl, RelayUrl, Sats } from '@sovit/core';
import { mocks, nostr, signer as signerMod } from '@sovit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { memoryLogger } from '../log.js';
import { MoneyPlane } from '../money.js';
import { hostMintRequest } from '../mint-transport.js';
import { WALLET_DIR } from '../wallet-journal.js';

const RELAY = 'wss://relay.mint-transport.test' as RelayUrl;
const TO = Buffer.from(getPubKeyFromPrivKey(new Uint8Array(32).fill(0x4d))).toString(
  'hex',
) as CashuP2pkPubkey;

let dir: string;
const cleanups: (() => Promise<void>)[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nf-mint-transport-'));
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await rm(dir, { recursive: true, force: true });
});

/**
 * A TestMint over real HTTP on 127.0.0.1, advertising NUT-19 like cdk-mintd 0.18.1. With
 * `loseFirstSwap`, the first POST /v1/swap is executed and its connection destroyed before the
 * answer, and every later POST /v1/swap is answered 429 (a rate limiter in front of the mint).
 */
async function httpMint(): Promise<{
  url: MintUrl;
  mint: mocks.TestMint;
  st: { loseFirstSwap: boolean; swapPosts: number; served429: number };
}> {
  const st = { loseFirstSwap: false, swapPosts: 0, served429: 0 };
  // Set once the server listens (the mint's URL is the server's).
  const at: { mint?: mocks.TestMint; base: string } = { base: '' };
  const answer = async (req: IncomingMessage, res: ServerResponse, text: string): Promise<void> => {
    const method = (req.method ?? 'GET').toUpperCase();
    const path = req.url ?? '/';
    const isSwap = method === 'POST' && path === '/v1/swap';
    if (isSwap) {
      st.swapPosts++;
      if (st.loseFirstSwap && st.swapPosts > 1) {
        st.served429++;
        res.writeHead(429, { 'Retry-After': '1' });
        res.end();
        return;
      }
    }
    const mint = at.mint;
    if (mint === undefined) throw new Error('no mint yet');
    let status = 200;
    let out: unknown;
    try {
      out = await mint.request({
        endpoint: `${at.base}${path}`,
        method,
        ...(text === '' ? {} : { requestBody: JSON.parse(text) as Record<string, unknown> }),
      });
    } catch (e) {
      const coded = e instanceof MintOperationError;
      status = coded ? 400 : 500;
      out = coded ? { code: e.code, detail: e.message } : { detail: 'error' };
    }
    if (isSwap && st.loseFirstSwap && st.swapPosts === 1) {
      req.socket.destroy(); // the mint has run it; the answer never arrives
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  };
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void answer(req, res, Buffer.concat(chunks).toString('utf8'));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${String((srv.address() as AddressInfo).port)}`;
  at.base = base;
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        srv.closeAllConnections();
        srv.close(() => {
          r();
        });
      }),
  );
  const mint = new mocks.TestMint({
    url: base as MintUrl,
    seed: new Uint8Array(32).fill(0x4e),
    nut19: {
      ttl: 60,
      cachedEndpoints: [
        { method: 'POST', path: '/v1/swap' },
        { method: 'POST', path: '/v1/mint/bolt11' },
        { method: 'POST', path: '/v1/melt/bolt11' },
      ],
    },
  });
  at.mint = mint;
  return { url: base as MintUrl, mint, st };
}

describe('the money plane’s default mint transport sends each request once (fix round 2)', () => {
  it('no mintRequest (production): a lost swap answer is not retried into a 429; the send completes from the journal', async () => {
    const { url, mint, st } = await httpMint();
    const signer = (
      await signerMod.LocalSigner.create({
        passphrase: Buffer.from('mint transport passphrase'),
        cost: signerMod.minimumCost(),
      })
    ).signer;
    const plane = await MoneyPlane.open({
      signer,
      pool: new nostr.FakeRelayPool(),
      relays: () => [{ url: RELAY, read: true, write: true }],
      defaultMints: () => [url],
      log: memoryLogger('warn'),
      journalDir: join(dir, WALLET_DIR),
      createWallet: true,
      // no mintRequest: the host's own default
    });
    try {
      await plane.recovery;
      const q = await plane.wallet.mintQuote(url, 32 as Sats);
      mint.payQuote(q.quoteId);
      await plane.wallet.pollQuote(q);
      expect(await plane.wallet.balance(url)).toBe(32);
      st.loseFirstSwap = true;
      const set = await plane.wallet.send(4 as Sats, { p2pk: TO, mint: url });
      expect(set.proofs.reduce((a, p) => a + p.amount, 0)).toBe(4);
      // One attempt reached the mint; nothing retried it into the rate limiter.
      expect(st.swapPosts).toBe(1);
      expect(st.served429).toBe(0);
      expect(await plane.wallet.balance(url)).toBe(28);
      expect(mint.calls.filter((c) => c === 'POST /v1/restore').length).toBeGreaterThan(0);
    } finally {
      plane.close();
    }
  });

  it('hostMintRequest: one call per request even when cashu-ts passes the mint’s NUT-19 ttl and cached endpoints', async () => {
    const { url, st } = await httpMint();
    st.loseFirstSwap = true;
    const request = hostMintRequest();
    await expect(
      request({
        endpoint: `${url}/v1/swap`,
        method: 'POST',
        requestBody: { inputs: [], outputs: [] },
        ttl: 60_000,
        cached_endpoints: [{ method: 'POST', path: '/v1/swap' }],
      }),
    ).rejects.toMatchObject({ name: 'NetworkError' });
    expect(st.swapPosts).toBe(1);
  });

  it('the money plane is the only way the desktop reaches a mint: one CashuMintConnections, given a request; no cashu-ts elsewhere', async () => {
    // inputFeePpk, mint info, keysets, quotes and every spend go through the money plane's
    // connections; the worker reaches a mint only through the host's `seller.*` handlers, and
    // main's only fetch is the loopback media proxy. A second way in would need cashu-ts.
    const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const files: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== '__tests__') await walk(p);
        } else if (/\.(ts|mts|tsx)$/.test(e.name)) files.push(p);
      }
    };
    await walk(src);
    const hits: string[] = [];
    for (const f of files) {
      const text = await readFile(f, 'utf8');
      if (/from '@cashu\/cashu-ts'|new Mint\(|CashuMintConnections\(/.test(text))
        hits.push(relative(src, f));
    }
    expect(hits).toEqual(['host/money.ts']);
    const money = await readFile(join(src, 'host', 'money.ts'), 'utf8');
    expect(money.match(/CashuMintConnections\(/g)).toHaveLength(1);
    expect(money).toMatch(
      /new walletMod\.CashuMintConnections\(\{\s*request: \(mint\) => o\.mintRequest\?\.\(mint\) \?\? single,/,
    );
  });
});

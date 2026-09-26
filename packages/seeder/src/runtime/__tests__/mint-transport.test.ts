/**
 * Issue #8, fix round 2: every mint of the daemon's wallet is reached through the single-attempt
 * `node:http(s)` transport (`mint-http.ts`), also a mint an injected (test) transport leaves out —
 * never cashu-ts's own fetch transport, which retries swaps and melts at a NUT-19 mint (a retry's
 * answer says nothing about the first attempt: `spend.ts` `isDefinitive`).
 *
 * The two are told apart by their headers: cashu-ts's fetch transport sends
 * `Accept: application/json, text/plain, *\/*` and a `User-Agent`; `cashuRequestFn` sends
 * `Accept: application/json` and none. Since fix round 3 core's own default for such a mint is
 * `cashuRequestFn` over `fetch` — single-attempt too, but `fetch` is undici, WebAssembly, which
 * crashes the daemon under `--jitless` — and Node's `fetch` adds `User-Agent: node`, so the check
 * below still tells `node:http` from it.
 */
import { mkdir, mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { CashuP2pkPubkey, MintUrl, NostrPubkey, RelayUrl } from '@sovit/core';
import { mocks, nostr, signer as signerMod } from '@sovit/core';
import { afterEach, describe, expect, it } from 'vitest';

import { validateDaemonConfig } from '../../cli/config-file.js';
import { capturedLogger } from '../../__tests__/helpers.js';
import { PASSPHRASE_CREDENTIAL, createKeyFile } from '../identity.js';
import { createSeederRuntime } from '../index.js';

const MINT = 'https://mint.runtime-transport.example' as MintUrl;
const RELAY = 'wss://relay.runtime-transport.example' as RelayUrl;
const CREATOR_P2PK = `02${'c7'.repeat(32)}` as CashuP2pkPubkey;
const CREATOR = 'c1'.repeat(32) as NostrPubkey;
const PASS = 'runtime-transport-passphrase-0123456789';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe('the daemon wallet’s mint transport (issue #8 fix round 2)', () => {
  it('a mint the injected transport leaves out gets the single-attempt node:http transport, never cashu-ts’s fetch', async () => {
    const seen: { accept?: string; ua?: string }[] = [];
    const at: { mint?: mocks.TestMint } = {};
    const srv = createServer((req, res) => {
      seen.push({
        ...(req.headers.accept === undefined ? {} : { accept: req.headers.accept }),
        ...(req.headers['user-agent'] === undefined ? {} : { ua: req.headers['user-agent'] }),
      });
      const mint = at.mint;
      const answer =
        mint === undefined
          ? Promise.reject(new Error('no mint yet'))
          : mint.request({
              endpoint: `http://127.0.0.1${req.url ?? '/'}`,
              method: req.method ?? 'GET',
            });
      answer.then(
        (out) => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(out));
        },
        () => {
          res.statusCode = 500;
          res.end('{}');
        },
      );
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    cleanups.push(
      () =>
        new Promise<void>((r) => {
          srv.closeAllConnections();
          srv.close(() => {
            r();
          });
        }),
    );
    const url = `http://127.0.0.1:${String((srv.address() as AddressInfo).port)}` as MintUrl;
    at.mint = new mocks.TestMint({ url, seed: new Uint8Array(32).fill(0x3e) });

    const dir = await mkdtemp(path.join(os.tmpdir(), 'nutflix-runtime-transport-'));
    await chmod(dir, 0o700);
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const data = path.join(dir, 'data');
    await mkdir(data, { mode: 0o700 });
    const r = validateDaemonConfig({
      dataDir: data,
      swarm: null,
      relays: [RELAY],
      policy: { satsPerBlock: 1, mints: [MINT], creatorP2pk: CREATOR_P2PK, creatorPubkey: CREATOR },
    });
    if (!r.ok) throw new Error(r.errors.join('; '));
    await createKeyFile({
      keyFile: r.config.keyFile,
      passphrase: Buffer.from(PASS),
      cost: signerMod.minimumCost(),
    });
    const creds = path.join(dir, 'creds');
    await mkdir(creds, { mode: 0o700 });
    await writeFile(path.join(creds, PASSPHRASE_CREDENTIAL), PASS, { mode: 0o400 });

    // A test transport for the configured mint only; `url` is left out.
    const configured = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x3f) });
    const rt = await createSeederRuntime(r.config, {
      credentialsDirectory: creds,
      logger: capturedLogger().logger,
      pool: new nostr.FakeRelayPool(),
      mintRequest: (m) => (m === MINT ? configured.request : undefined),
    });
    try {
      expect(await rt.wallet.inputFeePpk(url)).toBe(0);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((h) => h.accept === 'application/json' && h.ua === undefined)).toBe(true);
    } finally {
      await rt.close();
    }
  }, 60_000);
});

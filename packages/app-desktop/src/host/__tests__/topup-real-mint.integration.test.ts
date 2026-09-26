/**
 * Issue #2 against REAL Cashu mints (execution plan §4 "real-mint testing lane"). Opt-in: runs
 * only when `NUTFLIX_REAL_MINT_URL` (the source) and `NUTFLIX_REAL_MINT_URL_2` (the target) name
 * two mints — never in plain `npm test`, CI stays offline. `scripts/real-mint/nutshell.sh` starts
 * local Nutshells with the FakeWallet Lightning backend (nothing real moves):
 *
 *   NUTFLIX_REAL_MINT_URL=http://127.0.0.1:3399 NUTFLIX_REAL_MINT_URL_2=http://127.0.0.1:3398 \
 *     npx vitest run packages/app-desktop/src/host/__tests__/topup-real-mint.integration.test.ts
 *
 * What only real mints answer: the source's melt quote for the target's invoice (amount, fee
 * reserve within `maxFeeReserve`), the melt paying it as an EXTERNAL invoice with input fees on
 * top, the target minting, and core's own history lines — "top-up" in at the target, the melt out
 * at the source (shown as "top-up") — with nothing written twice.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MeltQuote, MintUrl, Sats, Settings } from '@sovit/core';
import { wallet as walletMod } from '@sovit/core';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { memoryLogger } from '../log.js';
import { DEFAULT_SETTINGS } from '../settings/settings.js';
import { AutoTopUp, maxFeeReserve } from '../topup/auto-topup.js';
import { TopUpLedger } from '../topup/ledger.js';

const SOURCE = process.env['NUTFLIX_REAL_MINT_URL'] as MintUrl | undefined;
const TARGET = process.env['NUTFLIX_REAL_MINT_URL_2'] as MintUrl | undefined;

vi.setConfig({ testTimeout: 120_000 });

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe.skipIf(SOURCE === undefined || TARGET === undefined)(
  `auto top-up on real mints (${SOURCE ?? 'NUTFLIX_REAL_MINT_URL unset'} → ${TARGET ?? 'NUTFLIX_REAL_MINT_URL_2 unset'})`,
  () => {
    it('tops up the target from the source within the cap; history in at the target, out at the source, once each', async () => {
      const source = SOURCE!;
      const target = TARGET!;
      const wallet = new walletMod.CashuWallet({
        mints: new walletMod.CashuMintConnections(),
        store: new walletMod.MemoryProofStore(),
      });
      // Fund the source (FakeWallet settles the mint's own invoice by itself).
      const q = await wallet.mintQuote(source, 3_000 as Sats);
      let funded = false;
      for (let i = 0; i < 50 && !funded; i++) {
        funded = (await wallet.pollQuote(q)).state === 'ISSUED';
        if (!funded) await new Promise((r) => setTimeout(r, 100));
      }
      expect(funded).toBe(true);

      const dir = await mkdtemp(join(tmpdir(), 'nf-topup-real-'));
      dirs.push(dir);
      const log = memoryLogger('debug');
      const settings: Settings = {
        ...DEFAULT_SETTINGS,
        defaultMints: [target, source],
        autoTopUp: { belowSats: 500 as Sats, fromMint: source, amountSats: 1_000 as Sats },
      };
      const asked: unknown[] = [];
      const top = new AutoTopUp({
        settings: () => settings,
        wallet: () => wallet,
        ledger: await TopUpLedger.open(dir, log),
        askFirstFunding: (x) => {
          asked.push(x);
          return Promise.resolve(true);
        },
        log,
        pollIntervalMs: 200,
      });
      const meltQuote = vi.spyOn(wallet, 'meltQuote');

      expect(await top.check(target, 0 as Sats)).toBe('done');
      expect(asked).toEqual([{ target, source, amount: 1_000 }]);
      const mq = (await meltQuote.mock.results[0]!.value) as MeltQuote;
      expect(mq).toMatchObject({ mint: source, amount: 1_000 });
      expect(mq.feeReserve).toBeLessThanOrEqual(maxFeeReserve(1_000));
      expect(await wallet.balance(target)).toBe(1_000);
      const spent = 3_000 - (await wallet.balance(source));
      // 1 000 plus at most the fee reserve and the input fees; the unused reserve came back.
      expect(spent).toBeGreaterThanOrEqual(1_000);
      expect(spent).toBeLessThanOrEqual(1_000 + mq.feeReserve + 10);

      const history = (await wallet.history()).map((e) => top.relabel(e));
      expect(history.filter((e) => e.mint === target)).toMatchObject([
        { direction: 'in', amount: 1_000, memo: 'top-up' },
      ]);
      expect(history.filter((e) => e.mint === source && e.direction === 'out')).toMatchObject([
        { memo: 'top-up', amount: spent },
      ]);
      // The next one waits (spacing), and the cap is counted from what moved — across a restart.
      expect(await top.check(target, 0 as Sats)).toBe('backoff');
      const reopened = await TopUpLedger.open(dir, log);
      expect(reopened.used()).toBe(spent);
      expect(reopened.isAllowed(target)).toBe(true);
      expect(JSON.stringify(log.lines)).not.toMatch(/lnbc|127\.0\.0\.1/);
    });
  },
);

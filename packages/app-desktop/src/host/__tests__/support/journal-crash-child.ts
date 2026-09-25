/**
 * Not a suite: the child process of `wallet-journal.integration.test.ts` — the host's REAL money
 * plane (`MoneyPlane` with its sealed journal in `<dir>/wallet`, a LocalSigner key file, a relay
 * that survives the process in `<dir>/relay.jsonl`) against a TestMint served over HTTP by the
 * parent. The parent kills this process (SIGKILL) while a request is at the mint, then starts it
 * again to recover.
 *
 *   node child.mjs <mode> <dir> <mintUrl>
 *     fund     create the wallet, mint 64 sat (the parent pays quotes at once)
 *     send     P2PK-send 3 sat (killed while the swap is at the mint)
 *     melt     melt a 20-sat invoice (killed while the melt is at the mint)
 *     recover  open (the startup settle runs), report, then spend everything to prove it is real
 *
 * One JSON line per report on stdout; exit 0 when done, 3 when the wallet did not open.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CashuP2pkPubkey, MintUrl, NostrEvent, RelayUrl, Sats } from '@sovit/core';
import { nostr, signer as signerMod } from '@sovit/core';

import { memoryLogger } from '../../log.js';
import { MoneyPlane } from '../../money.js';

const [mode = '', dir = '', mintArg = ''] = process.argv.slice(2);
const MINT = mintArg as MintUrl;
const RELAY = 'wss://relay.journal-crash.test' as RelayUrl;
const PASS = 'journal crash child passphrase';
const RECIPIENT = `02${'4d'.repeat(32)}` as CashuP2pkPubkey;

function out(o: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(o)}\n`);
}

async function signer(): Promise<signerMod.LocalSigner> {
  const keyFile = join(dir, 'key.json');
  if (existsSync(keyFile))
    return signerMod.LocalSigner.unlock(readFileSync(keyFile), Buffer.from(PASS));
  const { signer: s, file } = await signerMod.LocalSigner.create({
    passphrase: Buffer.from(PASS),
    cost: signerMod.minimumCost(),
  });
  writeFileSync(keyFile, file, { mode: 0o600 });
  return s;
}

/** A relay that outlives the process: every accepted event is appended to a file. */
function durablePool(): nostr.PoolLike {
  const file = join(dir, 'relay.jsonl');
  const pool = new nostr.FakeRelayPool();
  if (existsSync(file))
    for (const line of readFileSync(file, 'utf8').split('\n'))
      if (line.length > 0) pool.store(JSON.parse(line) as NostrEvent);
  return {
    query: (r, f) => pool.query(r, f),
    subscribe: (r, f, h) => pool.subscribe(r, f, h),
    publish: async (r, ev) => {
      const res = await pool.publish(r, ev);
      appendFileSync(file, `${JSON.stringify(ev)}\n`);
      return res;
    },
    close: () => {
      pool.close();
    },
  };
}

async function main(): Promise<void> {
  let plane: MoneyPlane;
  try {
    plane = await MoneyPlane.open({
      signer: await signer(),
      pool: durablePool(),
      relays: () => [{ url: RELAY, read: true, write: true }],
      defaultMints: () => [MINT],
      log: memoryLogger('error'),
      createWallet: mode === 'fund',
      journalDir: join(dir, 'wallet'),
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    out({ openError: /^[a-z][a-z0-9-]*(?=:)/.exec(m)?.[0] ?? 'unknown' });
    process.exit(3);
  }
  const w = plane.wallet;
  if (mode === 'fund') {
    const q = await w.mintQuote(MINT, 64 as Sats);
    const r = await w.pollQuote(q);
    out({ funded: r.minted ?? 0, balance: await w.balance(MINT) });
  } else if (mode === 'send') {
    out({ ready: true, balance: await w.balance(MINT) });
    await w.send(3 as Sats, { p2pk: RECIPIENT, mint: MINT });
    out({ unexpected: 'the swap answered' });
  } else if (mode === 'melt') {
    const q = await w.meltQuote(MINT, 'lnbc200n1journalcrash');
    out({ ready: true, balance: await w.balance(MINT), quote: q.quoteId });
    await w.melt(q);
    out({ unexpected: 'the melt answered' });
  } else if (mode === 'recover') {
    const heldAtOpen = await w.balance(MINT); // may already be settled: the settle races this
    const settled = await plane.recovery;
    const balance = await w.balance(MINT);
    const history = (await w.history({ limit: 3, mint: MINT })).map((h) => ({
      direction: h.direction,
      amount: h.amount,
      memo: h.memo ?? '',
    }));
    // Spend it all: the mint accepts the recovered proofs (neither double-spent nor forged).
    let spentAll = false;
    if (balance > 0) {
      const set = await w.send(balance, { p2pk: RECIPIENT, mint: MINT });
      spentAll = set.proofs.reduce((a, p) => a + p.amount, 0) === balance;
    }
    out({ heldAtOpen, settled, balance, history, spentAll, after: await w.balance(MINT) });
  }
  plane.close();
  process.exit(0);
}

void main().catch((e: unknown) => {
  out({ error: e instanceof Error ? e.message.slice(0, 200) : 'unknown' });
  process.exit(1);
});

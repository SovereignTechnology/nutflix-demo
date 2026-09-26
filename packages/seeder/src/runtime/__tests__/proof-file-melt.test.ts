/**
 * Issue #8 (ADR 0014 amendment) on the daemon's sealed wallet file: melts are journaled too — the
 * daemon's `melt` CLI goes through `FileProofStore` — so a melt entry must survive a reopen, an
 * entry of a kind nobody knows must refuse the start, and a melt whose answer was lost before a
 * crash gets its change back at the next start.
 */
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CashuProof, MintUrl, Sats } from '@sovit/core';
import { mocks, signer as signerMod, wallet as walletMod } from '@sovit/core';
import { afterEach, describe, expect, it } from 'vitest';

import { RuntimeSetupError } from '../files.js';
import { FileProofStore, selfCipher, type FileCipher } from '../proof-file.js';

const MINT = 'https://mint.proof-file-melt.example' as MintUrl;
const NODE = (
  await signerMod.LocalSigner.create({
    passphrase: Buffer.from('proof file melt passphrase'),
    cost: signerMod.minimumCost(),
  })
).signer;
const CIPHER: FileCipher = selfCipher(NODE, await NODE.getPublicKey());

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nutflix-melt-'));
  await chmod(dir, 0o700);
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function proof(n: number, amount = 2): CashuProof {
  return {
    id: '00ab'.repeat(4),
    amount,
    secret: `secret-${String(n)}`,
    C: `02${n.toString(16).padStart(64, '0')}`,
  };
}

function op(id: string, over: Partial<walletMod.PendingOp> = {}): walletMod.PendingOp {
  return {
    id,
    kind: 'receive',
    mint: MINT,
    key: ['secret-a'],
    keep: [
      {
        blindedMessage: { amount: '0', B_: id, id: '00ab'.repeat(4) },
        blindingFactor: '12345',
        secret: 'ab'.repeat(32),
      },
    ],
    send: [],
    spends: [],
    created: 1_900_000_000 as walletMod.PendingOp['created'],
    ...over,
  };
}

describe('FileProofStore — melt entries (issue #8)', () => {
  it('keeps a melt entry across a reopen; an entry of an unknown kind refuses the start', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'proofs.json');
    const a = await FileProofStore.open(file, CIPHER);
    const melt = op(`02${'cc'.repeat(32)}`, { kind: 'melt', key: ['quote-1'], spends: [proof(3)] });
    await a.commit({ mint: MINT, spent: [], added: [], begin: melt });
    expect(await (await FileProofStore.open(file, CIPHER)).pending(MINT)).toEqual([melt]);
    const f2 = path.join(dir, 'proofs2.json');
    const b = await FileProofStore.open(f2, CIPHER);
    await b.commit({
      mint: MINT,
      spent: [],
      added: [],
      begin: op(`02${'dd'.repeat(32)}`, { kind: 'teleport' as never }),
    });
    await expect(FileProofStore.open(f2, CIPHER)).rejects.toBeInstanceOf(RuntimeSetupError);
  });

  it('a melt whose answer was lost, then a crash before recovery: the next start restores the change', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'proofs.json');
    const mint = new mocks.TestMint({
      url: MINT,
      seed: new Uint8Array(32).fill(0x62),
      feeReserve: 4,
    });
    let restoreDown = false;
    const conns = new walletMod.CashuMintConnections({
      request:
        () =>
        <T>(args: Parameters<typeof mint.request>[0]): Promise<T> =>
          restoreDown && args.endpoint.endsWith('/v1/restore')
            ? Promise.reject(new Error('connect ETIMEDOUT'))
            : mint.request<T>(args),
    });
    const before = new walletMod.CashuWallet({
      mints: conns,
      store: await FileProofStore.open(file, CIPHER),
    });
    const q = await before.mintQuote(MINT, 64 as Sats);
    mint.payQuote(q.quoteId);
    await before.pollQuote(q);
    const mq = await before.meltQuote(MINT, 'lnbc200n1daemonmelt');
    restoreDown = true;
    mint.dropNextResponse();
    await expect(before.melt(mq)).rejects.toThrow(/mint-error/);
    // "Crash": a new process opens the same file; the mint is reachable again.
    restoreDown = false;
    const store = await FileProofStore.open(file, CIPHER);
    expect((await store.pending(MINT)).map((o) => o.kind)).toEqual(['melt']);
    const after = new walletMod.CashuWallet({ mints: conns, store });
    expect(await after.balance(MINT)).toBe(0); // the input is held until the mint says
    expect(await after.recoverPending()).toEqual({ recovered: 1, left: 0 });
    expect(await after.balance(MINT)).toBe(44);
  });
});

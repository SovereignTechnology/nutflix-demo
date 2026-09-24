/**
 * TestMint behaves like a mint where it matters to the adversary suite: it refuses a forged
 * signature, an unbalanced swap, a locked proof without its witness, a double-spend and an
 * unknown keyset — so a test that passes against it is not passing because the mint is lax.
 */
import { describe, expect, it } from 'vitest';
import {
  Amount,
  Mint,
  OutputData,
  getPubKeyFromPrivKey,
  hasValidDleq,
  type Proof,
} from '@cashu/cashu-ts';

import type { MintUrl } from '../../contracts/index.js';
import { TestMint } from '../test-mint.js';

const URL_ = 'https://mint.test.example' as MintUrl;

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

async function swap(tm: TestMint, inputs: Proof[], outAmount: number): Promise<unknown> {
  const mint = new Mint(URL_, { customRequest: tm.request });
  const keys = { id: tm.keysetId, keys: tm.keyset().keys };
  const outputs = OutputData.createRandomData(outAmount, keys).map((o) => o.blindedMessage);
  return mint.swap({ inputs, outputs });
}

const toProof = (p: ReturnType<TestMint['issue']>[number]): Proof => ({
  ...p,
  amount: Amount.from(p.amount),
});

describe('TestMint refuses what a real mint refuses', () => {
  it('issues proofs whose DLEQ verifies against its keyset', () => {
    const tm = new TestMint({ url: URL_ });
    for (const p of tm.issue(37)) expect(hasValidDleq(toProof(p), tm.keyset())).toBe(true);
  });

  it('a forged signature (C) → 10003', async () => {
    const tm = new TestMint({ url: URL_ });
    const [p] = tm.issue(4).map(toProof);
    const forged = {
      ...p!,
      C: p!.C.startsWith('02') ? `03${p!.C.slice(2)}` : `02${p!.C.slice(2)}`,
    };
    await expect(swap(tm, [forged], 4)).rejects.toMatchObject({ code: 10003 });
  });

  it('an unbalanced swap → 11002, and nothing is spent', async () => {
    const tm = new TestMint({ url: URL_ });
    const proofs = tm.issue(4).map(toProof);
    await expect(swap(tm, proofs, 5)).rejects.toMatchObject({ code: 11002 });
    expect(tm.isSpent(proofs[0]!.secret)).toBe(false);
  });

  it('a P2PK-locked proof without its witness → 10003', async () => {
    const tm = new TestMint({ url: URL_ });
    const pub = hex(getPubKeyFromPrivKey(new Uint8Array(32).fill(3)));
    await expect(swap(tm, tm.issue(2, { p2pk: pub }).map(toProof), 2)).rejects.toMatchObject({
      code: 10003,
    });
  });

  it('a double-spend → 11001 (and a proof repeated inside one swap too)', async () => {
    const tm = new TestMint({ url: URL_ });
    const proofs = tm.issue(8).map(toProof);
    await swap(tm, proofs, 8);
    expect(tm.isSpent(proofs[0]!.secret)).toBe(true);
    await expect(swap(tm, proofs, 8)).rejects.toMatchObject({ code: 11001 });
    const twice = tm.issue(2).map(toProof);
    await expect(swap(tm, [twice[0]!, twice[0]!], 4)).rejects.toMatchObject({ code: 11001 });
  });

  it('an unknown keyset → 12001; markSpent() spends behind everyone’s back', async () => {
    const tm = new TestMint({ url: URL_ });
    const [p] = tm.issue(1).map(toProof);
    await expect(swap(tm, [{ ...p!, id: '00ffffffffffffff' }], 1)).rejects.toMatchObject({
      code: 12001,
    });
    tm.markSpent([p!]);
    await expect(swap(tm, [p!], 1)).rejects.toMatchObject({ code: 11001 });
  });
});

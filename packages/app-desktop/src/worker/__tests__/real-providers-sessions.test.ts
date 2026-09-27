/**
 * Fix round 5 (the verifier of fix round 4, HIGH): which play session a PAY is built for.
 *
 * Every rendition of an upload lives in the uploader's one core, and a rendition switch opens the
 * new session BEFORE it closes the old one. The worker used to name the play session by core
 * alone, preferring an open one, so the old session's tail was asked of the NEW session; the host
 * refused it ('forbidden: the PAY covers blocks outside the video') and the payer gave the blocks
 * up for good. Now the worker asks the host for a session whose blocks cover the range (open ones
 * first, then those closing), and a session's refusal is not the last word while another covering
 * session may take the PAY.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  BlockRange,
  CashuP2pkPubkey,
  CoreKeyHex,
  MintUrl,
  NostrPubkey,
  PayMessage,
  PricePolicy,
  Sats,
} from '@sovit/core';
import { silentLogger } from '@sovit/seeder';
import { afterEach, describe, expect, it } from 'vitest';

import { IpcError } from '../../ipc/errors.js';
import type { SessionId } from '../../ipc/protocol.js';
import { realProviders } from '../pay/real-providers.js';
import { nodeStateFs } from './helpers/harness.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const CORE = 'c5'.repeat(32) as CoreKeyHex;
const MINT = 'https://mint.example' as MintUrl;
const A = 'aa'.repeat(16) as SessionId;
const B = 'bb'.repeat(16) as SessionId;
const POLICY: PricePolicy = {
  satsPerBlock: 2 as Sats,
  blockSize: 65_536,
  mints: [MINT],
  split: { seeder: 50, creator: 50 },
  creatorP2pk: `02${'11'.repeat(32)}` as CashuP2pkPubkey,
};
const SEEDER = {
  pubkey: 'ee'.repeat(32) as NostrPubkey,
  p2pk: `02${'22'.repeat(32)}` as CashuP2pkPubkey,
  mint: MINT,
};
const MSG = { type: 'PAY' } as unknown as PayMessage;

async function start(
  sidsFor: (range: BlockRange) => readonly SessionId[],
  host: (sid: SessionId) => Promise<PayMessage>,
) {
  const root = await mkdtemp(join(tmpdir(), 'nf-worker-sessions-'));
  dirs.push(root);
  const asked: SessionId[] = [];
  const p = realProviders({
    payments: { pubkey: 'ab'.repeat(32) as NostrPubkey, p2pk: SEEDER.p2pk, mints: [MINT] },
    dir: join(root, 'payments'),
    join,
    state: nodeStateFs,
    request: ((m: string, a: { sid: SessionId }) => {
      if (m !== 'pay.build') return Promise.reject(new Error(`not in this test: ${m}`));
      asked.push(a.sid);
      return host(a.sid);
    }) as never,
    sidsFor,
    priceCeiling: () => 2 as Sats,
    logger: silentLogger,
  });
  const range: BlockRange = { core: CORE, fromBlock: 3, toBlock: 4 };
  const pay = (): Promise<PayMessage> => p.pay(range, SEEDER, POLICY, { carryIn: 0 });
  return { p, asked, pay, range };
}

describe('real providers: a PAY is built for a session covering its blocks (fix round 5)', () => {
  it('asks for the range, not the core, and builds the PAY for the first covering session', async () => {
    const seen: BlockRange[] = [];
    const r = await start(
      (range) => {
        seen.push(range);
        return [A, B];
      },
      () => Promise.resolve(MSG),
    );
    await expect(r.pay()).resolves.toBe(MSG);
    expect(seen).toEqual([r.range]);
    expect(r.asked).toEqual([A]);
    r.p.close?.();
  });

  it("one session's refusal ('forbidden', 'session-closed') is not final while another covering session takes the PAY", async () => {
    for (const code of ['forbidden', 'session-closed'] as const) {
      const r = await start(
        () => [A, B],
        (sid) =>
          sid === A
            ? Promise.reject(new IpcError(code, `${code}: the PAY covers blocks outside the video`))
            : Promise.resolve(MSG),
      );
      await expect(r.pay()).resolves.toBe(MSG);
      expect(r.asked).toEqual([A, B]);
      r.p.close?.();
    }
  });

  it('every covering session refusing: the last refusal goes back to the payer (its code decides)', async () => {
    const r = await start(
      () => [A, B],
      (sid) =>
        Promise.reject(
          new IpcError(
            sid === A ? 'session-closed' : 'forbidden',
            'forbidden: the session has paid for its whole budget',
          ),
        ),
    );
    await expect(r.pay()).rejects.toMatchObject({ code: 'forbidden' });
    expect(r.asked).toEqual([A, B]);
    r.p.close?.();
  });

  it('any other failure (no balance, the host busy) is not tried on another session: it would fail alike', async () => {
    const r = await start(
      () => [A, B],
      () => Promise.reject(new IpcError('no-balance', 'no-balance: not enough sats at this mint')),
    );
    await expect(r.pay()).rejects.toMatchObject({ code: 'no-balance' });
    expect(r.asked).toEqual([A]);
    r.p.close?.();
  });

  // Independent review (lane P2-owed-viewer, HIGH): the payer's wrapper dropped `opts` and this
  // function split the PAY with `carryIn` 0 — the seeder refused it `malformed` after the host had
  // spent its proofs. A PAY without the carry of its chain is now refused before the host is asked.
  it('a PAY without the carry of its chain is refused before the host is asked (nothing spent)', async () => {
    const r = await start(
      () => [A],
      () => Promise.resolve(MSG),
    );
    await expect(r.p.pay(r.range, SEEDER, POLICY)).rejects.toThrow(/^internal: /);
    await expect(r.p.pay(r.range, SEEDER, POLICY, {})).rejects.toThrow(/^internal: /);
    expect(r.asked).toEqual([]);
    await expect(r.p.pay(r.range, SEEDER, POLICY, { carryIn: 20 })).resolves.toBe(MSG);
    expect(r.asked).toEqual([A]);
    r.p.close?.();
  });

  it('no session covers the blocks: refused session-closed without asking the host', async () => {
    const r = await start(
      () => [],
      () => Promise.resolve(MSG),
    );
    await expect(r.pay()).rejects.toThrow(/^session-closed: /);
    expect(r.asked).toEqual([]);
    r.p.close?.();
  });
});

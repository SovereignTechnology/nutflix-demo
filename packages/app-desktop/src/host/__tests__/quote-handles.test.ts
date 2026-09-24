/**
 * F17: mint quote ids never reach the renderer — the host answers `wallet.mintQuote` with an
 * opaque handle, polls by the STORED quote, and translates `wallet.change` quote events.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { MintQuote } from '@sovit/core';
import { mocks } from '@sovit/core';

import type { HostOut, ReplyMsg } from '../../ipc/protocol.js';
import { IPC_V } from '../../ipc/protocol.js';
import { MAX_QUOTE_HANDLES, QuoteHandles } from '../quote-handles.js';
import { SwitchingWallet } from '../wallet.js';
import type { Rig } from './support/rig.js';
import { rig } from './support/rig.js';

let seq = 0;
const rnd = (n: number): Uint8Array => {
  const b = new Uint8Array(n);
  new DataView(b.buffer).setUint32(0, ++seq);
  return b;
};
const quote = (id: string, over: Partial<MintQuote> = {}): MintQuote => ({
  mint: mocks.MINTS.a,
  quoteId: id,
  amount: 100,
  bolt11: 'lnbc1000n1mock',
  expiry: 1_900_000_000,
  state: 'UNPAID',
  ...over,
});

describe('QuoteHandles', () => {
  it('hands out a stable handle per quote and resolves it to the STORED quote', () => {
    const h = new QuoteHandles(rnd);
    const a = h.issue(quote('real-a'));
    expect(a.quoteId).toMatch(/^h[0-9a-f]{32}$/);
    expect(h.issue(quote('real-a', { state: 'PAID' })).quoteId).toBe(a.quoteId);
    // The renderer's copy cannot change the mint or amount: the stored quote is what polls.
    expect(h.resolve({ ...a, amount: 1, mint: mocks.MINTS.b })).toMatchObject({
      quoteId: 'real-a',
      mint: mocks.MINTS.a,
      amount: 100,
      state: 'PAID',
    });
    expect(() => h.resolve(quote('real-a'))).toThrow(/^not-found/); // a raw id is not a handle
    expect(h.translate({ type: 'quote', quote: quote('real-a') })).toMatchObject({
      type: 'quote',
      quote: { quoteId: a.quoteId },
    });
  });

  it('dies with the wallet that issued it: a signer change forgets every handle', async () => {
    const sw = new SwitchingWallet();
    const h = new QuoteHandles(rnd, () => sw.generation());
    const mine = h.issue(quote('for-a'));
    sw.set(new mocks.MockWallet());
    expect(() => h.resolve(mine)).toThrow(/^not-found/);
    // A quote the old wallet was still making when the signer changed is refused, not handed out.
    let finish: (q: MintQuote) => void = () => undefined;
    const pending = h.make(() => new Promise<MintQuote>((ok) => (finish = ok)));
    sw.set(undefined);
    finish(quote('for-b'));
    await expect(pending).rejects.toThrow(/^payments-unavailable/);
  });

  it('forgets the oldest past its bound', () => {
    const h = new QuoteHandles(rnd);
    const first = h.issue(quote('q-0'));
    for (let i = 1; i <= MAX_QUOTE_HANDLES; i++) h.issue(quote(`q-${String(i)}`));
    expect(() => h.resolve(first)).toThrow(/^not-found/);
  });
});

let r: Rig | undefined;
afterEach(async () => {
  await r?.close();
  r = undefined;
});

let nextId = 1;
async function invoke(rr: Rig, method: string, args: unknown[]): Promise<ReplyMsg> {
  const id = nextId++;
  rr.host.handle({ kind: 'call', wc: 4, msg: { v: IPC_V, id, method, args } });
  return (
    await rr.until(
      (o): o is Extract<HostOut, { kind: 'reply' }> =>
        o.kind === 'reply' && o.wc === 4 && o.msg.id === id,
      method,
    )
  ).msg;
}

describe('the host keeps quote ids from the renderer (F17)', () => {
  it('mintQuote answers a handle, pollQuote takes it back, a real id is refused, events carry handles', async () => {
    r = await rig({ flags: { devMocks: true } });
    r.host.handle({
      kind: 'sub',
      wc: 4,
      msg: { v: IPC_V, op: 'sub', subId: 9, topic: { t: 'wallet.change' } },
    });
    const made = await invoke(r, 'wallet.mintQuote', [mocks.MINTS.a, 500]);
    expect(made.ok).toBe(true);
    const q = (made.ok ? made.result : null) as MintQuote;
    expect(q.quoteId).toMatch(/^h[0-9a-f]{32}$/);
    const real = r.host.adapter.quoteHandles.resolve(q).quoteId;
    expect(real).not.toBe(q.quoteId);
    // Nothing the host sent the renderer names the real id. (The dev mock embeds its quote id in
    // its fake bolt11, so match the field, not the substring.)
    const sent = JSON.stringify(r.out);
    expect(sent).not.toContain(`"quoteId":"${real}"`);
    expect(sent).toContain(`"quoteId":"${q.quoteId}"`); // the wallet.change event, translated
    const polled = await invoke(r, 'wallet.pollQuote', [q]);
    expect(polled.ok).toBe(true);
    const bad = await invoke(r, 'wallet.pollQuote', [{ ...q, quoteId: real }]);
    expect(!bad.ok && bad.error.code).toBe('not-found');
  });
});

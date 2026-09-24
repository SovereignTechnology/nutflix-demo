/**
 * The signer flow through the whole host (ADR 0013): a renderer call names a kind, the host asks
 * "main" (this test, answering `prompt` HostOuts with `prompt-answer` HostIns), the key is made,
 * the money plane opens on the in-process TestMint, the worker is RESTARTED with the new
 * signer's payments in its init, subscribers hear `signer.status`, and a lock restarts it again
 * without them.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { MintUrl } from '@sovit/core';
import { mocks, signer as signerMod } from '@sovit/core';

import { isHostOut } from '../../ipc/guards.js';
import type { HostOut, PromptAnswer, PromptForm, ReplyMsg } from '../../ipc/protocol.js';
import { IPC_V } from '../../ipc/protocol.js';
import type { WorkerInit } from '../../ipc/worker-protocol.js';
import type { Rig } from './support/rig.js';
import { eventually, rig } from './support/rig.js';

const MINT = 'https://mint.signer-host.test' as MintUrl;
const PASS = 'a long enough passphrase';

let r: Rig | undefined;
afterEach(async () => {
  await r?.close();
  r = undefined;
});

let nextId = 1;
async function invoke(rr: Rig, method: string, args: unknown[]): Promise<ReplyMsg> {
  const id = nextId++;
  rr.host.handle({ kind: 'call', wc: 3, msg: { v: IPC_V, id, method, args } });
  const out = await rr.until(
    (o): o is Extract<HostOut, { kind: 'reply' }> =>
      o.kind === 'reply' && o.wc === 3 && o.msg.id === id,
    `reply to ${method}`,
    20_000, // argon2id at the INTERACTIVE floor, plus a new wallet on the TestMint
  );
  return out.msg;
}

function answering(script: (f: PromptForm) => PromptAnswer | null, asked: PromptForm[]) {
  return (o: HostOut, host: () => { handle(m: unknown): void }): void => {
    if (o.kind === 'prompt') {
      asked.push(o.form);
      const answer = script(o.form);
      queueMicrotask(() => {
        host().handle({ kind: 'prompt-answer', req: o.req, answer });
      });
    } else if (o.kind === 'keychain') {
      queueMicrotask(() => {
        host().handle({ kind: 'keychain-result', req: o.req, ok: false, value: null });
      });
    }
  };
}

const initOf = (rr: Rig, i: number): WorkerInit =>
  rr.spawned[i]?.received.find((m) => m.m === 'init')?.a as WorkerInit;

describe('the desktop signer through the host (ADR 0013)', () => {
  it('connect → key made in the prompt, wallet on the mint, worker restarted with payments; lock → without', async () => {
    const mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x44) });
    const asked: PromptForm[] = [];
    r = await rig({
      mintRequest: () => mint.request,
      signerCost: signerMod.minimumCost(),
      onOut: answering((f) => {
        if (f.kind === 'local-setup')
          return { kind: 'local-setup', method: 'passphrase', flow: 'generate' };
        if (f.kind === 'new-passphrase' || f.kind === 'unlock-passphrase')
          return { kind: 'secret', value: new TextEncoder().encode(PASS) };
        return null;
      }, asked),
    });
    await r.host.adapter.updateSettings({ defaultMints: [MINT] });
    await r.ready();
    expect(initOf(r, 0).payments).toBeUndefined();

    // Before any signer: honest refusals, and the info the Settings screen reads.
    const me0 = await invoke(r, 'me', []);
    expect(me0.ok && me0.result).toBeNull();
    const bal0 = await invoke(r, 'wallet.balance', [MINT]);
    expect(!bal0.ok && bal0.error.code).toBe('payments-unavailable');
    const info0 = await invoke(r, 'desktop.signer.info', []);
    expect(info0.ok && info0.result).toEqual({
      method: null,
      hasLocalKey: false,
      keychain: false,
      remembered: false,
    });

    r.host.handle({
      kind: 'sub',
      wc: 3,
      msg: { v: IPC_V, op: 'sub', subId: 41, topic: { t: 'signer.status' } },
    });
    const connected = await invoke(r, 'desktop.signer.connect', [{ kind: 'local' }]);
    expect(connected.ok).toBe(true);
    const pubkey = connected.ok ? (connected.result as { pubkey: string }).pubkey : '';
    expect(pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(asked.map((f) => f.kind)).toEqual(['local-setup', 'new-passphrase']);

    // The worker was restarted; its new init carries this signer's payments.
    await eventually(() => r?.spawned.length === 2, 'the worker restart');
    await r.ready();
    expect(r.spawned[0]?.destroyed).toBe(true);
    expect(initOf(r, 1).payments).toMatchObject({ pubkey, mints: [MINT] });

    // Subscribers heard it; the wallet answers; writes have a signer.
    const ev = await r.until(
      (o): o is Extract<HostOut, { kind: 'event' }> => o.kind === 'event' && o.msg.subId === 41,
      'signer.status event',
    );
    expect(ev.msg.payload).toMatchObject({ kind: 'local', pubkey, locked: false });
    const bal = await invoke(r, 'wallet.balance', [MINT]);
    expect(bal.ok && bal.result).toBe(0);
    expect(r.host.adapter.wallet).toBeDefined();

    // Lock: the worker restarts again, without payments; the wallet is gone.
    const locked = await invoke(r, 'desktop.signer.lock', []);
    expect(locked.ok).toBe(true);
    await eventually(() => r?.spawned.length === 3, 'the second restart');
    await r.ready();
    expect(initOf(r, 2).payments).toBeUndefined();
    const bal2 = await invoke(r, 'wallet.balance', [MINT]);
    expect(!bal2.ok && bal2.error.code).toBe('payments-unavailable');
    const st = await invoke(r, 'signer', []);
    expect(st.ok && st.result).toMatchObject({ pubkey, locked: true });

    // Everything the host sent main was a valid, clonable HostOut — and no secret went out.
    for (const o of r.out) {
      expect(isHostOut(o), o.kind).toBe(true);
      expect(structuredClone(o)).toEqual(o);
    }
    const everything = JSON.stringify(r.out);
    expect(everything).not.toContain(PASS);
    expect(r.log.lines.map((l) => JSON.stringify(l)).join('\n')).not.toContain(PASS);
  }, 30_000);

  it('a cancelled prompt answers `cancelled` and leaves the worker alone', async () => {
    const asked: PromptForm[] = [];
    r = await rig({ onOut: answering(() => null, asked) });
    await r.ready();
    const res = await invoke(r, 'desktop.signer.connect', [{ kind: 'nip46' }]);
    expect(!res.ok && res.error.code).toBe('cancelled');
    expect(asked).toEqual([{ kind: 'bunker', keychain: false }]);
    expect(r.spawned).toHaveLength(1);
  });

  it('--dev-mocks keeps the fixed viewer identity: the flow is refused', async () => {
    r = await rig({ flags: { devMocks: true } });
    const res = await invoke(r, 'desktop.signer.connect', [{ kind: 'local' }]);
    expect(!res.ok && res.error.code).toBe('forbidden');
    expect(r.out.some((o) => o.kind === 'prompt')).toBe(false);
  });
});

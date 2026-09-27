/**
 * ADR 0016 through the WHOLE host: the renderer names an action (`desktop.wallet.recovery.*`
 * over the IPC wire), "main" (this test) answers the prompt window and the native confirm, the
 * money plane reopens with the phrase (the worker restarts around it), the wallet's real balance
 * on the in-process TestMint is planned and reissued through the fake N1 seam, and a restore
 * reports per mint. Everything the renderer received and every log line is checked for the
 * phrase (the canary), and everything sent to main was a valid, clonable HostOut.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { MintUrl, NostrPubkey, Sats } from '@sovit/core';
import { mocks, signer as signerMod, wallet as walletMod } from '@sovit/core';

import { isHostOut } from '../../ipc/guards.js';
import type { HostOut, PromptAnswer, ReplyMsg } from '../../ipc/protocol.js';
import { IPC_V } from '../../ipc/protocol.js';
import { readEnvelope, recoveryPath } from '../recovery/files.js';
import { WALLET_DIR } from '../wallet-journal.js';
import type { Rig } from './support/rig.js';
import { eventually, rig } from './support/rig.js';
import { FakeRecoveryCore, entropyHexOf, wordsOf } from './support/fake-recovery.js';

const MINT = 'https://mint.recovery-host.test' as MintUrl;
const PASS = 'a long enough passphrase';

let r: Rig | undefined;
afterEach(async () => {
  await r?.close();
  r = undefined;
});

let nextId = 1;
async function invoke(rr: Rig, method: string, args: unknown[] = []): Promise<ReplyMsg> {
  const id = nextId++;
  rr.host.handle({ kind: 'call', wc: 3, msg: { v: IPC_V, id, method, args } });
  const out = await rr.until(
    (o): o is Extract<HostOut, { kind: 'reply' }> =>
      o.kind === 'reply' && o.wc === 3 && o.msg.id === id,
    `reply to ${method}`,
    20_000,
  );
  return out.msg;
}

describe('the recovery phrase through the host (ADR 0016)', () => {
  it('setup → covered with the balance reissued after the native fee confirm; restore reports per mint; the canary holds', async () => {
    const mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x61) });
    const core = new FakeRecoveryCore();
    core.phrases.queue.push(new Uint8Array(16).fill(0x7f));
    let shown: readonly number[] = [];
    const confirms: string[] = [];
    /** Each HostOut as main receives it: a structured clone taken when it is posted. */
    const posted: HostOut[] = [];
    r = await rig({
      mintRequest: () => mint.request,
      signerCost: signerMod.minimumCost(),
      recoveryCore: core,
      onOut: (o, host) => {
        posted.push(structuredClone(o));
        if (o.kind === 'prompt') {
          const f = o.form;
          let a: PromptAnswer | null = null;
          if (f.kind === 'local-setup')
            a = { kind: 'local-setup', method: 'passphrase', flow: 'generate' };
          else if (f.kind === 'new-passphrase' || f.kind === 'recovery-reauth')
            a = { kind: 'secret', value: new TextEncoder().encode(PASS) };
          else if (f.kind === 'recovery-show') {
            shown = [...f.words];
            a = { kind: 'recovery-show', done: true };
          } else if (f.kind === 'recovery-confirm')
            a = { kind: 'recovery-confirm', words: f.positions.map((p) => shown[p] ?? 0) };
          else if (f.kind === 'recovery-restore') a = { kind: 'recovery-restore', words: [] };
          queueMicrotask(() => {
            host().handle({ kind: 'prompt-answer', req: o.req, answer: a });
          });
        } else if (o.kind === 'confirm') {
          confirms.push(o.form.kind);
          queueMicrotask(() => {
            host().handle({ kind: 'confirm-result', req: o.req, ok: true });
          });
        } else if (o.kind === 'keychain') {
          queueMicrotask(() => {
            host().handle({ kind: 'keychain-result', req: o.req, ok: false, value: null });
          });
        }
      },
    });
    await r.host.adapter.updateSettings({ defaultMints: [MINT] });
    await r.ready();

    // Before any signer: unavailable, and the flows refuse.
    const st0 = await invoke(r, 'desktop.wallet.recovery.status');
    expect(st0.ok && st0.result).toEqual({
      state: 'unavailable',
      reissuePending: false,
      relayCopy: false,
    });
    const refused = await invoke(r, 'desktop.wallet.recovery.setup');
    expect(!refused.ok && refused.error.code).toBe('payments-unavailable');
    // The renderer can name the action only: any argument is refused at the gate's guard.
    const withArgs = await invoke(r, 'desktop.wallet.recovery.restore', [[1, 2, 3]]);
    expect(!withArgs.ok && withArgs.error.code).toBe('invalid-argument');

    const connected = await invoke(r, 'desktop.signer.connect', [{ kind: 'local' }]);
    expect(connected.ok).toBe(true);
    const pubkey = (
      connected.ok ? (connected.result as { pubkey: string }).pubkey : ''
    ) as NostrPubkey;
    await eventually(() => r?.spawned.length === 2, 'the worker restart after connect');
    await r.ready();
    // Fund the wallet (the user's own Lightning top-up).
    const wallet = r.host.adapter.wallet;
    const q = await wallet.mintQuote(MINT, 2_000 as Sats);
    mint.payQuote(q.quoteId);
    await wallet.pollQuote(q);
    core.wallet.balances.set(MINT, 2_000);
    core.wallet.plans.set(MINT, { inputs: 5, feeSats: 1 });

    const st1 = await invoke(r, 'desktop.wallet.recovery.status');
    expect(st1.ok && st1.result).toEqual({
      state: 'not-on-device',
      reissuePending: false,
      relayCopy: false,
    });

    const setup = await invoke(r, 'desktop.wallet.recovery.setup');
    expect(setup.ok && setup.result).toEqual({
      status: { state: 'covered', reissuePending: false, relayCopy: true },
      reissuedSats: 1_999,
      feeSats: 1,
      reissueFailed: 0,
    });
    expect(confirms).toEqual(['recovery-reissue']);
    // The plane reopened with the phrase: the worker restarted around it, and the new plane's
    // connections got the seed material (with the counters file) — the old one's seed is none.
    await eventually(() => r?.spawned.length === 3, 'the worker restart after the reopen');
    await r.ready();
    expect(core.materials).toHaveLength(1);
    expect(core.materials[0]?.counters).toMatchObject({
      path: join(r.userData, WALLET_DIR, `counters-${pubkey}.json`),
    });
    // The sealed file: 0600, NIP-44 to self; the relay copy on the user's write relay.
    const path = recoveryPath(join(r.userData, WALLET_DIR), pubkey);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    const env = await readEnvelope(path);
    expect(env).toMatchObject({ confirmed: true, reissued: true, relayCopy: true });
    const copy = r.pool.published.find((p) => p.event.kind === walletMod.RECOVERY_RELAY_KIND);
    expect(copy?.event.content).toBe(env?.sealed);
    expect(copy?.relays).toEqual(['wss://a.test']);

    // Restore: progress events to a subscriber, one row per mint.
    r.host.handle({
      kind: 'sub',
      wc: 3,
      msg: { v: IPC_V, op: 'sub', subId: 77, topic: { t: 'recovery.progress' } },
    });
    core.wallet.restores.set(entropyHexOf(new Uint8Array(16).fill(0x7f)), {
      [MINT]: { outcome: 'restored', restoredSats: 5 },
    });
    const restored = await invoke(r, 'desktop.wallet.recovery.restore');
    expect(restored.ok && restored.result).toEqual({
      phrases: 1,
      reports: [{ mint: MINT, outcome: 'restored', restoredSats: 5 }],
    });
    const progress = r.out.filter(
      (o): o is Extract<HostOut, { kind: 'event' }> => o.kind === 'event' && o.msg.subId === 77,
    );
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]?.msg.payload).toMatchObject({ phrase: 1, phrases: 1, mint: MINT });

    // Show again: the passphrase first, then the same indices.
    shown = [];
    const shownAgain = await invoke(r, 'desktop.wallet.recovery.show');
    expect(shownAgain.ok).toBe(true);
    expect(shown).toEqual(core.phrases.toIndices(new Uint8Array(16).fill(0x7f) as never));

    // ---- the canary --------------------------------------------------------------------------
    for (const o of r.out) {
      expect(isHostOut(o), o.kind).toBe(true);
      expect(structuredClone(o)).toEqual(o);
    }
    const toRenderer = JSON.stringify(
      posted.filter((o) => o.kind === 'reply' || o.kind === 'event' || o.kind === 'sub-reply'),
    );
    const logs = r.log.lines.map((l) => JSON.stringify(l)).join('\n');
    const entropy = new Uint8Array(16).fill(0x7f);
    const indices = core.phrases.toIndices(entropy as never);
    const words = wordsOf(indices);
    for (const sink of [toRenderer, logs]) {
      expect(sink).not.toContain(entropyHexOf(entropy));
      expect(sink).not.toContain(JSON.stringify(indices));
      for (let i = 0; i + 2 <= words.length; i++)
        expect(sink).not.toContain(words.slice(i, i + 2).join(' '));
      expect(sink).not.toContain(PASS);
    }
    // The words went to main ONLY as indices in prompt forms — never anywhere else.
    const withIndices = posted.filter((o) => JSON.stringify(o).includes(JSON.stringify(indices)));
    expect(withIndices.every((o) => o.kind === 'prompt' && o.form.kind === 'recovery-show')).toBe(
      true,
    );
    expect(withIndices).toHaveLength(2); // setup's show, and show again
    // …and the host zeroed its own copy of those indices once each question was answered.
    const hostCopies = r.out.filter(
      (o): o is Extract<HostOut, { kind: 'prompt' }> =>
        o.kind === 'prompt' && o.form.kind === 'recovery-show',
    );
    expect(hostCopies).toHaveLength(2);
    for (const o of hostCopies)
      expect(o.form.kind === 'recovery-show' && o.form.words.every((w) => w === 0)).toBe(true);
  }, 60_000);
});

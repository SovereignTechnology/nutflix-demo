/**
 * The host's side of main's prompt window and keychain (ADR 0013): requests matched by id,
 * bounded in time, answers that do not fit (or that nobody asked for) wiped and dropped.
 */
import { describe, expect, it } from 'vitest';

import type { HostOut } from '../../ipc/protocol.js';
import { MainBridge } from '../signer/main-bridge.js';
import type { Timers } from '../worker/supervisor.js';

class Clock implements Timers {
  private seq = 0;
  readonly due = new Map<number, () => void>();
  setTimeout(fn: () => void): unknown {
    const id = ++this.seq;
    this.due.set(id, fn);
    return id;
  }
  clearTimeout(h: unknown): void {
    this.due.delete(h as number);
  }
  fireAll(): void {
    for (const [id, fn] of [...this.due]) {
      this.due.delete(id);
      fn();
    }
  }
}

function bridge(): { b: MainBridge; out: HostOut[]; clock: Clock } {
  const out: HostOut[] = [];
  const clock = new Clock();
  return { b: new MainBridge({ post: (o) => out.push(o), timers: clock }), out, clock };
}

const reqOf = (o: HostOut | undefined): number => (o as { req: number }).req;

describe('MainBridge', () => {
  it('matches answers by request id', async () => {
    const { b, out } = bridge();
    const p1 = b.ask({ kind: 'import-nsec' });
    const p2 = b.ask({ kind: 'create-wallet' });
    expect(out.map((o) => o.kind)).toEqual(['prompt', 'prompt']);
    b.onPromptAnswer(reqOf(out[1]), { kind: 'create-wallet', create: true });
    b.onPromptAnswer(reqOf(out[0]), { kind: 'secret', value: new Uint8Array([1, 2]) });
    expect(await p2).toEqual({ kind: 'create-wallet', create: true });
    expect(await p1).toMatchObject({ kind: 'secret' });
  });

  it('an answer that does not fit its question is null, and its secret is wiped', async () => {
    const { b, out } = bridge();
    const p = b.ask({ kind: 'create-wallet' });
    const value = new Uint8Array([9, 9, 9]);
    b.onPromptAnswer(reqOf(out[0]), { kind: 'secret', value });
    expect(await p).toBeNull();
    expect([...value]).toEqual([0, 0, 0]);
  });

  it('an answer nobody asked for (or a second one) is wiped and ignored', async () => {
    const { b, out } = bridge();
    const stray = new Uint8Array([5, 5]);
    b.onPromptAnswer(77, { kind: 'secret', value: stray });
    expect([...stray]).toEqual([0, 0]);
    const p = b.ask({ kind: 'import-nsec' });
    b.onPromptAnswer(reqOf(out[0]), null);
    expect(await p).toBeNull();
    const late = new Uint8Array([4]);
    b.onPromptAnswer(reqOf(out[0]), { kind: 'secret', value: late });
    expect([...late]).toEqual([0]);
  });

  it('a prompt left open past its deadline is cancelled in main and resolves null', async () => {
    const { b, out, clock } = bridge();
    const p = b.ask({ kind: 'unlock-passphrase', retry: false });
    clock.fireAll();
    expect(await p).toBeNull();
    expect(out.at(-1)).toEqual({ kind: 'prompt-cancel', req: reqOf(out[0]) });
  });

  it('keychain: get returns the value, put/forget never do (a stray value is wiped)', async () => {
    const { b, out } = bridge();
    const g = b.keychain('get', 'passphrase');
    b.onKeychainResult(reqOf(out[0]), true, new Uint8Array([1]));
    expect(await g).toEqual({ ok: true, value: new Uint8Array([1]) });
    const put = new Uint8Array([7, 7]);
    const p = b.keychain('put', 'nip46', put);
    expect(out[1]).toMatchObject({ kind: 'keychain', op: 'put', slot: 'nip46' });
    const stray = new Uint8Array([3]);
    b.onKeychainResult(reqOf(out[1]), true, stray);
    expect(await p).toEqual({ ok: true, value: null });
    expect([...stray]).toEqual([0]);
    const f = b.keychain('forget', 'passphrase');
    expect(out[2]).toEqual({
      kind: 'keychain',
      req: reqOf(out[2]),
      op: 'forget',
      slot: 'passphrase',
    });
    b.onKeychainResult(reqOf(out[2]), false, null);
    expect(await f).toEqual({ ok: false, value: null });
  });

  it('keychain: a timeout is a failure, never a hang', async () => {
    const { b, clock } = bridge();
    const g = b.keychain('get', 'passphrase');
    clock.fireAll();
    expect(await g).toEqual({ ok: false, value: null });
  });

  it('cancelAll (shutdown): every prompt cancelled in main, everything settles', async () => {
    const { b, out } = bridge();
    const p = b.ask({ kind: 'import-nsec' });
    const k = b.keychain('get', 'nip46');
    b.cancelAll();
    expect(await p).toBeNull();
    expect(await k).toEqual({ ok: false, value: null });
    expect(out.filter((o) => o.kind === 'prompt-cancel')).toHaveLength(1);
    expect(await b.ask({ kind: 'import-nsec' })).toBeNull();
    expect(out.filter((o) => o.kind === 'prompt')).toHaveLength(1);
  });
});

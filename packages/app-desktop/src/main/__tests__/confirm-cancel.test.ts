/**
 * Round 8 (final panel, packaging): a host confirm the host stopped waiting for. Its deadline
 * passed, and main's native dialog stayed up: a later "Move it" answered a request the host had
 * dropped, and until it was dismissed main refused every other host confirm as busy. The host now
 * posts `confirm-cancel` (on the deadline and at shutdown), and main closes the dialog.
 *
 * Both halves together: the host's `MainBridge` and main's `HostConfirms`, the one's posts
 * delivered to the other as main.ts delivers them. (main.ts's own wiring of `confirm-cancel` and
 * of the dialog's `signal` is main-wiring.test.ts.)
 *
 * Why the bridge is imported at run time: this lane's allowlist covers main-bridge.ts but not
 * src/host/__tests__/, and a static import of host code from a main test puts that file in the
 * main tsc project, which the composite build refuses (TS6307). The host project still
 * type-checks main-bridge.ts; the shape used here is declared below, and the first test pins it.
 */
import { describe, expect, it } from 'vitest';

import type { ConfirmForm, HostOut } from '../../ipc/protocol.js';
import { HostConfirms } from '../host-confirm.js';

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
interface Bridge {
  confirm(form: ConfirmForm): Promise<boolean>;
  onConfirmResult(req: number, ok: boolean): void;
  cancelAll(): void;
}
type BridgeCtor = new (o: {
  post: (out: HostOut) => void;
  timers: Timers;
  confirmTimeoutMs?: number;
}) => Bridge;

const bridgeModule = '../../host/signer/main-bridge.js';
async function loadBridge(): Promise<{ MainBridge: BridgeCtor; CONFIRM_TIMEOUT_MS: number }> {
  return (await import(/* @vite-ignore */ bridgeModule)) as {
    MainBridge: BridgeCtor;
    CONFIRM_TIMEOUT_MS: number;
  };
}

class Clock implements Timers {
  private seq = 0;
  readonly due = new Map<number, { fn: () => void; ms: number }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.due.set(id, { fn, ms });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.due.delete(h as number);
  }
  fireAll(): void {
    for (const [id, t] of [...this.due]) {
      this.due.delete(id);
      t.fn();
    }
  }
}

const reqOf = (o: HostOut | undefined): number => (o as { req: number }).req;
const settle = (): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, 0);
  });

describe('the host side: MainBridge', () => {
  it('a confirm left open past its deadline (5 minutes) is no, and main is told to close its dialog', async () => {
    const { MainBridge, CONFIRM_TIMEOUT_MS } = await loadBridge();
    expect(CONFIRM_TIMEOUT_MS).toBe(5 * 60_000);
    const out: HostOut[] = [];
    const clock = new Clock();
    const b = new MainBridge({ post: (o) => out.push(o), timers: clock });
    const c = b.confirm({ kind: 'recovery-reveal' });
    expect(out).toEqual([
      { kind: 'confirm', req: reqOf(out[0]), form: { kind: 'recovery-reveal' } },
    ]);
    expect([...clock.due.values()].map((t) => t.ms)).toEqual([CONFIRM_TIMEOUT_MS]);
    clock.fireAll();
    expect(await c).toBe(false);
    expect(out).toEqual([
      { kind: 'confirm', req: reqOf(out[0]), form: { kind: 'recovery-reveal' } },
      { kind: 'confirm-cancel', req: reqOf(out[0]) },
    ]);
    // A late answer (the user clicked after all) changes nothing and cancels nothing twice.
    b.onConfirmResult(reqOf(out[0]), true);
    clock.fireAll();
    expect(out).toHaveLength(2);
  });

  it('an answered confirm is not cancelled; shutdown (cancelAll) closes every open dialog in main', async () => {
    const { MainBridge } = await loadBridge();
    const out: HostOut[] = [];
    const clock = new Clock();
    const b = new MainBridge({ post: (o) => out.push(o), timers: clock });
    const answered = b.confirm({ kind: 'recovery-rotate' });
    b.onConfirmResult(reqOf(out[0]), true);
    expect(await answered).toBe(true);
    clock.fireAll();
    expect(out.filter((o) => o.kind === 'confirm-cancel')).toEqual([]);
    const one = b.confirm({ kind: 'recovery-reveal' });
    const two = b.confirm({ kind: 'recovery-rotate' });
    b.cancelAll();
    expect(await one).toBe(false);
    expect(await two).toBe(false);
    expect(out.filter((o) => o.kind === 'confirm-cancel')).toEqual([
      { kind: 'confirm-cancel', req: reqOf(out[1]) },
      { kind: 'confirm-cancel', req: reqOf(out[2]) },
    ]);
    expect(clock.due.size).toBe(0);
  });
});

describe('both halves: the host’s deadline closes main’s dialog', () => {
  it('deadline → confirm-cancel → dialog closed, no answer; the next confirm gets its own dialog and its answer', async () => {
    const { MainBridge } = await loadBridge();
    const clock = new Clock();
    const dialogs: { signal: AbortSignal; answer: (v: unknown) => void }[] = [];
    const logs: string[] = [];
    // Main: a dialog open until answered, closed as a Cancel when its signal aborts (Electron).
    const link: { bridge?: Bridge } = {};
    const main = new HostConfirms({
      ask: (_p, signal) =>
        new Promise((resolve) => {
          dialogs.push({ signal, answer: resolve });
          signal.addEventListener('abort', () => {
            resolve(false);
          });
        }),
      answer: (req, ok) => link.bridge?.onConfirmResult(req, ok),
      log: (_l, e) => logs.push(e),
    });
    // The host: its posts reach main as main.ts's onHostOut routes them.
    const bridge = new MainBridge({
      timers: clock,
      post: (o) => {
        if (o.kind === 'confirm') main.ask(o.req, o.form);
        else if (o.kind === 'confirm-cancel') main.cancel(o.req);
      },
    });
    link.bridge = bridge;
    const first = bridge.confirm({ kind: 'recovery-reveal' });
    await settle();
    expect(dialogs).toHaveLength(1);
    clock.fireAll(); // five minutes, nobody answered
    expect(await first).toBe(false);
    expect(dialogs[0]?.signal.aborted).toBe(true);
    const second = bridge.confirm({ kind: 'recovery-rotate' });
    await settle();
    expect(logs).not.toContain('confirm.busy');
    expect(dialogs).toHaveLength(2);
    dialogs[1]?.answer(true);
    expect(await second).toBe(true);
  });
});

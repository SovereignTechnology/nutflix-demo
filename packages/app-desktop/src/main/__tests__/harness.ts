/**
 * Test harness for main: fake webContents / invoke events, a gate wired to a `FakeHost`, and a
 * fake `lstat`. Not a suite.
 */
import type { EventMsg, HostOut } from '../../ipc/protocol.js';
import { FileTokenRegistry, type FileStat } from '../file-tokens.js';
import { IpcGate, type GateEvent, type GateFrame, type GateWebContents } from '../ipc-gate.js';
import type { MoneyGate } from '../money-gate.js';
import { FakeHost, type FakeHostOptions } from './fake-host.js';

export class FakeWebContents implements GateWebContents {
  destroyed = false;
  readonly sent: { channel: string; msg: EventMsg }[] = [];
  constructor(readonly id: number) {}
  isDestroyed(): boolean {
    return this.destroyed;
  }
  send(channel: string, msg: EventMsg): void {
    this.sent.push({ channel, msg: structuredClone(msg) });
  }
}

export const APP_PAGE = 'app://nutflix/index.html';

/** A top frame (parent null) at `url`. */
export function topFrame(url = APP_PAGE): GateFrame {
  return { url, parent: null };
}

export function eventFrom(wc: GateWebContents, frame: GateFrame | null = topFrame()): GateEvent {
  return { sender: wc, senderFrame: frame };
}

export function fileStat(kind: 'file' | 'dir' | 'symlink' | 'device', size = 1234): FileStat {
  return {
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
    size,
  };
}

export interface Harness {
  readonly gate: IpcGate;
  readonly host: FakeHost;
  readonly tokens: FileTokenRegistry;
  readonly wc: FakeWebContents;
  readonly other: FakeWebContents;
  readonly clock: { now: number };
  readonly files: Map<string, FileStat>;
  readonly money: { asked: string[]; allow: boolean };
  readonly hostOut: HostOut[];
  /** An invoke event from the app window's top frame. */
  ev(wc?: FakeWebContents): GateEvent;
}

export function createHarness(opts: FakeHostOptions & { appWcIds?: number[] } = {}): Harness {
  const clock = { now: 1_000_000 };
  const files = new Map<string, FileStat>();
  let seq = 0;
  const tokens = new FileTokenRegistry({
    lstat: (p) => {
      const st = files.get(p);
      return st === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(st);
    },
    now: () => clock.now,
    randomHex: () => {
      seq += 1;
      return seq.toString(16).padStart(32, 'a');
    },
    basename: (p) => p.slice(p.lastIndexOf('/') + 1),
  });
  const money = { asked: [] as string[], allow: true };
  const moneyGate: MoneyGate = {
    confirm: (req) => {
      money.asked.push(req.method);
      return Promise.resolve(money.allow);
    },
  };
  const hostOut: HostOut[] = [];
  const appIds = new Set(opts.appWcIds ?? [1, 2]);
  // The gate is created after the host, but the host's replies go to the gate: late-bind.
  const sink: { gate?: IpcGate } = {};
  const host = new FakeHost((m) => {
    hostOut.push(m);
    sink.gate?.fromHost(m);
  }, opts);
  const gate = new IpcGate({
    post: host.post,
    tokens,
    moneyGate,
    isAppWebContents: (id) => appIds.has(id),
  });
  sink.gate = gate;
  const wc = new FakeWebContents(1);
  const other = new FakeWebContents(2);
  return {
    gate,
    host,
    tokens,
    wc,
    other,
    clock,
    files,
    money,
    hostOut,
    ev: (w = wc) => eventFrom(w),
  };
}

let callId = 0;
/** A well-formed `CallMsg` with a fresh id. */
export function callMsg(
  method: string,
  args: readonly unknown[],
  id?: number,
): Record<string, unknown> {
  callId += 1;
  return { v: 1, id: id ?? callId, method, args };
}

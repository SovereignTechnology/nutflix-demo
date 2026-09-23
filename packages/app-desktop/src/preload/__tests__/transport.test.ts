/**
 * The preload transport, first against a scripted fake `ipcRenderer`, then end to end through
 * main's REAL IPC gate and the `FakeHost` (MockNetworkAdapter): renderer ⇄ main ⇄ host with
 * structured clone on both hops. Main's modules live in another TypeScript project, so they are
 * imported at runtime by path and typed structurally here.
 */
import { describe, expect, it } from 'vitest';
import { mocks } from '@sovit/core';
import type { EventMsg, HostOut, ReplyMsg } from '../../ipc/protocol.js';
import { CHANNEL } from '../../ipc/protocol.js';
import { createBridge } from '../bridge.js';
import { createTransport, stripUndefined, type IpcRendererLike } from '../transport.js';

const { VIDEOS, MINTS } = mocks;
const VIDEO = VIDEOS[0]!;

async function codeOf(p: Promise<unknown>): Promise<{ code: unknown; message: string }> {
  try {
    await p;
  } catch (e: unknown) {
    const err = e as Error & { code?: unknown };
    return { code: err.code, message: err.message };
  }
  throw new Error('expected a rejection');
}

class ScriptedIpc implements IpcRendererLike {
  readonly sent: { channel: string; msg: Record<string, unknown> }[] = [];
  listener: ((e: unknown, msg: unknown) => void) | undefined;
  answer: (channel: string, msg: Record<string, unknown>) => unknown = (_c, msg) => ({
    v: 1,
    id: msg['id'] ?? msg['subId'] ?? 0,
    ok: true,
    result: 'ok',
  });
  invoke(channel: string, msg: unknown): Promise<unknown> {
    const m = msg as Record<string, unknown>;
    this.sent.push({ channel, msg: m });
    try {
      return Promise.resolve(this.answer(channel, m));
    } catch (e: unknown) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
  on(_channel: string, listener: (e: unknown, msg: unknown) => void): void {
    this.listener = listener;
  }
  emit(msg: unknown): void {
    this.listener?.({}, msg);
  }
}

describe('transport (scripted ipc)', () => {
  it('numbers calls, strips undefined keys, returns the result', async () => {
    const ipc = new ScriptedIpc();
    const t = createTransport(ipc);
    await t.call('feed', [{ source: 'trending', cursor: undefined } as never]);
    await t.call('related', [VIDEO.id, undefined]);
    expect(ipc.sent.map((s) => s.channel)).toEqual([CHANNEL.call, CHANNEL.call]);
    expect(ipc.sent[0]?.msg).toEqual({
      v: 1,
      id: 1,
      method: 'feed',
      args: [{ source: 'trending' }],
    });
    expect(ipc.sent[1]?.msg['id']).toBe(2);
    expect(ipc.sent[1]?.msg['args']).toEqual([VIDEO.id, undefined]);
  });

  it('rejects with the wire error (prefix kept, .code set), and on malformed or mismatched replies', async () => {
    const ipc = new ScriptedIpc();
    const t = createTransport(ipc);
    ipc.answer = (_c, m) => ({
      v: 1,
      id: m['id'],
      ok: false,
      error: { code: 'no-seeders', message: 'no-seeders: nobody' },
    });
    expect(await codeOf(t.call('me', []))).toEqual({
      code: 'no-seeders',
      message: 'no-seeders: nobody',
    });
    ipc.answer = () => ({ v: 1, id: 999, ok: true, result: 1 });
    expect((await codeOf(t.call('me', []))).code).toBe('internal');
    ipc.answer = () => 'junk';
    expect((await codeOf(t.call('me', []))).code).toBe('internal');
    ipc.answer = (_c, m) => ({
      v: 1,
      id: m['id'],
      ok: false,
      error: { code: 'made-up', message: 'x' },
    });
    expect((await codeOf(t.call('me', []))).code).toBe('internal');
    ipc.answer = () => {
      throw new Error('Error invoking remote method');
    };
    expect((await codeOf(t.call('me', []))).code).toBe('backend-down');
  });

  it('routes events by subId, isolates a throwing listener, and unsubscribes after the ack', async () => {
    const ipc = new ScriptedIpc();
    const t = createTransport(ipc);
    const got: unknown[] = [];
    const un1 = t.subscribe({ t: 'notifications' }, () => {
      throw new Error('listener bug');
    });
    t.subscribe({ t: 'wallet.change' }, (p) => got.push(p));
    ipc.emit({ v: 1, subId: 1, payload: 'a' });
    ipc.emit({ v: 1, subId: 2, payload: 'b' });
    ipc.emit({ v: 1, subId: 3, payload: 'nobody' });
    ipc.emit({ junk: true });
    expect(got).toEqual(['b']);
    un1();
    un1();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const unsubs = ipc.sent.filter((s) => s.msg['op'] === 'unsub');
    expect(unsubs).toEqual([{ channel: CHANNEL.sub, msg: { v: 1, op: 'unsub', subId: 1 } }]);
  });

  it('a refused subscription is dropped and never unsubscribed', async () => {
    const ipc = new ScriptedIpc();
    ipc.answer = (_c, m) => ({
      v: 1,
      id: m['subId'],
      ok: false,
      error: { code: 'rate-limited', message: 'rate-limited: x' },
    });
    const t = createTransport(ipc);
    await expect(t.subscribeAcked({ t: 'notifications' }, () => undefined)).rejects.toThrow(
      /backend-down/,
    );
    const un = t.subscribe({ t: 'notifications' }, () => undefined);
    un();
    await Promise.resolve();
    await Promise.resolve();
    expect(ipc.sent.filter((s) => s.msg['op'] === 'unsub')).toHaveLength(0);
  });

  it('grantFile returns only a well-formed token', async () => {
    const ipc = new ScriptedIpc();
    const t = createTransport(ipc);
    ipc.answer = () => ({ v: 1, id: 0, ok: true, result: `nf-file:${'1'.repeat(32)}` });
    await expect(t.grantFile('/a/b.mp4')).resolves.toBe(`nf-file:${'1'.repeat(32)}`);
    expect(ipc.sent.at(-1)).toEqual({ channel: CHANNEL.grant, msg: { v: 1, path: '/a/b.mp4' } });
    ipc.answer = () => ({ v: 1, id: 0, ok: true, result: '/a/b.mp4' });
    expect((await codeOf(t.grantFile('/a/b.mp4'))).code).toBe('internal');
  });

  it('stripUndefined keeps array slots and __proto__ as data', () => {
    const parsed = JSON.parse('{"__proto__": {"x": 1}, "a": 1}') as Record<string, unknown>;
    const out = stripUndefined({
      ...parsed,
      b: undefined,
      c: [undefined, { d: undefined, e: 1 }],
    }) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['__proto__', 'a', 'c']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out['c']).toEqual([undefined, { e: 1 }]);
  });
});

// ---- end to end: preload transport ⇄ real IPC gate ⇄ FakeHost --------------------------------

interface HarnessLike {
  gate: {
    call(e: unknown, raw: unknown): Promise<ReplyMsg>;
    sub(e: unknown, raw: unknown): Promise<ReplyMsg>;
    grant(e: unknown, raw: unknown): Promise<ReplyMsg>;
    stats(wc: number): { calls: number; subs: number };
  };
  host: {
    settled(): Promise<void>;
    tick(): void;
    openSessions(wc?: number): { paused: boolean }[];
    lastUpload: { path: string; name: string; size: number } | undefined;
    rejected: unknown[];
  };
  wc: { sent: { channel: string; msg: EventMsg }[]; send(channel: string, msg: EventMsg): void };
  files: Map<string, unknown>;
  hostOut: HostOut[];
  ev(): unknown;
}

async function mainHarness(
  opts: Record<string, unknown> = {},
): Promise<{ h: HarnessLike; stat: (k: string) => unknown }> {
  // Another TypeScript project: imported at runtime by path, typed structurally.
  const path = '../../main/__tests__/harness.js';
  const mod = (await import(/* @vite-ignore */ path)) as {
    createHarness(o: Record<string, unknown>): HarnessLike;
    fileStat(kind: string, size?: number): unknown;
  };
  return { h: mod.createHarness(opts), stat: (k) => mod.fileStat(k, 2048) };
}

/** `ipcRenderer` wired to the gate with structured clone both ways, events included. */
function ipcFor(h: HarnessLike): IpcRendererLike {
  const listeners: ((e: unknown, m: unknown) => void)[] = [];
  const send = h.wc.send.bind(h.wc);
  h.wc.send = (channel, msg) => {
    send(channel, msg);
    for (const l of listeners) l({}, structuredClone(msg));
  };
  return {
    async invoke(channel, msg) {
      const copy: unknown = structuredClone(msg);
      const r =
        channel === CHANNEL.call
          ? await h.gate.call(h.ev(), copy)
          : channel === CHANNEL.sub
            ? await h.gate.sub(h.ev(), copy)
            : await h.gate.grant(h.ev(), copy);
      return structuredClone(r);
    },
    on(_channel, l) {
      listeners.push(l);
    },
  };
}

describe('preload ⇄ IPC gate ⇄ FakeHost (MockNetworkAdapter)', () => {
  it('reads, Maps as $map, and screen error prefixes survive every hop', async () => {
    const { h } = await mainHarness();
    const b = createBridge(createTransport(ipcFor(h)), {
      pathForFile: () => '',
      randomHex: (n) => '9'.repeat(n * 2),
    });
    expect((await b.video(VIDEO.id))?.id).toBe(VIDEO.id);
    expect(await b.wallet.balances()).toEqual({
      $map: [
        [MINTS.a, 2100],
        [MINTS.b, 0],
      ],
    });
    const status = await b.seeder.status();
    expect(Array.isArray(status.earned.byMint.$map)).toBe(true);
    expect(h.host.rejected).toEqual([]);

    const { h: down } = await mainHarness({ mock: { failWith: 'relay-down' } });
    const bd = createBridge(createTransport(ipcFor(down)), {
      pathForFile: () => '',
      randomHex: (n) => '9'.repeat(n * 2),
    });
    const r = await codeOf(bd.feed({ source: 'trending' }));
    expect(r.code).toBe('relay-down');
    expect(r.message).toMatch(/^relay-down: /);
  });

  it('a session streams spend/peers events, pauses, and closes; the host ends with none open', async () => {
    const { h } = await mainHarness();
    const b = createBridge(createTransport(ipcFor(h)), {
      pathForFile: () => '',
      randomHex: (n) => '9'.repeat(n * 2),
    });
    const s = await b.play(VIDEO.id);
    expect(s.source.url).toMatch(/^nf-media:\/\/play\/tok[0-9a-f]+$/);
    const spend: unknown[] = [];
    s.onSpend((x) => spend.push(x));
    await h.host.settled();
    h.host.tick();
    await h.host.settled();
    expect(spend).toHaveLength(1);
    s.pause();
    await h.host.settled();
    expect(h.host.openSessions(1).map((x) => x.paused)).toEqual([true]);
    await s.close();
    await h.host.settled();
    expect(h.host.openSessions(1)).toHaveLength(0);
    expect(h.gate.stats(1).subs).toBe(0);
    expect(h.hostOut.filter((m) => m.kind === 'media-link').map((m) => m.url === null)).toEqual([
      false,
      true,
    ]);
  });

  it('upload: File → grant → token → HostIn.file; progress arrives; no path crosses the renderer hop', async () => {
    const { h, stat } = await mainHarness();
    h.files.set('/home/u/Videos/clip.mp4', stat('file'));
    const b = createBridge(createTransport(ipcFor(h)), {
      pathForFile: () => '/home/u/Videos/clip.mp4',
      randomHex: (n) => '9'.repeat(n * 2),
    });
    const stages: string[] = [];
    const video = await b.studio.upload(
      {
        file: new File(['x'], 'clip.mp4', { type: 'video/mp4' }),
        title: 'Mine',
        description: '',
        tags: [],
        kind: 21,
        mints: [MINTS.a],
        satsPerBlock: 2 as never,
        split: { seeder: 50, creator: 50 },
      },
      (p) => stages.push(p.stage),
    );
    expect(video.title).toBe('Mine');
    expect(h.host.lastUpload).toEqual({
      path: '/home/u/Videos/clip.mp4',
      name: 'clip.mp4',
      size: 2048,
    });
    expect(stages[0]).toBe('probing');
    expect(stages).toContain('thumbnails');
    expect(stages.at(-1)).toBe('done');
    expect(h.gate.stats(1).subs).toBe(0);
  });

  it('upload of a symlink is refused at the grant with a Studio-readable code', async () => {
    const { h, stat } = await mainHarness();
    h.files.set('/home/u/link.mp4', stat('symlink'));
    const b = createBridge(createTransport(ipcFor(h)), {
      pathForFile: () => '/home/u/link.mp4',
      randomHex: (n) => '9'.repeat(n * 2),
    });
    const r = await codeOf(
      b.studio.upload(
        {
          file: new File(['x'], 'link.mp4'),
          title: 't',
          description: '',
          tags: [],
          kind: 21,
          mints: [MINTS.a],
          satsPerBlock: 2 as never,
          split: { seeder: 50, creator: 50 },
        },
        () => undefined,
      ),
    );
    expect(r.code).toBe('unsupported-input');
  });
});

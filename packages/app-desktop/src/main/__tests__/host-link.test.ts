/**
 * Host supervision (design §1 "supervises host"): `isHostOut` on everything from the host,
 * `backend-down` + respawn on exit within a restart budget, no respawn after quit; plus the
 * redacting logger and main's argv.
 */
import { describe, expect, it } from 'vitest';
import type { HostIn, HostOut } from '../../ipc/protocol.js';
import { hostArgs, parseMainArgs } from '../args.js';
import { HostLink, type HostChild } from '../host-link.js';
import { createLogger, formatLogLine } from '../log.js';

class Child implements HostChild {
  readonly posted: HostIn[] = [];
  readonly handlers = new Map<string, ((x: never) => void)[]>();
  killed = false;
  throwOnPost = false;
  postMessage(msg: HostIn): void {
    if (this.throwOnPost) throw new Error('closed');
    this.posted.push(msg);
  }
  on(event: 'message' | 'exit', listener: (x: never) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
    return this;
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  emit(event: 'message' | 'exit', x: unknown): void {
    for (const l of this.handlers.get(event) ?? []) l(x as never);
  }
}

function link(maxRestarts = 3): {
  l: HostLink;
  children: Child[];
  out: HostOut[];
  events: string[];
  clock: { now: number };
} {
  const children: Child[] = [];
  const out: HostOut[] = [];
  const events: string[] = [];
  const clock = { now: 0 };
  const l = new HostLink({
    spawn: () => {
      const c = new Child();
      children.push(c);
      return c;
    },
    onOut: (m) => out.push(m),
    onDown: () => events.push('down'),
    onRestart: () => events.push('restart'),
    now: () => clock.now,
    maxRestarts,
    windowMs: 60_000,
  });
  return { l, children, out, events, clock };
}

describe('HostLink', () => {
  it('posts to the running host; false when none runs', () => {
    const t = link();
    expect(t.l.post({ kind: 'wc-gone', wc: 1 })).toBe(false);
    t.l.start();
    expect(t.l.post({ kind: 'wc-gone', wc: 1 })).toBe(true);
    expect(t.children[0]?.posted).toEqual([{ kind: 'wc-gone', wc: 1 }]);
    t.children[0]!.throwOnPost = true;
    expect(t.l.post({ kind: 'wc-gone', wc: 1 })).toBe(false);
  });

  it('forwards only messages that pass isHostOut', () => {
    const t = link();
    t.l.start();
    const c = t.children[0]!;
    c.emit('message', {
      kind: 'media-link',
      token: 'tok0123456789abcdef',
      url: 'http://127.0.0.1:1/x',
    });
    for (const bad of [
      { kind: 'media-link', token: 'tok0123456789abcdef', url: 'http://10.0.0.1:1/x' },
      {
        kind: 'reply',
        wc: 1,
        msg: { v: 1, id: 1, ok: false, error: { code: 'nope', message: 'x' } },
      },
      { kind: 'eval', code: '1' },
      'string',
      null,
    ]) {
      c.emit('message', bad);
    }
    expect(t.out).toEqual([
      { kind: 'media-link', token: 'tok0123456789abcdef', url: 'http://127.0.0.1:1/x' },
    ]);
  });

  it('on exit: down, respawn, restart — within the budget', () => {
    const t = link(2);
    t.l.start();
    t.children[0]!.emit('exit', 1);
    expect(t.events).toEqual(['down', 'restart']);
    expect(t.l.running).toBe(true);
    t.children[1]!.emit('exit', 1);
    t.children[2]!.emit('exit', 1);
    expect(t.children).toHaveLength(3);
    expect(t.l.running).toBe(false);
    expect(t.events).toEqual(['down', 'restart', 'down', 'restart', 'down']);
    // The window slides.
    t.clock.now = 61_000;
    t.l.start();
    expect(t.l.running).toBe(true);
  });

  it('a stale child cannot deliver messages or exits', () => {
    const t = link();
    t.l.start();
    const old = t.children[0]!;
    old.emit('exit', 1);
    old.emit('message', { kind: 'media-link', token: 'tok0123456789abcdef', url: null });
    old.emit('exit', 1);
    expect(t.out).toHaveLength(0);
    expect(t.children).toHaveLength(2);
  });

  it('stop kills the host and never respawns it', () => {
    const t = link();
    t.l.start();
    t.l.stop();
    expect(t.children[0]?.killed).toBe(true);
    t.children[0]!.emit('exit', 0);
    expect(t.events).toEqual(['down']);
    t.l.start();
    expect(t.children).toHaveLength(1);
  });
});

describe('redacting logger', () => {
  it('keeps event names and scalar fields only; code must be an ErrorCode', () => {
    expect(formatLogLine('warn', 'gate.refused', { code: 'forbidden', n: 3, ok: true })).toBe(
      '[nutflix-main] warn gate.refused code=forbidden n=3 ok=true',
    );
    const leaky = {
      code: 'nope' as never,
      path: '/home/u/.ssh/id_ed25519' as never,
      url: 'http://127.0.0.1:1/tok' as never,
      'bad key': 1,
      nan: Number.NaN,
    };
    expect(formatLogLine('error', 'host.exit', leaky)).toBe('[nutflix-main] error host.exit');
  });

  it('filters by level and survives a broken writer', () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l), 'warn');
    log('info', 'app.start');
    log('warn', 'host.exit');
    expect(lines).toEqual(['[nutflix-main] warn host.exit']);
    const broken = createLogger(() => {
      throw new Error('EPIPE');
    });
    expect(() => {
      broken('error', 'host.exit');
    }).not.toThrow();
  });
});

describe('main argv', () => {
  it('parses the dev flags and an absolute user-data dir (both spellings)', () => {
    expect(parseMainArgs(['main.js', '--dev-mocks', '--user-data-dir', '/tmp/x'])).toEqual({
      devMocks: true,
      devFixtures: false,
      userDataDir: '/tmp/x',
      e2eHooks: false,
    });
    expect(parseMainArgs(['--user-data-dir=/tmp/y', '--dev-fixtures', '--e2e-hooks'])).toEqual({
      devMocks: false,
      devFixtures: true,
      userDataDir: '/tmp/y',
      e2eHooks: true,
    });
  });

  it('refuses a relative user-data dir and a dangling flag', () => {
    expect(parseMainArgs(['--user-data-dir', 'rel/dir']).userDataDir).toBeUndefined();
    expect(parseMainArgs(['--user-data-dir']).userDataDir).toBeUndefined();
    expect(parseMainArgs(['--user-data-dir', '--dev-mocks']).devMocks).toBe(true);
  });

  it('host args carry userData and only the dev flags', () => {
    expect(hostArgs(parseMainArgs(['--dev-mocks', '--no-sandbox']), '/ud')).toEqual([
      '--user-data=/ud',
      '--dev-mocks',
    ]);
  });
});

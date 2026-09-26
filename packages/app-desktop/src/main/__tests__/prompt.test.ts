/**
 * Main's trusted prompt window (ADR 0013), Electron-free: one window at a time, answers only from
 * THAT window's top frame at `app://prompt`, answers that fit the question, text → bytes (and
 * main's copy wiped), a closed window is a cancel answered once, a host cancel answers nothing.
 */
import { describe, expect, it } from 'vitest';

import type { PromptAnswer, PromptForm } from '../../ipc/protocol.js';
import { PROMPT_CHANNEL } from '../../ipc/protocol.js';
import type { PromptSender, PromptWindowLike } from '../prompt.js';
import { PromptService, isPromptUrl, toPromptAnswer } from '../prompt.js';

class FakeWindow implements PromptWindowLike {
  closed = false;
  private cb: (() => void) | undefined;
  constructor(readonly webContentsId: number) {}
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cb?.();
  }
  onClosed(cb: () => void): void {
    this.cb = cb;
  }
}

function service(): {
  s: PromptService;
  windows: FakeWindow[];
  answers: { req: number; answer: PromptAnswer | null; snapshot: string | null }[];
  logs: string[];
} {
  const windows: FakeWindow[] = [];
  const answers: { req: number; answer: PromptAnswer | null; snapshot: string | null }[] = [];
  const logs: string[] = [];
  let id = 100;
  const s = new PromptService({
    openWindow: () => {
      const w = new FakeWindow(id++);
      windows.push(w);
      return w;
    },
    answer: (req, answer) => {
      // What the host would receive (structured clone happens at post time).
      const bytes =
        answer?.kind === 'secret' ? answer.value : answer?.kind === 'bunker' ? answer.uri : null;
      answers.push({
        req,
        answer,
        snapshot: bytes === null ? null : new TextDecoder().decode(bytes),
      });
    },
    log: (_l, e) => logs.push(e),
  });
  return { s, windows, answers, logs };
}

const from = (w: FakeWindow | undefined, over: Partial<PromptSender> = {}): PromptSender => ({
  senderId: w?.webContentsId ?? -1,
  frameUrl: 'app://prompt/prompt.html',
  topFrame: true,
  ...over,
});

const UNLOCK: PromptForm = { kind: 'unlock-passphrase', retry: false };

describe('PromptService', () => {
  it('channels are the two the prompt preload uses', () => {
    expect(PROMPT_CHANNEL).toEqual({ init: 'nf-prompt:init', answer: 'nf-prompt:answer' });
  });

  it('one window at a time: the next question opens when the first is answered', () => {
    const { s, windows, answers } = service();
    s.ask(1, UNLOCK);
    s.ask(2, { kind: 'new-passphrase' });
    expect(windows).toHaveLength(1);
    expect(s.init(from(windows[0]))).toEqual(UNLOCK);
    expect(s.submit(from(windows[0]), { kind: 'secret', value: 'pass phrase 1' })).toBe(true);
    expect(windows[0]?.closed).toBe(true);
    expect(answers[0]).toMatchObject({ req: 1, snapshot: 'pass phrase 1' });
    expect(windows).toHaveLength(2);
    expect(s.init(from(windows[1]))).toEqual({ kind: 'new-passphrase' });
  });

  it('main wipes its copy of a secret once it is handed over', () => {
    const { s, windows, answers } = service();
    s.ask(1, UNLOCK);
    s.submit(from(windows[0]), { kind: 'secret', value: 'wipe me please' });
    const a = answers[0]?.answer;
    expect(a?.kind).toBe('secret');
    if (a?.kind === 'secret') expect(a.value.every((b) => b === 0)).toBe(true);
    expect(answers[0]?.snapshot).toBe('wipe me please');
  });

  it('refuses every other sender: another webContents, a subframe, another origin', () => {
    const { s, windows, answers, logs } = service();
    s.ask(1, UNLOCK);
    const w = windows[0];
    const good = { kind: 'secret', value: 'x' };
    expect(s.init(from(w, { senderId: 1 }))).toBeNull(); // the app window
    expect(s.submit(from(w, { senderId: 1 }), good)).toBe(false);
    expect(s.submit(from(w, { topFrame: false }), good)).toBe(false);
    expect(s.submit(from(w, { frameUrl: 'app://nutflix/index.html' }), good)).toBe(false);
    expect(s.submit(from(w, { frameUrl: 'app://prompt.evil/prompt.html' }), good)).toBe(false);
    expect(s.submit(from(w, { frameUrl: undefined }), good)).toBe(false);
    expect(answers).toEqual([]);
    expect(w?.closed).toBe(false);
    expect(logs.filter((l) => l === 'prompt.refused-sender')).toHaveLength(6);
  });

  it('an answer that does not fit the question is a cancel (and main wipes it)', () => {
    const { s, windows, answers, logs } = service();
    s.ask(1, { kind: 'local-setup', hasKey: false, keychain: false });
    s.submit(from(windows[0]), { kind: 'local-setup', method: 'keychain', flow: 'generate' });
    expect(answers).toEqual([{ req: 1, answer: null, snapshot: null }]);
    expect(logs).toContain('prompt.bad-answer');
    s.ask(2, { kind: 'create-wallet' });
    s.submit(from(windows[1]), { kind: 'secret', value: 'not an answer to this' });
    expect(answers[1]).toEqual({ req: 2, answer: null, snapshot: null });
    s.ask(3, { kind: 'local-setup', hasKey: true, keychain: true });
    s.submit(from(windows[2]), { kind: 'local-setup', method: 'keychain', flow: 'generate' });
    expect(answers[2]?.answer).toBeNull();
  });

  it('closing the window answers null exactly once; a second submit is ignored', () => {
    const { s, windows, answers } = service();
    s.ask(1, UNLOCK);
    windows[0]?.close();
    expect(answers).toEqual([{ req: 1, answer: null, snapshot: null }]);
    expect(s.submit(from(windows[0]), { kind: 'secret', value: 'late' })).toBe(false);
    expect(answers).toHaveLength(1);
  });

  it('a host cancel closes the window without answering; a queued one just leaves', () => {
    const { s, windows, answers } = service();
    s.ask(1, UNLOCK);
    s.ask(2, { kind: 'import-nsec' });
    s.cancel(2);
    s.cancel(1);
    expect(windows[0]?.closed).toBe(true);
    expect(windows).toHaveLength(1);
    expect(answers).toEqual([]);
  });

  it('cancelAll (the host went away) closes everything and answers nothing', () => {
    const { s, windows, answers } = service();
    s.ask(1, UNLOCK);
    s.ask(2, UNLOCK);
    s.cancelAll();
    expect(windows).toHaveLength(1);
    expect(windows[0]?.closed).toBe(true);
    expect(answers).toEqual([]);
    expect(s.windowId).toBeNull();
  });

  it('a duplicate request id is ignored; the queue is bounded (overflow answered null)', () => {
    const { s, windows, answers } = service();
    s.ask(1, UNLOCK);
    s.ask(1, UNLOCK);
    for (let i = 2; i <= 12; i++) s.ask(i, UNLOCK);
    expect(windows).toHaveLength(1);
    expect(answers.map((a) => a.req)).toEqual([10, 11, 12]);
    expect(answers.every((a) => a.answer === null)).toBe(true);
  });

  it('a window that cannot open answers null and moves on', () => {
    let n = 0;
    const answers: (PromptAnswer | null)[] = [];
    const s = new PromptService({
      openWindow: () => {
        n++;
        if (n === 1) throw new Error('no display');
        return new FakeWindow(7);
      },
      answer: (_r, a) => answers.push(a),
    });
    s.ask(1, UNLOCK);
    s.ask(2, UNLOCK);
    expect(answers).toEqual([null]);
    expect(s.windowId).toBe(7);
  });
});

describe('NIP-46 approval links (ADR 0013 addendum)', () => {
  function withOpener(): { s: PromptService; windows: FakeWindow[]; opened: string[] } {
    const windows: FakeWindow[] = [];
    const opened: string[] = [];
    const s = new PromptService({
      openWindow: () => {
        const w = new FakeWindow(200 + windows.length);
        windows.push(w);
        return w;
      },
      answer: () => undefined,
      openExternal: (u) => opened.push(u),
    });
    return { s, windows, opened };
  }
  const URL_ = 'https://auth.bunker.example/approve?session=1';

  it('main opens the link — its own copy — only on "Open in browser"', () => {
    const { s, windows, opened } = withOpener();
    s.ask(1, { kind: 'bunker-auth', url: URL_ });
    expect(s.submit(from(windows[0]), { kind: 'bunker-auth', open: false })).toBe(true);
    expect(opened).toEqual([]);
    s.ask(2, { kind: 'bunker-auth', url: URL_ });
    s.submit(from(windows[1]), { kind: 'bunker-auth', open: true });
    expect(opened).toEqual([URL_]);
  });

  it('never opens anything for another question, or a link that is not https', () => {
    const { s, windows, opened } = withOpener();
    s.ask(1, { kind: 'create-wallet' });
    s.submit(from(windows[0]), { kind: 'bunker-auth', open: true }); // a misfit: a cancel
    s.ask(2, { kind: 'bunker-auth', url: 'http://auth.example/' } as never); // bypassed the guard
    s.submit(from(windows[1]), { kind: 'bunker-auth', open: true });
    expect(opened).toEqual([]);
  });
});

describe('main’s own question: open an external link (F25)', () => {
  it('shares the queue, never reaches the host, and answers true only for "open"', () => {
    const r = service();
    const done: boolean[] = [];
    expect(r.s.askLink('https://example.com/a', (o) => done.push(o))).toBe(true);
    const w = r.windows[0]!;
    expect(r.s.init(from(w))).toEqual({
      kind: 'open-link',
      url: 'https://example.com/a',
    });
    expect(r.s.submit(from(w), { kind: 'open-link', open: true })).toBe(true);
    expect(done).toEqual([true]);
    expect(r.answers).toEqual([]);
    expect(w.closed).toBe(true);
  });

  it('a close, a malformed answer or a failed window is "do not open"', () => {
    const r = service();
    const done: boolean[] = [];
    r.s.askLink('https://example.com/a', (o) => done.push(o));
    r.windows[0]!.close();
    r.s.askLink('https://example.com/b', (o) => done.push(o));
    r.s.submit(from(r.windows[1]), { kind: 'open-link', open: 'yes' });
    r.s.askLink('https://example.com/c', (o) => done.push(o));
    r.s.submit(from(r.windows[2]), { kind: 'bunker-auth', open: true });
    expect(done).toEqual([false, false, false]);
    expect(r.answers).toEqual([]);
  });

  it('refuses a link main may not open; a host going away leaves main’s question open', () => {
    const r = service();
    expect(r.s.askLink('http://example.com/', () => undefined)).toBe(false);
    expect(r.windows).toHaveLength(0);
    const done: boolean[] = [];
    r.s.askLink('https://example.com/a', (o) => done.push(o));
    r.s.cancelAll();
    expect(r.windows[0]!.closed).toBe(false);
    r.s.submit(from(r.windows[0]), { kind: 'open-link', open: true });
    expect(done).toEqual([true]);
  });
});

describe('issue #2: the first auto top-up into a mint', () => {
  const FORM: PromptForm = {
    kind: 'top-up-first',
    target: 'https://mint-a.example' as never,
    source: 'https://mint-b.example' as never,
    amount: 2_000 as never,
  };

  it('yes and no reach the host; a closed window or a misfitting answer is a cancel (null)', () => {
    const { s, windows, answers } = service();
    s.ask(1, FORM);
    expect(s.init(from(windows[0]))).toEqual(FORM);
    expect(s.submit(from(windows[0]), { kind: 'top-up-first', confirm: true })).toBe(true);
    s.ask(2, FORM);
    s.submit(from(windows[1]), { kind: 'top-up-first', confirm: false });
    s.ask(3, FORM);
    windows[2]!.close();
    s.ask(4, FORM);
    s.submit(from(windows[3]), { kind: 'create-wallet', create: true });
    // Only the prompt window may answer, never the app renderer.
    s.ask(5, FORM);
    expect(
      s.submit(from(windows[4], { frameUrl: 'app://nutflix/index.html' }), {
        kind: 'top-up-first',
        confirm: true,
      }),
    ).toBe(false);
    expect(answers.map((a) => [a.req, a.answer])).toEqual([
      [1, { kind: 'top-up-first', confirm: true }],
      [2, { kind: 'top-up-first', confirm: false }],
      [3, null],
      [4, null],
    ]);
  });
});

describe('toPromptAnswer (the page → the host)', () => {
  it('converts text to UTF-8 bytes and keeps only the known keys', () => {
    const a = toPromptAnswer({ kind: 'secret', value: 'pässword' });
    expect(a?.kind === 'secret' && new TextDecoder().decode(a.value)).toBe('pässword');
    const b = toPromptAnswer({ kind: 'bunker', uri: 'bunker://x', remember: true });
    expect(b).toMatchObject({ kind: 'bunker', remember: true });
    expect(toPromptAnswer({ kind: 'create-wallet', create: false })).toEqual({
      kind: 'create-wallet',
      create: false,
    });
    expect(toPromptAnswer(null)).toBeNull();
  });

  it.each([
    [undefined],
    ['secret'],
    [{ kind: 'secret' }],
    [{ kind: 'secret', value: '' }],
    [{ kind: 'secret', value: 7 }],
    [{ kind: 'secret', value: 'a\u0000b' }],
    [{ kind: 'secret', value: 'x'.repeat(2049) }],
    [{ kind: 'secret', value: 'é'.repeat(1500) }], // > 2048 UTF-8 bytes
    [{ kind: 'secret', value: 'ok', extra: 1 }],
    [{ kind: 'bunker', uri: 'bunker://x' }],
    [{ kind: 'bunker', uri: 'bunker://x', remember: 'yes' }],
    [{ kind: 'local-setup', method: 'keychain' }],
    [{ kind: 'local-setup', method: 'plaintext', flow: 'generate' }],
    [{ kind: 'local-setup', method: 'passphrase', flow: 'export' }],
    [{ kind: 'create-wallet', create: 1 }],
    [{ kind: 'remove-key' }],
    [{ kind: 'remove-key', confirm: 'yes' }],
    [{ kind: 'bunker-auth', open: true, url: 'https://evil.example' }],
    [{ kind: 'top-up-first' }],
    [{ kind: 'top-up-first', confirm: 'yes' }],
    [{ kind: 'top-up-first', confirm: true, amount: 50_000 }],
    [{ kind: 'nip07' }],
  ])('refuses %j', (raw) => {
    expect(toPromptAnswer(raw)).toBeUndefined();
  });

  it('isPromptUrl: exactly the app://prompt origin', () => {
    expect(isPromptUrl('app://prompt/prompt.html')).toBe(true);
    for (const u of [
      'app://nutflix/index.html',
      'app://prompt.x/prompt.html',
      'app://u@prompt/prompt.html',
      'https://prompt/prompt.html',
      'nf-media://prompt/x',
      '',
      42,
    ])
      expect(isPromptUrl(u), String(u)).toBe(false);
  });
});

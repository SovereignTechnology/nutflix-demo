/**
 * ADR 0016 in main, Electron-free:
 *   - the prompt window: content protection is ON before a words question can be fetched, and a
 *     window that cannot be protected is closed without the question (fail closed); recovery
 *     answers carry indices only, a typed phrase must pass main's own checksum re-check, and
 *     main's copy of the indices is zeroed once handed over;
 *   - the host's native confirms (`host-confirm.ts`): every word built by main from guarded data,
 *     Cancel the default, one dialog at a time, an old host's answer dropped; a dialog the host
 *     stopped waiting for (its deadline, a host gone) is closed and its late answer dropped.
 */
import { createHash } from 'node:crypto';

import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { describe, expect, it } from 'vitest';

import type { ConfirmForm, PromptAnswer, PromptForm } from '../../ipc/protocol.js';
import { phraseChecksumOk } from '../../ipc/recovery-checksum.js';
import { HostConfirms, describeHostConfirm } from '../host-confirm.js';
import type { ConfirmPrompt } from '../money-gate.js';
import type { PromptSender, PromptWindowLike } from '../prompt.js';
import { PromptService, showsWords, toPromptAnswer } from '../prompt.js';

const sha256 = (d: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(d).digest());
const checksumOk = (w: readonly number[]): boolean => phraseChecksumOk(w, sha256);
const PHRASE = entropyToMnemonic(new Uint8Array(16).fill(0x7f), wordlist)
  .split(' ')
  .map((w) => wordlist.indexOf(w));
const BAD = [...PHRASE.slice(0, 11), ((PHRASE[11] ?? 0) + 1) % 2048];

interface Win extends PromptWindowLike {
  closed: boolean;
  /** Protection state at each call, in order. */
  readonly protection: boolean[];
}

function service(o: { protect?: 'ok' | 'throws' | 'missing' } = {}) {
  const windows: Win[] = [];
  const answers: { req: number; answer: PromptAnswer | null }[] = [];
  const logs: string[] = [];
  let id = 500;
  const s = new PromptService({
    openWindow: () => {
      let cb: (() => void) | undefined;
      const w: Win = {
        webContentsId: id++,
        closed: false,
        protection: [],
        close() {
          if (w.closed) return;
          w.closed = true;
          cb?.();
        },
        onClosed(f) {
          cb = f;
        },
        ...(o.protect === 'missing'
          ? {}
          : {
              setContentProtection(on: boolean) {
                if (o.protect === 'throws') throw new Error('no compositor');
                w.protection.push(on);
              },
            }),
      };
      windows.push(w);
      return w;
    },
    answer: (req, answer) => {
      // What the host receives is a structured clone taken at post time.
      answers.push({ req, answer: structuredClone(answer) });
    },
    checksumOk,
    log: (_l, e) => logs.push(e),
  });
  return { s, windows, answers, logs };
}

const from = (w: Win | undefined): PromptSender => ({
  senderId: w?.webContentsId ?? -1,
  frameUrl: 'app://prompt/prompt.html',
  topFrame: true,
});

const SHOW: PromptForm = { kind: 'recovery-show', words: [...PHRASE], again: false };

describe('the prompt window with words on screen', () => {
  it.each<PromptForm>([
    SHOW,
    { kind: 'recovery-confirm', positions: [1, 4, 9], retry: false },
    { kind: 'recovery-restore' },
  ])('$kind: protection on before the page can fetch the question', (form) => {
    const { s, windows } = service();
    s.ask(1, form);
    expect(windows[0]?.protection).toEqual([true]);
    expect(s.init(from(windows[0]))).toEqual(form);
  });

  it('main zeroes its copy of a shown phrase once the window is gone (answered, closed or dropped)', () => {
    const { s, windows } = service();
    type Show = Extract<PromptForm, { kind: 'recovery-show' }>;
    const a: Show = { kind: 'recovery-show', words: [...PHRASE], again: false };
    const b: Show = { kind: 'recovery-show', words: [...PHRASE], again: true };
    const c: Show = { kind: 'recovery-show', words: [...PHRASE], again: true };
    s.ask(1, a);
    s.ask(2, b);
    s.ask(3, c);
    s.submit(from(windows[0]), { kind: 'recovery-show', done: true });
    expect(a.words.every((w) => w === 0)).toBe(true);
    s.cancel(3); // still queued: dropped
    expect(c.words.every((w) => w === 0)).toBe(true);
    expect(b.words).toEqual(PHRASE); // on screen now
    windows[1]?.close();
    expect(b.words.every((w) => w === 0)).toBe(true);
  });

  it('other questions are not protected (nothing to hide)', () => {
    const { s, windows } = service();
    s.ask(1, { kind: 'unlock-passphrase', retry: false });
    s.ask(2, { kind: 'recovery-reauth', retry: false });
    expect(windows[0]?.protection).toEqual([]);
    s.submit(from(windows[0]), null);
    expect(windows[1]?.protection).toEqual([]);
    expect(showsWords({ kind: 'recovery-reauth', retry: false })).toBe(false);
  });

  it.each(['throws', 'missing'] as const)(
    'protection %s: the window closes, the question is never served, the host hears a cancel',
    (protect) => {
      const { s, windows, answers, logs } = service({ protect });
      s.ask(7, { kind: 'recovery-show', words: [...PHRASE], again: false });
      expect(windows[0]?.closed).toBe(true);
      expect(s.init(from(windows[0]))).toBeNull();
      expect(answers).toEqual([{ req: 7, answer: null }]);
      expect(logs).toContain('prompt.protection-failed');
      // The queue moves on.
      s.ask(8, { kind: 'unlock-passphrase', retry: false });
      expect(s.init(from(windows[1]))).toEqual({ kind: 'unlock-passphrase', retry: false });
    },
  );

  it('answers: indices through, main’s copy zeroed after the hand-over; text refused', () => {
    const { s, windows, answers, logs } = service();
    s.ask(1, { kind: 'recovery-confirm', positions: [0, 5, 11], retry: false });
    const sent = [PHRASE[0], PHRASE[5], PHRASE[11]];
    const raw = { kind: 'recovery-confirm', words: [...sent] };
    expect(s.submit(from(windows[0]), raw)).toBe(true);
    expect(answers[0]).toEqual({ req: 1, answer: { kind: 'recovery-confirm', words: sent } });
    // Main copied the page's array: the page's object is untouched, main's own copy is gone.
    expect(raw.words).toEqual(sent);
    s.ask(2, { kind: 'recovery-confirm', positions: [0, 5, 11], retry: false });
    s.submit(from(windows[1]), { kind: 'recovery-confirm', words: ['legal', 'winner', 'thank'] });
    expect(answers[1]).toEqual({ req: 2, answer: null });
    expect(logs).toContain('prompt.bad-answer');
  });

  it('main zeroes ITS copy of the indices once the host has its clone', () => {
    const held: PromptAnswer[] = [];
    let cb: (() => void) | undefined;
    const s = new PromptService({
      openWindow: () => ({
        webContentsId: 9,
        close: () => cb?.(),
        onClosed: (f) => {
          cb = f;
        },
        setContentProtection: () => undefined,
      }),
      answer: (_req, a) => {
        if (a !== null) held.push(a);
      },
      checksumOk,
    });
    s.ask(1, { kind: 'recovery-restore' });
    s.submit(
      { senderId: 9, frameUrl: 'app://prompt/p.html', topFrame: true },
      {
        kind: 'recovery-restore',
        words: [...PHRASE],
      },
    );
    const a = held[0];
    expect(a?.kind === 'recovery-restore' && a.words.every((w) => w === 0)).toBe(true);
  });

  it('restore: a typed phrase must pass main’s checksum; none ([]) is fine; words as text are refused', () => {
    const { s, windows, answers } = service();
    s.ask(1, { kind: 'recovery-restore' });
    s.submit(from(windows[0]), { kind: 'recovery-restore', words: BAD });
    s.ask(2, { kind: 'recovery-restore' });
    s.submit(from(windows[1]), { kind: 'recovery-restore', words: [...PHRASE] });
    s.ask(3, { kind: 'recovery-restore' });
    s.submit(from(windows[2]), { kind: 'recovery-restore', words: [] });
    s.ask(4, { kind: 'recovery-restore' });
    s.submit(from(windows[3]), {
      kind: 'recovery-restore',
      words: PHRASE.map((i) => wordlist[i]).join(' '),
    });
    expect(answers).toEqual([
      { req: 1, answer: null },
      { req: 2, answer: { kind: 'recovery-restore', words: PHRASE } },
      { req: 3, answer: { kind: 'recovery-restore', words: [] } },
      { req: 4, answer: null },
    ]);
  });

  // Independent review IR4 (ADR 0016 §5.1): the mint addresses typed in the restore window.
  it('restore: typed mint addresses pass through main’s own guard (https, normalised, 1..8), never loosely', () => {
    const MINT = 'https://mint.typed.example';
    expect(toPromptAnswer({ kind: 'recovery-restore', words: [], mints: [MINT] })).toEqual({
      kind: 'recovery-restore',
      words: [],
      mints: [MINT],
    });
    expect(
      toPromptAnswer(
        { kind: 'recovery-restore', words: [...PHRASE], mints: [MINT, 'https://b.example:3338'] },
        { checksumOk },
      ),
    ).toEqual({
      kind: 'recovery-restore',
      words: PHRASE,
      mints: [MINT, 'https://b.example:3338'],
    });
    const nine = Array.from({ length: 9 }, (_, i) => `https://m${String(i)}.example`);
    for (const mints of [
      [],
      nine,
      ['http://mint.typed.example'],
      ['https://mint.typed.example/?q=1'],
      ['https://mint.typed.example/'],
      ['legal winner thank'],
      [42],
      MINT,
      null,
    ])
      expect(
        toPromptAnswer({ kind: 'recovery-restore', words: [], mints }),
        JSON.stringify(mints),
      ).toBeUndefined();
    // A bad mint list refuses the whole answer, typed phrase included.
    expect(
      toPromptAnswer(
        { kind: 'recovery-restore', words: [...PHRASE], mints: ['http://x.example'] },
        { checksumOk },
      ),
    ).toBeUndefined();
    // Main's copy is its own array (the page's cannot change it afterwards).
    const pageMints = [MINT];
    const a = toPromptAnswer({ kind: 'recovery-restore', words: [], mints: pageMints });
    pageMints[0] = 'https://evil.example';
    expect(a).toEqual({ kind: 'recovery-restore', words: [], mints: [MINT] });
  });

  it('toPromptAnswer: exact keys, indices only, no checksum function = every typed phrase refused', () => {
    expect(toPromptAnswer({ kind: 'recovery-show', done: true })).toEqual({
      kind: 'recovery-show',
      done: true,
    });
    expect(toPromptAnswer({ kind: 'recovery-show', done: true, extra: 1 })).toBeUndefined();
    expect(toPromptAnswer({ kind: 'recovery-show', done: 'yes' })).toBeUndefined();
    expect(toPromptAnswer({ kind: 'recovery-restore', words: PHRASE })).toBeUndefined();
    expect(toPromptAnswer({ kind: 'recovery-restore', words: [] })).toEqual({
      kind: 'recovery-restore',
      words: [],
    });
    expect(toPromptAnswer({ kind: 'recovery-restore', words: PHRASE }, { checksumOk })).toEqual({
      kind: 'recovery-restore',
      words: PHRASE,
    });
    expect(
      toPromptAnswer({ kind: 'recovery-restore', words: PHRASE.slice(1) }, { checksumOk }),
    ).toBeUndefined();
    expect(toPromptAnswer({ kind: 'recovery-confirm', words: [1, 2, 2048] })).toBeUndefined();
    expect(toPromptAnswer({ kind: 'recovery-confirm', words: [1, 2, 3.5] })).toBeUndefined();
    expect(
      toPromptAnswer({ kind: 'recovery-confirm', words: Object.assign([1, 2, 3], { extra: 'x' }) }),
    ).toEqual({ kind: 'recovery-confirm', words: [1, 2, 3] });
  });
});

describe('the host’s native confirms (host-confirm.ts)', () => {
  const REISSUE = {
    kind: 'recovery-reissue',
    plans: [
      { mint: 'https://mint.one.example/cashu/api?x=SECRET', amount: 1_500, inputs: 6, feeSats: 3 },
      { mint: 'https://two.example:3338', amount: 1, inputs: 1, feeSats: 0 },
    ],
  } as unknown as ConfirmForm;

  it('the reissue dialog names totals, fees and hosts only (no path, no query)', () => {
    const p = describeHostConfirm(REISSUE);
    expect(p.message).toBe(
      'Move 1,501 sats under your recovery phrase? The mints charge 3 sats in fees.',
    );
    expect(p.detail).toContain('mint.one.example: 1,500 sats, fee 3 sats');
    expect(p.detail).toContain('two.example:3338: 1 sat, fee 0 sats');
    expect(p.detail).toContain('You keep 1,498 sats.');
    expect(`${p.title}${p.message}${p.detail}${p.confirmLabel}`).not.toMatch(/SECRET|cashu\/api/);
    expect(p.confirmLabel).toBe('Move it (fee 3 sats)');
  });

  it('a look-alike host is shown as punycode', () => {
    const p = describeHostConfirm({
      kind: 'recovery-reissue',
      plans: [{ mint: 'https://mіnt.example', amount: 10, inputs: 1, feeSats: 1 }], // a Cyrillic "і"
    } as unknown as ConfirmForm);
    expect(p.detail).toMatch(/xn--/);
  });

  it('the reveal dialog warns about onlookers and recordings', () => {
    const p = describeHostConfirm({ kind: 'recovery-reveal' });
    expect(p.detail).toMatch(/recording or sharing your screen/);
    expect(p.confirmLabel).toBe('Show phrase');
  });

  // Independent review IR8: a rotation is worded as the destructive step it is.
  it('the rotate dialog says the phrase is replaced (not shown), with the fee to come', () => {
    const p = describeHostConfirm({ kind: 'recovery-rotate' });
    expect(p.title).toBe('Replace recovery phrase');
    expect(p.message).toMatch(/^Replace your recovery phrase/);
    expect(p.detail).toMatch(/fee is shown first/);
    expect(p.confirmLabel).toBe('Replace phrase');
    expect(`${p.title}${p.message}${p.confirmLabel}`).not.toMatch(/Show/);
  });

  it('true only for the confirm button; one dialog at a time; a failed dialog is no', async () => {
    const asked: ConfirmPrompt[] = [];
    const answers: [number, boolean][] = [];
    const logs: string[] = [];
    let resolveAsk: (v: unknown) => void = () => undefined;
    const c = new HostConfirms({
      ask: (p) => {
        asked.push(p);
        return new Promise((r) => {
          resolveAsk = r;
        });
      },
      answer: (req, ok) => answers.push([req, ok]),
      log: (_l, e) => logs.push(e),
    });
    c.ask(1, REISSUE);
    c.ask(2, { kind: 'recovery-reveal' }); // busy → no, at once
    expect(answers).toEqual([[2, false]]);
    expect(logs).toContain('confirm.busy');
    await Promise.resolve();
    resolveAsk('yes'); // anything but `true` is no
    await new Promise((r) => setTimeout(r, 0));
    expect(answers).toEqual([
      [2, false],
      [1, false],
    ]);
    c.ask(3, { kind: 'recovery-reveal' });
    await Promise.resolve();
    resolveAsk(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(answers.at(-1)).toEqual([3, true]);
    const failing = new HostConfirms({
      ask: () => Promise.reject(new Error('no display')),
      answer: (req, ok) => answers.push([req, ok]),
      log: (_l, e) => logs.push(e),
    });
    failing.ask(4, { kind: 'recovery-reveal' });
    await new Promise((r) => setTimeout(r, 0));
    expect(answers.at(-1)).toEqual([4, false]);
    expect(logs).toContain('confirm.failed');
  });

  it('an answer for a host that went away is dropped', async () => {
    const answers: [number, boolean][] = [];
    let resolveAsk: (v: unknown) => void = () => undefined;
    const c = new HostConfirms({
      ask: () =>
        new Promise((r) => {
          resolveAsk = r;
        }),
      answer: (req, ok) => answers.push([req, ok]),
    });
    c.ask(1, { kind: 'recovery-reveal' });
    await Promise.resolve();
    c.hostGone();
    resolveAsk(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(answers).toEqual([]);
    // The next host's question gets a dialog again.
    c.ask(1, { kind: 'recovery-reveal' });
    await Promise.resolve();
    resolveAsk(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(answers).toEqual([[1, true]]);
  });

  // Round 8 (final panel, packaging): the host's confirm deadline passed, and main's dialog
  // stayed up. A later "Move it" answered a question nobody was asking any more, and until it
  // was dismissed every other host confirm was refused ('confirm.busy').
  describe('a confirm the host stopped waiting for (confirm-cancel, host gone)', () => {
    interface Shown {
      readonly signal: AbortSignal;
      readonly answer: (v: unknown) => void;
    }
    function rig(): {
      c: HostConfirms;
      shown: Shown[];
      answers: [number, boolean][];
      logs: string[];
    } {
      const shown: Shown[] = [];
      const answers: [number, boolean][] = [];
      const logs: string[] = [];
      const c = new HostConfirms({
        // Like Electron's dialog: open until answered; an aborted `signal` closes it as a cancel.
        ask: (_p, signal) =>
          new Promise((resolve) => {
            shown.push({ signal, answer: resolve });
            signal.addEventListener('abort', () => {
              resolve(false);
            });
          }),
        answer: (req, ok) => answers.push([req, ok]),
        log: (_l, e) => logs.push(e),
      });
      return { c, shown, answers, logs };
    }
    const settle = (): Promise<void> =>
      new Promise((r) => {
        setTimeout(r, 0);
      });

    it('confirm-cancel closes the dialog (its signal aborts) and sends no answer', async () => {
      const { c, shown, answers } = rig();
      c.ask(7, { kind: 'recovery-reveal' });
      await settle();
      expect(shown).toHaveLength(1);
      expect(shown[0]?.signal.aborted).toBe(false);
      c.cancel(7);
      expect(shown[0]?.signal.aborted).toBe(true);
      await settle();
      expect(answers).toEqual([]);
    });

    it('a dialog that could not be closed: its late answer is dropped, and the next confirm is not refused', async () => {
      const shown: ((v: unknown) => void)[] = [];
      const answers: [number, boolean][] = [];
      const logs: string[] = [];
      // A dialog that ignores its signal (macOS runs a parentless message box synchronously).
      const c = new HostConfirms({
        ask: () =>
          new Promise((resolve) => {
            shown.push(resolve);
          }),
        answer: (req, ok) => answers.push([req, ok]),
        log: (_l, e) => logs.push(e),
      });
      c.ask(7, REISSUE);
      await settle();
      c.cancel(7);
      c.ask(8, { kind: 'recovery-reveal' });
      await settle();
      expect(logs).not.toContain('confirm.busy');
      expect(shown).toHaveLength(2);
      shown[0]?.(true); // "Move it", clicked after the host gave up
      await settle();
      expect(answers).toEqual([]);
      shown[1]?.(true);
      await settle();
      expect(answers).toEqual([[8, true]]);
    });

    it('a cancel for another request (or none open) changes nothing', async () => {
      const { c, shown, answers } = rig();
      c.cancel(1);
      c.ask(2, { kind: 'recovery-reveal' });
      await settle();
      c.cancel(1);
      c.cancel(3);
      expect(shown[0]?.signal.aborted).toBe(false);
      shown[0]?.answer(true);
      await settle();
      expect(answers).toEqual([[2, true]]);
      c.cancel(2); // already answered
      await settle();
      expect(answers).toEqual([[2, true]]);
    });

    it('the host going away closes its dialog, and a restarted host’s confirm gets one at once', async () => {
      const { c, shown, answers, logs } = rig();
      c.ask(1, { kind: 'recovery-reveal' });
      await settle();
      c.hostGone();
      expect(shown[0]?.signal.aborted).toBe(true);
      // The new host numbers its requests from 1 again; asked before the old dialog settles.
      c.ask(1, { kind: 'recovery-rotate' });
      expect(logs).not.toContain('confirm.busy');
      expect(answers).toEqual([]);
      await settle();
      expect(shown).toHaveLength(2);
      expect(shown[1]?.signal.aborted).toBe(false);
      shown[1]?.answer(true);
      await settle();
      expect(answers).toEqual([[1, true]]);
    });
  });
});

// @vitest-environment jsdom
/**
 * ADR 0016 in main's trusted prompt page: the words come from the page's OWN bundled BIP-39
 * English list, looked up from the indices the question carries (never text); they cannot be
 * copied, hide after two minutes or when the window loses focus, and leave the DOM when the
 * answer is sent. Typed words leave the page as indices; a typed phrase must carry a valid
 * checksum; the page refuses any recovery question that is not exactly indices / positions.
 * Round 8: the matching words offered while typing are drawn in the page itself, never in an
 * OS-drawn popup (a `<datalist>`). (That `hidden` hides whatever the stylesheet says is pinned
 * in src/main/__tests__/bundle.test.ts, on the stylesheet that ships.)
 */
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isMintUrl } from '../../ipc/guards.js';
import type { PromptForm } from '../../ipc/protocol.js';
import { BIP39_LIST_SIZE, LIMITS, MAX_RESTORE_MINTS, RECOVERY_WORDS } from '../../ipc/protocol.js';
import {
  MAX_MINT_URL,
  PHRASE_WORDS,
  RESTORE_MINTS,
  SUGGESTIONS,
  WORDS,
  WORDS_VISIBLE_MS,
  isForm,
  mintAddress,
  mount,
  phraseValid,
  suggestWords,
  wordIndex,
} from '../prompt/prompt.js';

const PHRASE = entropyToMnemonic(new Uint8Array(16).fill(0x7f), wordlist)
  .split(' ')
  .map((w) => wordlist.indexOf(w));
const TEXT = PHRASE.map((i) => wordlist[i] ?? '');

let root: HTMLElement = document.createElement('main');
afterEach(() => {
  root.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function show(q: PromptForm): { sent: unknown[] } {
  root = document.createElement('main');
  document.body.appendChild(root);
  const sent: unknown[] = [];
  mount(
    root,
    { question: () => Promise.resolve(q), answer: (a) => (sent.push(a), Promise.resolve(true)) },
    q,
  );
  return { sent };
}
const find = (sel: string): Element => {
  const e = root.querySelector(sel);
  if (e === null) throw new Error(`missing ${sel}`);
  return e;
};
const button = (label: string): HTMLButtonElement => {
  const b = [...root.querySelectorAll('button')].find((x) => x.textContent === label);
  if (b === undefined) throw new Error(`no button ${label}`);
  return b;
};
const submit = (): void => {
  (find('form') as HTMLFormElement).requestSubmit();
};
const shownWords = (): string[] =>
  [...root.querySelectorAll('.words__w')].map((e) => e.textContent);

describe('pins', () => {
  it('the page list is BIP-39 English; 12 words; two minutes', () => {
    expect(PHRASE_WORDS).toBe(RECOVERY_WORDS);
    expect(WORDS.length).toBe(BIP39_LIST_SIZE);
    expect(WORDS[0]).toBe('abandon');
    expect(WORDS[2047]).toBe('zoo');
    expect(WORDS_VISIBLE_MS).toBe(120_000);
  });

  it('wordIndex: exact words and unique 4-letter prefixes, case- and space-insensitive', () => {
    expect(wordIndex('abandon')).toBe(0);
    expect(wordIndex('  ZOO ')).toBe(2047);
    expect(wordIndex('aban')).toBe(0);
    expect(wordIndex('aba')).toBeUndefined();
    expect(wordIndex('notaword')).toBeUndefined();
    expect(wordIndex('')).toBeUndefined();
    expect(phraseValid(PHRASE)).toBe(true);
    expect(phraseValid([...PHRASE.slice(0, 11), ((PHRASE[11] ?? 0) + 1) % 2048])).toBe(false);
    expect(phraseValid(PHRASE.slice(1))).toBe(false);
  });
});

describe('recovery-show', () => {
  it('shows the 12 words in order from the page’s own list, numbered, with no way to copy them', () => {
    const { sent } = show({ kind: 'recovery-show', words: PHRASE, again: false });
    expect(shownWords()).toEqual(TEXT);
    expect([...root.querySelectorAll('.words__n')].map((e) => e.textContent)).toEqual(
      Array.from({ length: 12 }, (_, i) => `${String(i + 1)}.`),
    );
    expect([...root.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Copy');
    expect(root.textContent).not.toMatch(/\bcopy\b/i);
    const copy = new Event('copy', { bubbles: true, cancelable: true });
    find('.words').dispatchEvent(copy);
    expect(copy.defaultPrevented).toBe(true);
    const menu = new Event('contextmenu', { bubbles: true, cancelable: true });
    find('.words').dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(sent).toEqual([]);
  });

  it('"I wrote them down" answers done; the words leave the DOM once sent', () => {
    const { sent } = show({ kind: 'recovery-show', words: PHRASE, again: false });
    submit();
    expect(sent).toEqual([{ kind: 'recovery-show', done: true }]);
    expect(shownWords()).toEqual([]);
    for (const w of TEXT) expect(root.textContent).not.toContain(` ${w} `);
  });

  it('"Later" keeps it unconfirmed; Cancel / Escape discard (null)', () => {
    const a = show({ kind: 'recovery-show', words: PHRASE, again: false });
    button('Later').click();
    expect(a.sent).toEqual([{ kind: 'recovery-show', done: false }]);
    root.remove();
    const b = show({ kind: 'recovery-show', words: PHRASE, again: false });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(b.sent).toEqual([null]);
  });

  it('hide after two minutes (out of the DOM, not just out of sight); "Show the words" brings them back', () => {
    vi.useFakeTimers();
    show({ kind: 'recovery-show', words: PHRASE, again: false });
    expect(shownWords()).toHaveLength(12);
    vi.advanceTimersByTime(WORDS_VISIBLE_MS - 1);
    expect(shownWords()).toHaveLength(12);
    vi.advanceTimersByTime(1);
    expect(shownWords()).toEqual([]);
    expect((find('.words') as HTMLElement).hidden).toBe(true);
    expect(root.textContent).toContain('The words are hidden.');
    button('Show the words').click();
    expect(shownWords()).toEqual(TEXT);
  });

  it('hide when the window loses focus', () => {
    show({ kind: 'recovery-show', words: PHRASE, again: false });
    window.dispatchEvent(new Event('blur'));
    expect(shownWords()).toEqual([]);
  });

  it('shown again: its own title, no "Later", "Close" instead of Cancel', () => {
    show({ kind: 'recovery-show', words: PHRASE, again: true });
    expect(find('h1').textContent).toBe('Your recovery phrase');
    expect([...root.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Later');
    expect(button('Close')).toBeDefined();
  });

  it('on Linux the page says it cannot keep the window out of screen captures', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)');
    show({ kind: 'recovery-show', words: PHRASE, again: false });
    expect(root.textContent).toMatch(/On Linux this window cannot be kept out of screenshots/);
    root.remove();
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0)');
    show({ kind: 'recovery-show', words: PHRASE, again: false });
    expect(root.textContent).not.toMatch(/On Linux/);
  });
});

describe('recovery-confirm', () => {
  it('asks the named positions; words (or unique prefixes) leave as indices; fields cleared', () => {
    const { sent } = show({ kind: 'recovery-confirm', positions: [0, 5, 11], retry: false });
    const labels = [...root.querySelectorAll('label')].map((l) => l.textContent);
    expect(labels).toEqual(['Word 1', 'Word 6', 'Word 12']);
    const fields = [...root.querySelectorAll<HTMLInputElement>('input')];
    expect(fields.every((f) => f.getAttribute('autocomplete') === 'off')).toBe(true);
    // Round 8 (final panel): this used to pin a `<datalist>` of all 2048 words. Chromium draws a
    // datalist's suggestions in a popup window of its own, which the prompt window's content
    // protection does not cover on macOS, so a screen capture saw each typed word. The page
    // now draws its own suggestions ("word suggestions" below).
    expect(root.querySelector('datalist')).toBeNull();
    fields[0]!.value = TEXT[0] ?? '';
    fields[1]!.value = 'bogus';
    fields[2]!.value = (TEXT[11] ?? '').slice(0, 4).toUpperCase();
    submit();
    expect(sent).toEqual([]);
    expect(find('.error[role="alert"]').textContent).toMatch(/word from the list/);
    fields[1]!.value = TEXT[5] ?? '';
    submit();
    expect(sent).toEqual([{ kind: 'recovery-confirm', words: [PHRASE[0], PHRASE[5], PHRASE[11]] }]);
    expect(fields.map((f) => f.value)).toEqual(['', '', '']);
  });

  it('says when the last try did not match; "Later" is the cancel (null)', () => {
    const { sent } = show({ kind: 'recovery-confirm', positions: [1, 2, 3], retry: true });
    expect(root.textContent).toMatch(/do not match your phrase/);
    button('Later').click();
    expect(sent).toEqual([null]);
  });
});

describe('recovery-restore', () => {
  const fields = (): HTMLInputElement[] => [...root.querySelectorAll<HTMLInputElement>('input')];

  it('twelve empty fields restore without a typed phrase ([])', () => {
    const { sent } = show({ kind: 'recovery-restore' });
    expect(fields()).toHaveLength(12);
    submit();
    expect(sent).toEqual([{ kind: 'recovery-restore', words: [] }]);
  });

  it('partial, unknown and bad-checksum phrases are refused on the page; a valid one leaves as indices and the fields clear', () => {
    const { sent } = show({ kind: 'recovery-restore' });
    const f = fields();
    f[0]!.value = TEXT[0] ?? '';
    submit();
    expect(find('.error[role="alert"]').textContent).toMatch(/all 12 words/);
    f.forEach((x, i) => {
      x.value = TEXT[i] ?? '';
    });
    f[3]!.value = 'bogus';
    submit();
    expect(find('.error[role="alert"]').textContent).toMatch(/Word 4 is not a word/);
    f[3]!.value = TEXT[3] ?? '';
    f[11]!.value = wordlist[((PHRASE[11] ?? 0) + 1) % 2048] ?? '';
    submit();
    expect(find('.error[role="alert"]').textContent).toMatch(/not a valid recovery phrase/);
    expect(sent).toEqual([]);
    f[11]!.value = TEXT[11] ?? '';
    submit();
    expect(sent).toEqual([{ kind: 'recovery-restore', words: PHRASE }]);
    expect(f.every((x) => x.value === '')).toBe(true);
  });

  // Independent review IR4 (ADR 0016 §5.1): the words do not say which mints were used.
  describe('typed mint addresses', () => {
    // By tag, not id: a test that mounts twice leaves the first page in the document, and a
    // duplicate id defeats jsdom's scoped `#id` lookup.
    const box = (): HTMLTextAreaElement => find('textarea') as HTMLTextAreaElement;

    it('the page’s normaliser agrees with the IPC guard (https only, no query or user-info, no trailing slash)', () => {
      expect(RESTORE_MINTS).toBe(MAX_RESTORE_MINTS);
      expect(MAX_MINT_URL).toBe(LIMITS.maxServerUrl);
      const cases: [string, string | undefined][] = [
        ['https://mint.example', 'https://mint.example'],
        ['  https://Mint.Example/  ', 'https://mint.example'],
        ['HTTPS://mint.example:3338/cashu/', 'https://mint.example:3338/cashu'],
        ['mint.example', undefined],
        ['mint.example:3338/cashu/', undefined],
        ['https://mint.example/#frag', 'https://mint.example'],
        // A look-alike (Cyrillic "і") host leaves as punycode (checked below).
        ['https://mіnt.example', 'https://xn--mnt-jhd.example'],
        ['http://mint.example', undefined],
        ['ws://mint.example', undefined],
        ['https://mint.example/?token=1', undefined],
        ['https://user:pw@mint.example', undefined],
        ['javascript:alert(1)', undefined],
        ['https://', undefined],
        ['legal winner thank', undefined],
        [`https://${'a'.repeat(600)}.example`, undefined],
        ['', undefined],
      ];
      for (const [typed, want] of cases) {
        const got = mintAddress(typed);
        expect(got, typed).toBe(want);
        if (got !== undefined) expect(isMintUrl(got), got).toBe(true);
      }
    });

    it('sent normalised and once each, with or without a typed phrase (an empty box sends no `mints`: see “twelve empty fields”)', () => {
      const first = show({ kind: 'recovery-restore' });
      box().value = 'https://a.example\n https://mint.b.example:3338/ , https://A.example';
      submit();
      expect(first.sent).toEqual([
        {
          kind: 'recovery-restore',
          words: [],
          mints: ['https://a.example', 'https://mint.b.example:3338'],
        },
      ]);
      const second = show({ kind: 'recovery-restore' });
      fields().forEach((x, i) => {
        x.value = TEXT[i] ?? '';
      });
      box().value = 'https://a.example';
      submit();
      expect(second.sent).toEqual([
        { kind: 'recovery-restore', words: PHRASE, mints: ['https://a.example'] },
      ]);
    });

    it('an http, query-carrying or junk address, or too many, is refused on the page without repeating it', () => {
      const { sent } = show({ kind: 'recovery-restore' });
      box().value = 'https://ok.example\nhttp://plain.example';
      submit();
      const err = find('.error[role="alert"]').textContent;
      expect(err).toMatch(/Mint address 2 is not an https address/);
      expect(err).not.toContain('plain.example');
      box().value = 'legal winner thank year';
      submit();
      expect(find('.error[role="alert"]').textContent).not.toMatch(/legal|winner/);
      box().value = Array.from(
        { length: RESTORE_MINTS + 1 },
        (_, i) => `https://m${String(i)}.example`,
      ).join(' ');
      submit();
      expect(find('.error[role="alert"]').textContent).toMatch(/at most 8 mint addresses/);
      expect(sent).toEqual([]);
    });
  });

  it('pasting a whole phrase into one field spreads it over the fields', () => {
    show({ kind: 'recovery-restore' });
    const f = fields();
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
      clipboardData: { getData: () => string };
    };
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => TEXT.join('  \n ') } });
    f[0]!.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    expect(f.map((x) => x.value)).toEqual(TEXT);
  });
});

describe('recovery-reauth', () => {
  it('a passphrase field (password type), sent as a secret, cleared', () => {
    const { sent } = show({ kind: 'recovery-reauth', retry: true });
    expect(root.textContent).toMatch(/Wrong passphrase/);
    submit();
    expect(sent).toEqual([]);
    const p = find('#pass') as HTMLInputElement;
    expect(p.type).toBe('password');
    p.value = 'my passphrase';
    submit();
    expect(sent).toEqual([{ kind: 'secret', value: 'my passphrase' }]);
    expect(p.value).toBe('');
  });
});

describe('the page refuses recovery questions that are not indices / positions', () => {
  it.each<[string, unknown]>([
    ['words as text', { kind: 'recovery-show', words: TEXT, again: false }],
    ['eleven indices', { kind: 'recovery-show', words: PHRASE.slice(1), again: false }],
    [
      'an index past the list',
      { kind: 'recovery-show', words: [...PHRASE.slice(1), 2048], again: false },
    ],
    ['a fraction', { kind: 'recovery-show', words: [...PHRASE.slice(1), 0.5], again: false }],
    [
      'extra prose',
      { kind: 'recovery-show', words: PHRASE, again: false, note: 'go to x.example' },
    ],
    ['no `again`', { kind: 'recovery-show', words: PHRASE }],
    ['unsorted positions', { kind: 'recovery-confirm', positions: [5, 1, 9], retry: false }],
    ['a position past 11', { kind: 'recovery-confirm', positions: [1, 2, 12], retry: false }],
    ['four positions', { kind: 'recovery-confirm', positions: [1, 2, 3, 4], retry: false }],
    ['a restore carrying words', { kind: 'recovery-restore', words: PHRASE }],
    ['a reauth with prose', { kind: 'recovery-reauth', retry: false, text: 'x' }],
  ])('%s', (_what, q) => {
    expect(isForm(q)).toBe(false);
  });

  it('accepts exactly the guarded shapes', () => {
    expect(isForm({ kind: 'recovery-show', words: PHRASE, again: true })).toBe(true);
    expect(isForm({ kind: 'recovery-confirm', positions: [0, 1, 11], retry: false })).toBe(true);
    expect(isForm({ kind: 'recovery-restore' })).toBe(true);
    expect(isForm({ kind: 'recovery-reauth', retry: false })).toBe(true);
  });
});

// Round 8 (final panel, packaging): a `<datalist>` is drawn by Chromium in its own popup window,
// outside the prompt window's content protection on macOS, so typing a word showed it (narrowed
// to one match) to anything capturing the screen. The page now draws the matching words itself,
// inside the protected window, from its own bundled list.
describe('word suggestions: drawn in the page, never an OS popup', () => {
  const words = (): HTMLInputElement[] => [
    ...root.querySelectorAll<HTMLInputElement>('input[type="text"]'),
  ];
  const type = (f: HTMLInputElement, text: string): void => {
    f.focus();
    f.value = text;
    f.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const key = (f: HTMLElement, k: string): KeyboardEvent => {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    f.dispatchEvent(e);
    return e;
  };
  const listbox = (): HTMLElement => find('[role="listbox"]') as HTMLElement;
  const options = (): string[] =>
    [...root.querySelectorAll('[role="listbox"] [role="option"]')].map((o) => o.textContent);
  const selected = (): string[] =>
    [...root.querySelectorAll('[role="option"][aria-selected="true"]')].map((o) => o.textContent);
  const matching = (prefix: string): string[] =>
    WORDS.filter((w) => w.startsWith(prefix)).slice(0, SUGGESTIONS);

  it('suggestWords: the page list’s words that start with the typed text, in list order, at most SUGGESTIONS', () => {
    expect(SUGGESTIONS).toBe(6);
    expect(suggestWords('leg')).toEqual(['leg', 'legal', 'legend']);
    expect(suggestWords('  ACT ')).toEqual(['act', 'action', 'actor', 'actress', 'actual']);
    expect(suggestWords('a')).toEqual(matching('a'));
    expect(suggestWords('a')).toHaveLength(SUGGESTIONS);
    expect(suggestWords('lega')).toEqual(['legal']);
    // Nothing to offer: no match, nothing typed, or the one match is what was typed.
    expect(suggestWords('x')).toEqual([]);
    expect(suggestWords('')).toEqual([]);
    expect(suggestWords('zoo')).toEqual([]);
  });

  it.each<[string, PromptForm]>([
    ['confirm', { kind: 'recovery-confirm', positions: [0, 5, 11], retry: false }],
    ['restore', { kind: 'recovery-restore' }],
  ])(
    '%s: no datalist, select or list= anywhere; each word field is a combobox over a listbox in the page',
    (_what, q) => {
      show(q);
      expect(document.querySelector('datalist, select, [list]')).toBeNull();
      const lb = listbox();
      expect(root.contains(lb)).toBe(true);
      expect(lb.id).not.toBe('');
      expect(lb.hidden).toBe(true);
      expect(root.querySelectorAll('[role="listbox"]')).toHaveLength(1);
      for (const f of words()) {
        expect(f.getAttribute('role')).toBe('combobox');
        expect(f.getAttribute('aria-autocomplete')).toBe('list');
        expect(f.getAttribute('aria-expanded')).toBe('false');
        expect(f.getAttribute('aria-controls')).toBe(lb.id);
        expect(f.getAttribute('autocomplete')).toBe('off');
      }
      // Every field in a words window is a plain text box (or the mint textarea).
      for (const i of root.querySelectorAll('input')) expect(i.type).toBe('text');
    },
  );

  it('typing shows the matching words of the page’s own list, under the field being typed in', () => {
    show({ kind: 'recovery-restore' });
    const f = words();
    type(f[4]!, 'leg');
    expect(options()).toEqual(['leg', 'legal', 'legend']);
    expect(listbox().hidden).toBe(false);
    // In the field's own wrapper (its positioning box), not merely somewhere in the form.
    expect(listbox().parentElement).toBe(f[4]!.parentElement);
    expect(f[4]!.parentElement?.className).toBe('word-field');
    expect(f[4]!.getAttribute('aria-expanded')).toBe('true');
    type(f[4]!, 'A');
    expect(options()).toEqual(matching('a'));
    for (const o of options()) expect(WORDS).toContain(o);
    // One list, moved under whichever field is being typed in.
    type(f[9]!, 'wor');
    expect(options()).toEqual(matching('wor'));
    expect(listbox().parentElement).toBe(f[9]!.parentElement);
    expect(f[4]!.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelectorAll('[role="listbox"]')).toHaveLength(1);
    for (const nothing of ['x', 'zoo', '']) {
      type(f[9]!, nothing);
      expect(options(), nothing).toEqual([]);
      expect(listbox().hidden, nothing).toBe(true);
      expect(f[9]!.getAttribute('aria-expanded')).toBe('false');
    }
  });

  it('keyboard: ↓/↑ choose (wrapping), Enter takes the word without submitting, Escape closes the list before it cancels', () => {
    const { sent } = show({ kind: 'recovery-confirm', positions: [0, 5, 11], retry: false });
    const f = words()[0]!;
    // Enter with no list open is left alone (the form's own submit).
    expect(key(f, 'Enter').defaultPrevented).toBe(false);
    type(f, 'wor');
    expect(listbox().parentElement).toBe(f.parentElement);
    expect(f.parentElement?.className).toBe('field');
    expect(selected()).toEqual([]);
    expect(key(f, 'ArrowDown').defaultPrevented).toBe(true);
    expect(selected()).toEqual(['word']);
    const active = root.querySelector('[role="option"][aria-selected="true"]');
    expect(f.getAttribute('aria-activedescendant')).toBe(active?.id);
    key(f, 'ArrowDown');
    expect(selected()).toEqual(['work']);
    key(f, 'ArrowUp');
    key(f, 'ArrowUp');
    expect(selected()).toEqual(['worth']);
    key(f, 'ArrowDown');
    expect(selected()).toEqual(['word']);
    key(f, 'ArrowDown');
    const enter = key(f, 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(f.value).toBe('work');
    expect(options()).toEqual([]);
    expect(listbox().hidden).toBe(true);
    expect(f.hasAttribute('aria-activedescendant')).toBe(false);
    expect(sent).toEqual([]);
    // ↓ on a closed list opens it with the first match chosen.
    f.value = 'leg';
    key(f, 'ArrowDown');
    expect(options()).toEqual(['leg', 'legal', 'legend']);
    expect(selected()).toEqual(['leg']);
    // Escape: first the list, then (as everywhere in this window) the question.
    const esc = key(f, 'Escape');
    expect(esc.defaultPrevented).toBe(true);
    expect(listbox().hidden).toBe(true);
    expect(sent).toEqual([]);
    key(f, 'Escape');
    expect(sent).toEqual([null]);
  });

  it('a click takes the word; the list closes when the field or the window loses focus, and is emptied when the answer is sent', () => {
    show({ kind: 'recovery-restore' });
    const f = words();
    type(f[0]!, 'lega');
    const opt = root.querySelector('[role="option"]');
    // Another button (a right click) takes nothing.
    opt?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 }));
    expect(f[0]!.value).toBe('lega');
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    opt?.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true); // the field keeps the focus
    expect(f[0]!.value).toBe('legal');
    expect(options()).toEqual([]);
    type(f[1]!, 'leg');
    f[1]!.dispatchEvent(new FocusEvent('blur'));
    expect(options()).toEqual([]);
    expect(listbox().hidden).toBe(true);
    type(f[1]!, 'leg');
    window.dispatchEvent(new Event('blur'));
    expect(options()).toEqual([]);
    root.remove();
    const { sent } = show({ kind: 'recovery-confirm', positions: [1, 2, 3], retry: false });
    type(words()[0]!, 'leg');
    expect(root.textContent).toContain('legend');
    button('Later').click();
    expect(sent).toEqual([null]);
    expect(options()).toEqual([]);
    expect(root.textContent).not.toContain('legend');
  });

  // Round-8 verifier (low): a whole phrase pasted into a field is spread by setting the values
  // directly, so no `input` event fires. A list left open under that field kept its chosen word,
  // and the next Enter put that word over the pasted one instead of leaving the form to submit.
  it('pasting a whole phrase closes an open list: the next Enter is the form’s, and the pasted words are what is sent', () => {
    const { sent } = show({ kind: 'recovery-restore' });
    const f = words();
    type(f[0]!, 'wor');
    key(f[0]!, 'ArrowDown');
    expect(selected()).toEqual(['word']);
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => TEXT.join(' ') } });
    f[0]!.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    expect(f.map((x) => x.value)).toEqual(TEXT);
    expect(options()).toEqual([]);
    expect(listbox().hidden).toBe(true);
    expect(f[0]!.getAttribute('aria-expanded')).toBe('false');
    expect(f[0]!.hasAttribute('aria-activedescendant')).toBe(false);
    // Enter no longer takes a word: it is left to the form, and the pasted word stays.
    expect(key(f[0]!, 'Enter').defaultPrevented).toBe(false);
    expect(f[0]!.value).toBe(TEXT[0]);
    submit();
    expect(sent).toEqual([{ kind: 'recovery-restore', words: PHRASE }]);
  });
});

// @vitest-environment jsdom
/**
 * ADR 0016 in main's trusted prompt page: the words come from the page's OWN bundled BIP-39
 * English list, looked up from the indices the question carries (never text); they cannot be
 * copied, hide after two minutes or when the window loses focus, and leave the DOM when the
 * answer is sent. Typed words leave the page as indices; a typed phrase must carry a valid
 * checksum; the page refuses any recovery question that is not exactly indices / positions.
 */
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isMintUrl } from '../../ipc/guards.js';
import type { PromptForm } from '../../ipc/protocol.js';
import { BIP39_LIST_SIZE, MAX_RESTORE_MINTS, RECOVERY_WORDS } from '../../ipc/protocol.js';
import {
  PHRASE_WORDS,
  RESTORE_MINTS,
  WORDS,
  WORDS_VISIBLE_MS,
  isForm,
  mintAddress,
  mount,
  phraseValid,
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
    expect(root.querySelectorAll('datalist option')).toHaveLength(2048);
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

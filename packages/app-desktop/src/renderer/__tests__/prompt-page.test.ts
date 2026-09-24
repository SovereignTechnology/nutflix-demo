// @vitest-environment jsdom
/**
 * Main's trusted prompt page (ADR 0013): every question renders its own words, answers exactly
 * once with only what it offered, checks a new passphrase before sending it, clears secret fields
 * as it sends, defaults a money-shaped question to its safe answer, and Escape cancels.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { PromptForm } from '../../ipc/protocol.js';
import { MIN_PASSPHRASE_CHARS, mount } from '../prompt/prompt.js';

let root: HTMLElement;
afterEach(() => {
  root.remove();
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
const input = (sel: string): HTMLInputElement => find(sel) as HTMLInputElement;
const submit = (): void => {
  (find('form') as HTMLFormElement).requestSubmit();
};
const type = (sel: string, v: string): void => {
  input(sel).value = v;
};
const radio = (name: string, value: string): HTMLInputElement =>
  input(`input[name="${name}"][value="${value}"]`);

describe('prompt page', () => {
  it('local setup without a key or a keychain: create is the default, the keychain is not offered', () => {
    const { sent } = show({ kind: 'local-setup', hasKey: false, keychain: false });
    expect(root.textContent).toMatch(/Create a new key/);
    expect(radio('method', 'keychain').disabled).toBe(true);
    expect(root.textContent).toMatch(/no OS keychain/);
    submit();
    expect(sent).toEqual([{ kind: 'local-setup', method: 'passphrase', flow: 'generate' }]);
    submit();
    expect(sent).toHaveLength(1); // exactly one answer
  });

  it('local setup: import + keychain when offered; an existing key only unlocks', () => {
    const a = show({ kind: 'local-setup', hasKey: false, keychain: true });
    radio('flow', 'import').checked = true;
    radio('method', 'keychain').checked = true;
    submit();
    expect(a.sent).toEqual([{ kind: 'local-setup', method: 'keychain', flow: 'import' }]);
    root.remove();
    const b = show({ kind: 'local-setup', hasKey: true, keychain: false });
    expect(root.querySelector('input[name="flow"]')).toBeNull();
    submit();
    expect(b.sent).toEqual([{ kind: 'local-setup', method: 'passphrase', flow: 'unlock' }]);
  });

  it('new passphrase: too short and mismatched are refused on the page; a good one is sent and cleared', () => {
    const { sent } = show({ kind: 'new-passphrase' });
    type('#pass', 'x'.repeat(MIN_PASSPHRASE_CHARS - 1));
    type('#pass2', 'x'.repeat(MIN_PASSPHRASE_CHARS - 1));
    submit();
    expect(sent).toEqual([]);
    expect(find('.error[role="alert"]').textContent).toMatch(/at least/);
    type('#pass', 'a good passphrase');
    type('#pass2', 'a good passphrase!');
    submit();
    expect(sent).toEqual([]);
    expect(find('.error[role="alert"]').textContent).toMatch(/differ/);
    type('#pass2', 'a good passphrase');
    submit();
    expect(sent).toEqual([{ kind: 'secret', value: 'a good passphrase' }]);
    expect(input('#pass').value).toBe('');
    expect(input('#pass2').value).toBe('');
    expect(input('#pass').type).toBe('password');
  });

  it('unlock: says when the last try was wrong', () => {
    const { sent } = show({ kind: 'unlock-passphrase', retry: true });
    expect(root.textContent).toMatch(/Wrong passphrase/);
    submit();
    expect(sent).toEqual([]);
    type('#pass', 'pw');
    submit();
    expect(sent).toEqual([{ kind: 'secret', value: 'pw' }]);
  });

  it('import: only an nsec1… or 64 hex is sent', () => {
    const { sent } = show({ kind: 'import-nsec' });
    type('#nsec', 'npub1notasecret');
    submit();
    expect(sent).toEqual([]);
    type('#nsec', ` ${'ab'.repeat(32)} `);
    submit();
    expect(sent).toEqual([{ kind: 'secret', value: 'ab'.repeat(32) }]);
  });

  it('bunker: a bunker:// link only; "remember" needs a keychain', () => {
    const a = show({ kind: 'bunker', keychain: false });
    expect(input('#remember').disabled).toBe(true);
    type('#uri', 'https://example.com');
    submit();
    expect(a.sent).toEqual([]);
    type('#uri', 'bunker://abc?relay=wss://r');
    input('#remember').checked = true; // even if forced, not offered → false
    submit();
    expect(a.sent).toEqual([
      { kind: 'bunker', uri: 'bunker://abc?relay=wss://r', remember: false },
    ]);
    root.remove();
    const b = show({ kind: 'bunker', keychain: true });
    type('#uri', 'bunker://abc?relay=wss://r');
    input('#remember').checked = true;
    submit();
    expect(b.sent).toEqual([{ kind: 'bunker', uri: 'bunker://abc?relay=wss://r', remember: true }]);
  });

  it('create wallet: focus starts on "Not now", which answers no; the warning is shown', () => {
    const { sent } = show({ kind: 'create-wallet' });
    expect(document.activeElement?.textContent).toBe('Not now');
    expect(root.textContent).toMatch(/relays may just be unreachable/);
    (document.activeElement as HTMLButtonElement).click();
    expect(sent).toEqual([{ kind: 'create-wallet', create: false }]);
  });

  it('Escape cancels (null), once', () => {
    const { sent } = show({ kind: 'import-nsec' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(sent).toEqual([null]);
  });

  it('an existing key offers "Forgot the passphrase? Remove this key…"', () => {
    const { sent } = show({ kind: 'local-setup', hasKey: true, keychain: false });
    const link = [...root.querySelectorAll('button')].find((b) =>
      b.textContent.includes('Remove this key'),
    );
    expect(link).toBeDefined();
    link?.click();
    expect(sent).toEqual([{ kind: 'local-setup', method: 'passphrase', flow: 'remove' }]);
    root.remove();
    show({ kind: 'local-setup', hasKey: false, keychain: false });
    expect(root.textContent).not.toMatch(/Remove this key/);
  });

  it('remove key: "Keep it" is the default and the answer to Escape; Delete is destructive', () => {
    const a = show({ kind: 'remove-key' });
    expect(document.activeElement?.textContent).toBe('Keep it');
    expect(root.textContent).toMatch(/no undo/);
    expect(find('button.danger').textContent).toBe('Delete key');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(a.sent).toEqual([{ kind: 'remove-key', confirm: false }]);
    root.remove();
    const b = show({ kind: 'remove-key' });
    submit();
    expect(b.sent).toEqual([{ kind: 'remove-key', confirm: true }]);
  });

  it('approval link: shows the real host (punycode for a lookalike), defaults to Not now', () => {
    const a = show({
      kind: 'bunker-auth',
      url: 'https://auth.bunker.example:8443/approve?t=SECRET',
    });
    expect(find('.host code').textContent).toBe('auth.bunker.example:8443');
    expect(root.textContent).not.toMatch(/SECRET/);
    expect(document.activeElement?.textContent).toBe('Not now');
    (document.activeElement as HTMLButtonElement).click();
    expect(a.sent).toEqual([{ kind: 'bunker-auth', open: false }]);
    root.remove();
    show({ kind: 'bunker-auth', url: 'https://аuth.example/' }); // a Cyrillic "а"
    expect(find('.host code').textContent).toMatch(/^xn--/);
  });
});

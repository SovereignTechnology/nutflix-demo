/**
 * Main's trusted prompt page (ADR 0013; bundled to `dist/prompt/prompt.js`, served at
 * `app://prompt/prompt.html`). Plain DOM, no framework, no network, no storage: it asks main for
 * ONE question (`window.nutflixPrompt.question()`), shows it, and sends back ONE answer. Every
 * word it shows is here — the question is data only (`PromptForm`), so nothing upstream can put
 * text in front of the user in this trusted window.
 *
 * Secrets are typed into password fields, sent once, and the fields are cleared at once (a JS
 * string cannot be wiped; clearing the DOM is what the page can do). Escape or closing the
 * window cancels.
 *
 * ADR 0016: the recovery phrase. The page bundles the BIP-39 English list (`@scure/bip39`'s
 * wordlist data, and its `validateMnemonic` for the checksum — the only code this bundle takes
 * from outside this directory): a phrase arrives as 12 INDICES and is shown through that list;
 * a typed word leaves as its index. Main keeps the window out of screen captures while words
 * show (macOS/Windows; on Linux the page says it cannot); the words hide after two minutes or
 * when the window loses focus; nothing offers to copy them.
 */
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

import type { WindowForm } from '../../ipc/protocol.js';

interface PromptApi {
  question(): Promise<unknown>;
  answer(a: unknown): Promise<unknown>;
}

/** The same floor the host enforces (`MIN_NEW_PASSPHRASE_BYTES`, counted here in characters). */
export const MIN_PASSPHRASE_CHARS = 12;

/**
 * Issue #2: the daily auto top-up cap the page states — the host's `LIMITS.maxAutoTopUpSatsPerDay`
 * (core's `AUTO_TOP_UP_MAX_SATS_PER_DAY`), pinned by a test: the page bundle imports nothing.
 */
export const TOP_UP_PER_DAY_SATS = 50_000;
/** Issue #2: the most one auto top-up moves — `LIMITS.maxAutoTopUpAmountSats`, pinned by a test. */
export const TOP_UP_MAX_SATS = 10_000;

// ---- ADR 0016: the page's own BIP-39 English list ------------------------------------------

/** Words in a phrase (`RECOVERY_WORDS`, pinned by a test: the page bundle imports no ipc code). */
export const PHRASE_WORDS = 12;
/** How long the words stay on screen before they hide themselves. */
export const WORDS_VISIBLE_MS = 120_000;
/** The list itself (2048 words, `BIP39_LIST_SIZE`). */
export const WORDS: readonly string[] = wordlist;
const INDEX = new Map<string, number>(wordlist.map((w, i) => [w, i]));

/**
 * A typed word → its index in the list: the exact word, or a prefix of at least four letters
 * that only one word starts with (BIP-39 English words are unique in their first four).
 */
export function wordIndex(typed: string): number | undefined {
  const w = typed.trim().normalize('NFKD').toLowerCase();
  if (w === '') return undefined;
  const exact = INDEX.get(w);
  if (exact !== undefined) return exact;
  if (w.length < 4) return undefined;
  let hit: number | undefined;
  for (let i = 0; i < wordlist.length; i++)
    if (wordlist[i]?.startsWith(w) === true) {
      if (hit !== undefined) return undefined;
      hit = i;
    }
  return hit;
}

/** Does this phrase (as indices) carry a valid BIP-39 checksum? (`@scure/bip39`.) */
export function phraseValid(indices: readonly number[]): boolean {
  if (indices.length !== PHRASE_WORDS) return false;
  const words = indices.map((i) => wordlist[i]);
  if (words.some((w) => w === undefined)) return false;
  try {
    return validateMnemonic(words.join(' '), wordlist);
  } catch {
    return false;
  }
}

// ---- ADR 0016 §5.1: mint addresses typed in the restore window ------------------------------

/** Mint addresses the restore window takes (`MAX_RESTORE_MINTS`, pinned by a test). */
export const RESTORE_MINTS = 8;
/** Longest mint address (`LIMITS.maxServerUrl`, pinned by a test). */
export const MAX_MINT_URL = 512;
// The IPC guards' `isMintUrl` grammar (src/ipc/guards.ts `HTTPS_SERVER_RE`), copied because the
// page bundle imports no ipc code; a test checks the two agree. Main and the host check again.
const LABEL = '[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?';
const HOST = `(?:${LABEL}(?:\\.${LABEL})*|\\[[0-9A-Fa-f:.]{2,45}\\])`;
const PCHAR = "[A-Za-z0-9\\-._~!$&'()*+,;=:@%]";
const PATH = `(?:/[A-Za-z0-9\\-._~!$&'()*+,;=:@%/]*${PCHAR})?`;
const MINT_URL_RE = new RegExp(`^https://${HOST}(?::[0-9]{1,5})?${PATH}$`);

/**
 * A typed mint address → its normalised https URL (typed with `https://`; no user-info, no
 * query, no fragment, no trailing slash, an ASCII host), or `undefined`. Never `http:` — a
 * restore sends the phrase's blinded outputs to that mint (ADR 0016 §6: https only) — and never
 * a bare word, so a phrase typed into the wrong box is not taken for a list of hosts.
 */
export function mintAddress(typed: string): string | undefined {
  const t = typed.trim();
  if (t.length > MAX_MINT_URL || !/^https:\/\//i.test(t)) return undefined;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.search !== '')
    return undefined;
  u.hash = '';
  let out = u.toString();
  while (out.endsWith('/')) out = out.slice(0, -1);
  return out.length <= MAX_MINT_URL && MINT_URL_RE.test(out) ? out : undefined;
}

function isIndexList(x: unknown, n: number, max: number): x is readonly number[] {
  return (
    Array.isArray(x) &&
    x.length === n &&
    x.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < max)
  );
}

/** Linux has no way to keep a window out of screen captures (Electron's content protection). */
function captureUnprotected(): boolean {
  try {
    return /Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent);
  } catch {
    return false;
  }
}

function captureNote(): HTMLElement[] {
  return captureUnprotected()
    ? [
        el(
          'p',
          { class: 'warning' },
          'On Linux this window cannot be kept out of screenshots or screen sharing: make sure nothing is recording your screen.',
        ),
      ]
    : [];
}

/** One `<datalist>` of the whole list, for the fields that take words. */
function wordDatalist(id: string): HTMLDataListElement {
  const list = el('datalist', { id });
  for (const w of wordlist) list.append(el('option', { value: w }));
  return list;
}

function wordField(id: string, label: string, list: string): HTMLInputElement {
  return el('input', {
    id,
    type: 'text',
    list,
    autocomplete: 'off',
    spellcheck: 'false',
    autocapitalize: 'off',
    maxlength: '16',
    'aria-label': label,
  });
}

type Answer =
  | {
      kind: 'local-setup';
      method: 'passphrase' | 'keychain';
      flow: 'unlock' | 'import' | 'generate' | 'remove';
    }
  | { kind: 'secret'; value: string }
  | { kind: 'bunker'; uri: string; remember: boolean }
  | { kind: 'create-wallet'; create: boolean }
  | { kind: 'remove-key'; confirm: boolean }
  | { kind: 'bunker-auth'; open: boolean }
  | { kind: 'open-link'; open: boolean }
  | { kind: 'top-up-first'; confirm: boolean }
  | { kind: 'recovery-show'; done: boolean }
  | { kind: 'recovery-confirm'; words: number[] }
  | { kind: 'recovery-restore'; words: number[]; mints?: string[] }
  | null;

// ---- tiny DOM helpers --------------------------------------------------------------------

type Attrs = Record<string, string | boolean>;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false) continue;
    e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) e.append(c);
  return e;
}

function radio(
  name: string,
  value: string,
  label: string,
  opts: { checked?: boolean; disabled?: boolean; hint?: string } = {},
): HTMLLabelElement {
  const input = el('input', {
    type: 'radio',
    name,
    value,
    checked: opts.checked === true,
    disabled: opts.disabled === true,
  });
  return el(
    'label',
    { class: opts.disabled === true ? 'choice choice--disabled' : 'choice' },
    input,
    el(
      'span',
      { class: 'choice__text' },
      el('span', {}, label),
      ...(opts.hint ? [el('span', { class: 'hint' }, opts.hint)] : []),
    ),
  );
}

function password(
  id: string,
  label: string,
  autocomplete: string,
): { row: HTMLElement; input: HTMLInputElement } {
  const input = el('input', {
    id,
    type: 'password',
    autocomplete,
    spellcheck: 'false',
    autocapitalize: 'off',
    maxlength: '1024',
  });
  return { row: el('div', { class: 'field' }, el('label', { for: id }, label), input), input };
}

/** A URL's host as `URL` gives it: ASCII (IDNA-encoded), so no look-alike Unicode. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(invalid address)';
  }
}

function satsText(n: number): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'sat' : 'sats'}`;
}

function checked(form: HTMLFormElement, name: string): string | undefined {
  const r = form.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`);
  return r?.value;
}

// ---- the page ----------------------------------------------------------------------------

interface View {
  readonly title: string;
  readonly body: (Node | string)[];
  readonly submitLabel: string;
  readonly cancelLabel?: string;
  /** Build the answer, or return an error line to show instead. */
  readonly collect: (form: HTMLFormElement) => Answer | { error: string };
  /** Focus this first (default: the first input, then the submit button). */
  readonly focus?: HTMLElement;
  readonly secrets?: HTMLInputElement[];
  /**
   * An outward or destructive question: focus starts on Cancel, and Cancel / Escape send this
   * answer ("no") instead of a bare cancel.
   */
  readonly safeNo?: Answer;
  /** The confirm button is destructive (styled as such). */
  readonly danger?: boolean;
  /** A secondary action beside the buttons (e.g. "Forgot the passphrase?"). */
  readonly alt?: { readonly label: string; readonly answer: Answer };
  /** Runs once the form is on screen; the returned function runs when the answer is sent. */
  readonly onMount?: () => () => void;
}

function view(q: WindowForm): View {
  switch (q.kind) {
    case 'local-setup': {
      const body: (Node | string)[] = [];
      if (q.hasKey)
        body.push(el('p', {}, 'A key is stored on this device. Unlock it with your passphrase.'));
      else
        body.push(
          el(
            'fieldset',
            {},
            el('legend', {}, 'Your key'),
            radio('flow', 'generate', 'Create a new key', {
              checked: true,
              hint: 'A new Nostr identity, encrypted on this device.',
            }),
            radio('flow', 'import', 'Import an existing key (nsec)', {
              hint: 'Paste it in the next step, in this window only.',
            }),
          ),
        );
      body.push(
        el(
          'fieldset',
          {},
          el('legend', {}, 'Unlocking at launch'),
          radio('method', 'passphrase', 'Type my passphrase each time', {
            checked: true,
            hint: 'Most private: nothing is stored besides the encrypted key.',
          }),
          radio('method', 'keychain', 'Remember it in the OS keychain', {
            disabled: !q.keychain,
            hint: q.keychain
              ? 'Nutflix unlocks by itself. Anyone who can use your OS account can use your key.'
              : 'Not available: this system has no OS keychain Nutflix can use.',
          }),
        ),
      );
      return {
        title: 'Local key',
        body,
        submitLabel: 'Continue',
        ...(q.hasKey
          ? {
              alt: {
                label: 'Forgot the passphrase? Remove this key…',
                answer: { kind: 'local-setup', method: 'passphrase', flow: 'remove' },
              },
            }
          : {}),
        collect: (f) => {
          const method =
            checked(f, 'method') === 'keychain' && q.keychain ? 'keychain' : 'passphrase';
          const flow = q.hasKey
            ? 'unlock'
            : checked(f, 'flow') === 'import'
              ? 'import'
              : 'generate';
          return { kind: 'local-setup', method, flow };
        },
      };
    }
    case 'unlock-passphrase': {
      const p = password('pass', 'Passphrase', 'current-password');
      const body: (Node | string)[] = [];
      if (q.retry)
        body.push(el('p', { class: 'error', role: 'alert' }, 'Wrong passphrase. Try again.'));
      body.push(p.row);
      return {
        title: 'Unlock your key',
        body,
        submitLabel: 'Unlock',
        focus: p.input,
        secrets: [p.input],
        collect: () =>
          p.input.value === ''
            ? { error: 'Type your passphrase.' }
            : { kind: 'secret', value: p.input.value },
      };
    }
    case 'new-passphrase': {
      const a = password('pass', 'New passphrase', 'new-password');
      const b = password('pass2', 'Type it again', 'new-password');
      return {
        title: 'Choose a passphrase',
        body: [
          el(
            'p',
            {},
            `It encrypts your key on this device. At least ${String(MIN_PASSPHRASE_CHARS)} characters. It cannot be recovered — keep it somewhere safe.`,
          ),
          a.row,
          b.row,
        ],
        submitLabel: 'Save',
        focus: a.input,
        secrets: [a.input, b.input],
        collect: () => {
          // UTF-16 units: never fewer than the UTF-8 bytes the host counts.
          if (a.input.value.length < MIN_PASSPHRASE_CHARS)
            return { error: `Use at least ${String(MIN_PASSPHRASE_CHARS)} characters.` };
          if (a.input.value !== b.input.value) return { error: 'The two passphrases differ.' };
          return { kind: 'secret', value: a.input.value };
        },
      };
    }
    case 'import-nsec': {
      const p = password('nsec', 'Secret key (nsec1… or 64 hex)', 'off');
      return {
        title: 'Import your key',
        body: [
          el(
            'p',
            {},
            'Paste your secret key only here — this window belongs to Nutflix itself, not to any page.',
          ),
          p.row,
        ],
        submitLabel: 'Import',
        focus: p.input,
        secrets: [p.input],
        collect: () => {
          const v = p.input.value.trim();
          if (!/^nsec1[02-9ac-hj-np-z]{58}$/.test(v) && !/^[0-9a-fA-F]{64}$/.test(v))
            return { error: 'That is not an nsec1… key or 64 hex characters.' };
          return { kind: 'secret', value: v };
        },
      };
    }
    case 'bunker': {
      const input = el('input', {
        id: 'uri',
        type: 'password',
        autocomplete: 'off',
        spellcheck: 'false',
        autocapitalize: 'off',
        maxlength: '2048',
        placeholder: 'bunker://…',
      });
      const remember = el('input', { type: 'checkbox', id: 'remember', disabled: !q.keychain });
      return {
        title: 'Connect a remote signer',
        body: [
          el(
            'p',
            {},
            'Paste the bunker:// link from your signer app (NIP-46). Your key stays on that device.',
          ),
          el('div', { class: 'field' }, el('label', { for: 'uri' }, 'Bunker link'), input),
          el(
            'label',
            { class: q.keychain ? 'check' : 'check choice--disabled' },
            remember,
            el(
              'span',
              {},
              'Remember this signer on this device',
              el(
                'span',
                { class: 'hint' },
                q.keychain
                  ? 'Stored in the OS keychain; reconnects at launch.'
                  : 'Not available: no OS keychain on this system.',
              ),
            ),
          ),
        ],
        submitLabel: 'Connect',
        focus: input,
        secrets: [input],
        collect: () => {
          const v = input.value.trim();
          if (!v.startsWith('bunker://'))
            return { error: 'A remote-signer link starts with bunker://' };
          return { kind: 'bunker', uri: v, remember: q.keychain && remember.checked };
        },
      };
    }
    case 'remove-key':
      return {
        title: 'Remove your key from this device?',
        body: [
          el(
            'p',
            {},
            'This deletes the encrypted key file. Your identity lives only in that key: unless its secret key (nsec) is saved somewhere else, you lose this identity and any sats its wallet holds.',
          ),
          el('p', { class: 'warning' }, 'There is no undo.'),
        ],
        submitLabel: 'Delete key',
        cancelLabel: 'Keep it',
        danger: true,
        safeNo: { kind: 'remove-key', confirm: false },
        collect: () => ({ kind: 'remove-key', confirm: true }),
      };
    case 'bunker-auth': {
      let host: string;
      try {
        host = new URL(q.url).host;
      } catch {
        host = '(invalid address)';
      }
      return {
        title: 'Approve in your remote signer',
        body: [
          el('p', {}, 'Your remote signer asks you to approve Nutflix on its web page at:'),
          el('p', { class: 'host' }, el('code', {}, host)),
          el(
            'p',
            { class: 'hint' },
            'Continue only if you recognise this address. Nutflix opens it in your browser; approve there, then come back.',
          ),
        ],
        submitLabel: 'Open in browser',
        cancelLabel: 'Not now',
        safeNo: { kind: 'bunker-auth', open: false },
        collect: () => ({ kind: 'bunker-auth', open: true }),
      };
    }
    case 'open-link': {
      // The host as `URL` gives it: ASCII (IDNA-encoded), so no look-alike Unicode.
      let host: string;
      try {
        host = new URL(q.url).host;
      } catch {
        host = '(invalid address)';
      }
      return {
        title: 'Open this link in your browser?',
        body: [
          el('p', {}, 'The link goes to:'),
          el('p', { class: 'host' }, el('code', {}, host)),
          el(
            'p',
            { class: 'hint' },
            'Links in videos and profiles are written by whoever posted them, and the text you clicked may not match where it goes. Continue only if you trust this address.',
          ),
        ],
        submitLabel: 'Open in browser',
        cancelLabel: 'Cancel',
        safeNo: { kind: 'open-link', open: false },
        collect: () => ({ kind: 'open-link', open: true }),
      };
    }
    case 'top-up-first': {
      const perDay = satsText(TOP_UP_PER_DAY_SATS);
      return {
        title: 'Allow automatic top-ups into this mint?',
        body: [
          el('p', {}, 'Auto top-up wants to move sats into this mint for the first time:'),
          el(
            'dl',
            { class: 'facts' },
            el('dt', {}, 'Into'),
            el('dd', {}, el('code', {}, hostOf(q.target))),
            el('dt', {}, 'From'),
            el('dd', {}, el('code', {}, hostOf(q.source))),
            el('dt', {}, 'Each top-up'),
            el('dd', {}, satsText(q.amount)),
          ),
          el(
            'p',
            { class: 'hint' },
            `If you allow it, later top-ups into this mint run without asking: each at most the amount set in Settings (never more than ${satsText(TOP_UP_MAX_SATS)}), and ${perDay} in any 24 hours, Lightning fees included. Turn auto top-up off in Settings › Mints and top-up.`,
          ),
        ],
        submitLabel: 'Allow top-ups',
        cancelLabel: 'Not now',
        safeNo: { kind: 'top-up-first', confirm: false },
        collect: () => ({ kind: 'top-up-first', confirm: true }),
      };
    }
    case 'recovery-show':
      return recoveryShow(q.words, q.again);
    case 'recovery-confirm':
      return recoveryConfirm(q.positions, q.retry);
    case 'recovery-restore':
      return recoveryRestore();
    case 'recovery-reauth': {
      const p = password('pass', 'Passphrase', 'current-password');
      const body: (Node | string)[] = [];
      if (q.retry)
        body.push(el('p', { class: 'error', role: 'alert' }, 'Wrong passphrase. Try again.'));
      body.push(
        el(
          'p',
          {},
          'Type the passphrase of the key on this device to continue with your recovery phrase.',
        ),
        p.row,
      );
      return {
        title: 'Confirm it is you',
        body,
        submitLabel: 'Continue',
        focus: p.input,
        secrets: [p.input],
        collect: () =>
          p.input.value === ''
            ? { error: 'Type your passphrase.' }
            : { kind: 'secret', value: p.input.value },
      };
    }
    case 'create-wallet': {
      return {
        title: 'No wallet found',
        body: [
          el('p', {}, 'Nutflix found no Nostr wallet (NIP-60) for your key on your relays.'),
          el(
            'p',
            { class: 'warning' },
            'If you already have one, choose Not now: your relays may just be unreachable, and a new wallet would replace the old one on them.',
          ),
        ],
        submitLabel: 'Create wallet',
        cancelLabel: 'Not now',
        safeNo: { kind: 'create-wallet', create: false },
        collect: () => ({ kind: 'create-wallet', create: true }),
      };
    }
  }
}

/** ADR 0016: the words, shown from the page's own list; hidden after a while or on blur. */
function recoveryShow(indices: readonly number[], again: boolean): View {
  const grid = el('ol', { class: 'words', 'aria-label': 'Recovery phrase' });
  const hidden = el('p', { class: 'words-hidden', hidden: true }, 'The words are hidden. ');
  const reveal = el('button', { type: 'button', class: 'link' }, 'Show the words');
  hidden.append(reveal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hide = (): void => {
    clearTimeout(timer);
    timer = undefined;
    // Out of the DOM, not merely out of sight.
    grid.replaceChildren();
    grid.hidden = true;
    hidden.hidden = false;
  };
  const show = (): void => {
    grid.replaceChildren(
      ...indices.map((i, n) =>
        el(
          'li',
          {},
          el('span', { class: 'words__n' }, `${String(n + 1)}.`),
          el('span', { class: 'words__w' }, wordlist[i] ?? '?'),
        ),
      ),
    );
    grid.hidden = false;
    hidden.hidden = true;
    clearTimeout(timer);
    timer = setTimeout(hide, WORDS_VISIBLE_MS);
  };
  const block = (e: Event): void => {
    e.preventDefault();
  };
  for (const ev of ['copy', 'cut', 'contextmenu', 'dragstart', 'selectstart'])
    grid.addEventListener(ev, block);
  reveal.addEventListener('click', show);
  return {
    title: again ? 'Your recovery phrase' : 'Write down your recovery phrase',
    body: [
      el(
        'p',
        {},
        again
          ? 'These 12 words restore the ecash of this device. Anyone who sees them can take it.'
          : 'These 12 words can bring back your ecash if this device is lost. Write them on paper, in order, and keep them somewhere safe. Anyone who sees them can take your ecash.',
      ),
      ...captureNote(),
      grid,
      hidden,
      el(
        'p',
        { class: 'hint' },
        'Never type them into a website or share them. Nutflix only asks for them in this window.',
      ),
    ],
    submitLabel: 'I wrote them down',
    cancelLabel: again ? 'Close' : 'Cancel',
    ...(again
      ? {}
      : { alt: { label: 'Later', answer: { kind: 'recovery-show', done: false } as const } }),
    collect: () => ({ kind: 'recovery-show', done: true }),
    onMount: () => {
      show();
      window.addEventListener('blur', hide);
      return () => {
        window.removeEventListener('blur', hide);
        hide();
      };
    },
  };
}

/** ADR 0016: three words, typed back and sent as indices. */
function recoveryConfirm(positions: readonly number[], retry: boolean): View {
  const fields = positions.map((p) =>
    wordField(`w${String(p)}`, `Word ${String(p + 1)}`, 'nf-words'),
  );
  const body: (Node | string)[] = [];
  if (retry)
    body.push(
      el(
        'p',
        { class: 'error', role: 'alert' },
        'Those words do not match your phrase. Check what you wrote down and try again.',
      ),
    );
  body.push(
    el('p', {}, 'To check your copy, type these words from your recovery phrase.'),
    ...captureNote(),
    ...fields.map((f, k) =>
      el(
        'div',
        { class: 'field' },
        el('label', { for: f.id }, `Word ${String((positions[k] ?? 0) + 1)}`),
        f,
      ),
    ),
    wordDatalist('nf-words'),
  );
  return {
    title: 'Confirm your recovery phrase',
    body,
    submitLabel: 'Confirm',
    cancelLabel: 'Later',
    ...(fields[0] === undefined ? {} : { focus: fields[0] }),
    secrets: fields,
    collect: () => {
      const words = fields.map((f) => wordIndex(f.value));
      if (words.some((w) => w === undefined))
        return { error: 'Type each word as you wrote it down (a word from the list).' };
      return { kind: 'recovery-confirm', words: words as number[] };
    },
  };
}

/** ADR 0016: an optional typed phrase — 12 words, checked here before they are sent. */
function recoveryRestore(): View {
  const fields = Array.from({ length: PHRASE_WORDS }, (_, n) =>
    wordField(`r${String(n)}`, `Word ${String(n + 1)}`, 'nf-words'),
  );
  // Pasting a whole phrase into one field spreads it over the fields (a password manager).
  fields.forEach((f, start) => {
    f.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text') ?? '';
      const parts = text.trim().split(/\s+/);
      if (parts.length < 2) return;
      e.preventDefault();
      parts.slice(0, PHRASE_WORDS - start).forEach((w, k) => {
        const target = fields[start + k];
        if (target !== undefined) target.value = w;
      });
    });
  });
  // ADR 0016 §5.1: the words alone do not say which mints a phrase was used at.
  const mintBox = el('textarea', {
    id: 'r-mints',
    rows: '2',
    autocomplete: 'off',
    spellcheck: 'false',
    autocapitalize: 'off',
    maxlength: String(RESTORE_MINTS * (MAX_MINT_URL + 1)),
    placeholder: 'https://mint.example',
  });
  const collectMints = (): string[] | { error: string } => {
    const mints: string[] = [];
    const parts = mintBox.value.split(/[\s,]+/).filter((x) => x !== '');
    for (let n = 0; n < parts.length; n++) {
      const m = mintAddress(parts[n] ?? '');
      // The typed text is not repeated back (it could be anything the user pasted).
      if (m === undefined)
        return {
          error: `Mint address ${String(n + 1)} is not an https address like https://mint.example (no http, no ? part).`,
        };
      if (!mints.includes(m)) mints.push(m);
    }
    if (mints.length > RESTORE_MINTS)
      return { error: `Type at most ${String(RESTORE_MINTS)} mint addresses.` };
    return mints;
  };
  return {
    title: 'Restore from recovery phrases',
    body: [
      el(
        'p',
        {},
        'Nutflix restores from the recovery phrase of this device and from every copy on your relays that your key can open. To restore from another phrase too — another device’s, or one from another Cashu wallet — type its 12 words.',
      ),
      el(
        'p',
        { class: 'hint' },
        'Leave the fields empty to restore without a typed phrase. Each of your mints is asked about the phrase, which can take a while.',
      ),
      ...captureNote(),
      el(
        'div',
        { class: 'word-fields' },
        ...fields.map((f, n) =>
          el('div', { class: 'word-field' }, el('label', { for: f.id }, `${String(n + 1)}.`), f),
        ),
      ),
      wordDatalist('nf-words'),
      el(
        'div',
        { class: 'field' },
        el('label', { for: mintBox.id }, 'Other mints (optional)'),
        mintBox,
      ),
      el(
        'p',
        { class: 'hint' },
        `The words do not say which mints they were used at. If the phrase was used at a mint that is not in your list, type its address here (https only, up to ${String(RESTORE_MINTS)}).`,
      ),
    ],
    submitLabel: 'Restore',
    ...(fields[0] === undefined ? {} : { focus: fields[0] }),
    secrets: fields,
    collect: () => {
      const mints = collectMints();
      if (!Array.isArray(mints)) return mints;
      const answer = (words: number[]): Answer =>
        mints.length > 0
          ? { kind: 'recovery-restore', words, mints }
          : { kind: 'recovery-restore', words };
      const typed = fields.map((f) => f.value.trim());
      if (typed.every((t) => t === '')) return answer([]);
      if (typed.some((t) => t === ''))
        return { error: 'Type all 12 words, or leave every field empty.' };
      const words: number[] = [];
      for (let n = 0; n < typed.length; n++) {
        const w = wordIndex(typed[n] ?? '');
        if (w === undefined)
          return { error: `Word ${String(n + 1)} is not a word from the recovery phrase list.` };
        words.push(w);
      }
      if (!phraseValid(words))
        return {
          error: 'These words are not a valid recovery phrase: check their spelling and order.',
        };
      return answer(words);
    },
  };
}

/**
 * The page's own check of the question main hands it (main already checked it against the IPC
 * guards; this is the page refusing to render anything else). ADR 0016: a question with words
 * carries exactly 12 indices into the page's list — never text — and a confirmation exactly
 * three ascending positions.
 */
export function isForm(x: unknown): x is WindowForm {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  const k = o['kind'];
  const keys = Object.keys(o).sort().join(',');
  if (k === 'recovery-show')
    return (
      keys === 'again,kind,words' &&
      typeof o['again'] === 'boolean' &&
      isIndexList(o['words'], PHRASE_WORDS, WORDS.length)
    );
  if (k === 'recovery-confirm') {
    const p = o['positions'];
    return (
      keys === 'kind,positions,retry' &&
      typeof o['retry'] === 'boolean' &&
      isIndexList(p, 3, PHRASE_WORDS) &&
      p.every((v, i) => i === 0 || v > (p[i - 1] ?? PHRASE_WORDS))
    );
  }
  if (k === 'recovery-restore') return keys === 'kind';
  if (k === 'recovery-reauth') return keys === 'kind,retry' && typeof o['retry'] === 'boolean';
  return (
    k === 'local-setup' ||
    k === 'unlock-passphrase' ||
    k === 'new-passphrase' ||
    k === 'import-nsec' ||
    k === 'bunker' ||
    k === 'create-wallet' ||
    k === 'remove-key' ||
    k === 'bunker-auth' ||
    k === 'open-link' ||
    k === 'top-up-first'
  );
}

export function mount(root: HTMLElement, api: PromptApi, q: WindowForm): void {
  const v = view(q);
  let sent = false;
  const error = el('p', { class: 'error', role: 'alert', hidden: true });
  const submit = el(
    'button',
    { type: 'submit', class: v.danger === true ? 'danger' : 'primary' },
    v.submitLabel,
  );
  const cancel = el('button', { type: 'button' }, v.cancelLabel ?? 'Cancel');
  const alt =
    v.alt === undefined ? null : el('button', { type: 'button', class: 'link' }, v.alt.label);
  const form = el(
    'form',
    { autocomplete: 'off', novalidate: true },
    el('h1', {}, v.title),
    ...v.body,
    error,
    el('div', { class: 'actions' }, ...(alt === null ? [] : [alt]), cancel, submit),
  );
  const clear = (): void => {
    for (const s of v.secrets ?? []) s.value = '';
  };
  /** The view's own cleanup (`onMount`'s return), run once the answer is sent. */
  const mounted: { off?: (() => void) | undefined } = {};
  const send = (a: Answer): void => {
    if (sent) return;
    sent = true;
    for (const c of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button'))
      c.disabled = true;
    clear();
    mounted.off?.();
    void api.answer(a === null && v.safeNo !== undefined ? v.safeNo : a);
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const a = v.collect(form);
    if (a !== null && 'error' in a) {
      error.textContent = a.error;
      error.hidden = false;
      return;
    }
    send(a);
  });
  cancel.addEventListener('click', () => {
    send(null);
  });
  if (alt !== null && v.alt !== undefined) {
    const answer = v.alt.answer;
    alt.addEventListener('click', () => {
      send(answer);
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') send(null);
  });
  root.replaceChildren(form);
  mounted.off = v.onMount?.();
  // A money-shaped, destructive or outward question defaults to its safe answer.
  (v.safeNo !== undefined ? cancel : (v.focus ?? submit)).focus();
}

async function start(): Promise<void> {
  const root = document.getElementById('root');
  const api = (window as unknown as { nutflixPrompt?: PromptApi }).nutflixPrompt;
  if (root === null || api === undefined) return;
  const q = await api.question().catch(() => null);
  if (!isForm(q)) {
    root.replaceChildren(el('p', {}, 'Nothing to ask.'));
    return;
  }
  mount(root, api, q);
}

if (typeof document !== 'undefined' && document.getElementById('root') !== null) void start();

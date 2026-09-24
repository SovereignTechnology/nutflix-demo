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
 */
import type { PromptForm } from '../../ipc/protocol.js';

interface PromptApi {
  question(): Promise<unknown>;
  answer(a: unknown): Promise<unknown>;
}

/** The same floor the host enforces (`MIN_NEW_PASSPHRASE_BYTES`, counted here in characters). */
export const MIN_PASSPHRASE_CHARS = 12;

type Answer =
  | {
      kind: 'local-setup';
      method: 'passphrase' | 'keychain';
      flow: 'unlock' | 'import' | 'generate';
    }
  | { kind: 'secret'; value: string }
  | { kind: 'bunker'; uri: string; remember: boolean }
  | { kind: 'create-wallet'; create: boolean }
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
}

function view(q: PromptForm): View {
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
        collect: () => ({ kind: 'create-wallet', create: true }),
      };
    }
  }
}

function isForm(x: unknown): x is PromptForm {
  if (typeof x !== 'object' || x === null) return false;
  const k = (x as { kind?: unknown }).kind;
  return (
    k === 'local-setup' ||
    k === 'unlock-passphrase' ||
    k === 'new-passphrase' ||
    k === 'import-nsec' ||
    k === 'bunker' ||
    k === 'create-wallet'
  );
}

export function mount(root: HTMLElement, api: PromptApi, q: PromptForm): void {
  const v = view(q);
  let sent = false;
  const error = el('p', { class: 'error', role: 'alert', hidden: true });
  const submit = el('button', { type: 'submit', class: 'primary' }, v.submitLabel);
  const cancel = el('button', { type: 'button' }, v.cancelLabel ?? 'Cancel');
  const form = el(
    'form',
    { autocomplete: 'off', novalidate: true },
    el('h1', {}, v.title),
    ...v.body,
    error,
    el('div', { class: 'actions' }, cancel, submit),
  );
  const clear = (): void => {
    for (const s of v.secrets ?? []) s.value = '';
  };
  const send = (a: Answer): void => {
    if (sent) return;
    sent = true;
    for (const c of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button'))
      c.disabled = true;
    clear();
    void api.answer(
      q.kind === 'create-wallet' && a === null ? { kind: 'create-wallet', create: false } : a,
    );
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
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') send(null);
  });
  root.replaceChildren(form);
  // A money-shaped question defaults to its safe answer.
  (q.kind === 'create-wallet' ? cancel : (v.focus ?? submit)).focus();
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

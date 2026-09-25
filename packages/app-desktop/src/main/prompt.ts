/**
 * Main's trusted prompt window (ADR 0013): where the user chooses how to unlock and types every
 * passphrase, nsec and bunker URI — never in the app's renderer, which handles untrusted content
 * (relay events, peer data) and could be compromised.
 *
 *   - The host asks (`HostOut` `prompt`, a data-only `PromptForm`); main shows ONE window at a
 *     time (the rest queue), modal to the app window, at its own origin `app://prompt` (so site
 *     isolation keeps it out of the app renderer's process), with its own preload that exposes
 *     two calls and nothing else.
 *   - The page pulls its question (`nf-prompt:init`) and sends its answer (`nf-prompt:answer`);
 *     both are accepted only from the CURRENT prompt window's webContents, top frame, at
 *     `app://prompt`. The IPC gate refuses that webContents for everything else (it is not an
 *     app webContents), so the page can reach nothing but its own question.
 *   - The answer is shape-checked and must fit the question (`promptAnswerFits`); text becomes
 *     UTF-8 bytes for the host and main's copy is wiped once posted (structured clone).
 *   - A NIP-46 `auth_url` (the one piece of upstream data a question carries, `https:` only) is
 *     opened by main — never the page — and only when the user clicks "Open in browser".
 *   - Closing the window is a cancel. The host's own deadline closes it (`prompt-cancel`); a host
 *     that went away closes everything (`cancelAll`).
 *   - Main asks one question of its own (security review F25): open an external link? It shares
 *     the one-at-a-time queue, never reaches the host, and survives a host restart.
 *
 * Electron-free: `main.ts` passes a window factory; the tests pass fakes.
 */
import { isAuthUrl, isExternalLink, promptAnswerFits } from '../ipc/guards.js';
import type { OpenLinkForm, PromptAnswer, PromptForm, WindowForm } from '../ipc/protocol.js';
import { MAX_SECRET_BYTES } from '../ipc/protocol.js';
import type { LogEvent } from './log.js';
import { APP_SCHEME, PROMPT_HOST } from './schemes.js';

export { PROMPT_CHANNEL } from '../ipc/protocol.js';

/** What the page sends: text, not bytes (`null` = cancel). */
export type PageAnswer =
  | Extract<
      PromptAnswer,
      | { kind: 'local-setup' }
      | { kind: 'create-wallet' }
      | { kind: 'remove-key' }
      | { kind: 'bunker-auth' }
    >
  | { readonly kind: 'secret'; readonly value: string }
  | { readonly kind: 'bunker'; readonly uri: string; readonly remember: boolean }
  | null;

/** The window main opened for one question. */
export interface PromptWindowLike {
  readonly webContentsId: number;
  close(): void;
  /** Called once when the window is gone (closed by the user or by `close()`). */
  onClosed(cb: () => void): void;
}

/** The sender of an `nf-prompt:*` message (the part of `IpcMainInvokeEvent` read here). */
export interface PromptSender {
  readonly senderId: number;
  /** The sending frame's URL; `null` parent = the top frame. */
  readonly frameUrl: string | undefined;
  readonly topFrame: boolean;
}

export interface PromptServiceDeps {
  /** Open a prompt window (modal to the app window) and load the prompt page. */
  openWindow(): PromptWindowLike;
  /** Deliver an answer to the host (`HostIn` `prompt-answer`). */
  answer(req: number, answer: PromptAnswer | null): void;
  /**
   * Open a NIP-46 approval page in the user's browser (`shell.openExternal`). Called only for a
   * `bunker-auth` question the user answered "Open in browser", with its URL re-checked.
   */
  openExternal?(url: string): void;
  readonly log?: (level: 'info' | 'warn', event: Extract<LogEvent, `prompt.${string}`>) => void;
}

const MAX_QUEUED = 8;

function wipe(a: PromptAnswer | null): void {
  if (a?.kind === 'secret') a.value.fill(0);
  else if (a?.kind === 'bunker') a.uri.fill(0);
}

function isOwnText(x: unknown, max: number): x is string {
  return typeof x === 'string' && x.length > 0 && x.length <= max && !x.includes('\u0000');
}

/** The page's answer → the host's, or `undefined` when it is not one. Pure; never throws. */
export function toPromptAnswer(raw: unknown): PromptAnswer | null | undefined {
  try {
    if (raw === null) return null;
    if (typeof raw !== 'object') return undefined;
    const o = raw as Record<string, unknown>;
    const keys = Object.keys(o).sort().join(',');
    const enc = (s: string): Uint8Array | undefined => {
      const b = new TextEncoder().encode(s);
      if (b.byteLength <= MAX_SECRET_BYTES) return b;
      b.fill(0);
      return undefined;
    };
    switch (o['kind']) {
      case 'local-setup':
        if (keys !== 'flow,kind,method') return undefined;
        if (o['method'] !== 'passphrase' && o['method'] !== 'keychain') return undefined;
        if (
          o['flow'] !== 'unlock' &&
          o['flow'] !== 'import' &&
          o['flow'] !== 'generate' &&
          o['flow'] !== 'remove'
        )
          return undefined;
        return { kind: 'local-setup', method: o['method'], flow: o['flow'] };
      case 'create-wallet':
        if (keys !== 'create,kind' || typeof o['create'] !== 'boolean') return undefined;
        return { kind: 'create-wallet', create: o['create'] };
      case 'remove-key':
        if (keys !== 'confirm,kind' || typeof o['confirm'] !== 'boolean') return undefined;
        return { kind: 'remove-key', confirm: o['confirm'] };
      case 'bunker-auth':
        if (keys !== 'kind,open' || typeof o['open'] !== 'boolean') return undefined;
        return { kind: 'bunker-auth', open: o['open'] };
      case 'secret': {
        if (keys !== 'kind,value' || !isOwnText(o['value'], MAX_SECRET_BYTES)) return undefined;
        const value = enc(o['value']);
        return value === undefined ? undefined : { kind: 'secret', value };
      }
      case 'bunker': {
        if (keys !== 'kind,remember,uri' || typeof o['remember'] !== 'boolean') return undefined;
        if (!isOwnText(o['uri'], MAX_SECRET_BYTES)) return undefined;
        const uri = enc(o['uri']);
        return uri === undefined ? undefined : { kind: 'bunker', uri, remember: o['remember'] };
      }
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/**
 * Is this frame the prompt page (exactly `app://prompt`)? Never throws. Scheme + host, not
 * `URL.origin`: Node's URL gives a custom scheme an opaque origin (`"null"`).
 */
export function isPromptUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.length > 4096) return false;
  try {
    const u = new URL(url);
    return (
      u.protocol === `${APP_SCHEME}:` &&
      u.host === PROMPT_HOST &&
      u.username === '' &&
      u.password === ''
    );
  } catch {
    return false;
  }
}

/** A queued question: the host's (answered through `deps.answer`), or main's own. */
type Queued =
  | { readonly req: number; readonly form: PromptForm; readonly local?: undefined }
  | { readonly req: number; readonly form: OpenLinkForm; readonly local: (open: boolean) => void };

type Current = Queued & {
  readonly win: PromptWindowLike;
  /** The host got its answer (or cancelled): a later close must not answer again. */
  settled: boolean;
};

/** The page's answer to an `open-link` question: `true` = open, `false`/`null` = no. */
export function toLinkAnswer(raw: unknown): boolean | undefined {
  if (raw === null) return false;
  if (typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).sort().join(',') !== 'kind,open' || o['kind'] !== 'open-link')
    return undefined;
  return typeof o['open'] === 'boolean' ? o['open'] : undefined;
}

export class PromptService {
  private readonly d: PromptServiceDeps;
  private queue: Queued[] = [];
  private current: Current | null = null;
  /** Main's own questions get negative ids, so they never collide with the host's. */
  private localSeq = 0;

  constructor(deps: PromptServiceDeps) {
    this.d = deps;
  }

  /** The host asks. Answered later through `deps.answer`, exactly once per `req`. */
  ask(req: number, form: PromptForm): void {
    if (this.current?.req === req || this.queue.some((q) => q.req === req)) return;
    if (this.queue.length >= MAX_QUEUED) {
      this.d.answer(req, null);
      return;
    }
    this.queue.push({ req, form });
    this.pump();
  }

  /**
   * Main's own question (F25): open `url`? `done(true)` only when the user chose to open; a close,
   * a cancel or a malformed answer is `false`. `false` = not asked (not a link main may open, or
   * the queue is full).
   */
  askLink(url: string, done: (open: boolean) => void): boolean {
    if (!isExternalLink(url) || this.queue.length >= MAX_QUEUED) return false;
    this.queue.push({ req: --this.localSeq, form: { kind: 'open-link', url }, local: done });
    this.pump();
    return true;
  }

  /** The host no longer needs `req` (its deadline): close it without answering. */
  cancel(req: number): void {
    this.queue = this.queue.filter((q) => q.req !== req);
    const c = this.current;
    if (c?.req === req) {
      c.settled = true;
      c.win.close();
    }
  }

  /** The host went away: close its questions, answer nothing (nobody is listening). Main's own stay. */
  cancelAll(): void {
    this.queue = this.queue.filter((q) => q.local !== undefined);
    const c = this.current;
    if (c !== null && c.local === undefined) {
      c.settled = true;
      c.win.close();
    }
  }

  /** The webContents of the open prompt window, if any (main hardens and routes by it). */
  get windowId(): number | null {
    return this.current?.win.webContentsId ?? null;
  }

  /** `nf-prompt:init`: the current question, only for the current prompt window. */
  init(s: PromptSender): WindowForm | null {
    const c = this.accept(s);
    return c === null ? null : c.form;
  }

  /** `nf-prompt:answer`: `true` when taken. A bad or misfitting answer is a cancel. */
  submit(s: PromptSender, raw: unknown): boolean {
    const c = this.accept(s);
    if (c === null) return false;
    c.settled = true;
    if (c.local !== undefined) {
      const open = toLinkAnswer(raw);
      if (open === undefined) this.d.log?.('warn', 'prompt.bad-answer');
      c.win.close();
      // Main's own copy of the URL, re-checked where it is used (`ExternalLinks`).
      c.local(open === true);
      return true;
    }
    const a = toPromptAnswer(raw);
    if (a === undefined || (a !== null && !promptAnswerFits(c.form, a))) {
      wipe(a ?? null);
      this.d.log?.('warn', 'prompt.bad-answer');
      this.d.answer(c.req, null);
    } else {
      // The approval page opens from HERE, on the user's click, with main's own copy of the URL.
      if (
        a?.kind === 'bunker-auth' &&
        a.open &&
        c.form.kind === 'bunker-auth' &&
        isAuthUrl(c.form.url)
      ) {
        try {
          this.d.openExternal?.(c.form.url);
        } catch {
          this.d.log?.('warn', 'prompt.open-failed');
        }
      }
      this.d.answer(c.req, a);
      // `answer` posts a structured clone to the host: main's copy is no longer needed.
      wipe(a);
    }
    c.win.close();
    return true;
  }

  private accept(s: PromptSender): Current | null {
    const c = this.current;
    if (c === null || c.settled) return null;
    if (s.senderId !== c.win.webContentsId || !s.topFrame || !isPromptUrl(s.frameUrl)) {
      this.d.log?.('warn', 'prompt.refused-sender');
      return null;
    }
    return c;
  }

  private pump(): void {
    if (this.current !== null) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    let win: PromptWindowLike;
    try {
      win = this.d.openWindow();
    } catch {
      this.d.log?.('warn', 'prompt.window-failed');
      if (next.local !== undefined) next.local(false);
      else this.d.answer(next.req, null);
      this.pump();
      return;
    }
    const cur: Current = { ...next, win, settled: false };
    this.current = cur;
    win.onClosed(() => {
      if (this.current !== cur) return;
      this.current = null;
      if (!cur.settled) {
        if (cur.local !== undefined) cur.local(false);
        else this.d.answer(cur.req, null);
      }
      this.pump();
    });
  }
}

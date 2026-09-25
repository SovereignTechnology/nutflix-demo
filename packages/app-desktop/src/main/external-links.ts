/**
 * External links (security review F25). A link the user clicks in the app (a Markdown link in a
 * description, `target="_blank"`) reaches main as a window-open request, which is always denied.
 * Main then asks in its own trusted prompt window, which shows the link's real HOST (the ASCII,
 * IDNA-encoded form: no look-alike Unicode). The user's browser opens main's own copy of the URL,
 * and only on their click.
 *
 *   - `https:` only, the same rule as a NIP-46 approval link (`isExternalLink`), re-checked
 *     after `URL` normalises it. Anything else is refused and logged, never shown.
 *   - Only from the app's own webContents: the prompt window, devtools or anything else asks
 *     nothing.
 *   - One question at a time, and at most `LINK_LIMIT` per `LINK_WINDOW_MS`: a page cannot
 *     bury the user in prompts.
 *
 * Electron-free: `main.ts` passes the prompt service and `shell.openExternal`.
 */
import { isExternalLink } from '../ipc/guards.js';
import type { LogEvent } from './log.js';

/** Questions per window, and the window (ms). */
export const LINK_LIMIT = 5;
export const LINK_WINDOW_MS = 60_000;

export interface ExternalLinksDeps {
  /** Ask the user (`PromptService.askLink`); `false` when it could not ask. */
  ask(url: string, done: (open: boolean) => void): boolean;
  /** Open in the user's browser (`shell.openExternal`). */
  open(url: string): void;
  now(): number;
  readonly log?: (level: 'info' | 'warn', event: Extract<LogEvent, `link.${string}`>) => void;
}

/** The link as main will open it, or `undefined` when main may not. Never throws. */
export function externalLink(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !isExternalLink(raw)) return undefined;
  let href: string;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.host === '')
      return undefined;
    href = u.href;
  } catch {
    return undefined;
  }
  // What `URL` made of it must still pass the rule (it percent-encodes, lower-cases the host).
  return isExternalLink(href) ? href : undefined;
}

export class ExternalLinks {
  private busy = false;
  private asked: number[] = [];

  constructor(private readonly d: ExternalLinksDeps) {}

  /** A window-open request from webContents `fromApp` (is it the app's own?). Never throws. */
  request(raw: unknown, fromApp: boolean): void {
    const url = fromApp ? externalLink(raw) : undefined;
    if (url === undefined) {
      this.d.log?.('warn', 'link.refused');
      return;
    }
    if (this.busy) {
      this.d.log?.('info', 'link.busy');
      return;
    }
    const now = this.d.now();
    this.asked = this.asked.filter((t) => now - t < LINK_WINDOW_MS);
    if (this.asked.length >= LINK_LIMIT) {
      this.d.log?.('warn', 'link.throttled');
      return;
    }
    this.asked.push(now);
    this.busy = true;
    const asked = this.d.ask(url, (open) => {
      this.busy = false;
      if (!open) return;
      try {
        this.d.open(url);
        this.d.log?.('info', 'link.opened');
      } catch {
        this.d.log?.('warn', 'link.open-failed');
      }
    });
    if (!asked) {
      this.busy = false;
      this.d.log?.('warn', 'link.refused');
    }
  }
}

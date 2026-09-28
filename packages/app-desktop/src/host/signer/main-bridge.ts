/**
 * The host's side of main's trusted prompt window and OS-keychain store (ADR 0013): `HostOut`
 * `prompt` / `prompt-cancel` / `keychain` out, `HostIn` `prompt-answer` / `keychain-result` in,
 * matched by request id. ADR 0016 adds main's native dialog: `confirm` / `confirm-cancel` out,
 * `confirm-result` in.
 *
 * An answer must fit the question: the wrong kind, an unlock method or flow the question did not
 * offer, or a keychain value nobody asked for is treated as a cancel and any secret in it is wiped.
 * Every request is bounded in time; `cancelAll` (host shutdown) settles everything as cancelled.
 */
import { signer as signerMod } from '@sovit/core';

import { promptAnswerFits } from '../../ipc/guards.js';
import type {
  ConfirmForm,
  HostOut,
  KeychainSlot,
  PromptAnswer,
  PromptForm,
} from '../../ipc/protocol.js';

import type { Timers } from '../worker/supervisor.js';

/** How long the prompt window may stay open before the host gives up on it. */
export const PROMPT_TIMEOUT_MS = 5 * 60_000;
/**
 * ADR 0016: a NEW or re-shown recovery phrase (`recovery-show`) — the user is writing 12 words
 * down, which can take longer than any other question; the page hides the words itself after
 * two minutes or on blur (independent review IR9). A timeout discards a new phrase.
 */
export const RECOVERY_SHOW_TIMEOUT_MS = 30 * 60_000;
/** How long a keychain operation may take (safeStorage can wait on the OS keyring's own prompt). */
export const KEYCHAIN_TIMEOUT_MS = 60_000;
/** ADR 0016: how long main's native dialog may stay unanswered before it counts as "no". */
export const CONFIRM_TIMEOUT_MS = 5 * 60_000;

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

export interface MainBridgeOptions {
  readonly post: (out: HostOut) => void;
  readonly timers?: Timers;
  readonly promptTimeoutMs?: number;
  readonly recoveryShowTimeoutMs?: number;
  readonly keychainTimeoutMs?: number;
  readonly confirmTimeoutMs?: number;
}

export interface KeychainResult {
  readonly ok: boolean;
  /** A `get` that found a value; the caller wipes it. */
  readonly value: Uint8Array | null;
}

interface PendingPrompt {
  readonly form: PromptForm;
  readonly resolve: (a: PromptAnswer | null) => void;
  readonly timer: unknown;
}
interface PendingConfirm {
  readonly resolve: (ok: boolean) => void;
  readonly timer: unknown;
}
interface PendingKeychain {
  readonly op: 'get' | 'put' | 'forget';
  readonly resolve: (r: KeychainResult) => void;
  readonly timer: unknown;
}

/**
 * Wipe any secret an answer carries — ADR 0016: the word indices of a confirmation or a typed
 * phrase too (numbers, zeroed as far as JS allows; independent review IR11).
 */
export function wipeAnswer(a: PromptAnswer | null | undefined): void {
  if (a?.kind === 'secret') signerMod.wipe(a.value);
  else if (a?.kind === 'bunker') signerMod.wipe(a.uri);
  else if (a?.kind === 'recovery-confirm' || a?.kind === 'recovery-restore')
    (a.words as number[]).fill(0);
}

export class MainBridge {
  private readonly o: MainBridgeOptions;
  private readonly timers: Timers;
  private next = 1;
  private readonly prompts = new Map<number, PendingPrompt>();
  private readonly keychainReqs = new Map<number, PendingKeychain>();
  private readonly confirms = new Map<number, PendingConfirm>();
  private closed = false;

  constructor(o: MainBridgeOptions) {
    this.o = o;
    this.timers = o.timers ?? realTimers;
  }

  private id(): number {
    const id = this.next;
    this.next = this.next >= 0x7fffffff ? 1 : this.next + 1;
    return id;
  }

  /** Ask the user; `null` = cancelled, closed, timed out, or an answer that did not fit. */
  ask(form: PromptForm): Promise<PromptAnswer | null> {
    if (this.closed) return Promise.resolve(null);
    const req = this.id();
    return new Promise((resolve) => {
      const ms =
        form.kind === 'recovery-show'
          ? (this.o.recoveryShowTimeoutMs ?? RECOVERY_SHOW_TIMEOUT_MS)
          : (this.o.promptTimeoutMs ?? PROMPT_TIMEOUT_MS);
      const timer = this.timers.setTimeout(() => {
        if (!this.prompts.delete(req)) return;
        this.o.post({ kind: 'prompt-cancel', req });
        resolve(null);
      }, ms);
      this.prompts.set(req, { form, resolve, timer });
      this.o.post({ kind: 'prompt', req, form });
    });
  }

  /**
   * ADR 0016: ask in main's native dialog (Cancel the default). `true` only for the confirm
   * button; a timeout, a host shutdown or a dialog that could not open is `false`. A timeout
   * tells main to close the dialog (`confirm-cancel`, round-8 review): left open, a later click
   * would answer nobody while main refused every other confirm.
   */
  confirm(form: ConfirmForm): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    const req = this.id();
    return new Promise((resolve) => {
      const timer = this.timers.setTimeout(() => {
        if (!this.confirms.delete(req)) return;
        this.o.post({ kind: 'confirm-cancel', req });
        resolve(false);
      }, this.o.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS);
      this.confirms.set(req, { resolve, timer });
      this.o.post({ kind: 'confirm', req, form });
    });
  }

  /** `HostIn` `confirm-result`: answers only a question still waiting. */
  onConfirmResult(req: number, ok: boolean): void {
    const c = this.confirms.get(req);
    if (c === undefined) return;
    this.confirms.delete(req);
    this.timers.clearTimeout(c.timer);
    c.resolve(ok);
  }

  /** Main's keychain store. Never rejects: a failure is `{ ok: false }`. */
  keychain(op: 'get' | 'forget', slot: KeychainSlot): Promise<KeychainResult>;
  keychain(op: 'put', slot: KeychainSlot, value: Uint8Array): Promise<KeychainResult>;
  keychain(
    op: 'get' | 'put' | 'forget',
    slot: KeychainSlot,
    value?: Uint8Array,
  ): Promise<KeychainResult> {
    if (this.closed || (op === 'put') !== (value !== undefined))
      return Promise.resolve({ ok: false, value: null });
    const req = this.id();
    return new Promise((resolve) => {
      const timer = this.timers.setTimeout(() => {
        if (this.keychainReqs.delete(req)) resolve({ ok: false, value: null });
      }, this.o.keychainTimeoutMs ?? KEYCHAIN_TIMEOUT_MS);
      this.keychainReqs.set(req, { op, resolve, timer });
      // Structured clone copies `value`; the caller keeps (and wipes) its own buffer.
      this.o.post(
        value === undefined
          ? { kind: 'keychain', req, op, slot }
          : { kind: 'keychain', req, op, slot, value },
      );
    });
  }

  /** `HostIn` `prompt-answer` (already shape-checked by `isHostIn`). */
  onPromptAnswer(req: number, answer: PromptAnswer | null): void {
    const p = this.prompts.get(req);
    if (p === undefined) {
      wipeAnswer(answer);
      return;
    }
    this.prompts.delete(req);
    this.timers.clearTimeout(p.timer);
    if (answer !== null && !promptAnswerFits(p.form, answer)) {
      wipeAnswer(answer);
      p.resolve(null);
      return;
    }
    p.resolve(answer);
  }

  /** `HostIn` `keychain-result`. A value only ever answers a `get`. */
  onKeychainResult(req: number, ok: boolean, value: Uint8Array | null): void {
    const k = this.keychainReqs.get(req);
    if (k === undefined) {
      signerMod.wipe(value);
      return;
    }
    this.keychainReqs.delete(req);
    this.timers.clearTimeout(k.timer);
    if (k.op !== 'get' && value !== null) {
      signerMod.wipe(value);
      k.resolve({ ok, value: null });
      return;
    }
    k.resolve({ ok, value: ok ? value : null });
  }

  /** Host shutdown: close every prompt and dialog, settle everything as cancelled / failed. */
  cancelAll(): void {
    this.closed = true;
    for (const [req, p] of this.prompts) {
      this.timers.clearTimeout(p.timer);
      this.o.post({ kind: 'prompt-cancel', req });
      p.resolve(null);
    }
    this.prompts.clear();
    for (const [, k] of this.keychainReqs) {
      this.timers.clearTimeout(k.timer);
      k.resolve({ ok: false, value: null });
    }
    this.keychainReqs.clear();
    for (const [req, c] of this.confirms) {
      this.timers.clearTimeout(c.timer);
      this.o.post({ kind: 'confirm-cancel', req });
      c.resolve(false);
    }
    this.confirms.clear();
  }
}

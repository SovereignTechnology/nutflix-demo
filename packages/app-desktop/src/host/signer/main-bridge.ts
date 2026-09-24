/**
 * The host's side of main's trusted prompt window and OS-keychain store (ADR 0013): `HostOut`
 * `prompt` / `prompt-cancel` / `keychain` out, `HostIn` `prompt-answer` / `keychain-result` in,
 * matched by request id.
 *
 * An answer must fit the question: the wrong kind, an unlock method or flow the question did not
 * offer, or a keychain value nobody asked for is treated as a cancel and any secret in it is wiped.
 * Every request is bounded in time; `cancelAll` (host shutdown) settles everything as cancelled.
 */
import { signer as signerMod } from '@sovit/core';

import { promptAnswerFits } from '../../ipc/guards.js';
import type { HostOut, KeychainSlot, PromptAnswer, PromptForm } from '../../ipc/protocol.js';

import type { Timers } from '../worker/supervisor.js';

/** How long the prompt window may stay open before the host gives up on it. */
export const PROMPT_TIMEOUT_MS = 5 * 60_000;
/** How long a keychain operation may take (safeStorage can wait on the OS keyring's own prompt). */
export const KEYCHAIN_TIMEOUT_MS = 60_000;

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
  readonly keychainTimeoutMs?: number;
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
interface PendingKeychain {
  readonly op: 'get' | 'put' | 'forget';
  readonly resolve: (r: KeychainResult) => void;
  readonly timer: unknown;
}

/** Wipe any secret an answer carries. */
export function wipeAnswer(a: PromptAnswer | null | undefined): void {
  if (a?.kind === 'secret') signerMod.wipe(a.value);
  else if (a?.kind === 'bunker') signerMod.wipe(a.uri);
}

export class MainBridge {
  private readonly o: MainBridgeOptions;
  private readonly timers: Timers;
  private next = 1;
  private readonly prompts = new Map<number, PendingPrompt>();
  private readonly keychainReqs = new Map<number, PendingKeychain>();
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
      const timer = this.timers.setTimeout(() => {
        if (!this.prompts.delete(req)) return;
        this.o.post({ kind: 'prompt-cancel', req });
        resolve(null);
      }, this.o.promptTimeoutMs ?? PROMPT_TIMEOUT_MS);
      this.prompts.set(req, { form, resolve, timer });
      this.o.post({ kind: 'prompt', req, form });
    });
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

  /** Host shutdown: close every prompt, settle everything as cancelled / failed. */
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
  }
}

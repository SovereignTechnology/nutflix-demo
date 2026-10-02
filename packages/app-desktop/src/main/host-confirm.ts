/**
 * ADR 0016: questions the HOST asks main to put in a native dialog (`HostOut` `confirm`,
 * answered by `HostIn` `confirm-result`) — the reissue of the balance under the recovery phrase
 * with its fee, and the re-authentication of a signer that has no local passphrase before the
 * phrase is shown again or replaced (each worded for what it does).
 *
 * Like the confirm gate (`money-gate.ts`): the form is data only (`isConfirmForm`, checked by
 * `isHostOut` before it gets here), every word of the dialog is built here, Cancel is the
 * default button and the Escape answer. One dialog at a time: a second question while one is
 * open is answered "no" at once. A host that went away gets no answer (a new host never asked).
 *
 * Round 8 (final panel): a dialog the host stopped waiting for — its `confirm-cancel` (the
 * host's deadline passed, or it shut down) or the host gone — is CLOSED (Electron's `signal`
 * option; the dialog behaves as if cancelled) and its answer dropped. Before, it stayed on
 * screen: a later "Move it" answered nobody, and until it was dismissed every other host confirm,
 * a restarted host's included, was refused as busy. Where the dialog cannot be closed (macOS runs
 * a message box with no parent window synchronously, so main handles nothing until it is
 * answered), its answer is still dropped, and the next question is not refused.
 *
 * Electron-free: `main.ts` passes the dialog (`dialog.showMessageBox`); the tests pass a fake.
 */
import type { ConfirmForm, TopUpHoldReason } from '../ipc/protocol.js';
import type { LogEvent } from './log.js';
import type { ConfirmPrompt } from './money-gate.js';

function sats(n: number): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'sat' : 'sats'}`;
}

/** A mint URL's host (`URL` gives an ASCII, IDNA-encoded host: no look-alike Unicode). */
function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(invalid address)';
  }
}

/** The dialog for a host's question. Pure. */
export function describeHostConfirm(form: ConfirmForm): ConfirmPrompt {
  switch (form.kind) {
    case 'recovery-reissue': {
      const total = form.plans.reduce((n, p) => n + p.amount, 0);
      const fees = form.plans.reduce((n, p) => n + p.feeSats, 0);
      const lines = form.plans.map(
        (p) => `  • ${host(p.mint)}: ${sats(p.amount)}, fee ${sats(p.feeSats)}`,
      );
      return {
        title: 'Back up your balance',
        message: `Move ${sats(total)} under your recovery phrase? The mints charge ${sats(fees)} in fees.`,
        detail: [
          'Your ecash is swapped once, at each mint, into ecash your recovery phrase can restore:',
          ...lines,
          '',
          `You keep ${sats(total - fees)}. If you cancel, this balance is not covered by the phrase until it is spent; you can finish later in Settings.`,
        ].join('\n'),
        confirmLabel: `Move it (fee ${sats(fees)})`,
      };
    }
    case 'recovery-reveal':
      return {
        title: 'Show recovery phrase',
        message: 'Show your recovery phrase on screen?',
        detail:
          'Anyone who sees these 12 words can take your ecash. Make sure no one is watching and nothing is recording or sharing your screen.',
        confirmLabel: 'Show phrase',
      };
    case 'recovery-rotate':
      return {
        title: 'Replace recovery phrase',
        message: 'Replace your recovery phrase with a new one?',
        detail:
          'Nutflix makes a new 12-word phrase for this device and shows it next: write it down. Your balance is then moved under the new phrase (the mints’ fee is shown first), and the old phrase stops covering new ecash.',
        confirmLabel: 'Replace phrase',
      };
    case 'topup-resume': {
      const mint = host(form.target);
      return {
        title: 'Auto top-up paused',
        message: `Resume auto top-ups into ${mint}?`,
        detail: [
          `An earlier auto top-up of ${sats(form.amount)} into ${mint} is not finished. ${HOLD_WHY[form.reason]}`,
          '',
          'Resuming lets new auto top-ups into this mint run again. The earlier one is not cancelled: Nutflix keeps checking it, and if the mint pays it, the sats are added to your wallet.',
        ].join('\n'),
        confirmLabel: 'Resume top-ups',
      };
    }
  }
}

/** R5-R1: why a held top-up is held, in the words of the resume dialog. */
const HOLD_WHY: Readonly<Record<TopUpHoldReason, string>> = {
  checking: 'Nutflix has not checked it with the mint since it started.',
  unreadable:
    'Its record could not be opened. Your signer may simply be offline right now (a remote signer that is not answering): if so, waiting may clear this by itself.',
  unreachable: 'The mint could not be asked about it, or no longer knows it.',
  owed: 'The payment left your other mint, but this mint has not credited it yet. It may still arrive: if you resume, this mint could be topped up twice.',
  waiting: 'The mints have not settled it yet.',
};

export interface HostConfirmsDeps {
  /**
   * Show `prompt` natively; resolve `true` only for the confirm button. When `signal` aborts,
   * close the dialog (Electron's `showMessageBox` `signal`).
   */
  ask(prompt: ConfirmPrompt, signal: AbortSignal): Promise<unknown>;
  /** Deliver `confirm-result` to the host (`false` when the host is not running). */
  answer(req: number, ok: boolean): void;
  readonly log?: (level: 'warn', event: Extract<LogEvent, `confirm.${string}`>) => void;
}

/** The dialog on screen: whose question it answers, and how to close it. */
interface OpenDialog {
  readonly req: number;
  readonly abort: AbortController;
}

export class HostConfirms {
  private readonly d: HostConfirmsDeps;
  /** The one dialog a host is waiting on; `undefined` once answered, cancelled or orphaned. */
  private current: OpenDialog | undefined;

  constructor(deps: HostConfirmsDeps) {
    this.d = deps;
  }

  /** The host asks (`HostOut` `confirm`, already `isHostOut`-checked). Never throws. */
  ask(req: number, form: ConfirmForm): void {
    if (this.current !== undefined) {
      this.d.log?.('warn', 'confirm.busy');
      this.d.answer(req, false);
      return;
    }
    let prompt: ConfirmPrompt;
    try {
      prompt = describeHostConfirm(form);
    } catch {
      this.d.log?.('warn', 'confirm.failed');
      this.d.answer(req, false);
      return;
    }
    const open: OpenDialog = { req, abort: new AbortController() };
    this.current = open;
    void Promise.resolve()
      .then(() => this.d.ask(prompt, open.abort.signal))
      .then(
        (r) => r === true,
        () => {
          this.d.log?.('warn', 'confirm.failed');
          return false;
        },
      )
      .then((ok) => {
        if (this.current === open) this.current = undefined;
        // Closed because nobody waits for it (cancelled, host gone): the answer goes nowhere.
        if (!open.abort.signal.aborted) this.d.answer(req, ok);
      });
  }

  /** `HostOut` `confirm-cancel`: the host stopped waiting for `req` — close its dialog. */
  cancel(req: number): void {
    if (this.current?.req === req) this.close(this.current);
  }

  /** The host went away: nobody is waiting for an open dialog's answer — close it. */
  hostGone(): void {
    if (this.current !== undefined) this.close(this.current);
  }

  /** Close `open`, drop its answer, and free the slot for the next question at once. */
  private close(open: OpenDialog): void {
    this.current = undefined;
    open.abort.abort();
  }
}

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
 * Electron-free: `main.ts` passes the dialog (`dialog.showMessageBox`); the tests pass a fake.
 */
import type { ConfirmForm } from '../ipc/protocol.js';
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
  }
}

export interface HostConfirmsDeps {
  /** Show `prompt` natively; resolve `true` only for the confirm button. */
  ask(prompt: ConfirmPrompt): Promise<unknown>;
  /** Deliver `confirm-result` to the host (`false` when the host is not running). */
  answer(req: number, ok: boolean): void;
  readonly log?: (level: 'warn', event: Extract<LogEvent, `confirm.${string}`>) => void;
}

export class HostConfirms {
  private readonly d: HostConfirmsDeps;
  private open = false;
  /** Bumped when the host goes away: an answer for the old host is dropped. */
  private gen = 0;

  constructor(deps: HostConfirmsDeps) {
    this.d = deps;
  }

  /** The host asks (`HostOut` `confirm`, already `isHostOut`-checked). Never throws. */
  ask(req: number, form: ConfirmForm): void {
    if (this.open) {
      this.d.log?.('warn', 'confirm.busy');
      this.d.answer(req, false);
      return;
    }
    this.open = true;
    const gen = this.gen;
    let prompt: ConfirmPrompt;
    try {
      prompt = describeHostConfirm(form);
    } catch {
      this.open = false;
      this.d.log?.('warn', 'confirm.failed');
      this.d.answer(req, false);
      return;
    }
    void Promise.resolve()
      .then(() => this.d.ask(prompt))
      .then(
        (r) => r === true,
        () => {
          this.d.log?.('warn', 'confirm.failed');
          return false;
        },
      )
      .then((ok) => {
        this.open = false;
        if (gen === this.gen) this.d.answer(req, ok);
      });
  }

  /** The host went away: nobody is waiting for an open dialog's answer. */
  hostGone(): void {
    this.gen++;
  }
}

/**
 * R5-R1 (Cameron, 2026-10-02): auto top-ups held back for a mint, shown in the Auto top-up group,
 * each with a Resume button. Shell-provided (the desktop's `desktop.wallet.topUp.*`): the page
 * names a held top-up only; the host asks main's native dialog, which says what resuming means, and
 * a resumed hold is waived — still watched, never deleted. Absent controls (web, mocks), or no
 * hold: nothing is shown.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { MintUrl, Sats } from '@sovit/core';
import { Button, SatsBadge, mintHost } from '../../components/index.js';
import { Note } from './controls.js';
import { errorMessage } from './model.js';

/** Why a held top-up holds back its target (the host's `TopUpHoldReason`). */
export type TopUpHoldReason = 'checking' | 'unreadable' | 'unreachable' | 'owed' | 'waiting';

export interface TopUpHoldView {
  readonly id: string;
  readonly target: MintUrl;
  readonly amount: Sats;
  readonly reason: TopUpHoldReason;
}

/** The shell's held top-ups; `resume` resolves `false` when main's dialog was not confirmed. */
export interface TopUpHoldControls {
  holds(): Promise<readonly TopUpHoldView[]>;
  resume(id: string): Promise<boolean>;
}

const WHY: Readonly<Record<TopUpHoldReason, string>> = {
  checking: 'not checked yet',
  unreadable: 'its record could not be opened (your signer may be offline)',
  unreachable: 'the mint could not be asked about it',
  owed: 'the payment left your other mint and has not arrived yet',
  waiting: 'the mints have not settled it yet',
};

export function TopUpHolds({
  id,
  controls,
}: {
  readonly id: string;
  readonly controls?: TopUpHoldControls | undefined;
}): ReactElement | null {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [holds, setHolds] = useState<readonly TopUpHoldView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const refresh = useCallback((): void => {
    if (controls === undefined) return;
    controls.holds().then(
      (h) => {
        if (alive.current) setHolds(h);
      },
      () => undefined, // nothing to show: the group keeps working without it
    );
  }, [controls]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  if (controls === undefined || (holds.length === 0 && error === null && done === null))
    return null;

  const resume = (h: TopUpHoldView): void => {
    if (busy !== null) return;
    setBusy(h.id);
    setError(null);
    setDone(null);
    controls.resume(h.id).then(
      (yes) => {
        if (!alive.current) return;
        setBusy(null);
        if (yes) setDone(`Auto top-ups into ${mintHost(h.target)} run again.`);
        refresh();
      },
      (err: unknown) => {
        if (!alive.current) return;
        setBusy(null);
        const msg = errorMessage(err).replace(/^[a-z-]+:\s*/, '');
        setError(msg === '' ? 'That did not work. Try again.' : msg);
        refresh();
      },
    );
  };

  return (
    <div className="nf-settings__holds" id={`${id}-holds`}>
      {holds.map((h) => (
        <Note key={h.id} tone="warning" id={`${id}-hold-${h.id}`}>
          Auto top-up paused for <strong>{mintHost(h.target)}</strong>: an earlier top-up of{' '}
          <SatsBadge sats={h.amount} variant="neutral" size="sm" /> is not finished —{' '}
          {WHY[h.reason]}.{' '}
          <Button
            variant="secondary"
            size="sm"
            loading={busy === h.id}
            disabled={busy !== null && busy !== h.id}
            onClick={() => {
              resume(h);
            }}
            aria-describedby={`${id}-hold-${h.id}`}
          >
            Resume
          </Button>
        </Note>
      ))}
      {done !== null ? <p role="status">{done}</p> : null}
      {error !== null ? (
        <p role="alert" className="nf-settings__error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

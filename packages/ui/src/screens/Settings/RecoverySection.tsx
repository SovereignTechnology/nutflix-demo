/**
 * Settings › Wallet › Recovery phrase (ADR 0016, issue #3): whether this device's ecash is
 * covered by a 12-word recovery phrase, and the four actions — set up, finish the backup of the
 * old balance, show the words again, restore.
 *
 * This screen never sees a word. The shell passes `recovery` (desktop: `desktop.wallet.recovery.*`),
 * whose calls only NAME an action: the words are shown and typed in the desktop's own trusted
 * window, and the reissue fee is confirmed in a native dialog, both outside this renderer. What
 * comes back is a state, amounts, counts and the user's own mint addresses. Without `recovery`
 * the section says the phrase is not available here — on the web: not covered (the web app keeps
 * no phrase).
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { MintUrl, NetworkAdapter, Sats } from '@sovit/core';
import { Button, Skeleton, formatSats, mintHost } from '../../components/index.js';
import { Note, SectionFrame } from './controls.js';
import { errorMessage } from './model.js';

/** Where this device's recovery phrase stands (the desktop's `RecoveryState`). */
export type RecoveryState =
  'covered' | 'not-confirmed' | 'not-on-device' | 'unreadable' | 'unavailable';

export interface RecoveryStatusView {
  readonly state: RecoveryState;
  /** The balance held before the phrase is not all under it yet. */
  readonly reissuePending: boolean;
  /** The encrypted copy reached at least one of the user's relays. */
  readonly relayCopy: boolean;
}

export type RecoveryRestoreOutcome =
  'restored' | 'nothing' | 'unsupported' | 'unreachable' | 'refused';

export interface RecoveryRestoreView {
  readonly phrases: number;
  readonly reports: readonly {
    readonly mint: MintUrl;
    readonly outcome: RecoveryRestoreOutcome;
    readonly restoredSats: Sats;
  }[];
}

export interface RecoverySetupView {
  readonly status: RecoveryStatusView;
  readonly reissuedSats: Sats;
  readonly feeSats: Sats;
  readonly reissueFailed: number;
}

export interface RecoveryProgressView {
  readonly phrase: number;
  readonly phrases: number;
  readonly mint: MintUrl;
  readonly keysetsDone: number;
  readonly keysets: number;
}

/** The shell's recovery phrase flows (each names an action; the words stay outside this screen). */
export interface RecoveryControls {
  status(): Promise<RecoveryStatusView>;
  setup(): Promise<RecoverySetupView>;
  show(): Promise<unknown>;
  restore(): Promise<RecoveryRestoreView>;
  /** A restore's progress (optional). */
  onProgress?(cb: (p: RecoveryProgressView) => void): () => void;
}

type Busy = 'setup' | 'show' | 'restore' | null;

/** `cancelled` = the user closed the trusted window: nothing to say. */
function isCancel(err: unknown): boolean {
  return errorMessage(err).startsWith('cancelled');
}

function flowError(err: unknown): string {
  const msg = errorMessage(err);
  if (msg.startsWith('rate-limited'))
    return 'Too many windows were closed in a row. Try again in a minute.';
  const detail = msg.replace(/^[a-z-]+:\s*/, '');
  return detail === '' ? 'That did not work. Try again.' : detail;
}

const OUTCOME: Readonly<Record<RecoveryRestoreOutcome, string>> = {
  restored: 'restored',
  nothing: 'nothing to restore',
  unsupported: 'cannot restore here (the mint does not support it)',
  unreachable: 'could not be reached',
  refused: 'refused the restore',
};

export function RecoverySection({
  id,
  adapter,
  recovery,
  signedIn,
  headingRef,
}: {
  readonly id: string;
  readonly adapter: Pick<NetworkAdapter, 'platform'>;
  readonly recovery?: RecoveryControls | undefined;
  readonly signedIn: boolean;
  readonly headingRef?: ((el: HTMLHeadingElement | null) => void) | undefined;
}): ReactElement {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [status, setStatus] = useState<RecoveryStatusView | 'loading' | 'error'>('loading');
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [progress, setProgress] = useState<RecoveryProgressView | null>(null);
  const [report, setReport] = useState<RecoveryRestoreView | null>(null);

  const refresh = useCallback((): void => {
    if (recovery === undefined) return;
    recovery.status().then(
      (s) => {
        if (alive.current) setStatus(s);
      },
      () => {
        if (alive.current) setStatus('error');
      },
    );
  }, [recovery]);
  useEffect(() => {
    refresh();
  }, [refresh, signedIn]);

  const description =
    'Twelve words that bring back the ecash made on this device if the device, your relays or your key are lost.';

  if (recovery === undefined) {
    return (
      <SectionFrame
        id={id}
        title="Recovery phrase"
        description={description}
        headingRef={headingRef}
      >
        {adapter.platform === 'web' ? (
          <Note tone="warning" id={`${id}-web`}>
            Not covered. The web app keeps no recovery phrase: ecash held here can be brought back
            only from your relays. Use the desktop app to back your wallet up with 12 words.
          </Note>
        ) : (
          <Note id={`${id}-none`}>The recovery phrase is not available in this mode.</Note>
        )}
      </SectionFrame>
    );
  }

  const run = <T,>(
    which: Exclude<Busy, null>,
    f: () => Promise<T>,
    after?: (r: T) => void,
  ): void => {
    if (busy !== null) return;
    setBusy(which);
    setError(null);
    setDone(null);
    if (which === 'restore') {
      setReport(null);
      setProgress(null);
    }
    const off =
      which === 'restore'
        ? recovery.onProgress?.((p) => {
            if (alive.current) setProgress(p);
          })
        : undefined;
    f().then(
      (r) => {
        off?.();
        if (!alive.current) return;
        setBusy(null);
        setProgress(null);
        after?.(r);
        refresh();
      },
      (err: unknown) => {
        off?.();
        if (!alive.current) return;
        setBusy(null);
        setProgress(null);
        if (!isCancel(err)) setError(flowError(err));
        refresh();
      },
    );
  };

  const onSetup = (): void => {
    run(
      'setup',
      () => recovery.setup(),
      (r) => {
        const moved =
          r.reissuedSats > 0
            ? ` ${formatSats(r.reissuedSats)} moved under it (fee ${formatSats(r.feeSats)}).`
            : '';
        const left =
          r.reissueFailed > 0
            ? ` The balance at ${String(r.reissueFailed)} ${r.reissueFailed === 1 ? 'mint is' : 'mints are'} not covered yet: finish the backup later.`
            : '';
        setDone(`Recovery phrase saved on this device.${moved}${left}`);
      },
    );
  };
  const onShow = (): void => {
    run('show', () => recovery.show());
  };
  const onRestore = (): void => {
    run(
      'restore',
      () => recovery.restore(),
      (r) => {
        setReport(r);
      },
    );
  };

  const renderStatus = (): ReactElement => {
    if (status === 'loading')
      return (
        <div aria-hidden="true">
          <Skeleton variant="text" width="60%" />
        </div>
      );
    if (status === 'error')
      return <Note tone="warning">Could not read the recovery phrase status. Try again.</Note>;
    switch (status.state) {
      case 'covered':
        return (
          <Note tone="success" id={`${id}-state`}>
            Covered. This device&apos;s recovery phrase is here, and you confirmed you wrote it
            down.
          </Note>
        );
      case 'not-confirmed':
        return (
          <Note tone="warning" id={`${id}-state`}>
            Not confirmed. This device has a recovery phrase, but you have not confirmed writing it
            down. Show it again to check your copy.
          </Note>
        );
      case 'not-on-device':
        return (
          <Note tone="warning" id={`${id}-state`}>
            Not on this device. Ecash made here is not covered by a recovery phrase.
          </Note>
        );
      case 'unreadable':
        return (
          <Note tone="warning" id={`${id}-state`}>
            The recovery phrase on this device cannot be opened right now (your signer may be
            unreachable, or the file is damaged). It is kept, and new ecash is not covered until it
            opens.
          </Note>
        );
      case 'unavailable':
        return (
          <Note id={`${id}-state`}>
            {signedIn
              ? 'Unlock your signer and open your wallet to use a recovery phrase.'
              : 'Connect a signer with a wallet to use a recovery phrase.'}
          </Note>
        );
    }
  };

  const st = typeof status === 'object' ? status : null;
  const has = st !== null && (st.state === 'covered' || st.state === 'not-confirmed');
  const canSetup = st !== null && (st.state === 'not-on-device' || has);
  const setupLabel =
    st?.state === 'not-on-device'
      ? 'Set up recovery phrase'
      : st?.reissuePending === true
        ? 'Finish backup'
        : 'Replace phrase';

  return (
    <SectionFrame
      id={id}
      title="Recovery phrase"
      description={description}
      busy={busy !== null}
      headingRef={headingRef}
    >
      {renderStatus()}
      {st !== null && has && st.reissuePending ? (
        <Note tone="warning" id={`${id}-reissue`}>
          Part of your balance is not under the phrase yet. Finish the backup to move it (the mints
          charge a small fee, shown before anything moves).
        </Note>
      ) : null}
      {st !== null && has ? (
        <Note id={`${id}-relay`}>
          {st.relayCopy
            ? 'An encrypted copy is on your relays: your Nostr key can bring the phrase back.'
            : 'The encrypted copy did not reach your relays: only your written words can bring this phrase back.'}
        </Note>
      ) : null}
      <div className="nf-settings__actions">
        <Button
          variant={
            st?.state === 'not-on-device' || st?.reissuePending === true ? 'accent' : 'secondary'
          }
          size="sm"
          disabled={!canSetup || busy !== null}
          loading={busy === 'setup'}
          onClick={onSetup}
        >
          {setupLabel}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!has || busy !== null}
          loading={busy === 'show'}
          onClick={onShow}
        >
          Show again
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!has || busy !== null}
          loading={busy === 'restore'}
          onClick={onRestore}
          aria-describedby={`${id}-restore-desc`}
        >
          Restore
        </Button>
      </div>
      <p id={`${id}-restore-desc`} className="nf-settings__desc">
        {has
          ? 'Restore scans your mints with this device’s phrases, every copy on your relays your key can open, and any phrase you type.'
          : 'Restore needs this device’s own phrase first (set it up above).'}{' '}
        The words are only ever shown or typed in Nutflix&apos;s own window, never here.
      </p>
      {progress !== null ? (
        <p className="nf-settings__note" role="status" id={`${id}-progress`}>
          Phrase {progress.phrase} of {progress.phrases} · {mintHost(progress.mint)} ·{' '}
          {progress.keysetsDone} of {progress.keysets} keysets
        </p>
      ) : null}
      {error !== null ? (
        <p className="nf-settings__error" role="alert" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
      {done !== null ? (
        <Note tone="success" id={`${id}-done`}>
          {done}
        </Note>
      ) : null}
      {report !== null ? (
        <div className="nf-settings__report" id={`${id}-report`}>
          <p className="nf-settings__note" role="status">
            Scanned {report.phrases} {report.phrases === 1 ? 'phrase' : 'phrases'}
            {report.reports.length === 0 ? ': your wallet has no mints to ask.' : '.'}
          </p>
          {report.reports.length > 0 ? (
            <ul className="nf-settings__report-list">
              {report.reports.map((r) => (
                <li key={r.mint} data-outcome={r.outcome}>
                  <span className="nf-settings__mono">{mintHost(r.mint)}</span>:{' '}
                  {r.outcome === 'restored'
                    ? `${formatSats(r.restoredSats)} restored`
                    : OUTCOME[r.outcome]}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </SectionFrame>
  );
}

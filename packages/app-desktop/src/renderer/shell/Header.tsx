/**
 * The shell header (design §4 "Chrome"): back/forward, the brand (→ Home), search (→ the
 * `search` route on submit), the `WalletChip` (total from `wallet.balances` + `onChange`,
 * streaming rate from the playback coordinator; click → Wallet) and the viewer's avatar
 * (→ their channel; signed out → Settings to connect a signer).
 */
import { useEffect, useState, type ReactElement, type SyntheticEvent } from 'react';
import type { Sats } from '@sovit/core';
import { Avatar, Button, IconButton, WalletChip, shortPubkey } from '@sovit/ui';
import type { Route } from '@sovit/ui';
import type { Identity } from './hooks.js';

export interface HeaderProps {
  readonly route: Route;
  readonly navigate: (to: Route) => void;
  readonly canBack: boolean;
  readonly canForward: boolean;
  readonly onBack: () => void;
  readonly onForward: () => void;
  readonly identity: Identity;
  /** Wallet total; `undefined` while loading. */
  readonly balance: Sats | undefined;
  /** sats/min of the session that is paying now; 0 = none. */
  readonly ratePerMin: number;
}

export function Header(props: HeaderProps): ReactElement {
  const { route, navigate, identity } = props;
  const routeQ = route.name === 'search' ? route.q : '';
  const [q, setQ] = useState(routeQ);
  useEffect(() => {
    setQ(routeQ);
  }, [routeQ]);

  const submit = (e: SyntheticEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const text = q.trim();
    if (text !== '') navigate({ name: 'search', q: text });
  };

  return (
    <header className="nf-shell__header">
      <div className="nf-shell__header-start">
        <IconButton
          icon="chevronLeft"
          label="Back"
          disabled={!props.canBack}
          onClick={props.onBack}
        />
        <IconButton
          icon="chevronRight"
          label="Forward"
          disabled={!props.canForward}
          onClick={props.onForward}
        />
        <button
          type="button"
          className="nf-shell__brand"
          onClick={() => {
            navigate({ name: 'home' });
          }}
        >
          Nutflix
        </button>
      </div>
      <form className="nf-shell__search" role="search" onSubmit={submit}>
        <input
          className="nf-shell__search-input"
          type="search"
          aria-label="Search videos"
          placeholder="Search"
          maxLength={256}
          value={q}
          onChange={(e) => {
            setQ(e.currentTarget.value);
          }}
        />
        <IconButton icon="search" label="Search" type="submit" />
      </form>
      <div className="nf-shell__header-end">
        {identity.status === 'signed-in' ? (
          <>
            <WalletChip
              balance={props.balance}
              satsPerMin={props.ratePerMin > 0 ? props.ratePerMin : undefined}
              onClick={() => {
                navigate({ name: 'wallet' });
              }}
            />
            <button
              type="button"
              className="nf-shell__avatar"
              aria-label="Your channel"
              onClick={() => {
                navigate({ name: 'channel', pubkey: identity.pubkey });
              }}
            >
              <Avatar
                seed={identity.pubkey}
                name={
                  identity.profile?.displayName ??
                  identity.profile?.name ??
                  shortPubkey(identity.pubkey)
                }
                src={identity.avatarSrc}
                size="sm"
              />
            </button>
          </>
        ) : identity.status === 'signed-out' ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              navigate({ name: 'settings' });
            }}
          >
            Connect signer
          </Button>
        ) : null}
      </div>
    </header>
  );
}

/**
 * The shell sidebar (design §4 "Chrome"; L4 has none yet — move it into `@sovit/ui` later).
 * Plain navigation; the current section is marked with `aria-current="page"`.
 */
import type { ReactElement } from 'react';
import { Icon, type IconName } from '@sovit/ui';
import type { Route } from '@sovit/ui';

interface Item {
  readonly label: string;
  readonly icon: IconName;
  readonly to: Route;
  readonly active: (r: Route) => boolean;
}

const ITEMS: readonly (readonly Item[])[] = [
  [
    {
      label: 'Home',
      icon: 'playlist',
      to: { name: 'home' },
      active: (r) => r.name === 'home' && r.tab !== 'subscriptions',
    },
    { label: 'Shorts', icon: 'bolt', to: { name: 'shorts' }, active: (r) => r.name === 'shorts' },
    {
      label: 'Subscriptions',
      icon: 'people',
      to: { name: 'home', tab: 'subscriptions' },
      active: (r) => r.name === 'home' && r.tab === 'subscriptions',
    },
  ],
  [
    {
      label: 'Library',
      icon: 'clock',
      to: { name: 'library' },
      active: (r) => r.name === 'library',
    },
    { label: 'Studio', icon: 'seed', to: { name: 'studio' }, active: (r) => r.name === 'studio' },
    { label: 'Wallet', icon: 'wallet', to: { name: 'wallet' }, active: (r) => r.name === 'wallet' },
    {
      label: 'Settings',
      icon: 'settings',
      to: { name: 'settings' },
      active: (r) => r.name === 'settings',
    },
  ],
];

export interface SidebarProps {
  readonly route: Route;
  readonly navigate: (to: Route) => void;
}

export function Sidebar({ route, navigate }: SidebarProps): ReactElement {
  return (
    <nav className="nf-shell__sidebar" aria-label="Main">
      {ITEMS.map((group, i) => (
        <ul key={i} className="nf-shell__nav">
          {group.map((item) => {
            const current = item.active(route);
            return (
              <li key={item.label}>
                <button
                  type="button"
                  className="nf-shell__nav-item"
                  aria-current={current ? 'page' : undefined}
                  onClick={() => {
                    navigate(item.to);
                  }}
                >
                  <Icon name={item.icon} size={20} />
                  <span>{item.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ))}
    </nav>
  );
}

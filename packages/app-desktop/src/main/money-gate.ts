/**
 * Money gate (design §3 "Stage 2 hook"): main asks the USER — with a native dialog, outside
 * the renderer's reach — before relaying a call that moves sats out: `wallet.melt`,
 * `seeder.melt`, `nutzap`. The IPC gate calls `confirm` for exactly `MONEY_METHODS`, after the
 * guards and before the host sees anything.
 *
 * STAGE 1 STUB. No real money exists in Stage 1 (the only wallet is `MockWallet` behind
 * `--dev-mocks`; without it the host answers `payments-unavailable`). The stub therefore:
 *   - allows when main runs with `--dev-mocks` (mock sats only), and
 *   - REFUSES otherwise (`forbidden`), so a Stage 2 wallet wired up without the dialog fails
 *     closed instead of silently skipping the confirmation.
 * Stage 2 replaces `createMoneyGate` with `dialog.showMessageBox` naming amount, mint and
 * destination (read from the call's validated arguments, never from renderer-provided text).
 */
import type { Method, MethodTable } from '../ipc/protocol.js';

export const MONEY_METHODS = ['wallet.melt', 'seeder.melt', 'nutzap'] as const;
export type MoneyMethod = (typeof MONEY_METHODS)[number];

export function isMoneyMethod(m: Method): m is MoneyMethod {
  return (MONEY_METHODS as readonly string[]).includes(m);
}

export type MoneyRequest = {
  [M in MoneyMethod]: { readonly wc: number; readonly method: M; readonly args: MethodTable[M][0] };
}[MoneyMethod];

export interface MoneyGate {
  /** `true` = relay the call; `false` = answer `forbidden`. Must never throw. */
  confirm(req: MoneyRequest): Promise<boolean>;
}

export function createMoneyGate(opts: { readonly devMocks: boolean }): MoneyGate {
  return { confirm: () => Promise.resolve(opts.devMocks) };
}

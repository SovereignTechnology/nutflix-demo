/**
 * The engine's rate-limited `keyset` hook lives in `@sovit/core` (`wallet.guardedKeyset`) so the
 * desktop host can use it without loading this package; re-exported here for the runtime.
 */
import { wallet } from '@sovit/core';

export const guardedKeyset = wallet.guardedKeyset;
export type KeysetGuardOptions = wallet.KeysetGuardOptions;

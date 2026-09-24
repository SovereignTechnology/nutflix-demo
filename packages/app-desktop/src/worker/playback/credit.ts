/**
 * The credit pool moved to the shared upstream module (`@sovit/gateway/upstream`, security review
 * F37): the gateway's upstream reads use the same pool as the desktop's playback. Re-exported here
 * so the worker's imports stay put.
 */
export { CreditCancelled, CreditPool } from '@sovit/gateway/upstream';
export type { CreditWaiter } from '@sovit/gateway/upstream';

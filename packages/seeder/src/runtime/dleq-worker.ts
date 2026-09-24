/**
 * One DLEQ worker thread (security review F5; `dleq-pool.ts`). It runs core's `proofDleqOk` — the
 * engine's own DLEQ rule, cashu-ts underneath — on the checks it is sent and answers booleans in
 * order. It holds nothing but public data (proofs and mint keys) and never logs.
 *
 * Message in: `{ id, checks: DleqCheck[] }`. Message out: `{ id, results: boolean[] }`.
 */
import { parentPort } from 'node:worker_threads';

import type { payment as paymentTypes } from '@sovit/core';
import { payment } from '@sovit/core';

interface Job {
  readonly id: number;
  readonly checks: readonly paymentTypes.DleqCheck[];
}

function isJob(m: unknown): m is Job {
  const o = m as { id?: unknown; checks?: unknown } | null;
  return (
    typeof o === 'object' && o !== null && Number.isSafeInteger(o.id) && Array.isArray(o.checks)
  );
}

parentPort?.on('message', (m: unknown) => {
  if (!isJob(m)) return;
  const results = m.checks.map((c) => {
    try {
      return payment.proofDleqOk(c.proof, c.keyset);
    } catch {
      return false;
    }
  });
  parentPort?.postMessage({ id: m.id, results });
});

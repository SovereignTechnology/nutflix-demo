/**
 * Leaving the Bare worker process (fix round 4, I1 verifier). `Bare.exit` joins every live thread,
 * and a DLEQ thread parked in `Atomics.wait` between jobs (issue #8 d: a seller's thread lives
 * until `providers.close()`) never returns on its own — so an exit that cannot wait for
 * `host.close()` (an uncaught exception, a corrupt frame, the shutdown force timer) would block
 * for good, and the supervisor, which restarts only a worker that EXITED, would never restart it.
 * Every live DLEQ mailbox is therefore told to quit, synchronously, before `Bare.exit`.
 *
 * Runtime-neutral: `exit` defaults to `Bare.exit`, read only when called without one (tests).
 */
import { quitDleqThreadsNow } from './pay/dleq-thread.js';

export function exitWorker(
  code: number,
  exit: (code: number) => void = (c) => {
    Bare.exit(c);
  },
): void {
  try {
    quitDleqThreadsNow();
  } catch {
    // nothing may keep the process from exiting
  }
  exit(code);
}

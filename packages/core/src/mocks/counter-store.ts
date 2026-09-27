/**
 * MemoryCounterStore — a `CounterStore` (ADR 0016 §3) held in memory, for tests and dev rigs: the
 * desktop's real one is `<userData>/wallet/counters-<pubkey>.json` (0600, fsynced). "On disk" is
 * the last state `save` resolved with; a crash is a new counter source over the same store.
 *
 * Test hooks: `failNextSave()` rejects the next save (a full disk), `saved` lists every state
 * written, in order, `reset()` loses the file (the counters file deleted).
 */
import type { CounterState, CounterStore } from '../wallet/recovery-api.js';

export class MemoryCounterStore implements CounterStore {
  /** What is "on disk" (`null`: no file). */
  state: CounterState | null;
  /** Every state written, in order (copies). */
  readonly saved: CounterState[] = [];
  private failures = 0;

  constructor(initial: CounterState | null = null) {
    this.state = initial === null ? null : copy(initial);
  }

  load(): Promise<CounterState | null> {
    return Promise.resolve(this.state === null ? null : copy(this.state));
  }

  save(state: CounterState): Promise<void> {
    if (this.failures > 0) {
      this.failures--;
      return Promise.reject(new Error('memory counter store: simulated write failure'));
    }
    this.state = copy(state);
    this.saved.push(copy(state));
    return Promise.resolve();
  }

  /** The next `n` saves reject (nothing is written). */
  failNextSave(n = 1): void {
    this.failures += n;
  }

  /** The counters file is gone. */
  reset(): void {
    this.state = null;
  }
}

/** A deep copy of exactly what was written (a malformed test state stays malformed). */
function copy(s: CounterState): CounterState {
  return JSON.parse(JSON.stringify(s)) as CounterState;
}

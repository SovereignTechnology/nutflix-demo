/**
 * CreditPool — the viewer-side mirror of the seeders' unpaid window (SECURITY.md invariant 5,
 * `PaymentEngineConfig.windowBlocks`). Shared by every downloader that pays upstream: the desktop
 * worker's playback and the gateway's upstream reads (security review F37; moved here from the
 * desktop worker).
 *
 * A seeder counts a block as `uploaded` the moment it sends it and as `paid` once it has
 * verified our `PAY`; when `uploaded − paid` passes its window it cuts and BANS us (L2, spike
 * S-A). Hypercore pipelines requests (16+ in flight per peer), and design §1's lookahead
 * `core.download({start: i, end: i + prefetchBlocks})` would ask for ~150 blocks at once at
 * a 30 s prefetch — an honest viewer would be banned on its first second of playback.
 *
 * So every block the worker asks the network for first takes one unit of credit here, and
 * the unit comes back only when the block is SETTLED: its `PAY` was acknowledged by the
 * seeder that sent it (`ACK`, ok or not), or it came from a peer we have no `pay/1` with
 * (nothing is owed), or the request died without the block arriving. With `limit` equal to
 * the seeders' window, the blocks any one seeder has sent us and not yet been paid for can
 * never exceed its window — whatever mix of peers hypercore picks — because the pool is
 * global across peers, cores and sessions.
 *
 * Blocking `acquire()`s (a player waiting for its next block) are served FIFO and before any
 * opportunistic `tryAcquire()` (lookahead), so prefetch never starves playback.
 *
 * PRESSURE (security review F5, batching): a payer that batches PAYs holds blocks unpaid until a
 * run is long enough. If every unit is held and nobody pays, nothing more downloads — so the pool
 * reports pressure (`pressured`, and `onPressure` whenever an acquire has to queue or a
 * `tryAcquire` is refused for lack of units), and a batching payer then pays everything it holds.
 */
export interface CreditWaiter {
  readonly promise: Promise<void>;
  /** Stop waiting; resolves nothing, releases nothing it did not get. */
  cancel(): void;
}

interface Waiter {
  readonly id: string;
  resolve: (() => void) | null;
  reject: ((err: Error) => void) | null;
}

export class CreditCancelled extends Error {
  override readonly name = 'CreditCancelled';
}

export class CreditPool {
  readonly limit: number;
  private readonly held = new Set<string>();
  private readonly waiters: Waiter[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly pressureListeners = new Set<() => void>();

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError('credit limit must be >= 1');
    this.limit = limit;
  }

  /** Units in use (blocks requested or downloaded and not yet settled). */
  get size(): number {
    return this.held.size;
  }

  /** Blocking acquirers queued right now. */
  get waiting(): number {
    return this.waiters.length;
  }

  /** Every unit is held, or a blocking acquirer is queued: a batching payer must pay now. */
  get pressured(): boolean {
    return this.waiters.length > 0 || this.held.size >= this.limit;
  }

  /** Called when an acquire has to queue, or a `tryAcquire` is refused for lack of units. */
  onPressure(cb: () => void): () => void {
    this.pressureListeners.add(cb);
    return () => this.pressureListeners.delete(cb);
  }

  holds(core: string, index: number): boolean {
    return this.held.has(unit(core, index));
  }

  /** Take a unit now if one is free AND nobody is queued; `true` when this block holds one. */
  tryAcquire(core: string, index: number): boolean {
    const id = unit(core, index);
    if (this.held.has(id)) return true;
    if (this.waiters.length > 0 || this.held.size >= this.limit) {
      this.pressure();
      return false;
    }
    this.held.add(id);
    return true;
  }

  /** Wait (FIFO) for a unit for this block. Resolves at once when it already holds one. */
  acquire(core: string, index: number): CreditWaiter {
    const id = unit(core, index);
    if (this.held.has(id) || (this.waiters.length === 0 && this.held.size < this.limit)) {
      this.held.add(id);
      return { promise: Promise.resolve(), cancel: () => undefined };
    }
    const w: Waiter = { id, resolve: null, reject: null };
    const promise = new Promise<void>((resolve, reject) => {
      w.resolve = resolve;
      w.reject = reject;
    });
    this.waiters.push(w);
    this.pressure();
    return {
      promise,
      cancel: () => {
        const i = this.waiters.indexOf(w);
        if (i === -1) return;
        this.waiters.splice(i, 1);
        w.reject?.(new CreditCancelled('credit wait cancelled'));
        this.grant();
      },
    };
  }

  /** The block is paid for (or owes nothing, or never came): its unit is free again. */
  settle(core: string, index: number): void {
    if (!this.held.delete(unit(core, index))) return;
    this.grant();
    for (const cb of [...this.listeners]) cb();
  }

  /** Called after every settle (gates re-run their lookahead). */
  onAvailable(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private pressure(): void {
    for (const cb of [...this.pressureListeners]) {
      try {
        cb();
      } catch {
        // a listener's failure is its own
      }
    }
  }

  /** Serve queued acquirers in order while units are free (a block already held costs none). */
  private grant(): void {
    for (;;) {
      const w = this.waiters[0];
      if (w === undefined) return;
      if (!this.held.has(w.id)) {
        if (this.held.size >= this.limit) return;
        this.held.add(w.id);
      }
      this.waiters.shift();
      w.resolve?.();
    }
  }
}

function unit(core: string, index: number): string {
  return `${core}:${String(index)}`;
}

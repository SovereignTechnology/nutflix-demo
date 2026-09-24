/**
 * The seeder's set of proof secrets it has accepted (contracts v5 `double-spend`, ADR 0010 §5).
 *
 * `verify` asks it synchronously, so a replayed proof is refused before `ACK` instead of being
 * credited until the next swap batch. It must survive restarts for that to hold across them —
 * `SeenSecrets` is the seam: the engine keeps an in-memory set (bounded, FIFO eviction) and calls
 * `persist` for every newly accepted secret, and the host restores it with `restore()` at start.
 * An evicted secret is still caught by the swap at the mint, one batch later.
 */
export interface SeenSecretsOptions {
  /** Most secrets kept in memory; the oldest are evicted first. Default 1 000 000. */
  readonly capacity?: number;
  /** Called with every batch of newly accepted secrets (the host appends them to disk). */
  readonly persist?: (secrets: readonly string[]) => void;
}

export class SeenSecrets {
  private readonly set = new Set<string>();
  private readonly capacity: number;
  private readonly persist: ((secrets: readonly string[]) => void) | undefined;

  constructor(opts: SeenSecretsOptions = {}) {
    this.capacity = opts.capacity ?? 1_000_000;
    // 0 would evict every secret the moment it is added: no local double-spend check at all.
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1)
      throw new RangeError('SeenSecrets: capacity must be a positive integer');
    this.persist = opts.persist;
  }

  has(secret: string): boolean {
    return this.set.has(secret);
  }

  /** Record secrets accepted in one PAY. */
  add(secrets: readonly string[]): void {
    for (const s of secrets) this.insert(s);
    if (this.persist !== undefined && secrets.length > 0) this.persist(secrets);
  }

  /** Reload secrets from durable storage (no `persist` callback). */
  restore(secrets: Iterable<string>): void {
    for (const s of secrets) this.insert(s);
  }

  get size(): number {
    return this.set.size;
  }

  private insert(s: string): void {
    if (this.set.has(s)) return;
    this.set.add(s);
    if (this.set.size > this.capacity) {
      const oldest = this.set.values().next();
      if (oldest.done !== true) this.set.delete(oldest.value);
    }
  }
}

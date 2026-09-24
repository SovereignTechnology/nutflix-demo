/**
 * A node's `keyset` hook for `RealPaymentEngine`, rate-limited (engine.ts: "keep it rate-limited: a peer can name any
 * keyset id"). The wallet answers a keyset it has loaded from memory, but an id it does not know
 * makes it reload the mint (`loadMint(true)`) — so without a limit every PAY naming a random id is
 * a request to the mint, sent on a peer's behalf.
 *
 * Ids that resolved once are free forever. A lookup of an id not yet seen spends a token from a
 * per-mint bucket (`burst` tokens, one back every `refillMs`); with the bucket empty the lookup
 * answers `undefined` without asking the wallet. The engine then refuses that PAY as
 * `bad-dleq` "unknown keyset" — refused, never banned (engine.ts), so an honest viewer that hits
 * an empty bucket just pays again.
 */
import type { MintKeyset, MintUrl } from '../contracts/index.js';

export interface KeysetGuardOptions {
  /** Unknown-id lookups a mint gets at once. Default 4 (a PAY names at most 3 keysets). */
  readonly burst?: number;
  /** One token back per interval. Default 15 s. */
  readonly refillMs?: number;
  readonly now?: () => number;
}

export function guardedKeyset(
  lookup: (mint: MintUrl, id: string) => Promise<MintKeyset>,
  o: KeysetGuardOptions = {},
): (mint: MintUrl, id: string) => Promise<MintKeyset | undefined> {
  const burst = o.burst ?? 4;
  const refillMs = o.refillMs ?? 15_000;
  const now = o.now ?? Date.now;
  if (!Number.isSafeInteger(burst) || burst < 1) throw new Error('keyset guard: burst must be ≥ 1');
  if (!Number.isSafeInteger(refillMs) || refillMs < 1)
    throw new Error('keyset guard: refillMs must be ≥ 1');
  const known = new Set<string>();
  const buckets = new Map<MintUrl, { tokens: number; at: number }>();

  const take = (mint: MintUrl): boolean => {
    const t = now();
    const b = buckets.get(mint) ?? { tokens: burst, at: t };
    const refill = Math.floor((t - b.at) / refillMs);
    if (refill > 0) {
      b.tokens = Math.min(burst, b.tokens + refill);
      b.at += refill * refillMs;
    }
    buckets.set(mint, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };

  return async (mint, id) => {
    const key = `${mint}|${id}`;
    if (!known.has(key) && !take(mint)) return undefined;
    try {
      const ks = await lookup(mint, id);
      known.add(key);
      return ks;
    } catch {
      return undefined;
    }
  };
}

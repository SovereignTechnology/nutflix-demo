/**
 * The P2PK lock policy for money that moves over `pay/1` (NUT-10/11; contracts v5, ADR 0010).
 *
 * A proof is a PAYMENT to `target` only if `target` alone can spend it, now and later. The
 * envelope (`LockedProofSet.lockedTo`) is untrusted input; this checks the lock INSIDE the
 * secret, which the proof's signature and DLEQ commit to:
 *
 *   - kind `P2PK`, `data` = `target` (33-byte compressed hex, compared case-insensitively);
 *   - no `locktime` / `refund` / `n_sigs_refund`: a refund path lets the PAYER take the proof
 *     back after the locktime, racing the recipient's swap — a delayed double-spend;
 *   - no `pubkeys`, `n_sigs` absent or `1`: extra keys would let someone else spend it;
 *   - `sigflag` absent or `SIG_INPUTS` (a NIP-61 receiver signs inputs only);
 *   - the creator set's binding `['pay1', <seeder P2PK>]` when one is required, exactly once;
 *   - no other tag: an unknown tag means an unknown spending rule to some mint.
 *
 * Parsing is `@cashu/cashu-ts` `parseP2PKSecret` (NUT-10 shape, duplicate tag keys, sigflag).
 */
import { parseP2PKSecret } from '@cashu/cashu-ts';

export const PAY1_TAG = 'pay1' as const;

export type LockVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | 'malformed'
        | 'not-p2pk'
        | 'wrong-target'
        | 'refund-path'
        | 'extra-keys'
        | 'sig-all'
        | 'missing-binding'
        | 'wrong-binding'
        | 'unknown-tag';
    };

const COMPRESSED = /^0[23][0-9a-f]{64}$/;

export function checkPayLock(
  secret: string,
  target: string,
  opts: { readonly binding?: string } = {},
): LockVerdict {
  let parsed: ReturnType<typeof parseP2PKSecret>;
  try {
    parsed = parseP2PKSecret(secret);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const [kind, body] = parsed;
  if (kind !== 'P2PK') return { ok: false, reason: 'not-p2pk' };
  const data = typeof body.data === 'string' ? body.data.toLowerCase() : '';
  const want = target.toLowerCase();
  if (!COMPRESSED.test(want) || data !== want) return { ok: false, reason: 'wrong-target' };
  let binding: string | undefined;
  let bindings = 0;
  const tags: unknown = body.tags ?? [];
  if (!Array.isArray(tags)) return { ok: false, reason: 'malformed' };
  for (const tag of tags as unknown[]) {
    if (!Array.isArray(tag) || !tag.every((v): v is string => typeof v === 'string'))
      return { ok: false, reason: 'malformed' };
    const [key = '', ...values] = tag;
    switch (key) {
      case 'locktime':
      case 'refund':
      case 'n_sigs_refund':
        return { ok: false, reason: 'refund-path' };
      case 'pubkeys':
        if (values.length > 0) return { ok: false, reason: 'extra-keys' };
        break;
      case 'n_sigs':
        if (values.length !== 1 || values[0] !== '1') return { ok: false, reason: 'extra-keys' };
        break;
      case 'sigflag':
        if (values.length !== 1 || values[0] !== 'SIG_INPUTS')
          return { ok: false, reason: 'sig-all' };
        break;
      case PAY1_TAG:
        bindings++;
        binding = values.length === 1 ? values[0] : undefined;
        break;
      default:
        return { ok: false, reason: 'unknown-tag' };
    }
  }
  if (opts.binding === undefined) {
    if (bindings > 0) return { ok: false, reason: 'unknown-tag' };
    return { ok: true };
  }
  if (bindings === 0) return { ok: false, reason: 'missing-binding' };
  if (bindings !== 1 || binding?.toLowerCase() !== opts.binding.toLowerCase())
    return { ok: false, reason: 'wrong-binding' };
  return { ok: true };
}

/**
 * L10 provider indirection for `BlossomAuth` (Stage 2 seam).
 *
 * Stage 2 (PART A step 5) wired the real implementation: `getBlossomAuth()` returns a FRESH
 * `BlossomAuthImpl` per call, because the replay and deny-list tests assume no state leaks
 * between tests.
 *
 * `.mts` so vitest's `__tests__/**\/*.ts` include glob does not collect it as a test file.
 */
import { BlossomAuthImpl } from '../blossom-auth.js';
import type { BlossomAuth } from '../index.js';

export function getBlossomAuth(): BlossomAuth | undefined {
  return new BlossomAuthImpl();
}

export const SKIP_REASON = 'real BlossomAuthImpl (Stage 2)';

# Pre-push review — the NIP-71 `minpay` tag (2026-09-24)

Diff: `stage-3/worker-journal` (`8723ebb`) → `stage-3/manifest-minpay`. Method:
`differential-review` and `sharp-edges`, inline.

## Scope

- HIGH (untrusted input into a seeder's credit decision):
  - `core/src/payment/split.ts` (`effectiveWindowBlocks` caps the minimum's contribution);
  - `core/src/manifest/parse.ts` (reads `minpay`);
  - `build.ts` (emits it).
- MEDIUM:
  - `core/src/contracts/*` (`MAX_MIN_PAY_WINDOW_BLOCKS`, `MAX_MIN_PAY_SATS`, amended docs);
  - `app-desktop/src/ipc/guards.ts` + `protocol.ts` (`PricePolicy.minPaySats` optional,
    bounded; `LIMITS.maxMinPaySats`).
- LOW: tests, docs.

## Adversarial questions

- **A creator who wants free-riding (or to drain seeders).**
  - `minpay` 1 000 000 at 1 sat/block would ask for a 1 000 000-block unpaid window.
  - The cap holds it to `max(windowBlocks, 64)`, whatever the ratio, including after a seeder
    lowers its price by `PRICE`. Tested, including a seeder whose own window is larger.
- **Parser edge cases.** Rejected as `bad-price`: 0, negative, fractions, beyond 1 000 000,
  a unit other than `sat`, and a missing value (tested). The tag's absence is the default (10).
- **Consistency.** The viewer's payer and the seeder's engine both call `effectiveWindowBlocks`,
  so the cap applies to both. The amended property test states the exact formula.
- **The desktop boundary.** The IPC guards are exact-key, so without this change every manifest
  with `minpay` would have been refused crossing IPC and the video would not show. `minPaySats`
  is now an optional key bounded like the parser (pinned to core's constant by a test). A
  mutation dropping it fails that test.
- **Bundles.** `src/ipc` still imports only types from core; the bound is a local `LIMITS`
  entry, so no core runtime code reaches the preload bundle.

## Found and fixed before commit

- The exact-key guard problem above.

## Tests

- Core `split.test.ts`: cap examples and the amended property.
- Core `manifest.test.ts`: round-trip, default, six rejected forms, builder bounds.
- Desktop `guards.test.ts`: a manifest with `minpay` crosses, out-of-bound values do not, and
  the limit equals core's.
- Mutation: dropping `minPaySats` from `isPricePolicy` fails the guard test.

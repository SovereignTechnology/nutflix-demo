# Pre-push review — the fuzz campaign and F58 (2026-10-02)

Diff: `main` → the fuzz branch (lane C5-fuzz, a Claude Code cloud session). Cameron's decisions
(2026-10-02): **fast-check, long runs** (no new dependency) in a **manually started GitHub Actions
workflow**. Execution plan §4 asked for 24 h of fuzzing on the pay/1 codec and the payment parsers,
findings fixed with failing-first tests.

- Locked path changed: `packages/core/src/pay-protocol/codec.ts` (the F58 fix). No contract change
  (the grammar is unchanged for well-formed frames; only malformed ones are refused).
- New workflow `.github/workflows/fuzz.yml`: `workflow_dispatch` only, read-only token, the same
  SHA-pinned actions as `ci.yml`, no third-party action.

## The harness

`packages/core/src/fuzz/__tests__/fuzz.mts` — `fuzzIt(name, arbitrary, check)`:

- without `FUZZ_SECONDS` (every CI run): a quick property test (200 cases);
- with it (the workflow): fresh seeds in batches of 2 000 until the deadline; one file's targets
  share the time (vitest runs a file's tests one after another; each file is its own worker);
  `FUZZ_SHARD` keeps parallel jobs' seeds apart; a finding throws with the seed and path that
  replay it (`fc.assert(prop, { seed, path })`) — in the error, since the reporter always shows a
  failure's message.

Targets (`parsers.fuzz.test.ts`): the pay/1 codec (raw bytes; mutated valid frames — whatever it
accepts must re-encode to the same bytes; round trips), `checkPayLock` (arbitrary and mutated
P2PK secrets; `ok` only for the exact target), `verifyHello` (random HELLOs never verify),
`verifyVideoEvent` (arbitrary values and JSON; signed events with any field or tag edited — an
edited tag never verifies), `splitPay` (valid input: the parts sum to the amount; invalid:
`RangeError` only) and the ADR 0007 telescoping identity.

## F58 — found by the first quick runs

"Mutated valid frames" failed within ~30 cases: a frame the codec accepted re-encoded to other
bytes. Two causes, each replayed from its seed and path:

1. **Invalid UTF-8 in a string** (a HELLO's `p2pk` held a lone continuation byte `0xb0`):
   compact-encoding decodes it to U+FFFD, so the bytes on the wire and the string checked differ.
2. **A non-minimal uint** (a PRICE's `satsPerBlock` 0 written `0xfd 0 0`): compact-encoding reads
   any width.

Either way one message had many frames. Impact: low — no money path was found to depend on frame
bytes (signatures and locks are checked on the decoded values; a re-sent HELLO is compared by
bytes and would only refuse its own peer) — but the codec's contract is one encoding per message,
and a parser that silently normalises is how later code comes to depend on the wrong bytes.

**Fix** (`codec.ts`): every uint, a string's length included, must be in its minimal encoding
(`readMinimalUint`); every string must be strict UTF-8 (its bytes must equal the encoding of the
string read); `encode` refuses a lone surrogate (TextEncoder would write U+FFFD for it). Only
`TextEncoder` and byte comparison: the same under Node and Bare.

Tests (each failing before the fix): `codec.fuzz.test.ts` "strict UTF-8" (3: non-ASCII text
round-trips; three invalid byte pairs refused; lone surrogates refused at encode) and "uints are
minimal" (2: 0 in 3/5 bytes, 252 in 3 bytes refused, 253 accepted; a widened string length
refused); the fuzz target "mutated valid frames". Mutation: the minimality check removed → both
uint tests fail.

## Residuals

- fast-check is not coverage-guided: deep paths may need many hours (the campaign) to reach.
- The campaign's findings live in the job log; nothing files them automatically.

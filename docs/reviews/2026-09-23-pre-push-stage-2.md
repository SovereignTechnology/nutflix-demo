# Pre-push review — Stage 2 (differential review + sharp edges)

Date: 2026-09-23. Diff: `stage-1` (commit `1b0b4d9`) → `stage-2/2026-09-23`, reviewed on the tree
before the wrap-up commit (+ its fixes). Method: the `differential-review` and `sharp-edges`
skills (CLAUDE.md "Before any push/PR"), run inline — no subagents (Stage 2 rule), so the
adversarial pass is a self-review and says so: its independence is limited to re-reading the
code cold after a context compaction.

## Scope and triage

96 files, +11 098 / −1 205. Excluding tests and docs: **54 files, +5 909 / −493**. Strategy
FOCUSED (medium codebase): every HIGH-risk file read in full, MEDIUM files by diff, LOW files
skimmed.

| Risk | Files |
|---|---|
| HIGH (value transfer, crypto, auth) | `core/src/payment/{engine,split,lock,seen,range-set}.ts`, `core/src/wallet/{spend,wallet,nip60,store}.ts`, `core/src/signer/{keyfile,local,remote,control,nip46-connect,secure}.ts`, `core/src/pay-protocol/{codec,hello,channel}.ts`, `gateway/src/auth/blossom-auth.ts`, `seeder/src/payment/pay-bridge.ts`, `seeder/src/net/{peer-session,session-registry}.ts`, `gateway/src/{gateway,upstream/payer}.ts`, `app-desktop/src/worker/pay/viewer-payer.ts` |
| MEDIUM (contracts, mocks, wiring) | `core/src/contracts/*`, `core/src/mocks/{mock-payment-engine,test-mint}.ts`, `seeder/src/seeder.ts`, `*/dev-mocks.ts`, `fixtures-net.ts`, barrels |
| LOW | `ui` (Analytics "Unknown", Watch hides unknown seeders), `package.json` / lockfile (3 exact-pinned deps added to core), docs |

**Removed code** (the regression check):
- `app-desktop/src/worker/dev/dev-engine.ts` (−185): the Stage 1 wrapper around the two mock
  bugs. Deleted because v5 fixed the mock (ADR 0010 §4). It was dev-only and gated behind
  `--dev-mocks`; nothing in production referenced it.
- `seeder/src/payment/pay-bridge.ts` "core-less PAY on a multi-core stream" branch: v5 makes
  `core` required. The codec refuses a core-less PAY on the wire, and the engine refuses one as
  `malformed` whatever transport delivered it (test: `pay-bridge.test.ts` "a core-less PAY is
  refused as malformed by the engine on any stream"). No validation was lost.
- `gateway.ts` random-challenge HELLO signing (`signChallenge`): replaced by the
  connection-bound NIP-01 HELLO (ADR 0010 §7). Strictly stronger (the v4 challenge was
  unverifiable by the receiver).

## Findings from this review

### Fixed here (R1–R4 and S1 each with a new test that fails without the fix; R5 and S2 see the table)

| # | Where | Finding | Fix |
|---|---|---|---|
| R1 | `signer/local.ts` `signWitness` | The wallet key signed SHA-256 of ANY string: a general BIP-340 oracle for the key the user publishes in kind 10019 (e.g. over a NIP-01 serialization, whose hash is an event id) | Signs only a NUT-10 `P2PK` secret (cashu-ts `parseP2PKSecret`, kind checked) |
| R2 | `pay-protocol/channel.ts` | A second HELLO from the same pubkey replaced `peer`, so a peer could change its price, P2PK or mints after `open`. Today's consumers capture the HELLO at `open`, but `peer` is public API | A second HELLO is ignored if byte-identical, a protocol error otherwise |
| R3 | `payment/engine.ts` | A PAY could name up to 128 distinct keyset ids, each a potential keyset lookup (network, at the host's discretion) | `MAX_KEYSETS_PER_SET = 3`, structural → `malformed` before amounts or lookups |
| R4 | `seeder` `pay-bridge.ts` + `PeerSession.engineBanned` | The engine's new `forged-proof` ban answers `bad-dleq`; the bridge cut only on `peer-banned`/`double-spend`, so the forger kept its session for a whole window and the ban never reached the persisted ban list | Any rejected PAY that leaves the peer engine-banned is ACKed, then cut (ban persisted). A non-banning rejection is not cut |
| R5 | `payment/lock.ts` | `checkPayLock` could throw on a non-array tag. cashu-ts rejects those first today, and callers catch | Total: returns `malformed`. No test: cashu-ts's parser rejects such a secret first, so nothing reaches this path through a real secret (defence in depth) |
| S1 | `payment/seen.ts` (sharp edge) | `capacity: 0` evicted every secret as it was added, silently disabling the local double-spend check | Constructor refuses a non-positive / non-integer capacity |
| S2 | `pay-protocol/hello.ts` (sharp edge) | `verifyHello` returned `null` for VALID, so `if (verifyHello(h, b)) accept()` accepts forgeries | Returns `{ ok: true } \| { ok: false, reason }` (same shape as `checkPayLock`); the existing HELLO tests were adapted to the new shape (same assertions), no new test |

### Filed (added to `docs/security-review.md`)

- **F30 (High)**: the viewer carry is not scoped per channel or committed on ACK in
  `UpstreamPayer`. A reconnect or a single rejected PAY desynchronises it, and the honest
  viewer is window-cut and banned. The fix is in the consumer (outside the five directories);
  the contract already assigns the duty.
- **F31 (Medium)**: a redeem whose response is lost becomes a false double-spend ban on retry;
  the creator set is dropped and the swapped outputs are gone (no NUT-13).
- **F32 (Info)**: a DLEQ without `r` is banned as a forgery (third-party wallets).

### Sharp edges examined and accepted

| API | Edge | Why accepted |
|---|---|---|
| `RealPaymentEngine` deps | `keyset` absent → every PAY `bad-dleq` | Fails closed |
| `RealPaymentEngine` deps | `redeem` / `nutzap` absent → accepted PAYs queue forever | Visible (`pendingCount()`, flush counts); a seeder must wire both. Stage 3 runtime providers should refuse to build a seeder engine without them |
| `RealPaymentEngine` config | `windowBlocks`, `ownP2pk` | Validated in the constructor |
| `SeenSecrets` | default in-memory | F10 (persist hook exists; Stage 3 wires it) |
| `CashuMintConnections` | DLEQ on mint signatures | `requireSigDleq: true` hard-coded, not an option |
| `Spender.send` | tags with spending semantics | Refused (`RESERVED_TAGS`); post-checks every output's lock, sum and DLEQ |
| `sealKeyFile` / `openKeyFile` | KDF cost | Bounded both ways (INTERACTIVE floor, 1 GiB / 16 ops ceiling), header bound as AD |
| `LocalSigner.create` | empty passphrase | Refused |
| `PayChannel` | no Noise binding | A remote HELLO is a protocol error — fails closed |
| `PayChannel` | injectable `codec` | Test seam; the default is the strict codec |
| `checkPayLock` | `binding` omitted | Any `pay1` tag is then `unknown-tag` — fails closed |
| `BlossomAuthImpl` | `serverHost` omitted | `server` tags unchecked; documented, F29; the Stage 3 wiring passes it |
| `BlossomAuthImpl` | `allow()` switches to allow-list mode | Fails closed (locks others out), documented in ADR 0010 §8 |
| `BlossomAuthImpl` | `maxAgeSec`, `capacity` | Validated positive integers |
| `memoryWalletKey` (wallet.ts) | signs any string | In-process helper for tests and the dev path; the production path is `signerWalletKey` → `LocalSigner.signSecret` (R1). Low |

## Test coverage of the diff

Every HIGH file has direct tests. The 27 Stage-2-gated tests run (13 BlossomAuth, 10 codec
fuzz, 4 `skipIf(usingMock())`), and adversary cases were added after every module (each with
why it was missed). This review added 6 tests (R1, R2, R3, S1, and two for R4) and adapted the HELLO tests to S2. What remains
untested is what cannot run here: real mints (F6, F31), real bunkers and extensions, Electron
at runtime.

## Blast radius

`@sovit/core`'s barrel exports the new namespaces (`payment`, `payProtocol`, `signer`,
`wallet`); the consumers are the seeder, the gateway and the desktop worker, all adapted in
PART 0 / A.3 / A.4. No runtime provider wires the real modules yet (`*/providers.ts` return
`undefined`), so the production blast radius of a Stage 2 bug is currently the test suite and
`--dev-mocks`. It becomes the whole money path when Stage 3 wires them. Hence the Stage 3
blockers F1–F4 and F30.

## Secrets / hygiene sweep of the diff

- No key, nsec, token, proof or mnemonic in the diff: the only fixed keys are test scalars
  (`fill(11)` etc.) and `TestMint` seeds, in tests and mocks.
- Nothing in the five directories logs (now enforced by `scripts/check-locked-dirs.sh`).
- No `console.*` added outside tests; new log lines in seeder/gateway carry reason codes and
  counts (peer identifiers → F13, pre-existing policy).
- No AI attribution in any commit message on the branch.

## Confidence and limits

High confidence in the verify/lock/split/DLEQ path (read in full twice, property tests plus
real ecash end to end) and in the auth module (37 tests). Medium in the consumer seams
(F1/F2/F30 were found late, which says the seams deserved more time than the modules). Not
verified: real mints, real remote signers, Electron at runtime, performance on target hardware.

CI after the fixes: see the wrap-up commit message (`npm run ci` without
`LOCKED_DIRS_UNLOCKED`).

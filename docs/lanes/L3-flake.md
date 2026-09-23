# Lane L3-flake: the `ws-bridge` cut-test timeout, and the WS close path behind it

Branch `lane/L3-flake`, based on main @ `1fa4c59`. The allowlist was widened twice as the
diagnosis moved into the source:

- `packages/gateway/src/__tests__/ws-bridge.integration.test.ts`
- `packages/gateway/src/ws/ws-duplex.ts`
- `packages/gateway/src/__tests__/ws-duplex.test.ts`
- `packages/gateway/src/ws/bridge.ts`
- `packages/gateway/src/__tests__/ws-bridge.hardening.test.ts` (new)
- `docs/lanes/L3-flake.md`

| Commit | What |
|---|---|
| `03d7517` | Diagnosis only, while the source was out of scope. |
| `7bc03a0` | **The flake fix:** `WsDuplex` drops frames that arrive after a destroy, where it used to pause the closing socket. Adds a deterministic regression test and makes both cut tests event-driven with bounded waits. |
| `e0fb4c8` | **F1 + F2**, the production follow-ups found while checking the bug's reach. F1: the bridge tracks a socket until its own `close` and terminates it 5 s after its stream ends. F2: the close starts at the destroy even mid-write. Adds five hardening tests. |
| this commit | This document. |

## 1. The flake

### Symptom

Under CPU load, two tests in `ws-bridge.integration.test.ts` failed with
`Test timed out in 20000ms`:

- "a non-paying WS client is cut …"
- "sessions without a pay/1 factory … are still cut", the one L5-Settings hit.

Every failure took **30.15–30.32 s**, which is `ws`'s default `closeTimeout` plus setup.

### Root cause

It was not the Hypercore `REQUEST_TIMEOUT`, which ended 2.5 s after the cut on passing and
failing runs alike. It was the `await closed` after it:

1. The seeder cuts the viewer. The bridge destroys the gateway-side `WsDuplex`, and `_destroy`
   calls `ws.close(1000)`, so the socket is CLOSING.
2. The viewer still has requests in flight and keeps sending until it reads the close frame.
3. **streamx's `destroy()` sets the readable `highWaterMark` to 0**, so each late frame's
   `push()` returned `false`. `WsDuplex` then `pause()`d the socket, after `_destroy`'s one-shot
   `resume()` had already run.
4. The paused socket never read the viewer's close reply. The handshake stalled until
   `closeTimeout` destroyed the socket 30 s later.

Load widens the window between the close frame and the viewer reading it. On a real network the
window is a full RTT, so production hit this on most cuts.

### Fix (`7bc03a0`)

- **`ws-duplex.ts`:** the `message` handler starts with `if (this.destroying) return;`. A
  destroyed duplex has no reader, so late frames are dropped and never pause the socket.
  - The pause exists only for read backpressure. `_destroy`/`_read` still resume.
  - No other gateway code pauses a WebSocket; `http/body.ts` pauses HTTP requests only.
- **Regression test (`ws-duplex.test.ts`)**, deterministic with no load:
  1. The client pauses.
  2. The server duplex is destroyed.
  3. The client sends a frame.
  4. The test awaits the server handling that frame on its own.
  5. The client resumes.

  It asserts the socket is not paused and the client sees close code 1000 within 5 s.
- **Both cut tests (`ws-bridge.integration.test.ts`)** now wait on the gateway's `session-cut`
  event instead of the viewer's `get` timing out.
  - Hypercore arms a request's timer before the socket even opens, so a slow setup used to leave
    nothing cut and a `closed` that never resolved.
  - The viewer fetches in the background with no timeout. The test asserts the fetch is still
    outstanding after the cut, cancels it, and asserts it ends in an error.
  - Every wait is bounded, with a message naming what stalled: cut 8 s; `await closed` **5 s**,
    naming the closing-handshake stall; the viewer's replication stream closing 2 s.
  - The viewer's block count is taken after its stream has closed and the count has been stable
    for 500 ms.
  - No timeout was raised and no assertion was dropped. The non-paying test drops from about
    2.8 s to about 0.55 s.

## 2. F1 and F2: what a cut left behind (`e0fb4c8`)

Checking the bug's reach on the `7bc03a0` code turned up two more problems. A viewer that never
answers the close frame still had these effects:

- `wsConnections` = 0 while `server.getConnections()` = 1: an open socket invisible to the
  bridge;
- `gateway.close()` took **29 510 ms**.

**F1 (`bridge.ts`):** the bridge dropped a socket from `sockets` when its **replication stream**
closed (a cut, a handshake timeout, a remote Noise close), not when the **WebSocket** closed.
While the socket stayed open it was:

- not counted against `maxConnections`;
- not pinged;
- not terminated by `close()`.

**F2 (`ws-duplex.ts`):** streamx defers `_destroy` until an in-flight `_write` calls back, and
`WsDuplex._write` waits for `ws.send` to flush. A cut while the peer had stopped reading
therefore never started the close. No closeTimer was armed, and the socket stayed **OPEN
indefinitely**: it was still open at +33 s, and closed only once the peer read again.

Together, one malicious viewer could hold an **unbounded, uncounted** socket: file-descriptor
exhaustion that gets around `maxConnections`.

### Fix (decision: 5 s grace)

- **F1, `bridge.ts`:**
  - A socket stays in `sockets` (counted, and owned by `close()`) until its own `close`.
  - When its stream ends, the handshake and ping timers stop and a grace timer starts. If the
    WebSocket has not closed within **`WS_CLOSE_GRACE_MS = 5_000`**, it is `terminate()`d and
    counted in `stats().graceTerminations`. The timer is cleared on `close`, so honest closes
    never reach it.
  - The constant is exported from `ws/bridge.ts`. `WsBridgeOptions.closeGraceMs` overrides it,
    for tests. Nothing else is configurable: `config.ts` was out of scope, and the gateway uses
    the default.
- **F2, `ws-duplex.ts`:** the close starts in `_predestroy`, which runs synchronously in
  `destroy()` and is not deferred by an active write. `_destroy` repeats it, idempotently. The
  close frame queues behind every frame already handed to `ws.send`, so the close stays graceful
  and "the viewer holds ≤ window blocks" is unchanged.
- **Together:** a socket is gone at most 5 s after its stream ends, even if the peer never
  reads and never answers.
- **Honest viewers are unchanged:** they close cleanly with 1000 in milliseconds and the grace
  never fires.

### Tests: each fails on `7bc03a0` and passes on `e0fb4c8`

The hardening tests are **deterministic with no load**. A fake seeder hands the bridge a streamx
`Duplex` as the "replication stream", so the test performs the cut and puts bytes on the wire
itself. Upgrades come in through a real `http` server, with an injected 300 ms grace, and the
test watches the server-side TCP sockets directly.

| Test | On `7bc03a0` | On `e0fb4c8` |
|---|---|---|
| hardening: a peer that never answers the close frame stays counted until the grace, then is terminated | ✗ `expected +0 to be 1` (uncounted) | ✓ terminated at ≥ 300 ms, `graceTerminations` 1 |
| hardening: `close()` terminates a cut socket that is still closing (default 5 s grace) | ✗ `expected +0 to be 1` | ✓ socket gone within 2 s |
| hardening: a cut during a stalled write is still gone by the grace | ✗ `expected +0 to be 1` | ✓ |
| hardening: maxConnections, a cut-but-not-closed socket still holds its slot until it closes | ✗ `expected 'open' to contain '503'` | ✓ 503, then the slot frees on close |
| hardening: an honest peer closes 1000 in ms and the grace never fires | ✗ only `graceTerminations` (new stat) `undefined`; the behaviour already held | ✓ |
| ws-duplex: a destroy during a stalled write still starts the closing handshake, and stays graceful | ✗ `expected 1 to be 2` (OPEN, not CLOSING) | ✓ CLOSING at once, data then 1000 |
| integration: a real cut viewer that never answers stays counted, and `gateway.close()` does not wait | ✗ `expected +0 to be 1` (and about 29.5 s to close) | ✓ `gateway.close()` < 3 s |

In summary: 7 failed / 14 passed on `7bc03a0`, and 21/21 on `e0fb4c8`. The whole gateway project
passed 77, with 13 skipped (the existing `BlossomAuth` Stage-2 skips), 3 runs out of 3.

## 3. Evidence

Load came from 16 `node -e 'for(;;){}'` busy loops on 8 cores plus other agents' jobs. Only this
lane's own loops were started and killed. Logs are in `/tmp/claude-1000/nutflix-L3-flake/`.

### Flake fix (`7bc03a0`)

- **Regression test on the unfixed `ws-duplex.ts`:** it fails in 6 ms (`isPaused` true), or after
  5 s with `'stalled'` if that check is removed. On the fix: close 1000 in 2–3 ms.
- **Isolation:** 10/10 green, 14/14 tests, 1.9–2.1 s per run.
- **Slow setup:** delaying the viewer's connect by 3 s after starting its fetch still passes. The
  old test hung here.

### A/B under load, 10 rounds, interleaved (`ab3.sh`)

Three arms, run back to back in each round so they see the same load. The 1-min load average
was 14.5–20.5 throughout.

| Arm | Code | Runs failed | Tests failed | Cut-test durations |
|---|---|---|---|---|
| **before** | `03d7517`: original test + source | **4 / 10** | 5, every one a 20 s vitest timeout at **30 152–30 288 ms** (2 non-paying, 3 no-pay/1) | when passing: non-paying 2.8–2.9 s, no-pay/1 1.6–1.7 s |
| **after** | `e0fb4c8`: integration + hardening + duplex tests | **0 / 10** | 0 (21/21 in every run) | non-paying 0.66–0.92 s, no-pay/1 0.18–0.32 s |
| hardened tests, old source | `7bc03a0` cut tests on `03d7517` source | 7 / 10 | 7, **every one the named message**, no 20 s test timeout | the failing test reports about 25.2 s |

The failures in the hardened-tests arm read "the WebSocket did not close after the cut — closing
handshake stalled … (waited 5000 ms)". Each one is then followed by an `afterEach` hook timeout,
because on the old source `gateway.close()` waits out the stalled socket, which is F1 itself.
This arm shows the hardening does its job: a regression is reported by name at 5 s instead of as
an anonymous 20 s timeout.

The **after** arm also ran the five new hardening tests and the two new duplex tests under the
same load: 10/10 green, so the short injected grace does not make them load-sensitive.

Earlier data for the flake fix alone (`7bc03a0`, the first A/B in this lane): unmodified 5/10
failed, simulated fix 28/28 green.

### CI

`npm run ci > /tmp/claude-1000/nutflix-L3-flake/ci.log 2>&1; echo exit=$?` on `e0fb4c8`, with
the load average at about 0.4: **exit=0**.

- lint, prettier, build, `check:locked`, `check:native` and `lint:electron` all passed;
- vitest: **73 files, 1023 passed, 27 skipped**.

Compared with the pre-lane run (72 files, 1014 passed + 1 flake failure): 1 new file
(`ws-bridge.hardening.test.ts`) and 8 new tests (5 hardening, 2 duplex, 1 integration), with the
flake gone.

### Diagnosis record (`03d7517`)

- Trace of a failing run: the server sent its close at +612 ms, then called `pause()` 14 times
  while CLOSING. The viewer replied to the close at +624 ms, and `closed` resolved only at
  +30 618 ms.
- A simulated fix (a monkeypatch that drops frames while `destroying`) went 28/28 green, while
  the unmodified code failed 5/10.

## 4. Not done / notes

- `WS_CLOSE_GRACE_MS` is not re-exported from `packages/gateway/src/index.ts`, which is outside
  this lane. Add it there if any consumer needs it.
- The grace is not configurable through `GatewayConfig`, because `config.ts` and `gateway.ts`
  are out of scope. It is a constant by decision.
- No test timeout was raised, no assertion was dropped, and no suites were serialised.

# Lane L3-flake: the `ws-bridge` cut-test timeout

Branch `lane/L3-flake`, based on main @ `1fa4c59`. Allowlist:
`packages/gateway/src/__tests__/ws-bridge.integration.test.ts`, `docs/lanes/L3-flake.md`.

**Status: diagnosed, NOT fixed. The fix is outside this lane's allowlist.** The flake comes from a
bug in `packages/gateway/src/ws/ws-duplex.ts`, not from the test. The test's `await closed` is
catching a real stall: the gateway holds a half-closed socket for 30 s after a cut. A test-only
change could only hide that, either by waiting out the 30 s or by dropping the "socket closed"
assertion, so this lane changes no test code. This document is the whole deliverable. The
proposed patch is below, and it was validated in this worktree without editing the source (see
Evidence).

## Symptom

`packages/gateway` → `ws-bridge.integration.test.ts` fails with `Test timed out in 20000ms` under
CPU load. Two tests fail this way, not just one:

- "a non-paying WS client is cut by the seeder window exactly as over hyperswarm (S-A finding 3)"
- "sessions without a pay/1 factory still replicate and are still cut (no factory = no HELLO)".
  This is the one L5-Settings hit.

Every failure reports a test duration of **30.15–30.32 s**, which is `ws`'s default
`closeTimeout` (30 000 ms) plus setup. That number is what points away from Hypercore.

## Root cause

It is not the Hypercore `REQUEST_TIMEOUT`. With instrumentation, the viewer's `get` rejects at
2.50–2.53 s after the cut every time, on passing and failing runs alike. The hang is the
`await closed` that follows it, and it happens in this order:

1. The seeder cuts the viewer inside the `upload` gate. That destroys the Noise stream, and the
   bridge destroys the gateway-side `WsDuplex`. `_destroy` resumes the socket and calls
   `ws.close(1000)`, so the server socket is now CLOSING and a close frame is on the wire.
2. **The viewer has requests in flight.** It keeps sending frames until it reads that close
   frame.
3. Each late frame reaches `WsDuplex`'s `message` handler and is `push()`ed into the destroyed
   duplex. **streamx's `destroy()` sets `_readableState.highWaterMark = 0`**
   (`node_modules/streamx/index.js` `destroy()`), so every later `push()` returns `false`, and the
   handler calls **`ws.pause()`**. `_destroy`'s one-shot `resume()` has already run, so nothing
   resumes the socket again.
4. The paused server socket never reads the viewer's close-frame reply, so the closing handshake
   cannot finish. `ws`'s `closeTimeout` finally `destroy()`s the TCP socket 30 s later, and only
   then does the viewer's `close` fire, which is what the test's `closed` promise waits for.

The failure is a race between the server's close frame and the viewer's next request. Load
widens the window: a starved viewer event loop reads the close frame later, so more requests
cross it. On a real network the window is a full RTT, so **in production this is probably the
common case, not a test artefact.**

### Production impact (gateway, today)

After such a cut the server-side socket stays open and paused for 30 s. It has **already been
removed from `WsBridge.sockets`**: `cleanup()` runs on the Noise stream's `close`. So for those
30 s it is:

- not counted against `ws.maxConnections`;
- not pinged;
- not terminated by `bridge.close()`.

The failing tests' 30.2 s durations (vitest's 20 s timeout, then an `afterEach` that ran until
about 30 s) fit `gateway.close()` → `server.close()` also waiting on that socket. That last point
is inferred from the timings, not traced.

A malicious peer that never answers a close frame can already hold a socket this way, so the bug
gives an attacker nothing new. What it changes is that **honest** cut viewers do it too.

## Proposed fix (needs `ws-duplex.ts` and `ws-duplex.test.ts` in an allowlist)

`packages/gateway/src/ws/ws-duplex.ts`, first line of the `message` handler:

```ts
ws.on('message', (data, isBinary) => {
  // After a destroy (a seeder-side cut) the peer keeps sending until it reads our close
  // frame. Drop those frames, and never pause for them: streamx's destroy() sets
  // highWaterMark = 0, so push() returns false for every later frame, and a paused socket
  // never reads the peer's close reply. The closing handshake then stalls until ws's
  // closeTimeout (30 s), with the socket already gone from WsBridge.sockets.
  if (this.destroying) return;
  // … existing text-frame check and push/pause unchanged …
});
```

(`destroying` is streamx's public getter and is true for both destroying and destroyed.)
`_destroy`'s existing `resume()` stays, because it still covers a pause from real backpressure
before the destroy. With this guard, frames arriving between `destroy()` and a deferred
`_destroy` (for example while `_write` waits on `ws.send`'s callback) are dropped as well, where
today they pause the socket and rely on the later resume.

A deterministic regression test for `packages/gateway/src/__tests__/ws-duplex.test.ts`. It needs
no load, because it forces the ordering with events instead of timing:

```ts
it('a frame arriving after destroy does not stall the closing handshake', async () => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const port = (wss.address() as { port: number }).port;
  const serverSide = new Promise<{ ws: WebSocket; duplex: WsDuplex }>((resolve) =>
    wss.once('connection', (ws) => {
      const duplex = new WsDuplex(ws);
      duplex.on('error', () => undefined);
      resolve({ ws, duplex });
    }),
  );
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((r) => client.once('open', () => r()));
  const { ws: server, duplex } = await serverSide;
  const clientClosed = new Promise<number>((r) => client.once('close', (code) => r(code)));
  const lateFrameSeen = new Promise<void>((r) => server.once('message', () => r()));
  client.pause(); // the viewer has not read the close frame yet …
  duplex.destroy(); // … when the seeder-side cut closes the socket …
  client.send(Buffer.from([1, 2, 3])); // … so its next request crosses it on the wire
  await lateFrameSeen; // the server handled that frame on its own (not coalesced with the reply)
  client.resume(); // the viewer now reads the close frame and replies
  const outcome = await Promise.race([
    clientClosed,
    new Promise<'stalled'>((r) => setTimeout(() => r('stalled'), 3000)), // ≪ 30 s closeTimeout
  ]);
  client.terminate();
  for (const c of wss.clients) c.terminate(); // else wss.close() waits out the stalled socket
  await new Promise<void>((r) => wss.close(() => r()));
  expect(outcome).toBe(1000);
});
```

The `client.pause()` / `await lateFrameSeen` pair matters. Without it, the late frame and the
close reply can arrive in one TCP read and get parsed together even after the `pause()`, and the
test then passes without the fix. That was the first attempt here.

### Test-side hardening for the same re-issue (in this lane's file)

These are worth doing together with the fix. Neither one fixes the flake on its own.

- **Bound `await closed` in both cut tests well under 30 s**, for example 10 s, and fail with a
  message naming the closing-handshake stall. A regression then fails loudly and specifically
  instead of as a generic 20 s vitest timeout.
- **Wait for the gateway's `session-cut` event (`r.gateway.seeder.on`) instead of the viewer's
  `get` timing out.** There is a second, latent hang with the same shape. Hypercore arms the
  request timer when the request is created (`lib/replicator.js` `setTimeout(r, ms)`), which is
  before the WebSocket even opens. If setup takes longer than the `get` timeout (2.5 s, or 1.5 s
  in the sibling test), the viewer abandons the fetch before the gateway has uploaded
  `window + 1` blocks. There is then no cut, and `closed` never resolves.
  - Reproduced with `timeout` ≤ 10 ms: `uploads=0`, no cut, 20 s timeout.
  - It was not the observed failure: at load average 20, connect-to-cut took 0.3–0.6 s.
  - Consuming `vcore.blobs.createReadStream(entry.blob, { wait: true })` with no timeout,
    awaiting the cut event, and then destroying the stream keeps "the viewer never obtained the
    blob" and drops the 2.5 s fixed wait.
  - The `countBlocks` checks (`> 0`, `≤ window`) should then run after a bounded quiescence wait
    (viewer `raw` closed, and the block count stable), not after `settle(150)`. The old test only
    got its quiescence from the 2.5 s timer.

**Fallback if the source must not change:** raise both cut tests' timeouts above 30 s, for
example to 45 s, with a comment. That is deterministic, because the `ws` closeTimeout always
fires, but it masks the production stall and costs 30 s on each hit. Not recommended.

## Evidence

All runs are in this worktree, with `vitest run --project gateway
src/__tests__/ws-bridge.integration.test.ts`. The instrumentation was a temporary block in the
(allowlisted) test file and has been reverted; the tree is clean. Load came from 16
`node -e 'for(;;){}'` busy loops on 8 cores plus other agents' jobs, giving a 1-min load average
of 14.5–24.

- **Isolation, unmodified:** 7/7 pass in 5.8 s.
- **Trace of a failure** (non-paying test; `+ms` since file start):
  ```
  +612   SERVER ws.close() readyState=1            ← _destroy after the cut
  +617   SERVER ws.pause() readyState=2 (×14)      ← late viewer frames, push() → false
  +624   client ws.close()                         ← viewer read the close frame, replied
  +2867  get settled: REQUEST_TIMEOUT, uploads=5, cut logged   ← 2.5 s, as designed
  +2867  awaiting closed
  +30618 closed resolved                            ← server closeTimeout destroyed the socket
  ```
  A passing run shows no server `pause()` while CLOSING, and `closed` resolves at the same
  moment the `get` settles.
- **Interleaved A/B, 10 pairs at the same load.** Arm B simulates the fix by monkeypatching
  `WsDuplex.prototype.push` to drop frames while `destroying` (no source edit):

  | arm | runs failed | test timeouts | server `pause()` while CLOSING | late frames dropped |
  |---|---|---|---|---|
  | unmodified | **5 / 10** | 6 (4 non-paying, 2 no-pay/1), all 30.18–30.32 s | yes, in every failing run | — |
  | simulated fix | **0 / 10** | 0 | 0 | in 7 / 10 runs (1–15 frames each) |

  The "late frames dropped" column shows that the fixed arm hit the race repeatedly and got
  through it. It was not simply lucky. Across all three simulated-fix batches (10 + 8 + 10
  runs), the result was **28/28 green** at load 16.8–24. The unmodified arm also failed at a
  similar rate in the earlier exploratory runs, for example 3 of 6 runs of the non-paying test
  alone.
- **Deterministic regression test above, no load:** 3/3 fail without the fix (`stalled` after
  3 s) and 3/3 pass with the simulated fix (clean close code 1000 in 5–10 ms).
- **`npm run ci` on this doc-only commit, exit 1**, which is expected because nothing is fixed.
  Ambient load was 14–17 from other agents' jobs, with none of this lane's busy loops running.
  Lint, prettier and build were green, and the tests came out at
  `1 failed | 1014 passed | 27 skipped`. The failure was "sessions without a pay/1 factory …"
  at **30 218 ms**, the same closeTimeout signature.
- **Latent `get`-timeout hang:** `timeout: 10`, `3` and `1` ms each produced `uploads=0`, no
  `session cut`, and a 20 s timeout. `timeout: 30` still passed, with connect-to-cut in < 34 ms
  when idle.

## What this lane did not do

- It did not change the test. Every allowlisted fix either masks the bug or weakens what the test
  proves.
- It did not edit `ws-duplex.ts`, even temporarily. The fix was validated by the prototype
  monkeypatch from the test file only.
- It did not change `vitest.config` or serialise suites. Serialising would only shrink the race
  window, and a real RTT reopens it.

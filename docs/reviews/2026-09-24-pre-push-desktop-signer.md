# Pre-push review — the desktop signer (2026-09-24)

Diff: `stage-3/desktop-runtime` (`8b703db`) → `stage-3/desktop-signer`. Method: the
`differential-review` checklist and `sharp-edges` questions, run inline by the session that wrote
the change. This is a self-review: the tests that fail without each guard (mutation runs below)
are its only independence.

## Scope

HIGH risk (keys, secrets crossing processes, a new trusted window):

- `app-desktop/src/host/signer/*`: `DesktopSigner`, `FileKeyStore`, `MainBridge`, private files.
- `app-desktop/src/main/prompt.ts`, `main/keychain.ts`, `main/window.ts` (`createPromptWindow`),
  `main/main.ts` (wiring), `main/app-protocol.ts` (a second origin).
- `app-desktop/src/renderer/prompt/prompt.ts`, `preload/prompt-preload.ts`, `static/prompt.html`.
- `app-desktop/src/ipc/protocol.ts` / `guards.ts`: the prompt and keychain messages, the new shell
  methods.
- `core/src/signer/nip46-connect.ts`: remember / resume, deadlines, `onauth`, pool disposal.

MEDIUM:

- `host/host.ts` (identity and money wiring).
- `host/worker/supervisor.ts` (`restart`, per-request handlers).
- `host/adapter.ts` (the money-plane lookup; revoke on the authorising plane).
- `host/wallet.ts` (`SwitchingWallet`).
- `main/money-gate.ts` + `ipc-gate.ts` (the sign-out confirm).

LOW:

- The renderer (`App.tsx`, `Header.tsx`, `hooks.ts`), `bundle.ts`, flags / args, docs, tests.

## Adversarial questions

**A compromised app renderer** (it renders relay events and peer data):

- **Can it read a passphrase, an nsec or a bunker URI?** No.
  - They are typed in main's prompt window: another origin (`app://prompt`), another renderer
    process (verified in Electron: a different PID, seccomp-bpf, its own PID namespace), another
    preload.
  - The app window's preload has no access to `nf-prompt:*`. Main accepts those channels only from
    the current prompt window's webContents, top frame, at `app://prompt` (tested with the app
    window's id, a subframe, the wrong origin, a lookalike host).
  - A compromised renderer PROCESS sending raw IPC arrives with its own webContents id and is
    refused.
- **Can it choose how the key is stored (e.g. force the keychain)?** No: the renderer names a kind
  only. The method, the flow and "remember" are answered in the prompt, and must fit the question
  (`promptAnswerFits`, checked in main AND the host).
- **Can it get a wallet key replaced (ADR 0012 D1)?** No. Creation is asked in the prompt window
  (default Not now, with the warning), only on an interactive flow, never at launch. A brand-new
  key's wallet is created at once, since there is nothing to replace.
- **Can it sign the user out silently?** No: main's native confirm (tested, also under
  `--dev-mocks`).
- **Lock?** No confirm. Denial of service only: payments stop until unlock. Accepted.
- **Can it keep re-opening the genuine prompt?** It could (P1 below), and is now throttled.

**The host ↔ main hop:**

- **Can the host put words in the trusted window?** No: `PromptForm` is flags only (`isHostOut`
  refuses extra keys; tested with a `title`). The page holds every word.
- Main's keychain answers only the host. Secrets are bounded (`MAX_SECRET_BYTES`) on both guards.

**Local attackers:**

- The key file is 0600 in a 0700 directory, written with an `O_EXCL` temp file and read with
  `O_NOFOLLOW`. It is refused when a symlink, not ours, or readable by others (tested; the unlock
  is refused before any passphrase is asked).
- Sealed keychain files follow the same rules.
- With the `keychain` method, any process of the same OS user can unseal the passphrase through
  the Secret Service / Keychain. That is the method's documented trade-off, stated in the prompt
  itself ("Anyone who can use your OS account can use your key"). Linux `basic_text` is refused.

**Secrets at rest and in logs:**

- Nothing logs a secret. The host logs error-code prefixes and slot names; main logs a closed set
  of event names.
- The e2e hook reports kind + byte length only.
- The host-level test asserts that neither the HostOut log nor the host log contains the
  passphrase.

## Found by this review and fixed before commit

| # | Severity | Finding | Fix |
|---|---|---|---|
| F39 (P3) | **Medium** | nostr-tools `console.warn`s a bunker's `auth_url` (often carrying a session token) when no `onauth` is set. The host's stdio is inherited by main, so the URL would reach the terminal/journal past the redacting logger | `connectBunker` / `resumeBunker` default `onauth` to a no-op (a caller may pass its own). Tested with a spy on `console.warn`; the mutation fails the test |
| P1 | Medium | A compromised renderer could re-open the (genuine) prompt window the moment the user closed it, forever: nagging, and teaching the user to type a passphrase whenever asked | Three dismissals within a minute pause renderer-started connect / unlock for a minute (`rate-limited`). Tested both ways (bursts pause; spread-out cancels do not) |
| P2 | Low | A keychain store that succeeded while the method file failed to save would leave a sealed passphrase that nothing uses | When recording the method fails after a keychain store, the sealed copy is forgotten |
| P4 | Low | Without a caller's pool, each bunker connect made a nostr-tools pool whose relay sockets outlived `close()` | The connector makes the pool itself and closes it with the bunker, and on a failed setup (tested with a mocked `SimplePool`) |
| P5 | Low | Node's `URL` gives a custom scheme an opaque origin (`"null"`), so an origin comparison for `app://prompt` would have refused the real prompt page (found by the unit test before it could ship) | `isPromptUrl` compares scheme + host, like `isAppUrl` |

## Mutation runs (each guard removed → a test fails)

- The key-file mode check → "refuses a key file other users can read".
- The "interactive" gate on wallet creation → "never asks at an unattended launch".
- Always create the wallet → four tests.
- The keychain gates (`this.o.keychain`) → the first local-key test (keychain touched where there
  is none).
- `promptAnswerFits` in the host bridge → both "answer did not fit" tests.
- The worker restart around the money swap (`host.ts` `swap`) → the host-level test (no second
  worker, no payments in its init).
- The default `onauth` → the `auth_url` test.

## Residual

- No "remove the key from this device" flow: a forgotten passphrase needs the file deleted by hand
  (UI lane, with a native confirm).
- NIP-46 `auth_url` flows are ignored, not supported.
- The locked identity shown before unlock is the key file header's pubkey (unauthenticated until
  the unlock verifies it; informational only).
- JS strings: `safeStorage` takes and returns strings; a bunker URI is a string for nostr-tools.
- A host crash re-asks the passphrase (the new host starts locked). Correct, if noisy.
- Carried from ADR 0012: the decrypted NIP-60 wallet key is held in memory (`mode: 'memory'`)
  unless a signer holds it.

## Tests

- New suites:
  - core `nip46-connect` (8): connect / remember / resume, revoked client refused within the
    deadline, wrong secret, bad blobs, `auth_url` never reaching the console, pool disposal;
  - desktop `desktop-signer` (21): every flow, file modes, keychain seal / silent unlock / stale
    copy, retries, sign-out, exclusivity, throttle, wallet creation, NIP-46 remember / resume;
  - `main-bridge` (7);
  - `signer-host` (3): through the whole host — the worker restarted with the new signer's
    payments, the `signer.status` event, lock, no secret in the HostOut or log;
  - main `prompt` (28) and `keychain` (6);
  - renderer `signer-flow` (5) and `prompt-page` (8).
- Additions to existing suites:
  - supervisor restart (5);
  - guards (prompt / keychain messages, `promptAnswerFits`);
  - main-wiring (prompt round trip with real sender checks, keychain through `safeStorage`,
    `--keychain` forwarding);
  - the `app:` protocol (the prompt origin serves only its files, and neither origin serves the
    other's);
  - money-gate / ipc-gate (sign-out confirm);
  - window posture;
  - flags; bundle (prompt outputs; the preload exposes only its two calls).
- Electron end to end (`e2e/signer.e2e.ts`, real Electron 44):
  - the prompt at `app://prompt`, in its own sandboxed process, modal, with exactly
    `nutflixPrompt.{answer,question}`, no Node, no `window.nutflix`;
  - no CSP violation, and an injected inline script blocked;
  - a short passphrase stays on the page, a good one reaches main as bytes and closes the window;
  - "Create a wallet" defaults to Not now; Escape and closing the window cancel.
- Stage 1 e2e and fidelity still green.
- `npm run ci` green: 160 files passed, 2 skipped; 2567 tests passed, 7 skipped. `check-locked-dirs`,
  native-module inventory and the Electron security lint OK (the lint's pinned window count moved
  from 1 to 2 in `packages/app-desktop/src`, with this review as its justification).
- `npm run test:e2e` (real Electron): 15 passed (fidelity 5, signer 2, Stage 1 8).

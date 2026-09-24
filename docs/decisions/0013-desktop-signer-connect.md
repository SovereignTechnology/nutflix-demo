# 13. The desktop signer: the user picks how it unlocks, main's own window asks

Date: 2026-09-24

## Status

Accepted for Stage 3 (lane "desktop signer", branch `stage-3/desktop-signer`). Implemented and
tested, including the real Electron prompt window (`e2e/signer.e2e.ts`). Cameron's choice
(2026-09-24): offer all three unlock methods and let the user pick.

## Context

ADR 0012 left the desktop's money plane opening only when a signer was injected. The desktop
needs a real signer, and how it unlocks is a trade-off only the user can make:

1. **A passphrase at every launch.** The most private; the key file is the only thing stored.
2. **The OS keychain.** The app unlocks by itself; anyone who can use the OS account can use the
   key.
3. **A remote signer (NIP-46 bunker).** The key never touches this device.

Secrets must never be typed into the app's renderer: it renders relay events and peer data, and
a compromised renderer must not be able to read a passphrase, an nsec or a bunker URI (the URI
carries a one-time connect secret).

## 1. The flow

- The renderer asks only for a **kind** (`desktop.signer.connect {kind: 'local' | 'nip46'}`).
  There is no NIP-07 on the desktop.
- Everything else is asked in **main's trusted prompt window**:
  - for a local key: the unlock method (passphrase or keychain), and with no key yet, create or
    import;
  - then the passphrase(s), the nsec or the bunker URI;
  - "remember this remote signer" (keychain only).
- The host drives the flow (`host/signer/desktop-signer.ts`): core's `SignerManager`, a file
  `KeyStore`, and a `SecretPrompt` that asks main. Main (`main/prompt.ts`) only shows the window
  and hands the answer back.

| Method | Stored | At launch |
| --- | --- | --- |
| `passphrase` | `<userData>/signer/local.key` (argon2id + XChaCha20-Poly1305), 0600 in a 0700 dir | the prompt window asks |
| `keychain` | the key file + the passphrase sealed by `safeStorage` in `<userData>/keychain/passphrase.sealed` (0600/0700) | main unseals it, no window; a stale copy is dropped and asked for |
| `nip46` | nothing, or (remember) the session's client key + bunker pointer sealed in `keychain/nip46.sealed` | resumed (`core` `resumeBunker`); otherwise reconnected by hand |

The choice is recorded in `<userData>/signer/method.json` (no secret). Unlock also exists in the
header ("Unlock" while locked, "Lock", "Sign out").

## 2. The prompt window

- **Its own origin, `app://prompt`,** served by a second `app:` handler from `dist/prompt/` (its
  own file list), so Chromium's site isolation keeps it out of the app renderer's process
  (verified: separate PID, seccomp-bpf, own PID namespace).
- The same literal `webPreferences` as the app window, plus `devTools: false`. Modal to the app
  window. The CSP is the same header, so `'self'` means only its own three files.
- **Its own preload** exposes `window.nutflixPrompt` with two calls, `question()` and `answer()`,
  on `nf-prompt:init` / `nf-prompt:answer`. Main accepts them only from the current prompt
  window's webContents, top frame, at `app://prompt`. The IPC gate refuses that webContents for
  everything else, and the app window's preload never uses those channels.
- **Data-only questions.** A `PromptForm` carries flags (`hasKey`, `keychain`, `retry`), never
  text: every word the window shows is in its own page, so nothing upstream can put prose in
  front of the user in this trusted window.
- **Answers must fit.** An answer is shape-checked, and `promptAnswerFits` checks that it answers
  the question asked, with only what the question offered. The page checks it, and then main and
  the host check it again. Keychain is refused when not offered, "remember" without a keychain is
  refused, and a flow other than the key's state allows is refused. A misfit is a cancel, and its
  secret is wiped.
- Closing the window, or Escape, is a cancel. The host gives a prompt 5 minutes.
- "Create a wallet" defaults to **Not now** (focus and Escape).

## 3. Secrets in transit

- Page (a password field) → main (UTF-8 bytes; main's copy wiped once posted) → host (bytes) →
  `SignerManager` (wiped after use).
- For `keychain`, the host keeps one secure copy until the unlock succeeds, then asks main to seal
  it, then wipes it.
- `safeStorage` takes JS strings, and a bunker URI must be a string for nostr-tools. Neither can
  be wiped (documented residual).
- Nothing logs a secret: the host logs error-code prefixes, and main logs a closed set of event
  names.

## 4. The OS keychain

- Main decides once, after `ready`, whether there is a real keychain (`keychainUsable`):
  - `safeStorage.isEncryptionAvailable()`, and on Linux a backend that is neither `basic_text` (a
    hard-coded key) nor `unknown`;
  - `setUsePlainTextEncryption` is never called.
- The host learns the answer as `--keychain` and offers the method only then. Main's store
  refuses anyway when unusable.
- Sealed files are 0600 in a 0700 directory, written with `O_EXCL` temp files. A symlink or a
  loose file is not read. Every failure is `null` / `false`, never a throw.
- Async `safeStorage` calls, so a keychain prompt cannot block main's event loop.

## 5. The money plane follows the signer

- Every signer change (connect, unlock, lock, sign out) swaps the money plane inside
  `WorkerSupervisor.restart(between)`:
  1. the worker is killed, and outstanding calls and play sessions end;
  2. the old plane is closed and a new one opened for an unlocked signer;
  3. a fresh worker starts, and its init carries the new signer's payments.
- Deliberate restarts do not count against the crash budget, and revive a `failed` worker.
- The worker's money handlers are read per request. The adapter holds a `SwitchingWallet`, and
  each play session revokes on the plane that authorised it.
- **Wallet creation (ADR 0012 §3):**
  - a brand-new key gets a NIP-60 wallet at once, since there is nothing to replace;
  - an existing identity (unlock, import, remote) with no wallet found is asked in the prompt
    window, defaulting to Not now, with the warning that relays may just be unreachable;
  - never asked at an unattended launch;
  - the renderer cannot start it.
- `signer.status` (a shell-only topic) tells the renderer to re-read identity and the wallet.

## 6. Other changes

- Core `connectBunker` / `resumeBunker`: bounded setup (`timeoutMs`, default 60 s; nostr-tools
  waits forever, and a bunker that revoked a client never answers). `remember` returns the resume
  blob. `onauth` defaults to a no-op: nostr-tools otherwise `console.warn`s a bunker's `auth_url`,
  often carrying a session token, past the host's logger (F39, found by this lane's review).
  Without a caller's pool, the connector makes one and closes it with the bunker (nostr-tools'
  own per-signer pool would keep its relay sockets open after `close()`).
- IPC: shell methods `desktop.signer.{info,connect,unlock,lock,signOut}`, topic `signer.status`,
  HostOut `prompt` / `prompt-cancel` / `keychain`, HostIn `prompt-answer` / `keychain-result`,
  error codes `cancelled` and `remote-signer`.
- Sign-out goes through main's native confirm (it forgets the keychain's secrets). Connect and
  lock do not, since the prompt window is the confirmation and lock only stops payments.
- A page that keeps re-opening the prompt is throttled: three dismissals within a minute pause
  connect and unlock for a minute.
- `--e2e-hooks` gains `openPrompt` / `promptAnswer` (kind + byte length only), so the Electron
  suite can drive the real window under `--dev-mocks`.

## Consequences

- The desktop signs, pays and is paid with a signer the user connected, unlocked the way they
  chose. F24 is closed for the desktop.
- `--dev-mocks` keeps its fixed read-only identity; the flow is refused there.
- Residual:
  - no "remove the key from this device" flow (a forgotten passphrase is a dead end without
    deleting the file; UI lane);
  - NIP-46 `auth_url` flows are not supported (ignored);
  - the locked identity shown before unlock is the key file header's pubkey, unauthenticated
    until unlock;
  - JS strings for `safeStorage` and the bunker URI.

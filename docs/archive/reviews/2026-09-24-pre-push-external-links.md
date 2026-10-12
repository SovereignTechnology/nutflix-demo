# Pre-push review — external links (2026-09-24)

Diff: `stage-3/f21-dev-flags` (`2c74ec9`) → `stage-3/external-links`. Method: `differential-review`
and `sharp-edges`, inline.

## Scope

- HIGH (a new path from untrusted content to the OS):
  - `app-desktop/src/main/external-links.ts` (new: the policy);
  - `main/prompt.ts` (main's own `open-link` question in the one-at-a-time queue);
  - `main/security.ts` (the window-open handler hands the URL to main and still denies);
  - `main/main.ts` (wiring; the e2e counter).
- MEDIUM:
  - `ipc/protocol.ts` (`OpenLinkForm`, `WindowForm`: main-only, not in the host's `PromptForm`);
  - `ipc/guards.ts` (`isExternalLink`);
  - `renderer/prompt/prompt.ts` (the `open-link` view).
- LOW: tests, the e2e, docs.

## Adversarial questions

- **A description that lies.** `[bank.com](https://evil.example)` shows "bank.com", but the prompt
  shows the HOST `URL` computes from main's copy (`evil.example`). A Unicode look-alike host is
  refused outright (the rule takes ASCII hosts; `URL` would have shown punycode anyway). The page
  also says the text may not match the target.
- **Schemes.**
  - Only `https:` is opened, and only after `URL` normalises it and the normalised form passes the
    rule again (tested).
  - Refused: `javascript:`, `file:`, `nostr:`, `app:`, plain `http:`, user-info, whitespace,
    control or bidi characters, and more than 2048 characters.
- **Who can ask.** Only the app's webContents, by id. The prompt window, devtools and any other
  webContents are refused (tested in the policy and through the fake Electron).
  - A compromised renderer can still call `window.open` with an https URL. That shows the same
    question with the real host, and the user must click.
  - Prompt flooding is bounded: one question at a time, five a minute (tested).
- **Who can answer.** The answer comes only from the prompt window's top frame at `app://prompt`
  (the existing sender check), as exactly `{kind:'open-link', open}`. Anything else, a close or a
  failed window means "don't open" (tested).
  - The URL opened is main's own copy from when it asked, never anything the page sends.
- **Host separation.** The host's guard (`isPromptForm`) does not accept `open-link`, so a
  compromised host cannot use main's link question to open anything.
  - Main's question never reaches the host: no `prompt-answer` is posted (tested).
  - A host restart (`cancelAll`) leaves it open (tested).
- **Deny stays deny.** The window-open handler returns deny whatever the callback does, even if
  it throws (tested). No new BrowserWindow ever loads the link.

## Found and fixed before commit

None beyond the design. Test names now carry labels: the overlong-link case printed a
3000-character test name.

## Tests

- `external-links.test.ts` (17): what may be opened, and 13 refusals; asks and opens only on
  "open"; other webContents and non-https links; one at a time; the rate limit.
- `prompt.test.ts` (3): main's question shares the queue and never reaches the host; close,
  malformed answer or failed window means don't open; a host going away leaves it.
- `security.test.ts` (1): the handler passes the URL and id on and still denies.
- `main-wiring.test.ts` (1): the whole path through the fake Electron.
- Electron e2e (`stage1.e2e.ts`): clicking the fixture's Markdown link opens the prompt window
  showing `example.com`; Escape opens nothing, and the app stays on its page. 16/16.
- Mutations (all caught):
  - any webContents may ask;
  - any answer opens;
  - no one-at-a-time;
  - no rate limit;
  - no link rule.

# Pre-push review — packaged builds refuse the dev flags (2026-09-24)

Diff: `stage-3/wallet-journal` (`b000032`) → `stage-3/f21-dev-flags`. Method: `differential-review`
and `sharp-edges`, inline.

## Scope

MEDIUM: `app-desktop/src/main/main.ts` (a startup refusal), `args.ts` (`DEV_FLAGS`,
`devFlagIn`), `log.ts` (one event). LOW: tests, docs.

## Adversarial questions

- **Bypass by spelling.**
  - Refused: the exact flags, which are also the only spellings `parseMainArgs` honours.
  - `--dev-mocks=1` or `--DEV-MOCKS` are ignored by the parser, so they cannot switch anything
    on either (host-link tests pin the parser).
- **Bypass through the host.**
  - The host takes dev flags only from main (`hostArgs`), and in a packaged build main exits
    before spawning it.
  - A host launched by hand is not the app, and has no window to show a mock wallet in.
- **Order.** The check runs before the ready event, next to the sandbox refusal: nothing is
  registered and no window, protocol or IPC channel exists (tested: `order` is empty and no
  protocol is registered).
- **What it does not cover.** `NODE_OPTIONS`, `--inspect` and `ELECTRON_RUN_AS_NODE` act before
  main's code runs, so only the Electron fuses can close them. They are recorded as open in F21,
  for the packaging lane.

## Found and fixed before commit

None.

## Tests

- `main-wiring.test.ts`:
  - a packaged build refuses each dev flag (exit 78, nothing registered);
  - a packaged build without dev flags starts, and its host gets no dev flag.
- Mutation (removing the check): the 3 refusal tests fail.

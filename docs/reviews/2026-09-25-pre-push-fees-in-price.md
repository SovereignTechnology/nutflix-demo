# Pre-push review — mint fees shown in the price (2026-09-25)

Diff: `stage-3/profile-picture` (`8efb865`) → `stage-3/fees-in-price`. Method: `differential-review`
and `sharp-edges`, inline. Issue #7.

## Scope

- LOW (display only; a read-only wallet query):
  - `core/src/contracts/wallet.ts` (`inputFeePpk`, v6);
  - `core/src/wallet/wallet.ts`;
  - `core/src/mocks/mock-wallet.ts`;
  - `app-desktop/src/host/wallet.ts` and the IPC table, guards, bridge, renderer adapter;
  - `ui/src/components/shared/format.ts` (`estimateMintFeeSats`);
  - `ui/src/screens/Watch/*` (the fee line; the channel avatar's hash and size).

## Adversarial questions

- **Nothing moves money.** `inputFeePpk` reads the cached active keyset. The estimate only
  changes a label; the PAY path, and what a viewer is charged, are untouched.
- **A mint lying about fees** changes only the displayed estimate. The real fee is still
  whatever the mint takes at swap time, as before.
- **Bad values.** A non-integer or negative fee reads as 0. The estimate is 0 for a free mint
  or a zero price, so no fee line is shown.
- **Renderer bundle.** The UI still imports no core runtime code. The default minimum PAY is a
  local constant pinned to core's by a test.
- **IPC.** The method count pin moves to 56, and the argument is a mint URL (guarded).

## Tests

- Core:
  - `wallet.test.ts`: 100 ppk reported, 0 for a free mint;
  - `real-mint.integration.test.ts`: equals the advertised active keyset fee on Nutshell (100)
    and cdk.
- UI:
  - the estimate's arithmetic, the pin to core's default, and the constants;
  - Watch shows the fee line for a charging mint and none for a free one.
- Desktop: guard samples.

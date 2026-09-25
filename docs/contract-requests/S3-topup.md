# Contract requests — lane S3-topup (issue #2, against `CONTRACTS_VERSION = 6`)

Neither item blocks the lane: each is worked around in the desktop host as described.

## 1. `Wallet.melt` takes no memo, so an auto top-up's funding melt is written as "melt to Lightning"

**Need.** Issue #2: "every top-up in wallet history" — memo `top-up`, in at the target mint, out
at `fromMint`. Minting at the target already writes `in … "top-up"` (core `wallet/spend.ts`
`mint`). The melt at `fromMint` writes `out … "melt to Lightning"`: `Wallet.melt(quote)` has no
`memo` (unlike `Wallet.send`, which does since v5), and `wallet/spend.ts` is a locked audit path
outside this lane. Writing a second, "top-up"-labelled kind 7376 for the same movement would
count the sats out twice, so the host does not.

**Workaround.** The desktop host records the melt's own history id in its top-up ledger
(`packages/app-desktop/src/host/topup/ledger.ts`, entry `melt`) and shows that entry as `top-up`
wherever the screens read history (`wallet.history` and the `wallet.change` topic —
`AutoTopUp.relabel`). While the melt is in flight, the one new melt entry at the source mint is
labelled too, so the live event agrees. The NIP-60 event itself still says "melt to Lightning":
another client (or this app on another device) shows it that way.

**Proposal.** `Wallet.melt(quote, opts?: { readonly memo?: string })`, `memo` into the 7376
history entry exactly as `send` does (default unchanged). The host then passes `"top-up"` and the
relabel (and the ledger's `melt` field) can go.

## 2. The per-day cap's accounting of fees is not stated

**Need.** `AUTO_TOP_UP_MAX_SATS_PER_DAY` says "the most auto top-ups move in any rolling 24
hours". A top-up of `amountSats` also costs the source mint's Lightning fee and its input fees.

**Decision taken (fail closed).** The host counts what left the source mint — the amount plus
every fee — and, while a top-up is in flight, the amount plus the Lightning fee reserve plus an
input-fee allowance (64 inputs at the keyset's `input_fee_ppk`). So four 10 000-sat top-ups fit in
a day, not five, whenever the source mint charges anything. `AUTO_TOP_UP_MAX_SATS` remains the
amount minted at the target (fees on top, at most 5 % with a 10-sat floor, or the top-up is
refused).

**Proposal.** One sentence in the `Settings.autoTopUp` doc: "fees included" (or the opposite, if
Cameron prefers the amount alone — then the host counts `amount` only and the copy changes).

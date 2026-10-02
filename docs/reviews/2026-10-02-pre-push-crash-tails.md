# Pre-push review — R2: an open session's crash tail (2026-10-02)

Diff: `main` → the crash-tails branch (lane C4-crash-tails, a Claude Code cloud session).
Cameron's decision (status.md, Stage 3 input 28): **persist open-session budgets** so a full-app
crash's tail can be paid. No contract change, no locked path; money path: `host/tails.ts`,
`host/money.ts`.

## The residual

A seeder keeps counting blocks we never paid, across our runs; the worker pays those its durable
record says it received, under a TAIL AUTHORISATION the host keeps for the closed session. Tails
were written at close, quit, sign-out or a worker crash — never at a crash of the whole app (the
host's session budgets are in memory). After such a crash the worker's record still offered the
tail and the host refused it: respected, never paid; the seeder lost those blocks.

## The design

No new file and no new mechanism: the tail book that already persists closed sessions' tails (a
private file per identity, blocks taken off ON DISK before a PAY is built) gets one more kind of
entry, the open session's PROVISIONAL tail.

| When | What |
|---|---|
| `authorizeSession` | provisional = min(`MAX_TAIL_BLOCKS`, the session's budget), written (async; a failure is logged) |
| each PAY of the open session | its blocks leave the provisional ON DISK before the PAY is built; a write that fails refuses the PAY (`internal`, nothing spent — the wallet's own journal needs the disk for it anyway); a PAY that fails gives them back — only while the session is still open |
| `revokeSession` / plane `close` | replaced by the ordinary tail (`keepTail`), or **dropped** when nothing is unpaid |
| next start (`TailBook.load`) | a provisional entry on disk is a crash's: an ordinary tail, expiring `TAIL_TTL_MS` after its last write; logged as a count |
| the same run | a provisional entry is never payable as a tail (`lookup` skips it): the open session pays |

The authority this adds is exactly the one a clean close with an unknown count (`unpaid: null`,
the worker gone) already leaves: at most what the session had left, at most `MAX_TAIL_BLOCKS`, the
same core, blob and terms, 7 days. The bound on what is paid is still the worker's record (only
blocks it received and has not paid, written ahead of every PAY) and the seeder's report.

## Tests (each mutation checked)

`host/__tests__/tails.test.ts` "R2" (5):
- TailBook: provisional never pays in its run; a re-opened book makes it a tail; `drop`; lowered to
  nothing drops it; the crash count is logged.
- A full-app crash with a session open (the plane never closed): the next run pays exactly what was
  left (12 − 2 blocks), the provisional on disk having dropped by the PAY before it was built.
- Closed with nothing unpaid: a crash after it pays nothing for that session.
- A crash tail that cannot be written refuses the open session's PAY, nothing spent (the directory
  replaced by a file: fails even as root).
- A PAY that fails after its session closed gives nothing back to a provisional: the ordinary tail
  stays payable.

Mutations, each caught: no write-ahead on open PAYs (2 fail), no drop on a nothing-unpaid close
(1), provisional payable in its own run (1), no conversion on load (2), the give-back written after
the close (1).

## Attacker model

- **A compromised worker** could already claim a closed session's whole remaining budget (capped)
  by saying nothing at close; a crash now gives it the same, no more. It cannot raise a provisional:
  only the host writes it, from its own session budget.
- **A crash between a spend and its write** cannot leave more authorised than was left: the write
  precedes the spend; a crash after it leaves less (the conservative side).
- **Another identity's file, a symlink, a damaged entry**: the tail book's existing rules (refused,
  dropped, replaced).

## Residuals

- One more private-file write per PAY of an open session (the book is small; PAYs batch to half a
  seeder's window).
- An older build reading a provisional entry drops that entry (its strict guard): no deployed base.

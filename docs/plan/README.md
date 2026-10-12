# Plans

- `build-plan.md`: the v2 build plan (the *what*), kept verbatim as a historical input. Where it
  disagrees with `docs/decisions/` or the code, those win; the resolutions of its open assumptions
  are in `docs/decisions/0003-*.md`.
- `L6-design.md`: the design review of the desktop shell, written before it was built. The ADRs
  (0012, 0013, 0017) and the code are the current description.
- The execution plan (the *how* of the parallel build) is in the archive:
  [`../archive/execution-plan.md`](../archive/execution-plan.md).

Section map used by the lane briefs in the archive (a lane got only its own section of the plan):

| Lane | build-plan sections |
|------|---------------------|
| L1 nostr-data | §2.2 |
| L2 seeder | §2.1, §2.3, §7 |
| L3 gateway | §5 |
| L4 design-system | §6.2, §6.3 |
| L5 screens | §6.1, §6.2 |
| L6 desktop-shell | §2.1, §7 |
| L7 web-shell | §5 |
| L8 transcode | §6.4 |
| L9 ci-hardening | §7 |
| L10 adversary-tests | §1 (via SECURITY.md) |
| Stage 2 | §1–§3, §4 |

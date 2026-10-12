# Documentation

Start with the [project README](../README.md). This page indexes everything else by what you are
trying to do.

## Project status

- [`status.md`](status.md): the current status: what is released, what CI checks, what has not
  been checked, and the open work.
- [`CHANGELOG.md`](../CHANGELOG.md): what each release contains.

## Use the app

- [Releases](https://github.com/SovereignTechnology/nutflix-demo/releases): the downloads, with
  checksums and the signed release notice.
- [README: Install](../README.md#install) covers installing and verifying a release.

## Run a seeder or gateway

- [`deploy/systemd/README.md`](../deploy/systemd/README.md): the hardened systemd units for the
  seeder and gateway daemons, the config keys, and what each hardening directive does.
- [`deploy/systemd/MDWE-RESULTS.md`](../deploy/systemd/MDWE-RESULTS.md): the measured result for
  `MemoryDenyWriteExecute`.

## Contribute

- [`CONTRIBUTING.md`](../CONTRIBUTING.md) and the [Code of Conduct](../CODE_OF_CONDUCT.md).
- [`decisions/`](decisions/): architecture decision records (ADRs). Each one records a decision
  and why it was made. Code comments cite them by number, so they are never renumbered.
- [`plan/build-plan.md`](plan/build-plan.md): the original build plan. It is a historical input:
  where it disagrees with the ADRs or the code, those win.
- [`spikes/`](spikes/): the three early research spikes that ADRs 0002 and 0003 rest on.
- [`native-modules.txt`](native-modules.txt): the reviewed list of native modules. CI fails if the
  installed set differs; `scripts/native-module-inventory.sh --check` runs the same test.

## Review the security

- [`SECURITY.md`](../SECURITY.md): how to report a vulnerability, the threat model, the
  money-path invariants and the audit surface.
- [`security-review.md`](security-review.md): the security review: every finding, its state and
  its residual risk.
- [`reviews/`](reviews/): per-change review records written before each push (differential
  review and sharp-edges notes).

## Reference

- [`vendor/`](vendor/): pinned copies of the upstream specs and library docs the code is written
  against (Nostr NIPs, Cashu NUTs, Blossom BUDs, Hypercore and Pear). They are other projects'
  documents, not covered by this repository's licence grant.
- [`design/README.md`](design/README.md): the brief the UI was designed to.

## Project history

These are the working records of the build. They are kept for provenance, not as current
documentation, and commit hashes or branch names in them may not exist in this repository.

- [`lanes/`](lanes/): one report per work lane (scope, what changed, how it was verified).
- [`contract-requests/`](contract-requests/): requests to change the frozen interface contracts.
- [`prompts/`](prompts/): the working prompts used during the build.
- [`plan/execution.md`](plan/execution.md) and [`plan/L6-design.md`](plan/L6-design.md): the
  execution plan and the desktop shell design review.

# Archive: the records of the build

**These are historical records, kept for provenance. They are not current documentation.**

Desktop 0.1.0 was built in September and October 2026 by a parallel process run by the maintainer:
an *orchestrator* session coordinated many *lanes*, each a unit of work with its own scope, brief
and report, in *stages* (Stage 0 scaffold and spikes, Stage 1 parallel lanes, Stage 2 security,
Stage 3 integration). These files are what that process wrote down as it went. They were written
for the people running it, not for readers of the finished project.

Read them with this in mind:

- **Commit hashes, `stage-N/` and `lane/` branches, and issue numbers do not exist in this
  repository.** The history was rewritten before publication, and the tracker was private. The
  decisions and fixes they describe are in `main`; to find one, use the finding's F-number, the
  file the record names, or the test that pins it.
- **Many of the records are self-review.** A review or a lane report was usually written by the
  session that made the change. The project's security review, which collects the findings, is
  [`docs/security-review.md`](../security-review.md), and it was done in-house with AI assistance;
  it is not an independent audit.
- Source comments still cite these files by path. That is why they are here and not deleted.

## Contents

| Path | What it is |
| ---- | ---------- |
| [`status-2026-10-04.md`](status-2026-10-04.md) | The orchestrator's running log of the build, up to the 0.1.0 release |
| [`execution-plan.md`](execution-plan.md) | The execution plan: ground rules for the parallel lanes, stages, merge order |
| [`prompts/`](prompts/) (3) | The prompts that started the orchestrator, a lane and the Stage 2 security session |
| [`lanes/`](lanes/) (43) | One report per lane (scope, what changed, how it was verified), and `BRIEFS.md` with each lane's allowlist. Several hold reference material that code cites: `L2` and `L3` (the seeder and gateway entry points), `L6-A` (the desktop shell design and its fidelity findings), `L9` (the native-module review) and `L10` (the adversary tests) |
| [`contract-requests/`](contract-requests/) (18) | Requests from lanes to change the frozen interface contracts, with the outcome. `P2-owed-viewer.md` is cited as normative by `packages/core/src/contracts/pay-protocol.ts`; stubs at `docs/contract-requests/` redirect the two files that frozen code cites |
| [`reviews/`](reviews/) (45) | Pre-push security reviews, one per change from 2026-09-23 to 2026-10-02, with the findings and what was done about them, and the secret scan of the history (2026-09-27) |

## Where the current versions are

- What is released and what is open: [`docs/status.md`](../status.md) and the
  [CHANGELOG](../../CHANGELOG.md).
- Decisions and their reasons: [`docs/decisions/`](../decisions/).
- The threat model and the reporting policy: [`SECURITY.md`](../../SECURITY.md).
- How to run the end-to-end suites: [`docs/development.md`](../development.md).

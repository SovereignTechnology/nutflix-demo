# 19. Scope: Pear/desktop only; the web portal is out

Date: 2026-10-02

## Status

Accepted. Amends ADR 0002 and ADR 0003, which describe a web portal as part of the design.

## Context

The early plans (ADR 0002, the build plan) described two shells over one protocol library: a
desktop app and a static web portal that would talk to a gateway over WebSockets and run Hypercore
in the page. Only the desktop half was ever built. The web lane (L7) never started, and
`packages/app-web` is an empty scaffold.

In parallel, the sibling repository [nfx](https://github.com/SovereignTechnology/nfx) took on the
multi-network design: a standardised protocol suite over iroh, content-addressed segments and a
broader reach (its ADRs 0006 and 0008). That left this repository as the JavaScript implementation
on the Hypercore stack: a working demonstration of pay-per-block video, which is what shipped as
desktop 0.1.0.

## Decision

**This repository is Pear/desktop only.** It ships the Electron desktop app, and keeps the seeder
and gateway daemons as the building blocks the app embeds and that an operator can run. The web
portal is out of scope here: build-plan Phase 5 and lane L7 are not built. A browser shell, if one
is wanted, belongs to nfx.

`packages/app-web` stays in the workspace as a labelled placeholder rather than being deleted in
the same change, because the TypeScript project references and a few tests enumerate it.

## Consequences

- ADR 0002's web shell and ADR 0003's browser-Hypercore result (spike A8) stand as research, but
  nothing is built on them.
- Threat T13 (malicious portal JavaScript) and invariant 8 in `SECURITY.md` describe a browser shell.
  They are kept for a future one and annotated as not applicable to 0.1.0.
- The web-only tooling (`scripts/reproducible-web-build.sh`, `scripts/csp-sri.mjs`) has no shipping
  target in this repository.
- Numbers 0006 and 0008 are used by the nfx repository and are not used here. This is why the
  sequence skips them.
- Follow-up, not done by this decision: delete `packages/app-web` and the web-only tooling. That is
  a code change that also touches the TypeScript references and the tests that enumerate packages.

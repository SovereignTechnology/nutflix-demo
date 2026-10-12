# Frontend design reference

The maintainer supplied this brief in writing on 2026-09-05, verbatim:

> i do not have files or things to show you. you know how youtube works and feels. also
> Rumble. it should be a clean expreience just like these mainstream sites

## What that means for the design system and the screens

- **Reference sites: YouTube and Rumble.** Layout, information density, navigation model, card
  grid, watch page (player + title/channel/actions row + description + comments, related list on
  the right at desktop width), channel page tabs, search results list, Shorts vertical feed,
  Library, Studio upload flow and Settings follow those two sites' conventions. Where they differ,
  YouTube's wins and Rumble is the second reference.
- **"Clean, like the mainstream sites."** No experimental layouts and no novelty chrome. What
  differs from YouTube is the *content* Nutflix adds: the price (`SatsBadge`) shown before
  playback, the mint (`MintChip`), `PeerMeter` and the wallet balance. They are ordinary UI
  elements in those same layouts, not a separate "crypto" visual language.
- **No brand assets were supplied** (no files, palette or type). The design system therefore uses
  defaults that match the brief: a neutral palette with light and dark themes, a system UI font
  stack, YouTube-like density and radii. Each choice is recorded in the design-system report
  (`docs/lanes/L4.md`) and can be changed without touching the screens, because everything is a
  token.
- **Theme** (ADR 0005): light and dark, following the system (`prefers-color-scheme`), with a
  toggle in Settings. Both themes are token sets.
- Anything in this file beyond the quoted brief and the theme decision is a reading of the brief,
  not a stated requirement.

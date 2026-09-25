/**
 * What the packaged app is called, and where its pieces live (issue #6, ADR 0017). One place, so
 * the Forge config, the makers, the staging step and the release manifest agree.
 */

export const APP = {
  /** Package, executable and Linux binary name. */
  name: 'nutflix',
  /** Human-facing name: window class, bundle, installer, artifact prefix. */
  productName: 'Nutflix',
  /** macOS bundle id / Windows AppUserModelID base (ADR 0017: a question for Cameron). */
  appId: 'xyz.sovit.nutflix',
  description: 'Nostr-native peer-to-peer video, paid per block with Cashu ecash',
  author: 'SovTech',
  /** Debian `Maintainer:` (the repo's commit identity; ADR 0017 open question). */
  maintainer: 'SovTech <git@sovit.xyz>',
  license: 'AGPL-3.0-or-later',
} as const;

/** The Nostr `d` tag of the desktop release notice (kind 30071, `NostrKind.ReleaseNotice`). */
export const RELEASE_D_TAG = 'nutflix-desktop';

/**
 * Relative to `app.asar.unpacked/`: the packaged worker's unbundled boot module. Must equal
 * `PACKAGED_WORKER_ENTRY` in src/main/args.ts (main hands this path to the host); a test pins
 * the two together, since this build-time code cannot import the app's sources at runtime.
 */
export const PACKAGED_WORKER_ENTRY = 'worker/boot.mjs';
/** The bundle the boot module loads (our sources only; npm packages stay imports). */
export const PACKAGED_WORKER_BUNDLE = 'worker/worker.mjs';

/**
 * Directories of the staged app that `asar` must leave as real files in `app.asar.unpacked/`:
 * the Bare worker and everything it loads (Bare cannot read an archive), which includes
 * `bare-sidecar`'s prebuilt `bare` (a spawned binary cannot live in one either).
 */
export const UNPACKED_DIRS = ['worker', 'node_modules'] as const;

/**
 * Runtime dependencies of @sovit/app-desktop that are NOT copied into the packaged
 * `node_modules`, with the reason. Everything else in `dependencies` is, with its closure.
 */
export const NOT_SHIPPED: Readonly<Record<string, string>> = {
  react: 'bundled into renderer/app.js (scripts/bundle.ts)',
  'react-dom': 'bundled into renderer/app.js (scripts/bundle.ts)',
  '@sovit/ui': 'bundled into renderer/app.js (scripts/bundle.ts)',
  'pear-runtime':
    'types only: the host spawns the worker with bare-sidecar directly (D2) and never constructs PearRuntime (no OTA, ADR 0017)',
};

/**
 * The files the renderer bundles leave in `dist/` (scripts/bundle.ts) and main serves: must
 * equal `APP_FILES` / `PROMPT_FILES` in src/main/app-protocol.ts (pinned by a test).
 */
export const RENDERER_FILES = ['index.html', 'app.js', 'ui.css', 'shell.css'] as const;
export const PROMPT_FILES = ['prompt.html', 'prompt.js', 'prompt.css'] as const;
export const PRELOAD_FILES = ['preload.cjs', 'prompt-preload.cjs'] as const;

/**
 * @sovit/app-desktop — Electron + pear-runtime Bare-worker shell (ADR 0003, design
 * docs/plan/L6-design.md). Wave 1 contributed the transcode worker (L8); L6-0 the IPC
 * foundation; L6-A/B/C add the shell, host and worker.
 */
export const PACKAGE = '@sovit/app-desktop' as const;
export * as transcode from './worker/transcode/index.js';
export * as ipc from './ipc/index.js';

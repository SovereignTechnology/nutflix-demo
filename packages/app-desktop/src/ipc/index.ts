/**
 * `@sovit/app-desktop` IPC foundation (lane L6-0): the renderer ⇄ main ⇄ host protocol, the
 * host ⇄ worker protocol, their guards, framing, error envelopes and Map rehydration.
 * Runtime-neutral — safe to import from main, host, preload, renderer and the Bare worker.
 */
export * from './protocol.js';
export * from './guards.js';
export * from './errors.js';
export * from './wiremap.js';
export * from './codec.js';
export * from './framing.js';
export * from './worker-protocol.js';
export * from './worker-guards.js';

/**
 * @sovit/seeder — Corestore + Hyperblobs seeder daemon (build-plan §2.1, §2.3, §7).
 * Issued against CONTRACTS_VERSION = 2, re-issued at CONTRACTS_VERSION = 3 (ADR 0004).
 * Public API documented in docs/lanes/L2.md.
 *
 * Node entry = the runtime-portable API (`./portable.ts`, also the `bare` export condition)
 * plus the Node adapters.
 */
export * from './portable.js';

// Node adapters (Node only — never reachable from the `bare` condition)
export { nodeAdapters, nodeFs, nodeCrypto, nodeProcess } from './adapters/node/index.js';
export type { SeederAdapters } from './adapters/node/index.js';

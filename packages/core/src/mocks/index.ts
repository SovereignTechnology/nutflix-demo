/**
 * Mocks — execution plan §0 rule 4. Explicit and cheatable. Lanes use them to integrate before
 * the real implementations exist. Never reached by a production code path: the only runtime
 * importers are behind loud, fenced dev flags — the gateway's `--dev-mocks` (loopback-only
 * listen) and the desktop host/worker's `--dev-mocks` / `--dev-fixtures` (loopback-only swarm
 * bootstrap) — accepted for Stage 1 (docs/plan/L6-design.md). Stage 2 replaces them.
 */
export * from './fixtures.js';
export * from './mock-payment-engine.js';
export * from './mock-wallet.js';
export * from './mock-network-adapter.js';
export * from './test-mint.js';
export * from './counter-store.js';

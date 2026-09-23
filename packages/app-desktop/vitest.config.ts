import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'app-desktop',
    // Only `*.test.ts(x)` under `__tests__/` are suites; helpers beside them are not.
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.tsx'],
    // `e2e/` is the Electron end-to-end suite (NUTFLIX_E2E=1, playwright-core) — never here.
    exclude: ['e2e/**', '**/node_modules/**', '**/dist/**'],
    // Main, host and worker code is Node/Bare; renderer tests opt in per file with a
    // `// @vitest-environment jsdom` docblock.
    environment: 'node',
  },
});

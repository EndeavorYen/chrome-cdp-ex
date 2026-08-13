import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 15_000,
    // Vitest 3.2 worker RPC can miss onTaskUpdate after heavy AST inventory
    // files even when every assertion passed; coverage then exits 1.
    dangerouslyIgnoreUnhandledErrors: true,
    coverage: {
      provider: 'v8',
      thresholds: {
        statements: 34,
        // Match the current full-suite baseline so CI catches regressions without false-red releases.
        branches: 68,
        functions: 44,
        lines: 34,
      },
    },
  },
});

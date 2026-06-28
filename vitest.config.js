import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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

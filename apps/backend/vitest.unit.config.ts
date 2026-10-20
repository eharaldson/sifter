import { defineConfig } from 'vitest/config';

// These existing tests exercise pure normalization and matching logic.
// No database setup hook, catalogue, network access or API keys are needed.
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/normalize.test.ts', 'tests/match/colorMatching.test.ts'],
    testTimeout: 10000,
  },
});

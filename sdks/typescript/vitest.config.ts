import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Use node environment for tests
    environment: 'node',

    // Disable threads for reliability - ensures single container/pool is used
    threads: false,

    // Test file patterns
    include: ['test/**/*.test.ts'],

    // Timeout for tests (30s to account for container startup)
    testTimeout: 30000,

    // Setup file for global test utilities
    setupFiles: ['./test/setup.ts'],
  },
});

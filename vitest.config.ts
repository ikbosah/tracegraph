import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/tests/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'sample-projects/*/tests/**/*.test.ts',
      'apps/*/tests/**/*.test.ts',
    ],
    globals: false,
    environment: 'node',
    testTimeout: 30_000,   // integration tests can be slow
    hookTimeout: 15_000,
    reporters: ['verbose'],
  },
});

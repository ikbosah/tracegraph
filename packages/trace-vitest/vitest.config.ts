import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@tracegraph/shared-types': path.resolve(__dirname, '../shared-types/src/index.ts'),
      '@tracegraph/trace-core':   path.resolve(__dirname, '../trace-core/src/index.ts'),
      '@tracegraph/trace-js':     path.resolve(__dirname, '../trace-js/src/index.ts'),
    },
  },
});

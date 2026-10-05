import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts'],
    // The scanner probes many paths per fixture; give slow CI room.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    reporters: 'default',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/dist/**', '**/*.d.ts'],
    },
  },
});
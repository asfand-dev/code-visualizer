import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Fixture projects are analyzed statically; their own *.test.* files must never run.
    exclude: [...configDefaults.exclude, 'test/fixtures/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

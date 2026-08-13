import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: [
      'tests/**/*.test.{ts,tsx}',
      'src/**/*.test.{ts,tsx}',
      'packages/**/*.test.{ts,tsx}',
    ],
    exclude: [
      'tests/known-failures/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
    ],
    testTimeout: 15000,
  },
});

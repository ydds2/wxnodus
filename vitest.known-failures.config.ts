import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/known-failures/known-failures-wrapper.test.ts'],
    testTimeout: 600000,
  },
});

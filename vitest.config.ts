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
    // CI runner（Defender 进程级扫描拖慢 spawn-heavy 用例）放宽默认超时——开发机实测
    // 全绿用例多在秒级，此值只影响真实慢环境的容差（2026-08-18 十轮 CI 实测）
    testTimeout: 60000,
  },
});

// tests/support/distGate.ts — Q3（2026-09-04 第三批）：真机层 dist 门——dist 缺失显式红而非静默 skip
// 背景：master CI 六天红（2026-08-29~09-04）期间「本地绿」部分来自静默跳过的真机层用例
// ——静默绿 ≠ 真绿（与 hasDist 静默 skip 是同族系统性风险，评估报告 Q3 提级处置）。
// 语义：dist 在 → 正常 describe；缺 → 单条显式失败用例（提示先构建）；逃生口
// WXNODUS_TEST_ALLOW_NO_DIST=1 → describe.skip（无构建环境调试纯逻辑用，skip 可见于报告）。
import { describe, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const CLI_PATH = resolve(__dirname, '../../dist/cli/index.js');
export const hasDist = existsSync(CLI_PATH);
const allowNoDist = process.env.WXNODUS_TEST_ALLOW_NO_DIST === '1';

export const describeWithDist: typeof describe = hasDist
  ? describe
  : ((name: string, fn: () => void) => {
      if (allowNoDist) return describe.skip(name, fn);
      return describe(name, () => {
        it(`dist 缺失（${CLI_PATH}）——真机层测试要求先构建：npm run build；逃生口 WXNODUS_TEST_ALLOW_NO_DIST=1`, () => {
          throw new Error('dist 缺失：真机层测试无法运行（先 npm run build）');
        });
      });
    }) as typeof describe;

import { runKnownFailureCase } from '../caseHarness.js';

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ComputerUse } from '../../../src/kernel/computer/index.js';
import { ActionGuard } from '../../../src/kernel/computer/guards.js';

await runKnownFailureCase({
  failureId: 'KF-008',
  expectedFailureCode: 'ROBOTJS_ARGUMENT_MISMATCH',
  assertionMessage: 'ROBOTJS_ARGUMENT_MISMATCH',
  run: async () => {
    // 预加载 robotjs 并打入 spy（与 index.ts 的 createRequire 共享模块缓存）——不产生真实鼠标动作
    const requireCjs = createRequire(import.meta.url);
    const robot = requireCjs('robotjs');
    let clicked: string | undefined;
    const origClick = robot.mouseClick;
    robot.mouseClick = ((b: string) => { clicked = b; }) as any;
    try {
      const cu = new ComputerUse(new ActionGuard({ width: 1920, height: 1080 }));
      await cu.act({ type: 'click', x: 10, y: 10, button: 'double' });
      // 正确行为：robotjs 无 'double' 点击语义，应转为两次 click 或诚实报错
      assert.notEqual(clicked, 'double', 'ROBOTJS_ARGUMENT_MISMATCH');
    } finally {
      robot.mouseClick = origClick;
    }
  },
});

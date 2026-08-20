// tests/regressions/known-failures/kf-008-robotjs-arguments.regression.test.ts — KF-008 迁移绿回归
// 契约：robotjs mouseClick 无 'double' 按钮语义——double 必须转换为按钮 + 双击布尔第二参
// （mouseClick(button, double)），绝不把 'double' 当按钮名传入（原生层参数不匹配）。
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ComputerUse } from '../../../src/kernel/computer/index.js';
import { ActionGuard } from '../../../src/kernel/computer/guards.js';

describe('KF-008 resolved: robotjs 双击语义转换（不把 double 当按钮名）', () => {
  it('源锚点：click 分支 button 只传 left/right，双击走布尔第二参', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/kernel/computer/index.ts'), 'utf8');
    const block = src.slice(src.indexOf("case 'click'"), src.indexOf("case 'type'"));
    expect(block).toContain("r.mouseClick(a.button === 'right' ? 'right' : 'left', a.button === 'double')");
    expect(block).not.toContain("'double' ? 'double'");
  });

  it('行为：double 点击经真实 robotjs spy——首参按钮名绝不等于 double', async () => {
    // 预加载 robotjs 并打入 spy（与 index.ts 的 createRequire 共享模块缓存）——不产生真实双击
    const requireCjs = createRequire(import.meta.url);
    const robot = requireCjs('robotjs');
    let clicked: string | undefined;
    let doubleFlag: boolean | undefined;
    const origClick = robot.mouseClick;
    const origMove = robot.moveMouse;
    robot.mouseClick = ((b: string, d?: boolean) => { clicked = b; doubleFlag = d === true; }) as any;
    robot.moveMouse = (() => {}) as any; // 不移动真实光标
    try {
      const cu = new ComputerUse(new ActionGuard({ width: 1920, height: 1080 }));
      await cu.act({ type: 'click', x: 10, y: 10, button: 'double' });
      expect(clicked).toBe('left');
      expect(doubleFlag).toBe(true);
    } finally {
      robot.mouseClick = origClick;
      robot.moveMouse = origMove;
    }
  });
});

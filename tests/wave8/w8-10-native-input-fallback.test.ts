// tests/wave8/w8-10-native-input-fallback.test.ts — W8-10：robotjs 输入兜底契约（Windows 生态互依收尾）
// 契约：robotjs 原生模块加载失败时，鼠标/键盘输入兜底到系统 user32 SendInput（PowerShell 桥）——
// 消除最后一个 npm 原生模块单点：
// ① 纯脚本构建器：click=MOUSEEVENTF_LEFTDOWN/UP、double=两轮、right=RIGHTDOWN/UP、type=SendWait（转义）、
//    key 具名键→SendKeys 记法、scroll=MOUSEEVENTF_WHEEL；
// ② 非 Windows → ok:false（诚实）；
// ③ 主通道优先：getRobot 失败才走兜底（源锚点）。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSendInputScript, nativeInput } from '../../src/kernel/computer/nativeInput.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const indexSrc = (): string => readFileSync(resolve(ROOT, 'src/kernel/computer/index.ts'), 'utf8');

describe('W8-10 robotjs 输入兜底（user32 SendInput）', () => {
  it('脚本构建器：click 按下/抬起事件正确；double 两轮；right 用 RIGHT 事件', () => {
    const single = buildSendInputScript({ type: 'click', x: 10, y: 20 });
    expect(single).toContain('0x0002'); // MOUSEEVENTF_LEFTDOWN
    expect(single).toContain('0x0004'); // MOUSEEVENTF_LEFTUP
    const dbl = buildSendInputScript({ type: 'click', x: 10, y: 20, button: 'double' });
    expect(dbl.match(/0x0002/g)?.length).toBe(2);
    const right = buildSendInputScript({ type: 'click', x: 10, y: 20, button: 'right' });
    expect(right).toContain('0x0008'); // MOUSEEVENTF_RIGHTDOWN
    expect(right).toContain('0x0010'); // MOUSEEVENTF_RIGHTUP
  });

  it('脚本构建器：type 走 SendWait 且转义特殊字符；key 具名键→SendKeys 记法；scroll 滚轮', () => {
    const t = buildSendInputScript({ type: 'type', text: 'hello{world}+' });
    expect(t).toContain('SendWait');
    expect(t).toContain('hello');
    expect(t).toContain('{{}');
    const k = buildSendInputScript({ type: 'key', key: 'enter' });
    expect(k).toContain('{ENTER}');
    const s = buildSendInputScript({ type: 'scroll', x: 0, y: 0, amount: 3 });
    expect(s).toContain('0x0800'); // MOUSEEVENTF_WHEEL
  });

  it('非 Windows → nativeInput ok:false（诚实，绝不伪造输入完成）', async () => {
    if (process.platform === 'win32') return;
    const r = await nativeInput({ type: 'key', key: 'a' });
    expect(r.ok).toBe(false);
  });

  it('源锚点：act 的 click/type/key/scroll 分支在 getRobot() 为空时走 nativeInput 兜底', () => {
    const src = indexSrc();
    const block = src.slice(src.indexOf('async act('), src.indexOf('default:'));
    expect(block).toContain('nativeInput');
    expect(block).toContain('getRobot()');
    // 主通道优先：getRobot 失败才兜底（robotFailed 记忆失败，不反复抛）
    const getBlock = src.slice(src.indexOf('function getRobot'), src.indexOf('function getRobot') + 300);
    expect(getBlock).toContain('robotFailed');
  });
});

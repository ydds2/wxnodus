// scripts/check-statusbar-clock-repaint.mjs — W8-29/W8-32 状态栏时钟自驱重绘检查（fail-closed，正向活性检测）
// 断言：进入就绪态后，空闲（无输入/无 overlay）10s 内状态栏时钟必须持续自驱重绘。
// 渲染契约（实测更正，见 docs/audit-deep.md §7.4）：winpty = 每秒整行重绘状态栏（含「就绪」词）；
// ConPTY = 时钟 CUP 改写（\x1b[29;3xH<digit>）——无 \b、无就绪词，且 CUP 序列会被 ANSI strip 吞掉，
// 故 CUP 活性必须在原始字节段上判定。实测节拍：winpty 空闲 1/s；ConPTY 空闲 1/10s（活动态 1/s）。
// 判据：空闲 15s 内 winpty 词重绘 ≥2 或 ConPTY CUP tick ≥1 即自驱重绘正常。
// 注意：启动后先等就绪（会话锻造可能 2-10s），再测空闲段——锻造窗口内测量会误报。
// 用法：node scripts/check-statusbar-clock-repaint.mjs [WXNODUS_ACCEPT_CONPTY=1]
import { spawn } from 'node-pty';

const useConpty = process.env.WXNODUS_ACCEPT_CONPTY === '1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const p = spawn(process.execPath, ['dist/cli/index.js'], {
  name: 'xterm-256color', cols: 100, rows: 30,
  cwd: process.cwd(), env: { ...process.env, TERM: 'xterm-256color' }, useConpty,
});
let out = '';
p.onData(d => { out += d; });
const strip = s => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
const waitFor = async (pred, ms = 8000) => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) { if (pred()) return true; await sleep(250); }
  return pred();
};
try {
  // 先等就绪（会话锻造完成——时钟行才存在）
  const ready = await waitFor(() => /就绪|ready/.test(strip(out)), 20000);
  await sleep(1500);
  const idleStart = out.length;
  await sleep(15000); // 空闲 15s：无任何输入/overlay，只看自驱重绘
  const idleRaw = out.slice(idleStart);
  const idleStripped = strip(idleRaw);
  // winpty 整行重绘形态：每次 tick 重发含「就绪/ready」的整行（实测 1/s）
  const wordPaints = (idleStripped.match(/就绪|ready/g) ?? []).length;
  // ConPTY CUP 改写形态：\x1b[29;3xH<digit>（原字节上判——strip 吞 CUP；空闲实测 1/10s）
  const cupTicks = (idleRaw.match(/\x1b\[29;3[2-9]H\d/g) ?? []).length;
  const ok = ready && (wordPaints >= 2 || cupTicks >= 1);
  console.log(`===== 状态栏时钟自驱重绘（${useConpty ? 'ConPTY' : 'winpty'}）=====`);
  console.log(`就绪达成: ${ready} | 空闲 15s 词重绘: ${wordPaints} | CUP 改写 tick: ${cupTicks}`);
  console.log(ok ? '✓ 时钟自驱重绘正常' : '✗ 空闲态时钟零重绘——状态栏活性异常');
  try { p.kill(); } catch {}
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error('测试崩溃：', e);
  try { p.kill(); } catch {}
  process.exit(1);
}

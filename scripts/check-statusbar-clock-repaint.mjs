// scripts/check-statusbar-clock-repaint.mjs — W8-29/W8-32 状态栏时钟自驱重绘检查（fail-closed，正向活性检测）
// 断言：进入就绪态后，空闲（无输入/无 overlay）10s 内状态栏时钟必须持续自驱重绘。
// 渲染契约（实测更正，见 docs/audit-deep.md §7.4 + full-scene W8-32）：winpty = 每秒整行重绘状态栏（含「就绪」词）；
// ConPTY = 时钟原位改写（\b<digit> 回退一格覆盖；光标恰停时钟格时亦见 \x1b[29;3xH<digit> CUP 形态——
// 形态随状态栏尾部布局漂移，两者均判活性）——无就绪词，且 CUP 序列会被 ANSI strip 吞掉，
// 故 ConPTY 活性必须在原始字节段上判定。实测节拍：winpty 空闲 1/s；ConPTY 空闲 1/s。
// 判据：空闲 15s 内 winpty 词重绘 ≥2 或 ConPTY 改写 tick（\b<digit> 或 CUP+digit）≥2 即自驱重绘正常。
// 注意：启动后先等就绪（会话锻造可能 2-10s），再测空闲段——锻造窗口内测量会误报。
// 用法：node scripts/check-statusbar-clock-repaint.mjs [WXNODUS_ACCEPT_CONPTY=1]
import { spawn } from 'node-pty';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const useConpty = process.env.WXNODUS_ACCEPT_CONPTY === '1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 洁净间数据目录（同 full-scene 头注 8）：与评估者本机密钥/模型解耦——状态栏尾部布局
// （时钟落点/改写形态）随模型名宽度漂移，真实 key 下会引入环境绑定；无 key 洁净间
// 布局确定，任何评估者重跑同证据同分数。
const p = spawn(process.execPath, ['dist/cli/index.js'], {
  name: 'xterm-256color', cols: 100, rows: 30,
  cwd: process.cwd(), env: {
    ...process.env, TERM: 'xterm-256color',
    WXNODUS_DATA_DIR: join(dirname(fileURLToPath(import.meta.url)), '..', 'artifacts', 'battery-cleanroom'),
    // 首启语言选择会阻塞 TUI——显式 WXNODUS_LANG 跳过 onboarding（同 full-scene 头注 8）
    WXNODUS_LANG: 'zh-CN',
  }, useConpty,
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
  // winpty 整行重绘形态：每次 tick 重发含「就绪/ready」的整行（实测 1/s）；
  // 首跑黑洞策展（curator）完成通告会占据动词槽——通告行同样 1/s 重发，同判活性
  const wordPaints = (idleStripped.match(/就绪|ready|curator|自动审查/g) ?? []).length;
  // ConPTY 原位改写形态（原字节上判——strip 吞 CUP；两种形态均判活性）：
  // ① \b<digit> 回退一格覆盖（渲染器光标停时钟格后的紧凑改写，实测 1/s）；
  // ② \x1b[29;<col>H<digit> CUP 改写（光标每帧停靠输入行时逐 tick CUP 回时钟格——
  //    CUP 列随状态栏布局漂移（模型名宽度等），不锁死列号；早期实测空闲 1/10s）。
  const bsTicks = (idleRaw.match(/\x08\d/g) ?? []).length;
  const cupTicks = (idleRaw.match(/\x1b\[29;\d+H\d/g) ?? []).length;
  const ok = ready && (wordPaints >= 2 || bsTicks >= 2 || cupTicks >= 2);
  console.log(`===== 状态栏时钟自驱重绘（${useConpty ? 'ConPTY' : 'winpty'}）=====`);
  console.log(`就绪达成: ${ready} | 空闲 15s 词重绘: ${wordPaints} | \b改写 tick: ${bsTicks} | CUP 改写 tick: ${cupTicks}`);
  console.log(ok ? '✓ 时钟自驱重绘正常' : '✗ 空闲态时钟零重绘——状态栏活性异常');
  try { p.kill(); } catch {}
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error('测试崩溃：', e);
  try { p.kill(); } catch {}
  process.exit(1);
}

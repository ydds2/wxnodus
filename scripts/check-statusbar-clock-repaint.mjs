// scripts/check-statusbar-clock-repaint.mjs — W8-29 状态栏时钟自驱重绘检查（fail-closed）
// 断言：空闲态（无输入/无 overlay）下，状态栏时钟（SessionDuration/IdleSince 每秒 tick）
// 必须自主产生屏幕重绘。当前全档（ConPTY/WT）damage-limited diff 下时钟 tick 不标 damage
// → 空闲段零时钟重绘 → 本检查 RED（缺陷检测器，修复后转绿）；winpty 减档全量 diff → GREEN。
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
try {
  await sleep(2500);
  const idleStart = out.length;
  await sleep(10000); // 空闲 10s：无任何输入/overlay，只看自驱重绘
  const idleSeg = out.slice(idleStart);
  // 时钟重绘 = 状态条「│ Ns │」段中数字更新（排除启动帧——只读空闲段）
  const paints = [...idleSeg.matchAll(/│(\d+)s\s*│/g)].map(m => Number(m[1]));
  const distinct = new Set(paints);
  const ok = distinct.size >= 2; // 空闲段内至少观察到两次不同秒值（tick 在动）
  console.log(`===== W8-29 状态栏时钟自驱重绘（${useConpty ? 'ConPTY/全档' : 'winpty/减档'}）=====`);
  console.log(`空闲 10s 内时钟重绘秒值：${paints.length ? [...distinct].join(',') : '无'}`);
  console.log(ok ? '✓ 时钟自驱重绘正常' : '✗ W8-29：空闲态时钟零重绘——全档 damage-limited diff 不标时钟 tick 为 damage');
  try { p.kill(); } catch {}
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error('测试崩溃：', e);
  try { p.kill(); } catch {}
  process.exit(1);
}

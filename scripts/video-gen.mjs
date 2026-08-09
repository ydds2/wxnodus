// scripts/video-gen.mjs — 生成 wxnodus 复杂全场景操作视频（供 /video 项目级分析自举测试）
// 流程：node-pty 驱动复杂操作序列 → 每 500ms 捕获终端帧（剥 ANSI/控制字符）→
//       ffmpeg drawtext（SimSun 中文字体）逐帧渲染 PNG → image2 合成 mp4（2fps）
// 输出：data/wxnodus-scene.mp4
import { spawn } from 'node-pty';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'dist', 'cli', 'index.js');
const COLS = 100, ROWS = 30;
const OUT_VIDEO = join(ROOT, 'data', 'wxnodus-scene.mp4');
const WORK = join(tmpdir(), `wxnodus-video-${process.pid}`);
mkdirSync(WORK, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
// ANSI 剥离 + 控制字符清理（\r、\x00-\x1f 非换行）
const strip = s => s
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  .replace(/\x1b\][^\x07]*\x07/g, '')
  .replace(/\x1b\([A-Za-z]/g, '')
  .replace(/\r/g, '')
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

// ── 1. pty 驱动复杂全场景操作序列 ─────────
let out = '';
const p = spawn(process.execPath, [BIN], {
  name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: ROOT,
  env: { ...process.env, TERM: 'xterm-256color' },
});
p.onData(d => { out += d; });
const typeKeys = async s => { for (const ch of s) { p.write(ch); await sleep(35); } };

// 复杂场景序列（概念编译/帮助面板/配置/合规/SQL/选择器/错误/滚动）
const acts = [
  ['启动页', async () => {}, 3],
  ['对话提交', async () => { await typeKeys('你好'); await sleep(300); p.write('\r'); }, 2.5],
  ['命令建议面板', async () => { p.write('/'); await sleep(400); await typeKeys('build'); }, 2],
  ['概念编译 /build 待办系统', async () => { p.write('\r'); }, 8],
  ['帮助分类面板 /help', async () => { await typeKeys('/help'); await sleep(300); p.write('\r'); }, 3],
  ['配置面板 /config', async () => { await typeKeys('/config'); await sleep(300); p.write('\r'); }, 2.5],
  ['合规面板 /compliance', async () => { await typeKeys('/compliance'); await sleep(300); p.write('\r'); }, 2.5],
  ['SQL 表格 /sql', async () => { await typeKeys('/sql SELECT id,title FROM sessions'); await sleep(300); p.write('\r'); }, 2.5],
  ['模型选择器', async () => { await typeKeys('/model'); await sleep(300); p.write('\r'); await sleep(700); p.write('\x1b'); }, 2.5],
  ['会话选择器', async () => { await typeKeys('/sessions'); await sleep(300); p.write('\r'); await sleep(700); p.write('\x1b'); }, 2.5],
  ['批量消息制造滚动', async () => {
    for (let i = 1; i <= 5; i++) { await typeKeys('复杂测试消息' + i + ' 用于展示滚动回看'); await sleep(180); p.write('\r'); await sleep(800); }
  }, 4],
  ['上滑查看历史', async () => { p.write('\x1b[A'); await sleep(400); p.write('\x1b[A'); await sleep(400); }, 2],
  ['错误命令 /nosuch', async () => { await typeKeys('/nosuch'); await sleep(300); p.write('\r'); }, 2],
  ['回底并退出', async () => { p.write('\x1b[F'); await sleep(600); p.write('\x07'); }, 1.5],
];

// ── 2. 逐帧捕获（每 500ms） ──────────────
const frames = [];
let running = true;
const sampler = setInterval(() => {
  if (!running) return;
  const clean = strip(out).split('\n').filter(l => l.trim().length > 0).slice(-ROWS);
  frames.push(clean);
}, 500);

for (const [name, act, dur] of acts) {
  console.log(`[step] ${name}`);
  await act();
  await sleep(dur * 1000);
}
running = false;
clearInterval(sampler);
try { p.kill(); } catch {}

console.log(`捕获帧数：${frames.length}`);

// ── 3. ffmpeg drawtext 渲染（SimSun 中文字体，相对路径规避冒号转义） ──
copyFileSync('C:/Windows/Fonts/simsun.ttc', join(WORK, 'font.ttc'));
const W = COLS * 32, H = ROWS * 32; // 中文 2 倍宽（32px @32 号）
const pngs = [];
for (let i = 0; i < frames.length; i++) {
  const txt = `f_${String(i).padStart(3, '0')}.txt`;
  const body = frames[i].map(l => l.slice(0, COLS).padEnd(COLS, ' ')).join('\n');
  writeFileSync(join(WORK, txt), body, 'utf8');
  const png = `f_${String(i).padStart(3, '0')}.png`;
  try {
    const vf = 'drawtext=fontfile=font.ttc:textfile=' + txt + ':fontsize=32:fontcolor=0xe2e8f0:x=24:y=24:line_spacing=8:expansion=none';
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x0f1115:s=${W}x${H}:d=0.5`, '-vf', vf, '-frames:v', '1', png], { timeout: 20000, cwd: WORK });
    pngs.push(join(WORK, png));
  } catch { console.log(`[skip] 帧 ${i} 渲染失败`); }
}
console.log(`渲染 PNG：${pngs.length}/${frames.length}`);

// ── 4. 合成视频（image2 序列，-framerate 在 -i 前） ─────
if (pngs.length < 2) { console.error('帧不足，无法合成'); process.exit(1); }
execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-framerate', '2', '-i', join(WORK, 'f_%03d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', OUT_VIDEO], { timeout: 120000, cwd: WORK });
rmSync(WORK, { recursive: true, force: true });
console.log(`视频已生成：${OUT_VIDEO}（${pngs.length} 帧 @ 2fps ≈ ${(pngs.length / 2).toFixed(0)}s）`);

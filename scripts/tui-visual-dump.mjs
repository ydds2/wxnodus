// scripts/tui-visual-dump.mjs — TUI 视觉驱动美化（2026-09-04）：关键场景真实渲染帧 dump
// 用 ink-testing-library 渲染 App 于各状态，把 lastFrame 存 .tmp/tui-frames/——
// 「基于视觉判断完善」的验证环：评审帧 → 改 → 重 dump 对比。零新依赖（复用 vitest 同款渲染链）。
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { App } from '../dist/tui/ui/App.js';
import { TuiStore } from '../dist/tui/store.js';
import { TuiRuntime } from '../dist/tui/runtime.js';
import { setTuiTheme } from '../dist/tui/theme.js';
import { glyphs } from '../dist/tui/termcap.js';

const OUT = '.tmp/tui-frames';
mkdirSync(OUT, { recursive: true });

const settle = (ms = 120) => new Promise(r => setTimeout(r, ms));

function makeRuntime(store) {
  return new TuiRuntime({
    store,
    bus: { on: () => () => {} },
    agent: { run: async () => ({ ok: true, text: '好的，已完成三项检查：\n1. 内核门禁全绿\n2. 队列为空\n3. 无孤儿进程', turns: 3, interrupted: false }), abort() {}, steer: () => true },
    commandBus: { execute: async () => ({ ok: true, output: 'ok' }) },
    config: { get: () => ({}) },
    cwd: 'C:/proj/wxnodus',
  });
}

async function frame(name, setup, theme) {
  if (theme) setTuiTheme(theme);
  const store = new TuiStore();
  const runtime = makeRuntime(store);
  setup(store, runtime);
  const app = render(createElement(App, { store, runtime }));
  await settle(180);
  const text = app.lastFrame() ?? '';
  writeFileSync(join(OUT, `${name}.txt`), text, 'utf8');
  app.unmount();
  return text;
}

// ── 场景集（覆盖用户日常视觉路径）──
await frame('01-first-run', s => { s.push({ kind: 'notice', text: 'WxNodus 就绪——输入 /help 查看命令，或直接说需求' }); });
await frame('02-conversation', s => {
  s.push({ kind: 'user', text: '帮我检查项目状态' });
  s.push({ kind: 'assistant', text: '已完成三项检查：\n1. 内核门禁全绿（3048 用例）\n2. 队列为空\n3. 无孤儿进程——进程树回收正常' });
  s.push({ kind: 'user', text: '很好，再看看 /doctor' });
  s.push({ kind: 'assistant', text: '✓ doctor 全组件体检通过：模型/记忆/审计/沙箱 四绿' });
});
await frame('03-help', (s, r) => { r.toggleHelp(); });
await frame('04-model-picker', (s, r) => { r.openModelPicker?.(); });
await frame('05-running', s => {
  s.push({ kind: 'user', text: '跑一下全量测试' });
  s.beginTurn();
  s.push({ kind: 'notice', text: '◈ 执行 bash: npm test（已运行 12s）' });
});
await frame('06-error', s => {
  s.push({ kind: 'user', text: '读取不存在文件' });
  s.push({ kind: 'error', text: '文件不存在：X:/nope/missing.json', errorHint: '检查路径或用 find_files 搜索同名文件' });
});
// 视觉评审：多行输入（三行需求——盒内折叠计数与钉底验证）。早于浮层帧跑（浮层 stableInput
// 全局态会污染后续帧的 dump 序列——工具侧规避；生产单实例无此序列）
await frame('07-multiline', s => {
  s.patch({ composer: { value: '第一行需求说明\n第二行补充约束\n第三行验收标准', slashSel: 0 } });
});
await frame('08-dark-theme', s => { s.push({ kind: 'notice', text: '主题预览帧' }); }, 'midnight');
await frame('09-light-theme', s => { s.push({ kind: 'notice', text: '主题预览帧' }); }, 'paper');
await frame('10-ascii-tier', s => { s.push({ kind: 'notice', text: 'ASCII 档预览帧' }); });

console.log(`TUI_VISUAL_DUMP_OK: 10 帧已写入 ${OUT}/（tier=${glyphs().box.tl === '╭' ? 'full' : glyphs().box.tl === '┌' ? 'basic' : 'ascii'}）`);

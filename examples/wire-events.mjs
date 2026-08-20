#!/usr/bin/env node
// examples/wire-events.mjs — --wire/--stream-json 事件流最小消费者（可运行示例）
// 运行：node examples/wire-events.mjs "帮我列一下当前目录"
// 行为：spawn wxnodus -p <prompt> --wire → 逐行解析 JSONL 事件流 → 打印 type 摘要
//       → 透传 agent.result 终态的退出码（协议契约：任何 failure 不藏在 exit 0 后面）。
// 依赖：仅 Node 内置模块；wxnodus 需已 npm link 或提供 WXNODUS_BIN 指向 CLI 入口。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const prompt = process.argv[2];
if (!prompt) {
  console.error('用法：node examples/wire-events.mjs "<需求>"');
  process.exit(64);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = process.env.WXNODUS_BIN
  ?? (existsSync(join(repoRoot, 'dist', 'cli', 'index.js')) ? join(repoRoot, 'dist', 'cli', 'index.js') : 'wxnodus');

const args = bin.endsWith('.js')
  ? [bin, '--data-dir', join(repoRoot, 'data'), '-p', prompt, '--wire']
  : ['--data-dir', join(repoRoot, 'data'), '-p', prompt, '--wire'];

const child = spawn(process.execPath, args, { stdio: ['inherit', 'pipe', 'inherit'] });
const counts = new Map();
child.stdout.setEncoding('utf8');
let lastLine = null;
let buf = '';
child.stdout.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const ev = (() => { try { return JSON.parse(line); } catch { return null; } })();
    if (!ev || typeof ev.type !== 'string') { console.log(`[非JSON行] ${line.slice(0, 80)}`); continue; }
    counts.set(ev.type, (counts.get(ev.type) ?? 0) + 1);
    lastLine = ev;
    if (ev.type === 'agent.message') console.log(`  assistant: ${String(ev.content ?? '').slice(0, 120)}`);
    else if (ev.type === 'agent.tool') console.log(`  tool: ${ev.name} ${ev.phase ?? ''}${ev.ok === false ? '（失败）' : ''}`);
    else if (ev.type === 'agent.error') console.log(`  error: ${ev.message}`);
  }
});
child.on('close', (code) => {
  console.log(`\n事件统计：${[...counts.entries()].map(([t, n]) => `${t}×${n}`).join('  ') || '（无事件）'}`);
  if (lastLine?.type !== 'agent.result') { console.error('协议违约：缺少 agent.result 终态行'); process.exit(1); }
  console.log(`终态：${lastLine.wireFinal}（exit ${code}）`);
  process.exit(code ?? 1);
});

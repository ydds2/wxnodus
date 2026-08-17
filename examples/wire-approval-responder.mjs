#!/usr/bin/env node
// examples/wire-approval-responder.mjs — --wire 双向帧通道消费者（可运行示例）
// 运行：node examples/wire-approval-responder.mjs "<需求>"
// 行为：spawn wxnodus -p <prompt> --wire（stdin 为帧通道）→ 订阅事件流；
//       检测到危险工具（bash/fs_write/fs_edit/scaffold_build）的 agent.tool start 事件
//       → 向 stdin 回 approval.respond 请求帧 → 消费 wire.response 应答。
// 注：真实应答需要正在进行的审批弹窗（request_id 来自 approval.request 事件，经 gateway 桥）；
//     本例演示「帧协议的正确写法 + WIRE_GATEWAY_NOT_READY 的容错」，可直接跑通协议路径。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const prompt = process.argv[2];
if (!prompt) {
  console.error('用法：node examples/wire-approval-responder.mjs "<需求>"');
  process.exit(64);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = process.env.WXNODUS_BIN
  ?? (existsSync(join(repoRoot, 'dist', 'cli', 'index.js')) ? join(repoRoot, 'dist', 'cli', 'index.js') : 'wxnodus');
const args = bin.endsWith('.js')
  ? [bin, '--data-dir', join(repoRoot, 'data'), '-p', prompt, '--wire']
  : ['--data-dir', join(repoRoot, 'data'), '-p', prompt, '--wire'];

const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'inherit'] });
const DANGER = new Set(['bash', 'fs_write', 'fs_edit', 'scaffold_build', 'wx_cmd']);

// 帧写入：每行一个 JSON 请求帧（协议 §2）
const sendFrame = (method, params) => {
  child.stdin.write(JSON.stringify({ method, params }) + '\n');
};

child.stdout.setEncoding('utf8');
let buf = '';
child.stdout.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const ev = (() => { try { return JSON.parse(line); } catch { return null; } })();
    if (!ev || typeof ev.type !== 'string') continue;
    if (ev.type === 'agent.tool' && ev.phase === 'start' && DANGER.has(ev.name)) {
      console.log(`检测到危险工具 ${ev.name}（toolId=${ev.toolId}）→ 发送 approval.respond 请求帧`);
      // 契约写法：应答 request_id（真实场景来自 approval.request 事件桥接的 request_id）
      sendFrame('approval.respond', { request_id: ev.toolId ?? '', answer: 'deny' });
    }
    if (ev.type === 'wire.response') {
      console.log(`wire.response: method=${ev.method} ok=${ev.ok}${ev.error ? ` code=${ev.error.code}` : ''}`);
    }
    if (ev.type === 'agent.result') {
      console.log(`终态：${ev.wireFinal}`);
      child.stdin.end();
    }
  }
});
child.on('close', (code) => process.exit(code ?? 1));

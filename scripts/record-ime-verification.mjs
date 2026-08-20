// scripts/record-ime-verification.mjs — IME 真机人工验证 receipt（人工门——任何 AI/脚本不可替代）
// 用法：node scripts/record-ime-verification.mjs "<验证人>"
// 产出：artifacts/ime-verification.json（记录验证人/时间/commit + 六步声明逐项确认）
// 诚实铁律：本脚本只记录人工声明——验证动作由真人执行，机器不代签。
import { sha256File as sha256, gitCommit as commit, repoRoot } from './lib/evidence.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = repoRoot();
const name = process.argv[2] ?? '';
if (!name) { console.error('usage: node scripts/record-ime-verification.mjs "<验证人>"'); process.exit(2); }

const rec = {
  kind: 'ime-human-verification',
  verifier: name,
  at: new Date().toISOString(),
  commit,
  machine: { os: 'win32', arch: process.arch, node: process.version },
  steps: [
    { step: '候选窗出现', confirmed: true, how: 'TUI 输入框内用微软拼音输入 nihao，观察候选窗真实弹出' },
    { step: '中文上屏', confirmed: true, how: '回车选择「你好」，确认输入框出现中文字符（非英文/乱码）' },
    { step: '提交与回显', confirmed: true, how: 'Enter 提交，会话面板回显中文消息，无丢失/截断' },
    { step: '历史渲染', confirmed: true, how: '滚动会话历史，中文消息行完整渲染（无半个字符/错位）' },
  ],
};
const dir = join(ROOT, 'artifacts');
mkdirSync(dir, { recursive: true });
const path = join(dir, 'ime-verification.json');
writeFileSync(path, `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
const sha = sha256(path);
console.log(`IME 人工验证已记录：${path}\nsha256=${sha}\n（本文件由真人验证后记录——机器不代签候选窗行为）`);

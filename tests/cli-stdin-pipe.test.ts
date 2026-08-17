// tests/cli-stdin-pipe.test.ts — stdin 管道模式（cat 文件 | wxnodus；crush/gemini 对齐）
// 契约：
//  ① composePipePrompt 纯函数——无 -p 时 stdin 即提问；有 -p 时指令 + <stdin> 素材块；超限诚实标注
//  ② 真实进程：piped stdin 成为一次性输入（会话事件流留下证据）；-p + stdin 组合注入
// dist 未构建时诚实 skip（环境不足不假通过——与 w2-cli-process 同口径）。
import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { composePipePrompt } from '../src/cli/stdinPipe.js';

const CLI = resolve(__dirname, '../dist/cli/index.js');
const hasDist = existsSync(CLI);

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 静默 */ } } });

describe('composePipePrompt 纯函数', () => {
  it('无 -p：stdin 即提问（trim 后原样）', () => {
    expect(composePipePrompt(null, '  你好，请回答  \n')).toBe('你好，请回答');
  });

  it('有 -p：指令 + <stdin> 素材块包裹', () => {
    const out = composePipePrompt('总结内容', '这是素材文本');
    expect(out.startsWith('总结内容')).toBe(true);
    expect(out).toContain('<stdin>\n这是素材文本\n</stdin>');
  });

  it('超限截断诚实标注（模型知道有剩余）', () => {
    const big = '长'.repeat(51_000);
    const out = composePipePrompt(null, big);
    expect(out).toContain('已截断（共 51000 字');
    expect(out).toContain('剩余 1000 字未读');
  });
});

const runPipeCli = (args: string[], stdinText: string) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wxn-pipe-'));
  tempDirs.push(dataDir);
  return new Promise<{ code: number | null; stdout: string; dataDir: string }>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI, '--data-dir', dataDir, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 静默 */ } reject(new Error('pipe CLI timeout')); }, 90_000);
    child.stdout.on('data', (c: Buffer) => { stdout += String(c); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, dataDir }); });
    child.stdin.write(stdinText);
    child.stdin.end();
  });
};

const sessionUserEvents = (dataDir: string): string[] => {
  const f = join(dataDir, 'session-streams', 'default.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8')
    .split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter((e): e is { type: string; content?: string } => e?.type === 'user')
    .map(e => String(e.content ?? ''));
};

const describeWithDist = hasDist ? describe : describe.skip;

describeWithDist('stdin 管道真实进程', () => {
  it('无 -p：piped stdin 成为一次性提问（会话事件流留证）', async () => {
    const marker = '管道提问-独有标记-' + Date.now().toString(36);
    const r = await runPipeCli(['--json'], `${marker}，请回答`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"ok":true');
    const events = sessionUserEvents(r.dataDir);
    expect(events.some(c => c.includes(marker))).toBe(true);
  });

  it('有 -p：指令 + <stdin> 素材块注入（组合提问留证）', async () => {
    const marker = '管道素材-独有标记-' + Date.now().toString(36);
    const r = await runPipeCli(['-p', '总结一下', '--json'], `这是素材：${marker}`);
    expect(r.code).toBe(0);
    const events = sessionUserEvents(r.dataDir);
    const hit = events.find(c => c.includes(marker));
    expect(hit).toBeDefined();
    expect(hit).toContain('总结一下');
    expect(hit).toContain('<stdin>');
  });
});

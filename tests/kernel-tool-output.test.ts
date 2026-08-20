// tests/kernel-tool-output.test.ts — 工具输出工程三件套（gap P0-1/P2-4）
// 覆盖：offload 阈值/预览/落盘、promoteOffloadFile 接管、掩码保护窗/触发量/幂等、
// wrapLimit/蒸馏阈值 resolve 夹取——阈值全部 settings 可覆盖（无写死魔法数字）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  offloadToolOutput, promoteOffloadFile, maskOldToolOutputs, maskNote,
  resolveWrapLimit, resolveOffloadThreshold, resolveMaskWindow, resolveDistillThreshold,
  readHeadTail,
} from '../src/kernel/toolOutput.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wxn-out-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('offloadToolOutput', () => {
  it('超阈值（默认 50KB）落盘 + 头尾预览 + 续读路径', () => {
    const big = 'A'.repeat(60_000);
    const r = offloadToolOutput({ tool: 'grep', text: big, dataDir: dir, sessionId: 's1' });
    expect(r).not.toBeNull();
    expect(r!.total).toBe(60_000);
    expect(r!.preview).toContain('已落盘');
    expect(r!.preview).toContain('bash cat/sed/tail');
    expect(existsSync(r!.path)).toBe(true);
    expect(readFileSync(r!.path, 'utf8').length).toBe(60_000);
    // 预览头尾都在
    expect(r!.preview).toContain('A'.repeat(5));
  });

  it('阈值内 → null（不落盘）', () => {
    const r = offloadToolOutput({ tool: 'ls', text: 'short', dataDir: dir });
    expect(r).toBeNull();
  });

  it('settings.toolOutputOffloadBytes 可覆盖阈值（下限夹取 10k）', () => {
    const r = offloadToolOutput({ tool: 't', text: 'x'.repeat(30_000), dataDir: dir, settings: { toolOutputOffloadBytes: 1000 } });
    expect(r).not.toBeNull(); // 1000 → 夹取到 10k，30k 仍超限
    const r2 = offloadToolOutput({ tool: 't', text: 'x'.repeat(30_000), dataDir: dir, settings: { toolOutputOffloadBytes: 100_000 } });
    expect(r2).toBeNull();
  });

  it('行数超 2000 行也触发（即便字节少）', () => {
    const many = Array.from({ length: 2100 }, (_, i) => `line${i}`).join('\n');
    const r = offloadToolOutput({ tool: 't', text: many, dataDir: dir });
    expect(r).not.toBeNull();
  });
});

describe('promoteOffloadFile / readHeadTail', () => {
  it('接管源文件为正式 offload（重命名 + 有界头尾读取）', () => {
    const src = join(dir, 'tmp.log');
    writeFileSync(src, 'H'.repeat(10_000) + 'TAIL', 'utf8');
    const ht = readHeadTail(src, 100, 4);
    expect(ht?.total).toBe(10_004);
    expect(ht?.head.length).toBe(100);
    expect(ht?.tail).toBe('TAIL');
    const p = promoteOffloadFile({ srcPath: src, tool: 'bash', dataDir: dir, sessionId: 's' });
    expect(p).not.toBeNull();
    expect(existsSync(src)).toBe(false); // 已移走
    expect(existsSync(p!.path)).toBe(true);
    expect(p!.preview).toContain('已落盘');
  });
});

describe('maskOldToolOutputs', () => {
  const toolMsg = (len: number) => ({ role: 'tool' as const, content: '汉'.repeat(len) });

  it('保护窗内不掩码；保护窗外超触发量才掩码', () => {
    // 最新 60k 在保护窗（50k）内保留；旧 1k 在窗外但未超触发（30k）→ 不掩码
    const msgs = [toolMsg(1000), toolMsg(1000), { role: 'assistant' as const, content: 'x' }, toolMsg(60_000)];
    const r0 = maskOldToolOutputs(msgs, { protectTokens: 50_000, triggerTokens: 30_000 });
    expect(r0).toBe(0);
    // 旧输出超保护窗且总量超触发 → 掩码；最新大输出保留
    const msgs2 = [toolMsg(60_000), toolMsg(60_000), { role: 'assistant' as const, content: 'x' }];
    const r = maskOldToolOutputs(msgs2, { protectTokens: 50_000, triggerTokens: 30_000 });
    expect(r).toBe(1);
    expect(msgs2[0]!.content).toContain('[已掩码');
    expect(msgs2[1]!.content).toBe('汉'.repeat(60_000)); // 最新不掩
  });

  it('幂等：已掩码的消息不重复处理', () => {
    const msgs = [toolMsg(60_000), toolMsg(60_000), { role: 'assistant' as const, content: 'x' }];
    const r1 = maskOldToolOutputs(msgs, { protectTokens: 50_000, triggerTokens: 30_000 });
    const r2 = maskOldToolOutputs(msgs, { protectTokens: 50_000, triggerTokens: 30_000 });
    expect(r1).toBe(1);
    expect(r2).toBe(0);
  });

  it('掩码标注诚实告知原文长度与恢复方式', () => {
    expect(maskNote(123)).toContain('123');
    expect(maskNote(123)).toContain('已掩码');
  });
});

describe('阈值解析（settings 覆盖 + 夹取防误配）', () => {
  it('resolveWrapLimit：默认 8000，settings 覆盖，非法值回退', () => {
    expect(resolveWrapLimit(undefined)).toBe(8000);
    expect(resolveWrapLimit({ untrustedWrapLimit: 2000 })).toBe(2000);
    expect(resolveWrapLimit({ untrustedWrapLimit: 999_999 })).toBe(100_000); // 夹取
    expect(resolveWrapLimit({ untrustedWrapLimit: 'abc' })).toBe(8000);
  });
  it('resolveOffloadThreshold / resolveMaskWindow / resolveDistillThreshold 默认与覆盖', () => {
    expect(resolveOffloadThreshold(undefined)).toBe(50 * 1024);
    expect(resolveOffloadThreshold({ toolOutputOffloadBytes: 123_456 })).toBe(123_456);
    expect(resolveMaskWindow(undefined)).toEqual({ protectTokens: 50_000, triggerTokens: 30_000 });
    expect(resolveDistillThreshold(undefined)).toBe(8000);
  });
});

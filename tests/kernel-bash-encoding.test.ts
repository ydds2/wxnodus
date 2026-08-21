// tests/kernel-bash-encoding.test.ts — V4 P1-1：bash 中文 Windows GBK 三连根治
// ① buildPowerShellArgs：UTF8 前缀 + UTF-16LE base64 编码（命令字节零歧义——CJK argv 损坏根治）
// ② createIncrementalUtf8：多字节序列跨 chunk 边界安全（逐 chunk toString 的 U+FFFD 损坏根治）
// ③ 真实 PowerShell 中文实测（win32）：echo 中文 / Get-ChildItem 中文文件名 / git 式多行中文输出
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPowerShellArgs, createIncrementalUtf8 } from '../src/kernel/toolOutput.js';

describe('V4 P1-1 buildPowerShellArgs（EncodedCommand 构造）', () => {
  it('args 形态：-NoProfile -EncodedCommand <base64>；解码回 UTF-16LE 得到 UTF8 前缀+命令', () => {
    const args = buildPowerShellArgs('echo 你好世界');
    expect(args[0]).toBe('-NoProfile');
    expect(args[1]).toBe('-EncodedCommand');
    const decoded = Buffer.from(args[2]!, 'base64').toString('utf16le');
    expect(decoded).toContain('[Console]::OutputEncoding=[System.Text.Encoding]::UTF8');
    expect(decoded.endsWith('echo 你好世界')).toBe(true);
  });
  it('任意 CJK/emoji/引号命令编码零歧义（往返恒等）', () => {
    for (const cmd of ['Write-Output "中文「引号」测试"', 'echo 🎉 émoji', '$x = "混合 ABC123 中文"; $x']) {
      const args = buildPowerShellArgs(cmd);
      const decoded = Buffer.from(args[2]!, 'base64').toString('utf16le');
      expect(decoded.endsWith(cmd)).toBe(true);
    }
  });
});

describe('V4 P1-1 createIncrementalUtf8（跨 chunk 边界安全）', () => {
  it('多字节序列跨 chunk 拆分：增量解码正确（旧逐块 toString 会产 U+FFFD）', () => {
    const text = '中文输出测试：文件名报告.md、提交历史「修复」';
    const bytes = Buffer.from(text, 'utf8');
    // 逐字节喂入——最极端边界（每个多字节序列都被拆散）
    const dec = createIncrementalUtf8();
    let out = '';
    for (const b of bytes) out += dec.push(Buffer.from([b]));
    out += dec.flush();
    expect(out).toBe(text);
  });
  it('随机切分点：任意两段切分解码恒等于整体', () => {
    const text = '项目构建成功——3 个模块 · 耗时 1.2s';
    const bytes = Buffer.from(text, 'utf8');
    for (const split of [1, 3, 7, bytes.length - 1]) {
      const dec = createIncrementalUtf8();
      const out = dec.push(bytes.subarray(0, split)) + dec.push(bytes.subarray(split)) + dec.flush();
      expect(out).toBe(text);
    }
  });
  it('对照组：旧逐块 toString 在切分点产 U+FFFD（缺陷实证——修复必要性锚点）', () => {
    const bytes = Buffer.from('中文', 'utf8'); // 6 字节：e4 b8 ad e6 96 87
    const oldWay = bytes.subarray(0, 2).toString('utf8') + bytes.subarray(2).toString('utf8');
    expect(oldWay).not.toBe('中文'); // 「中」的 3 字节被拆 → U+FFFD 损坏
    expect(oldWay).toContain('\uFFFD');
  });
});

describe('V4 P1-1 真实 PowerShell 中文实测（win32）', { skip: process.platform !== 'win32' }, () => {
  it('echo 中文 + 中文文件名目录列表输出正确（GBK 控制台环境下不乱码）', async () => {
    const { spawn } = await import('node:child_process');
    const { buildPowerShellArgs: bpa, createIncrementalUtf8: mkDec } = await import('../src/kernel/toolOutput.js');
    const dir = mkdtempSync(join(tmpdir(), 'wx-gbk-'));
    try {
      writeFileSync(join(dir, '中文文件名报告.md'), '# 内容', 'utf8');
      writeFileSync(join(dir, '提交历史「修复」.txt'), 'x', 'utf8');
      // 模拟 bash 工具生产路径：编码命令 + 增量解码
      const args = bpa(`Get-ChildItem -Name "${dir}"`);
      const child = spawn('powershell.exe', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const dec = mkDec();
      let out = '';
      child.stdout?.on('data', (d: Buffer) => { out += dec.push(d); });
      await new Promise<void>((res, rej) => { child.on('close', () => res()); child.on('error', rej); });
      out += dec.flush();
      expect(out).toContain('中文文件名报告.md');
      expect(out).toContain('提交历史「修复」.txt');
      // echo 中文（CJK 命令经 EncodedCommand 零歧义）
      const child2 = spawn('powershell.exe', bpa('Write-Output "构建成功——模块编译通过"'), { stdio: ['pipe', 'pipe', 'pipe'] });
      const dec2 = mkDec();
      let out2 = '';
      child2.stdout?.on('data', (d: Buffer) => { out2 += dec2.push(d); });
      await new Promise<void>((res, rej) => { child2.on('close', () => res()); child2.on('error', rej); });
      out2 += dec2.flush();
      expect(out2.trim()).toBe('构建成功——模块编译通过');
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* EBUSY */ }
    }
  }, 30_000);
});

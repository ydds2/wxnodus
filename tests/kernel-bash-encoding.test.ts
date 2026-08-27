// tests/kernel-bash-encoding.test.ts — V4 P1-1：bash 中文 Windows GBK 三连根治
// ① buildPowerShellArgs：UTF8 前缀 + UTF-16LE base64 编码（命令字节零歧义——CJK argv 损坏根治）
// ② createIncrementalUtf8：多字节序列跨 chunk 边界安全（逐 chunk toString 的 U+FFFD 损坏根治）
// ③ 真实 PowerShell 中文实测（win32）：echo 中文 / Get-ChildItem 中文文件名 / git 式多行中文输出
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPowerShellArgs, clampInt, createIncrementalUtf8 } from '../src/kernel/toolOutput.js';

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

// V4 P1-2：bash 超时可调 + 空闲计时——默认 60s 不再腰斩长任务；静默挂死仍按预算终止。
import { coreTools as _coreToolsForP12 } from '../src/kernel/tools.js';
describe('V4 P1-2 bash 超时可调（win32 真实执行）', { skip: process.platform !== 'win32' }, () => {
  it('timeout_ms 参数生效：默认 60s 会杀的 3s 任务在 timeout_ms=8000 下完整跑完', async () => {
    const tools = _coreToolsForP12();
    const d = mkdtempSync(join(tmpdir(), 'wx-p12-'));
    try {
      const r = await tools.bash!.run(
        { command: `$t=Get-Date; Start-Sleep -Milliseconds 2500; Write-Output "done $(( [int]((Get-Date)-$t).TotalSeconds ))s"`, timeout_ms: 8000 },
        { cwd: d } as any,
      );
      expect(String(r)).toContain('done');
      expect(String(r)).not.toMatch(/超时/);
    } finally { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  }, 20_000);

  it('静默挂死按预算终止：1s 预算杀 Start-Sleep 60s，返回语引导 timeout_ms//jobs', async () => {
    const tools = _coreToolsForP12();
    const d = mkdtempSync(join(tmpdir(), 'wx-p12b-'));
    try {
      const r = await tools.bash!.run({ command: 'Start-Sleep -Seconds 60', timeout_ms: 1500 }, { cwd: d } as any);
      expect(String(r)).toMatch(/超时/);
      expect(String(r)).toMatch(/timeout_ms|\/jobs/);
    } finally { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  }, 15_000);

  it('间歇输出续命：每 800ms 输出一次共 3 次（总 2.4s > 2s 预算）不被误杀', async () => {
    // P1-6（2026-08-27）：预算 1.5s→2s——高负载下 PowerShell 子进程调度抖动曾使 800ms
    // 间隔偶发超 1.5s 预算误杀（全量并发 flaky）；2s 预算对 800ms 节奏保留 2.5 倍裕度，
    // 「静默才杀」语义不变（总时长仍 > 预算，续命断言依然有效）。
    const tools = _coreToolsForP12();
    const d = mkdtempSync(join(tmpdir(), 'wx-p12c-'));
    try {
      const r = await tools.bash!.run(
        { command: '1..3 | ForEach-Object { Start-Sleep -Milliseconds 800; Write-Output "tick $_" }', timeout_ms: 2000 },
        { cwd: d } as any,
      );
      expect(String(r)).toContain('tick 3');
      expect(String(r)).not.toMatch(/超时/);
    } finally { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  }, 20_000);

  it('timeout_ms 上限夹取：>600000 按 600000（clamp 语义——schema 契约由 clampInt 保证）', () => {
    // 夹取逻辑为 clampInt(timeout_ms ?? settings, 60000, 1000, 600000)——契约级断言（不真跑 10min）
    expect(clampInt(9_999_999, 60_000, 1_000, 600_000)).toBe(600_000);
    expect(clampInt(undefined, 60_000, 1_000, 600_000)).toBe(60_000);
    expect(clampInt(500, 60_000, 1_000, 600_000)).toBe(1_000);
  });
});

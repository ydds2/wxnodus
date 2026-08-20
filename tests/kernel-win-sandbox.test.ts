// tests/kernel-win-sandbox.test.ts — Windows OS 内核沙盒（gap P0-4）
// 纯函数部分（profile 解析/参数映射/启用判定/runner 脚本生成）全平台确定性测试；
// 能力探测为真实调用（仅 win32 且 powershell 存在时）——探测的契约是「诚实」：
// 要么 ok 要么给出具体失败原因（Add-Type 编译/API 错误/超时），绝无第三种假装态。
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveSandboxProfile, sandboxSpec, sandboxEnabled, probeWinSandbox, parseProbeBody,
  ensureSandboxRunnerForTest,
} from '../src/kernel/winSandbox.js';

describe('resolveSandboxProfile / sandboxEnabled（纯函数）', () => {
  it('settings.sandbox 对象/字符串/缺省解析', () => {
    expect(resolveSandboxProfile(undefined)).toBe('off');
    expect(resolveSandboxProfile({ sandbox: { profile: 'L1' } })).toBe('L1');
    expect(resolveSandboxProfile({ sandbox: 'L0' })).toBe('L0');
    expect(resolveSandboxProfile({ sandbox: { profile: 'bogus' } })).toBe('off');
    expect(resolveSandboxProfile({ sandbox: { profile: 'l2' } })).toBe('L2'); // 大小写不敏感
  });

  it('enabled=false 显式关闭（profile 存在也不启用）', () => {
    expect(sandboxEnabled({ sandbox: { profile: 'L1' } })).toBe(true);
    expect(sandboxEnabled({ sandbox: { profile: 'L1', enabled: false } })).toBe(false);
    expect(sandboxEnabled(undefined)).toBe(false);
  });

  it('sandboxSpec 四层映射与实测校准口径一致', () => {
    expect(sandboxSpec('L0')).toEqual({ lowIl: true, netLimitBps: 1, job: true });
    expect(sandboxSpec('L1')).toEqual({ lowIl: false, netLimitBps: 1, job: true });
    expect(sandboxSpec('L2')).toEqual({ lowIl: false, netLimitBps: 10 * 1024, job: true });
    expect(sandboxSpec('L3')).toEqual({ lowIl: false, netLimitBps: null, job: true });
  });
});

describe('助手脚本生成（可落盘、版本戳、纯 ASCII 红线）', () => {
  it('runner 脚本含版本戳 + C# 核心 API（双态沙盒 supremacy 3.2：标准用户 Low IL + 提权受限令牌）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-sbx-'));
    try {
      const { script, path, version } = ensureSandboxRunnerForTest(dir);
      expect(script).toContain('wxnodus sandbox runner v' + version);
      expect(script).toContain('SetTokenInformation');
      expect(script).toContain('CreateJobObject');
      expect(script).toContain('JNRC'); // JobObjectNetRateControlInformation
      expect(script).toContain('S-1-16-4096'); // Low IL SID
      expect(script).toContain('AssignProcessToJobObject');
      expect(script).toContain('CreateProcessAsUser');
      // supremacy 3.2 双态：提权分支走受限令牌（1314 是标准用户路径的证伪——双态分流绕开）；
      // 标准用户分支仍是 Low IL（本机实测校准）
      expect(script).toContain('CreateRestrictedToken');
      expect(script).toContain('S-1-5-32-544'); // 禁用 Administrators
      expect(script).toContain('S-1-16-8192'); // Medium IL（提权分支降完整性）
      expect(script).toContain('IsElevated'); // 运行时分流
      expect(script).toContain('OK-ELEVATED');
      expect(script).toContain('OK-STANDARD');
      expect(path).toBe(join(dir, 'sandbox', 'sandbox-runner.ps1'));
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  });
});

describe('能力探测（诚实契约）', () => {
  it('探测返回 { ok, detail } 且失败时 detail 给出具体原因（绝不假装）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-sbx-probe-'));
    try {
      // 缓存语义：两次非 force 探测读同一进程级缓存，结果必须一致
      const r0 = await probeWinSandbox(dir);
      const r1 = await probeWinSandbox(dir);
      expect(r1.ok).toBe(r0.ok);
      expect(r1.detail).toBe(r0.detail);
      // force 强制重探：只查形状与诚实文案（结果可能因环境负载瞬时不同——缓存语义不涉及）
      const forced = await probeWinSandbox(dir, true);
      expect(typeof forced.ok).toBe('boolean');
      expect(typeof forced.detail).toBe('string');
      expect(forced.detail.length).toBeGreaterThan(0);
      if (!forced.ok) {
        // 失败必须可解释：三类诚实原因之一（非 Windows / 无 powershell / 编译或 API 错误 / 超时）
        expect(forced.detail).toMatch(/非 Windows|powershell|ERR:|探测超时|无输出/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('L3 端到端冒烟（探测可用时）：沙盒内真实执行命令并捕获 stdout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-sbx-run-'));
    try {
      const probe = await probeWinSandbox(dir, true);
      if (!probe.ok) return; // 探测不可用：只验证诚实口径（上面的用例已覆盖）；本用例不假装
      const { trySandboxLaunch } = await import('../src/kernel/winSandbox.js');
      const { readHeadTail } = await import('../src/kernel/toolOutput.js');
      const r = await trySandboxLaunch({
        settings: { sandbox: { profile: 'L3' } },
        dataDir: dir,
        cmd: 'powershell.exe',
        args: ['-NoProfile', '-Command', 'Write-Output SBX_OK'],
        cwd: dir,
        timeoutMs: 60_000,
      });
      expect(r.result).not.toBeNull();
      expect(r.result!.code).toBe(0);
      const head = readHeadTail(r.result!.outPath, 100, 0);
      expect(head?.head).toContain('SBX_OK');
      expect(head?.total).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('parseProbeBody（双态探测口径——supremacy 3.2，纯函数）', () => {
  it('OK-ELEVATED：提权受限令牌路径（本机实测口径）', () => {
    const r = parseProbeBody('OK-ELEVATED');
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('受限令牌');
    expect(r.detail).toContain('Administrators');
  });
  it('OK-STANDARD：标准用户 Low IL 路径（提权分支诚实标注未实测）', () => {
    const r = parseProbeBody('OK-STANDARD');
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('Low IL');
    expect(r.detail).toContain('未实测'); // 诚实：标准用户机器上提权分支不宣称
  });
  it('旧 runner 缓存 OK → 标准路径口径（诚实降级）', () => {
    const r = parseProbeBody('OK');
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('旧 runner');
  });
  it('失败输出原样透传（绝不伪装）', () => {
    const r = parseProbeBody('ERR:EX:Add-Type boom');
    expect(r.ok).toBe(false);
    expect(r.detail).toBe('ERR:EX:Add-Type boom');
    expect(parseProbeBody('无输出（exit 1）').ok).toBe(false);
  });
});

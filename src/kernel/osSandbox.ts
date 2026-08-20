// src/kernel/osSandbox.ts — 三平台 OS 沙盒门面（gap ⑥ 三平台化，2026-08-18）
// 平台分派（诚实契约统一）：win32 → winSandbox（受限令牌证伪后为 Low IL+Job+断网限速，
// 标准用户实测校准）；linux → posixSandbox（bwrap）；darwin → posixSandbox（Seatbelt）。
// bash 工具只依赖本门面——非三平台返回诚实原因（绝不把未沙盒当沙盒）。
export { resolveSandboxProfile, resolveSandboxFailOpen, sandboxEnabled, type SandboxProfile, type SandboxSettings } from './winSandbox.js';
import { resolveSandboxProfile, resolveSandboxFailOpen, sandboxEnabled, trySandboxLaunch as tryWinSandboxLaunch, probeWinSandbox } from './winSandbox.js';
import { tryPosixSandboxLaunch, probePosixSandbox } from './posixSandbox.js';

export interface OsSandboxOutcome {
  result: { code: number | null; outPath: string; errPath: string; outTotal: number; errTotal: number } | null;
  reason?: 'not-win32' | 'not-posix' | 'off' | 'probe-failed' | 'launch-failed';
  note?: string;
}

/** 沙盒门决策（纯函数可单测）：'sandboxed'=照常 | 'plain'=普通路径（未请求沙盒或 failOpen 显式降级）| 'refuse'=fail-closed 拒绝执行 */
export function classifySandboxOutcome(
  outcome: OsSandboxOutcome,
  settings: Record<string, any> | undefined,
): { action: 'sandboxed' | 'plain' | 'refuse'; note?: string } {
  if (outcome.result) return { action: 'sandboxed' };
  if (outcome.reason === 'off' || outcome.reason === undefined) return { action: 'plain' };
  // 用户中止不是沙盒问题——透传原文，不套沙盒框架
  if (/已中断/.test(outcome.note ?? '')) return { action: 'refuse', note: outcome.note };
  if (resolveSandboxFailOpen(settings)) {
    return { action: 'plain', note: `沙盒不可用（${outcome.note ?? outcome.reason}）——failOpen 显式降级：本次命令未沙盒执行` };
  }
  return { action: 'refuse', note: outcome.note ?? `沙盒不可用（${outcome.reason}）` };
}

/** 能力探测（按平台分派；/sandbox os status 使用） */
export async function probeOsSandbox(dataDir: string, force = false): Promise<{ ok: boolean; detail: string }> {
  if (process.platform === 'win32') return probeWinSandbox(dataDir, force);
  if (process.platform === 'linux' || process.platform === 'darwin') return probePosixSandbox(force);
  return { ok: false, detail: `平台 ${process.platform} 无 OS 沙盒实现（win32=Low IL+Job / linux=bwrap / darwin=Seatbelt）——本次命令已按普通方式执行（未沙盒）` };
}

/** 经当前平台的 OS 沙盒执行命令（bash 工具执行层唯一入口） */
export async function tryOsSandboxLaunch(opts: {
  settings?: Record<string, any>;
  dataDir: string;
  cmd: string;
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<OsSandboxOutcome> {
  const profile = resolveSandboxProfile(opts.settings);
  if (profile === 'off' || !sandboxEnabled(opts.settings)) return { result: null, reason: 'off' };
  if (process.platform === 'win32') return tryWinSandboxLaunch(opts);
  if (process.platform === 'linux' || process.platform === 'darwin') {
    return tryPosixSandboxLaunch({ profile, dataDir: opts.dataDir, cmd: opts.cmd, args: opts.args, cwd: opts.cwd, stdin: opts.stdin, timeoutMs: opts.timeoutMs, signal: opts.signal });
  }
  return { result: null, reason: 'not-win32', note: `平台 ${process.platform} 无 OS 沙盒实现——本次命令已按普通方式执行（未沙盒）` };
}

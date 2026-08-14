// src/infrastructure/plugins/processIsolationSandbox.ts — Plugin sandbox 生产实现（crash-isolation 级）
// 真实进程隔离：插件以独立子进程运行（环境变量清除、stdio 管道、句柄不继承、stop 原子终止）。
// probe 证据如实报告：strength='crash-isolation'，OS 强制项（fs/network/process/credential）为 false——
// 因此 Untrusted 插件被 sandbox gate 一律 quarantined（没有 OS-enforced 实现绝不放行）；
// Trusted 插件（本机用户自写）经 crash-isolation 正常启用。绝不降级宣称安全。
import { spawn } from 'node:child_process';
import type { OperationResult } from '../../protocol/results.js';
import { assertSandboxAvailable, type PluginCandidate, type PluginProcess, type PluginSandbox, type SandboxProbeEvidence } from './pluginSandbox.js';

const evidenceOf = (): SandboxProbeEvidence => ({
  // 如实：crash-isolation 只保证进程隔离，不阻断 fs/network/process/credential
  strength: 'crash-isolation',
  environmentCleared: true,
  inheritedHandlesBlocked: true,
  filesystemDenied: false,
  networkDenied: false,
  processDenied: false,
  credentialDenied: false,
  evidenceIds: ['sandbox:process-isolation:v1'],
});

export function createProcessIsolationSandbox(): PluginSandbox {
  return {
    strength: 'crash-isolation',
    async probe(_signal) {
      return { ok: true, value: evidenceOf() };
    },
    async start(candidate, broker, signal): Promise<OperationResult<PluginProcess>> {
      void broker; // broker 协议注册由后续插件进程协议接线消费（当前最小面：进程隔离 + 生命周期）
      try {
        const child = spawn(process.execPath, [candidate.entrypointPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { PATH: process.env.PATH ?? '' }, // 环境清除：不继承宿主凭据类环境变量
          windowsHide: true,
        });
        const onAbort = () => {
          try { child.kill(); } catch { /* 已退出 */ }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        child.on('close', () => signal.removeEventListener('abort', onAbort));
        child.on('error', () => { /* 启动失败由 smoke/registrations 判定 */ });
        const pluginProcess: PluginProcess = {
          processId: `${candidate.id}:${child.pid ?? 0}`,
          registrations: () => null,
          stop: async (_reason, _sig) => {
            try { child.kill(); } catch { /* 已退出 */ }
            return { ok: true as const, value: { stopped: true as const } };
          },
        };
        return { ok: true, value: pluginProcess };
      } catch (cause) {
        return {
          ok: false,
          error: { code: 'PLUGIN_PROCESS_SPAWN_FAILED', message: String(cause), messageKey: 'PLUGIN_PROCESS_SPAWN_FAILED', retryable: false },
        };
      }
    },
  };
}

/** 便捷判定：sandbox gate 结论（Untrusted + crash-isolation → 拒绝） */
export const pluginSandboxGate = (trustLevel: PluginCandidate['trustLevel'], probe: SandboxProbeEvidence) =>
  assertSandboxAvailable(trustLevel, probe);

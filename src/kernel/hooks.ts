// src/kernel/hooks.ts — L2-6 生命周期 Hooks（本地命令执行）
// 设计：settings.hooks 配置事件 → 本地 shell 命令（PowerShell/bash 适配），
//       上下文经环境变量 WXNODUS_HOOK_EVENT / WXNODUS_HOOK_DATA（JSON）传入，
//       全部本地进程执行（本地化为准）；preToolUse 输出 DENY: 开头即真实拦截工具。
//       失败不阻断主流程（记录 system.notice），10s 超时防挂死。
import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import type { EventBus } from './events.js';

export type HookEvent =
  | 'userPromptSubmit' | 'preToolUse' | 'postToolUse' | 'stop'
  | 'sessionStart' | 'sessionEnd'
  | 'preCompact' | 'postCompact'
  | 'subagentStart' | 'subagentStop'
  | 'postToolUseFailure' | 'notification';

export type HookConfig = Partial<Record<HookEvent, string>>;

export const HOOK_EVENTS: HookEvent[] = ['userPromptSubmit', 'preToolUse', 'postToolUse', 'stop', 'sessionStart', 'sessionEnd', 'preCompact', 'postCompact', 'subagentStart', 'subagentStop', 'postToolUseFailure', 'notification'];

// 从 settings 读取 hooks 配置（空对象/非法值 → 全禁用）
export function hooksFromConfig(settings: Record<string, any> | undefined): HookConfig {
  const raw = settings?.hooks;
  if (!raw || typeof raw !== 'object') return {};
  const out: HookConfig = {};
  for (const ev of HOOK_EVENTS) {
    const cmd = (raw as Record<string, unknown>)[ev];
    if (typeof cmd === 'string' && cmd.trim()) out[ev] = cmd.trim();
  }
  return out;
}

// 执行单条 hook 命令（execFileSync 精确 shell 参数，10s 超时，stdout 截断）
export function runHook(cmd: string, event: HookEvent, data: unknown): string {
  const isWin = platform() === 'win32';
  const args = isWin ? ['-NoProfile', '-Command', cmd] : ['-c', cmd];
  try {
    const out = execFileSync(isWin ? 'powershell.exe' : '/bin/bash', args, {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        WXNODUS_HOOK_EVENT: event,
        WXNODUS_HOOK_DATA: JSON.stringify(data ?? {}),
      },
    });
    return String(out ?? '').trim().slice(0, 4000);
  } catch (e: any) {
    // 命令本身失败（非零退出）也回传 stdout 供 DENY 判断；超时/其他异常返回空
    if (e?.stdout) return String(e.stdout).trim().slice(0, 4000);
    return '';
  }
}

export interface HookRunner {
  preToolUse(name: string, args: Record<string, any>): Promise<boolean>;
  postToolUse(name: string, out: string): void;
  postToolUseFailure(name: string, err: string): void;
  userPromptSubmit(prompt: string, sessionId: string): void;
  stop(result: { ok: boolean; turns: number }): void;
  sessionStart(sessionId: string): void;
  sessionEnd(result: { ok: boolean; turns: number }): void;
  /** 压缩前——输出 BLOCK 开头可阻止压缩（Claude PreCompact 语义） */
  preCompact(reason: string): boolean;
  postCompact(prevTokens: number, nextTokens: number): void;
  subagentStart(goal: string): void;
  subagentStop(result: { ok: boolean; output: string; turns: number }): void;
  /** 后台任务/定时任务完成通知 */
  notification(kind: string, text: string): void;
  enabled: boolean;
}

// 构建 hook 运行器（订阅配置快照——每次读取当前 settings，热生效）
export function createHookRunner(getSettings: () => Record<string, any> | undefined, bus: EventBus): HookRunner {
  const fire = (event: HookEvent, data: unknown): string => {
    const cfg = hooksFromConfig(getSettings());
    const cmd = cfg[event];
    if (!cmd) return '';
    const out = runHook(cmd, event, data);
    if (out) bus.emit('system.notice', { text: `[hook:${event}] ${out.slice(0, 120)}` });
    return out;
  };

  return {
    enabled: true,
    async preToolUse(name, args) {
      const out = fire('preToolUse', { tool: name, args });
      // DENY: 开头（或包含 DENY 行）→ 真实拦截工具执行
      return !(out.startsWith('DENY') || /\nDENY/.test(out));
    },
    postToolUse(name, out) {
      fire('postToolUse', { tool: name, output: out.slice(0, 2000) });
    },
    postToolUseFailure(name, err) {
      fire('postToolUseFailure', { tool: name, error: String(err ?? '').slice(0, 2000) });
    },
    userPromptSubmit(prompt, sessionId) {
      fire('userPromptSubmit', { prompt: prompt.slice(0, 2000), session_id: sessionId });
    },
    stop(result) {
      fire('stop', { ok: result.ok, turns: result.turns });
    },
    sessionStart(sessionId) {
      fire('sessionStart', { session_id: sessionId });
    },
    sessionEnd(result) {
      fire('sessionEnd', { ok: result.ok, turns: result.turns });
    },
    preCompact(reason) {
      const out = fire('preCompact', { reason });
      return out.startsWith('BLOCK') || /\nBLOCK/.test(out);
    },
    postCompact(prevTokens, nextTokens) {
      fire('postCompact', { prev_tokens: prevTokens, next_tokens: nextTokens });
    },
    subagentStart(goal) {
      fire('subagentStart', { goal: String(goal ?? '').slice(0, 500) });
    },
    subagentStop(result) {
      fire('subagentStop', { ok: result.ok, output: String(result.output ?? '').slice(0, 500), turns: result.turns });
    },
    notification(kind, text) {
      fire('notification', { kind, text: String(text ?? '').slice(0, 1000) });
    },
  };
}

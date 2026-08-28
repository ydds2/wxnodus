// src/kernel/hooks.ts — L2-6 生命周期 Hooks（本地命令执行）
// 设计：settings.hooks 配置事件 → 本地 shell 命令（PowerShell/bash 适配），
//       上下文经环境变量 WXNODUS_HOOK_EVENT / WXNODUS_HOOK_DATA（JSON）传入，
//       全部本地进程执行（本地化为准）；preToolUse 输出 DENY: 开头即真实拦截工具。
//       P0-06：安全关键 hook 崩溃/超时/缺失/非零退出 fail-closed（结构化决策，见 domain/hooks/hookDecision）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { platform } from 'node:os';
import type { EventBus } from './events.js';
import { sanitizedEnv } from './env.js';
import { decideSecurityHook, type HookExecutionOutcome } from '../domain/hooks/hookDecision.js';

export type HookEvent =
  | 'userPromptSubmit' | 'preToolUse' | 'postToolUse' | 'stop'
  | 'sessionStart' | 'sessionEnd'
  | 'preCompact' | 'postCompact'
  | 'subagentStart' | 'subagentStop'
  | 'postToolUseFailure' | 'notification';

export type HookConfig = Partial<Record<HookEvent, string>>;

export const HOOK_EVENTS: HookEvent[] = ['userPromptSubmit', 'preToolUse', 'postToolUse', 'stop', 'sessionStart', 'sessionEnd', 'preCompact', 'postCompact', 'subagentStart', 'subagentStop', 'postToolUseFailure', 'notification'];

// ── P2-A（2026-08-28，kimi hooks engine.py:33,97 声明式 matcher 语义参考·实现原创）──
// 配置键支持 `事件:匹配器` 形态：preToolUse/postToolUse/postToolUseFailure 按工具名、
// notification 按通知类型值匹配；匹配器支持前缀与 * / ? 通配（锚定）。裸键=匹配全部（向后兼容）。
// 差异：kimi 用结构化配置的 matcher 字段；本仓用字符串映射的 `event:matcher` 键形——
// 零 schema 破坏、同键序热生效，用户不再需要在 hook 脚本里手写 if 过滤。
export interface HookEntry {
  event: HookEvent;
  /** 空 = 匹配全部（裸键） */
  matcher?: string;
  cmd: string;
}

/** 匹配器命中判定（纯函数）：* / ? 通配 → 双端锚定正则；否则前缀匹配 */
export function hookKeyMatches(pattern: string, value: string): boolean {
  if (!pattern) return true;
  if (!/[*?]/.test(pattern)) return value.startsWith(pattern);
  const re = new RegExp('^' + pattern.split(/([*?])/).map(p => p === '*' ? '.*' : p === '?' ? '.' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$');
  return re.test(value);
}

/** 解析 `事件[:匹配器]` 配置键（纯函数；事件未收录 → null） */
export function parseHookKey(key: string): { event: HookEvent; matcher?: string } | null {
  const sep = key.indexOf(':');
  const event = (sep < 0 ? key : key.slice(0, sep)) as HookEvent;
  if (!(HOOK_EVENTS as string[]).includes(event)) return null;
  const matcher = sep < 0 ? undefined : key.slice(sep + 1).trim();
  return { event, ...(matcher ? { matcher } : {}) };
}

/** 全量条目解析（含 matcher 形态；同一事件可多条——命中即全部顺序执行） */
export function hookEntriesFromConfig(settings: Record<string, any> | undefined): HookEntry[] {
  const raw = settings?.hooks;
  if (!raw || typeof raw !== 'object') return [];
  const out: HookEntry[] = [];
  for (const [key, cmd] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof cmd !== 'string' || !cmd.trim()) continue;
    const parsed = parseHookKey(key);
    if (parsed) out.push({ ...parsed, cmd: cmd.trim() });
  }
  return out;
}

/** 条目筛选（纯函数）：事件相等 + （有 matcher 时值命中）；无值事件仅裸键入选 */
export function selectHookEntries(entries: HookEntry[], event: HookEvent, value?: string): HookEntry[] {
  return entries.filter(e => e.event === event && (!e.matcher || hookKeyMatches(e.matcher, value ?? '')));
}

// 从 settings 读取 hooks 配置（空对象/非法值 → 全禁用）——裸键兼容视图（既有消费者/测试）
export function hooksFromConfig(settings: Record<string, any> | undefined): HookConfig {
  const out: HookConfig = {};
  for (const e of hookEntriesFromConfig(settings)) {
    if (!e.matcher) out[e.event] = e.cmd;
  }
  return out;
}

// 执行单条 hook 命令（execFileSync 精确 shell 参数，10s 超时，stdout 截断）
// P0-06：返回结构化结果（成功/非零退出/超时/缺失/错误），不再用空输出吞噬失败。
// 编码加固（2026-08-18 CI 实测）：-Command 直传 CJK 命令受 argv 编码影响（Node 22.23.x
// 下 PowerShell 可能收到空/损坏命令并等待 stdin → 误判超时）；改 -EncodedCommand
// （UTF-16LE base64）——命令字节零歧义，任意 Node 版本/任意字符同语义。
export async function runHook(cmd: string, event: HookEvent, data: unknown): Promise<HookExecutionOutcome> {
  const isWin = platform() === 'win32';
  const args = isWin
    ? ['-NoProfile', '-EncodedCommand', Buffer.from(cmd, 'utf16le').toString('base64')]
    : ['-c', cmd];
  const env = {
    // P0-3 环境净化：hook 子进程不继承密钥类变量（env.ts 统一策略），
    // WXNODUS_HOOK_* 为显式白名单传入（配置在 settings.hooks，非密钥）
    ...sanitizedEnv(),
    WXNODUS_HOOK_EVENT: event,
    WXNODUS_HOOK_DATA: JSON.stringify(data ?? {}),
  };
  try {
    // V4 P2-12：execFileSync → execFileAsync（同步阻塞事件循环最长 10s——TUI 冻结根治；
    // runHook 本就 async 签名，行为零漂移纯搬运）
    const { stdout } = await execFileAsync(isWin ? 'powershell.exe' : '/bin/bash', args, {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      env,
    });
    return { kind: 'ok', output: String(stdout ?? '').trim().slice(0, 4000) };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; killed?: boolean; signal?: string };
    // 超时优先判定：execFile 超时以 killed+SIGTERM 形态抛出（V4 P2-12 异步化后形态）
    if (err.code === 'ETIMEDOUT' || (err.killed === true && err.signal === 'SIGTERM')) return { kind: 'timeout' };
    // 非零退出（code 为数字）：附 stdout（可为空——exit(N) 无输出也是合法非零退出）
    if (typeof err.code === 'number' && err.code !== 0) {
      return { kind: 'exited-nonzero', output: String(err.stdout ?? '').trim().slice(0, 4000) };
    }
    if (err.stdout !== undefined && String(err.stdout).length > 0) {
      return { kind: 'exited-nonzero', output: String(err.stdout).trim().slice(0, 4000) };
    }
    if (err.code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'error', message: String(err.message ?? err).slice(0, 100) };
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
  preCompact(reason: string): Promise<boolean>; // V4 P2-12：异步 hook（同步阻塞冻结根治）
  postCompact(prevTokens: number, nextTokens: number): void;
  subagentStart(goal: string): void;
  subagentStop(result: { ok: boolean; output: string; turns: number }): void;
  /** 后台任务/定时任务完成通知 */
  notification(kind: string, text: string): void;
}

// 构建 hook 运行器（订阅配置快照——每次读取当前 settings，热生效）
// P2-A：条目级派发——`event:matcher` 键命中即执行（同事件多条顺序跑；preToolUse 全部命中项 AND 决策）
export function createHookRunner(getSettings: () => Record<string, any> | undefined, bus: EventBus): HookRunner {
  const fireOne = async (entry: HookEntry, event: HookEvent, data: unknown): Promise<HookExecutionOutcome> => {
    const outcome = await runHook(entry.cmd, event, data);
    const text = outcome.kind === 'ok' || outcome.kind === 'exited-nonzero' ? outcome.output
      : outcome.kind === 'timeout' ? `[hook:${event}] 超时未响应（10s）`
      : outcome.kind === 'missing' ? `[hook:${event}] 执行失败：未找到 shell（hook 未运行——请检查 PATH）`
      : `[hook:${event}] 执行失败：${outcome.message}（hook 未运行）`;
    if (text) bus.emit('system.notice', { text: text.slice(0, 120) });
    return outcome;
  };
  const fire = async (event: HookEvent, data: unknown, matcherValue?: string): Promise<HookExecutionOutcome | null> => {
    const hit = selectHookEntries(hookEntriesFromConfig(getSettings()), event, matcherValue);
    if (!hit.length) return null;
    let last: HookExecutionOutcome | null = null;
    for (const entry of hit) last = await fireOne(entry, event, data);
    return last;
  };

  return {
    async preToolUse(name, args) {
      // P2-A：matcher 按工具名过滤（无 matcher 裸键仍全量）
      const outcomes: HookExecutionOutcome[] = [];
      for (const entry of selectHookEntries(hookEntriesFromConfig(getSettings()), 'preToolUse', name)) {
        outcomes.push(await fireOne(entry, 'preToolUse', { tool: name, args }));
      }
      if (!outcomes.length) return true;
      // P0-06：安全关键事件走结构化 fail-closed 决策；DENY 只来自干净退出的合法协议（多条 AND）
      return outcomes.every(o => decideSecurityHook(o).allow);
    },
    async postToolUse(name, out) {
      return fire('postToolUse', { tool: name, output: out.slice(0, 2000) }, name);
    },
    async postToolUseFailure(name, err) {
      return fire('postToolUseFailure', { tool: name, error: String(err ?? '').slice(0, 2000) }, name);
    },
    async userPromptSubmit(prompt, sessionId) {
      return fire('userPromptSubmit', { prompt: prompt.slice(0, 2000), session_id: sessionId });
    },
    async stop(result) {
      return fire('stop', { ok: result.ok, turns: result.turns });
    },
    async sessionStart(sessionId) {
      return fire('sessionStart', { session_id: sessionId });
    },
    async sessionEnd(result) {
      return fire('sessionEnd', { ok: result.ok, turns: result.turns });
    },
    async preCompact(reason) {
      const outcome = await fire('preCompact', { reason });
      const output = outcome && (outcome.kind === 'ok' || outcome.kind === 'exited-nonzero') ? outcome.output : '';
      return output.startsWith('BLOCK') || /\nBLOCK/.test(output);
    },
    async postCompact(prevTokens, nextTokens) {
      return fire('postCompact', { prev_tokens: prevTokens, next_tokens: nextTokens });
    },
    async subagentStart(goal) {
      return fire('subagentStart', { goal: String(goal ?? '').slice(0, 500) });
    },
    async subagentStop(result) {
      fire('subagentStop', { ok: result.ok, output: String(result.output ?? '').slice(0, 500), turns: result.turns });
    },
    notification(kind, text) {
      fire('notification', { kind, text: String(text ?? '').slice(0, 1000) }, kind); // P2-A：按通知类型值匹配
    },
  };
}

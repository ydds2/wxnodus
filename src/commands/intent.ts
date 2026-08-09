// src/commands/intent.ts — L4 意图路由（说人话不记命令）
// 四层：① 别名（registry）② 确定性工具直调 ③ NL 正则路由 ④ AI 意图（agent 层）
import { resolveAlias, isSlash, completeCommand } from './registry.js';
import { deterministicRun } from './deterministic.js';

export interface NlTrigger { re: RegExp; cmd: string }

// ③ NL 正则路由：说人话 → 命令（不占用 AI 意图层）
export const NL_TRIGGERS: NlTrigger[] = [
  { re: /(?:做|建|造|写|开发|生成|制作).*(?:系统|应用|网站|工具|待办|记账|管理|页面)/i, cmd: '/build' },
  { re: /分析.*视频|视频.*分析|看.*视频|视频里/i, cmd: '/video' },
  { re: /(?:看|分析|识别).*图|图片.*(?:看|分析)|这张图|截图.*(?:看|分析)/i, cmd: '/vision' },
  { re: /(?:搜|找).*(?:记忆|黑洞|内容)|之前.*说|记得.*说|黑洞.*搜/i, cmd: '/hole' },
  { re: /体检|检查.*状态|看看.*健康/i, cmd: '/doctor' },
  { re: /备份/i, cmd: '/backup' },
  { re: /部署|上线|落地/i, cmd: '/deploy' },
  { re: /(?:抓取|爬).*网页|网页.*(?:抓|爬)|打开.*网页.*分析/i, cmd: '/claw' },
  { re: /定时|每隔|每(?:天|周|小时)/i, cmd: '/cron' },
  { re: /沙盒|隔离.*运行/i, cmd: '/sandbox' },
  { re: /合规|授权|consent/i, cmd: '/compliance' },
  { re: /多开|并行.*代理|swarm/i, cmd: '/swarm' },
];

export function routeNaturalLanguage(text: string): string | null {
  for (const t of NL_TRIGGERS) {
    if (t.re.test(text)) return t.cmd;
  }
  return null;
}

// 完整输入路由：别名 → 确定性 → NL → null（null 走 AI 意图/对话）
export async function routeInput(text: string): Promise<{ kind: 'command' | 'tool' | 'chat'; cmd?: string; value?: string }> {
  const trimmed = text.trim();
  // ① 斜杠命令（别名 + 补全）
  if (isSlash(trimmed)) {
    const [head, ...rest] = trimmed.split(/\s+/);
    const cmd = resolveAlias(head);
    const full = completeCommand(cmd) ?? cmd;
    if (SLASH_CONTAINS(full)) return { kind: 'command', cmd: full, value: rest.join(' ') };
    return { kind: 'chat', value: text };
  }
  // ② 确定性工具直调（毫秒级）
  const toolResult = await deterministicRun(trimmed);
  if (toolResult !== null) return { kind: 'tool', value: toolResult };
  // ③ NL 正则路由
  const cmd = routeNaturalLanguage(trimmed);
  if (cmd) return { kind: 'command', cmd };
  // ④ null → AI 意图层（agent 判断 command/tool/chat）
  return { kind: 'chat', value: text };
}

function SLASH_CONTAINS(cmd: string): boolean {
  const { SLASH } = require('./registry.js') as { SLASH: string[] };
  return SLASH.includes(cmd);
}

// src/commands/intent.ts — L4 意图路由（自然语言免记命令）
// 四层：① 别名（registry）② 确定性工具直调 ③ NL 正则路由 ④ AI 意图（agent 层）
import { resolveAlias, isSlash, completeCommand, SLASH } from './registry.js';
import { deterministicRun } from './deterministic.js';

export interface NlTrigger { re: RegExp; cmd: string }

// ③ NL 正则路由：自然语言 → 命令（不占用 AI 意图层）
// F16 修复：误劫持防御——长句必须祈使动词开头（"把代码备份到U盘" ✓ / "我之前备份过" ✗ 叙述），
// 疑问/陈述式长句一律交 AI 对话层；触发正则排除完成态（备份过/部署后/上线了）
export const NL_TRIGGERS: NlTrigger[] = [
  { re: /(?:做|建|造|写|开发|生成|制作).*(?:系统|应用|网站|工具|待办|记账|管理|页面)/i, cmd: '/build' },
  { re: /分析.*视频|视频.*分析|看.*视频|视频里/i, cmd: '/video' },
  { re: /(?:看|分析|识别).*图|图片.*(?:看|分析)|这张图|截图.*(?:看|分析)/i, cmd: '/vision' },
  { re: /(?:搜|找).*(?:记忆|黑洞|内容)|之前.*说|记得.*说|黑洞.*搜/i, cmd: '/hole' },
  { re: /体检|检查.*状态|看看.*健康/i, cmd: '/doctor' },
  { re: /备份(?!过|了|好|完)(?:一下|一份|数据|项目|代码|资料|文件|到|吧|$)/i, cmd: '/backup' },
  { re: /(?:部署|上线|落地)(?!了|过|后|完|完成)/i, cmd: '/deploy' },
  { re: /(?:抓取|爬).*网页|网页.*(?:抓|爬)|打开.*网页.*分析/i, cmd: '/claw' },
  { re: /定时|每隔|每(?:天|周|小时)/i, cmd: '/cron' },
  { re: /沙盒|隔离.*运行/i, cmd: '/sandbox' },
  { re: /合规|授权|consent/i, cmd: '/compliance' },
  { re: /多开|并行.*代理|swarm/i, cmd: '/swarm' },
];

// 祈使动词开头（"帮我/请/把/看/搜/分析/备份…"）——非此开头的长句视为叙述/提及，不劫持为命令
const IMPERATIVE_OPEN = /^(?:请|帮|把|给|用|来|去|现在|立即|马上|先|可以|能|看|搜|找|分析|检查|抓|爬|读|写|建|做|定时|沙盒|部署|备份)/;
// 疑问/语气特征——长句含此特征必为对话
const QUESTION_MARK = /(?:请问|你觉得|怎么样|怎么办|好不好|能不能|是否|为什么|如何|天气|吗|呢|吧|？|\?)/;

export function routeNaturalLanguage(text: string): string | null {
  const t = text.trim();
  // F16：长句守卫——非祈使开头或疑问式一律交 AI 对话层（不劫持为命令）
  if (t.length > 14) {
    if (QUESTION_MARK.test(t)) return null;
    if (!IMPERATIVE_OPEN.test(t)) return null;
  }
  for (const tr of NL_TRIGGERS) {
    if (tr.re.test(t)) return tr.cmd;
  }
  return null;
}

// 完整输入路由：别名 → 确定性 → NL → null（null 走 AI 意图/对话）
export async function routeInput(text: string): Promise<{ kind: 'command' | 'tool' | 'chat'; cmd?: string; value?: string }> {
  const trimmed = text.trim();
  // ① 斜杠命令（别名 + 补全 + `/skill:名` 冒号参数语法）
  if (isSlash(trimmed)) {
    const [head, ...rest] = trimmed.split(/\s+/);
    // 大小写归一：/HELP → /help（仅命令段，参数/技能名保持原样）
    const headNorm = head.toLowerCase();
    let cmd = resolveAlias(headNorm);
    let argTail = rest.join(' ');
    if (!SLASH.includes(cmd) && head.includes(':')) {
      const [c, ...a] = head.split(':');
      const canon = resolveAlias(c.toLowerCase());
      if (SLASH.includes(canon)) {
        cmd = canon;
        const joined = a.join(':');
        argTail = joined ? joined + (argTail ? ' ' + argTail : '') : argTail;
      }
    }
    const full = completeCommand(cmd) ?? cmd;
    if (SLASH.includes(full)) return { kind: 'command', cmd: full, value: argTail };
    return { kind: 'chat', value: text };
  }
  // ② 确定性工具直调（毫秒级）
  const toolResult = await deterministicRun(trimmed);
  if (toolResult !== null) return { kind: 'tool', value: toolResult };
  // ③ NL 正则路由（原文作为命令参数传递）
  const cmd = routeNaturalLanguage(trimmed);
  if (cmd) return { kind: 'command', cmd, value: trimmed };
  // ④ null → AI 意图层（agent 判断 command/tool/chat）
  return { kind: 'chat', value: text };
}


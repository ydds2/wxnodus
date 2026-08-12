// src/commands/intent.ts — L4 意图路由（自然语言免记命令）
// 四层：① 别名（registry）② 确定性工具直调 ③ NL 正则路由 ④ AI 意图（agent 层）
import { resolveAlias, isSlash, completeCommand, SLASH } from './registry.js';
import { deterministicRun } from './deterministic.js';

export interface NlTrigger { re: RegExp; cmd: string }

/** 自然语言触发注册 API（开放兼容：插件/外部代码可注册新意图词，运行时生效） */
export function registerNlTrigger(re: RegExp, cmd: string): () => void {
  const trigger: NlTrigger = { re, cmd };
  NL_TRIGGERS.push(trigger);
  return () => {
    const i = NL_TRIGGERS.indexOf(trigger);
    if (i >= 0) NL_TRIGGERS.splice(i, 1);
  };
}

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
  { re: /(?:部署|上线|落地)(?!了|过|后|完|完成|上)/i, cmd: '/deploy' },
  { re: /(?:抓取|爬).*网页|网页.*(?:抓|爬)|打开.*网页.*分析/i, cmd: '/claw' },
  // A20：联网搜索（自研 DDG——区别于 /hole 的记忆检索）
  { re: /(?:搜一搜|搜一下|帮我搜|上网.*搜|查一下.*资料|搜索)[^记]*$/i, cmd: '/search' },
  { re: /定时|每隔|每(?:天|周|小时)/i, cmd: '/cron' },
  { re: /沙盒|隔离.*运行/i, cmd: '/sandbox' },
  { re: /合规|授权|consent/i, cmd: '/compliance' },
  { re: /多开|并行.*代理|swarm/i, cmd: '/swarm' },
  // ── 智能度扩充（全方面自研化·B）：编程/运维/会话类触发 ──
  // 审查修复：代码审查指向 /review（自查子代理）、写测试指向 /gate（测试门）——
  // 此前两者都路由到 /fdr（部署后保障文档），AI 对话层被正则劫持到错误命令
  { re: /审查|审阅|review.*代码|代码.*review|检查.*(?:代码|逻辑|bug)|找.*(?:bug|缺陷)/i, cmd: '/review' },
  { re: /写测试|补测试|测试(?:一下|这个|代码)|单测/i, cmd: '/gate' },
  // 审计修复：NL 触发与命令语义对齐（此前「写文档→/evidence（不生成文档）」
  // 「提交代码→/build（不提交 git）」「重构→/build」均错配——删除误导词，让 AI 对话层接管）
  { re: /数据库|执行.*sql|sql.*查询/i, cmd: '/sql' },
  { re: /导出.*(?:会话|历史|对话)|导出数据/i, cmd: '/export' },
  { re: /恢复(?:上次|之前)?会话|继续上次|resume/i, cmd: '/resume' },
  { re: /压缩(?:上下文|记忆)|清理上下文/i, cmd: '/compact' },
  { re: /用量|token.*(?:用了|花费)|花了多少/i, cmd: '/usage' },
  { re: /审计|合规审查|留痕/i, cmd: '/audit' },
  { re: /安全通道|注入通道|sudo.*开启|secret.*开启/i, cmd: '/security' },
  { re: /做(?:一个)?计划|制定方案|规划(?:一下|方案)/i, cmd: '/plan' },
  { re: /派(?:子)?任务|委派|子代理.*(?:做|处理)/i, cmd: '/delegate' },
  // 黑洞同化：指定目录吸收技能 / 素材消化产出技能
  { re: /同化|吸收.*技能|消化.*技能|技能.*(?:同化|吸收|消化)|把.*(?:目录|文件夹).*(?:技能|吸收)/i, cmd: '/assimilate' },
];

// 祈使动词开头（"帮我/请/把/看/搜/分析/备份…"）——非此开头的长句视为叙述/提及，不劫持为命令
// 审查修复（P3）：此前加「上」使「上周/上面/上午」开头的叙述句通过守卫被误劫持——
// 改精准词「上网」（服务 /search 的「上网搜…」场景），不移除也不扩大
const IMPERATIVE_OPEN = /^(?:请|帮|把|给|用|来|去|现在|立即|马上|先|可以|能|看|搜|找|分析|检查|抓|爬|读|写|建|做|定时|沙盒|部署|备份|上网)/;
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


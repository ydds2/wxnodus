// src/kernel/systemPrompt.ts — 结构化系统提示（智能度基础，自研）
// 文案规范：专业术语保留（agent/工具/模式/凭据），首次出现附一句通俗解释——
// 专业但不晦涩，易懂但不失严谨（docs/copy-guide.md 规范）
// 开放兼容：lang 参数使 /lang 设置真实生效（en → 英文输出规范）；
// dataDir 下 prompts/system.md 存在时整体替换内置提示（外部自定义人格/工作流，热生效）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Mode } from './permissions.js';

const MODE_RULES: Record<Mode, string> = {
  smart: '更改前确认模式：只读操作直接执行；写入、联网、危险操作先征得用户同意；工作区内的文件编辑自动放行（视为低风险）。',
  auto: '自动编辑模式：文件编辑自动接受；shell 命令按危险等级处理，危险命令仍需确认。',
  goal: '目标驱动模式：你自主规划并持续执行，直到目标全部完成；全部完成时在回复末尾输出 [GOAL_DONE]（完成标记），未完成则继续。',
  manual: '全量确认模式：所有动作（包括只读查询）都先征求用户同意。',
  plan: '计划模式：只做只读调研与方案设计；用 /plan 提交实现计划，经用户批准后再动手实施。',
  yolo: '完全访问模式：除硬红线（破坏系统、泄露密钥等不可逆行为）外全部自动执行。',
};

export interface SysPromptOpts {
  mode: Mode;
  cwd: string;
  model: string;
  hasImageIn: boolean;
  sessionId?: string;
  /** /lang 设置：'en' 时输出规范切英文（其余保持中文） */
  lang?: string;
  /** dataDir：存在 prompts/system.md 时整体替换内置提示 */
  dataDir?: string;
}

/** 外部提示覆盖：<dataDir>/prompts/system.md 存在则整体替换（热生效——每次构建时读） */
function externalPromptOverride(dataDir: string | undefined): string | null {
  if (!dataDir) return null;
  try {
    const text = readFileSync(join(dataDir, 'prompts', 'system.md'), 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

export function buildSystemPrompt(opts: SysPromptOpts): string {
  const now = new Date();
  const lang = opts.lang === 'en' ? 'en' : 'zh';
  const locale = lang === 'en' ? 'en-US' : 'zh-CN';
  const external = externalPromptOverride(opts.dataDir);

  // 环境段始终追加（外部提示也带上——模型需要知道工作目录/模型/时间）
  const envBlock = [
    '## 环境',
    `- 工作目录：${opts.cwd}`,
    `- 当前模型：${opts.model}${opts.hasImageIn ? '（支持图像输入）' : ''}`,
    `- 会话：${opts.sessionId ?? 'default'}`,
    `- 时间：${now.toLocaleString(locale, { hour12: false })}`,
  ].join('\n');

  if (external) {
    return `${external}\n\n${envBlock}`;
  }

  const outputRules = lang === 'en'
    ? [
        '1. Reply in English (keep code and commands verbatim).',
        '2. Annotate code blocks with their language; explain each file when changing several.',
        '3. Conclusion first, then details; use lists or tables for long content.',
        '4. Terminal layout: headings with ## (### for deeper levels); numbered steps 1. 2.;',
        '   conclusion paragraphs start with **Conclusion:**; wrap key numbers/paths/commands in backticks;',
        '   keep lines ≤ 80 chars.',
      ]
    : [
        '1. 用中文回复（代码与命令保留原文）。',
        '2. 代码块标注语言；改动多个文件时逐个说明。',
        '3. 先结论后细节；长内容用列表或表格组织，方便快速浏览。',
        '4. 终端排版：标题用 ##（多级用 ###，避免 # 占行）；步骤用 1. 2. 编号；',
        '   结论段以 **结论：** 开头；关键数字/路径/命令用反引号包裹；',
        '   话题间用空行分隔（避免 --- 水平线在窄终端浪费行）；',
        '   列表每项一行，长项拆行保持每行 ≤80 字符。',
      ];

  const lines: string[] = [
    '你是 WxNodus——本地概念编译器（把自然语言需求"编译"为可运行系统的智能助手），完全自研的 CLI 产品。',
    '',
    '## 工作准则',
    '1. 工具优先：能调用工具拿到事实（读文件、执行命令、搜索历史记忆），就不要凭记忆猜测。',
    '2. 证据驱动：关键结论给出证据（文件路径、命令输出）；不确定就明确说"不确定"。',
    '3. 完成度：交付可运行、可验证的结果；完成后用不超过三句话总结做了什么、怎么验证。',
    '4. 安全：绝不执行破坏性操作（删除根目录、格式化磁盘、泄露账号密钥）；危险操作先说明再做。',
    '5. 自主探索（简化人工指令）：需要了解项目结构/符号时调用 repo_map 工具；有可用技能时按需用 skill_load 加载；不确定用哪个工具时用 tool_search 检索。不要等用户提示，主动寻找并使用合适的能力。',
    '6. 目标导向（四要素）：接任务先明确 Goal（做什么）与 Done-when（完成的可验证条件），再动手；受约束（Constraints）时先说明影响；每个里程碑自查是否达到完成条件，未达到继续、达到则明确报告——绝不把"做了"冒充"完成"。',
    '',
    `## 当前模式：${opts.mode}`,
    MODE_RULES[opts.mode] ?? MODE_RULES.smart,
    '',
    '## 输出规范',
    ...outputRules,
    '',
    envBlock,
  ];
  return lines.join('\n');
}

// src/kernel/agents.ts — 自定义 agent 定义体系（P0-2，对齐 OpenCode .opencode/agents / Codex agents.md / Kimi agents YAML）
// 约定：`.wxnodus/agents/*.md`（项目级）+ `<dataDir>/agents/*.md`（用户级，项目同名覆盖用户）
// 格式：YAML frontmatter（name/description/mode/tools）+ Markdown 正文（角色指令，整体替换内置 system prompt）
// frontmatter 仅标量键，手写解析零依赖（与 skills.ts 同模式）
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseSkillMd } from './skills.js';
import type { Mode } from './permissions.js';

export interface AgentDef {
  name: string;
  description: string;
  /** 权限模式（smart/auto/plan/yolo…；缺省 smart） */
  mode?: Mode;
  /** 工具白名单（缺省：只读子代理集）——白名单外工具对子代理不可用 */
  tools?: string[];
  /** 角色指令（frontmatter 下方正文；整体替换内置 system prompt） */
  instructions: string;
  /** 来源文件（展示用） */
  source: string;
}

/** frontmatter 解析（复用 skills.ts 共享解析器——`---` 分隔 + 标量键，单一事实源；无 frontmatter 返回 null） */
function parseAgentFile(text: string, file: string): AgentDef | null {
  const { meta, body } = parseSkillMd(text);
  const name = meta.name?.trim();
  if (!name) return null;
  const toolsRaw = meta.tools?.trim();
  const tools = toolsRaw && toolsRaw !== 'none'
    ? toolsRaw.replace(/^\[|\]$/g, '').split(/[,\s]+/).map(t => t.trim()).filter(Boolean)
    : undefined;
  const mode = (['smart', 'auto', 'goal', 'manual', 'plan', 'yolo'] as const).includes(meta.mode as Mode)
    ? meta.mode as Mode
    : undefined;
  return {
    name,
    description: meta.description ?? '',
    mode,
    tools,
    instructions: body,
    source: file,
  };
}

/** 扫描目录收集 agent 定义（不存在/无文件返回空数组） */
function scanDir(dir: string): AgentDef[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const file = join(dir, f);
        try { return parseAgentFile(readFileSync(file, 'utf8'), file); } catch { return null; }
      })
      .filter((d): d is AgentDef => d !== null);
  } catch {
    return [];
  }
}

/** 加载全部 agent 定义（项目级优先，用户级同名被项目覆盖） */
export function loadAgentDefs(cwd: string, dataDir: string): AgentDef[] {
  const user = scanDir(join(dataDir, 'agents'));
  const proj = scanDir(join(cwd, '.wxnodus', 'agents'));
  const byName = new Map<string, AgentDef>();
  for (const d of user) byName.set(d.name, d);
  for (const d of proj) byName.set(d.name, d); // 项目级覆盖用户级
  return [...byName.values()];
}

/** 按名查找（不存在返回 null） */
export function findAgentDef(name: string, cwd: string, dataDir: string): AgentDef | null {
  const n = String(name ?? '').trim();
  if (!n) return null;
  return loadAgentDefs(cwd, dataDir).find(d => d.name === n) ?? null;
}

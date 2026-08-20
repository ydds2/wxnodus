// src/kernel/projectRules.ts — 生态规范文件链（agents.md 标准 + 多工具共存）
// 设计：同一套项目规范被多家 CLI 消费——按优先级读取首个存在者，避免多文件叠加冲突：
//   AGENTS.md（Codex/OpenCode 标准，/init 生成）> CLAUDE.md（Claude Code）>
//   GEMINI.md（Gemini CLI）> .cursorrules（Cursor）> .clinerules（Cline）> .roomodes（Roo）
// 32KiB 预算（超限整体跳过，避免半截内容误导模型）；每轮调用频率低，不做内容缓存
import { join } from 'node:path';
import { statSync, readFileSync } from 'node:fs';

export const RULES_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursorrules', '.clinerules', '.roomodes'] as const;
export const RULES_MAX_BYTES = 32768;

/** 读取项目规范链首个存在者；无则返回 null。逐文件容错（缺失/无权限/超限 → 下一个） */
export function loadProjectRules(cwd: string): { file: string; text: string } | null {
  for (const f of RULES_FILES) {
    const p = join(cwd, f);
    let st;
    try { st = statSync(p); } catch { continue; } // 不存在/无权限 → 尝试下一个
    if (st.size > RULES_MAX_BYTES) continue;
    let text = '';
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    return { file: f, text };
  }
  return null;
}

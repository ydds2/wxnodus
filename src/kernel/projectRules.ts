// src/kernel/projectRules.ts — 生态规范文件链（agents.md 标准 + 多工具共存）
// 设计：同一套项目规范被多家 CLI 消费——按优先级读取首个存在者，避免多文件叠加冲突：
//   AGENTS.md（Codex/OpenCode 标准，/init 生成）> CLAUDE.md（Claude Code）>
//   GEMINI.md（Gemini CLI）> .cursorrules（Cursor）> .clinerules（Cline）> .roomodes（Roo）
// 32KiB 预算（超限整体跳过，避免半截内容误导模型）；每轮调用频率低，不做内容缓存
//
// V4 P4-1：AGENTS.md 分层互操作标准（codex AGENTS.md guide 对齐）——
//   ① 分层搜索：全局（dataDir/AGENTS.md）> 仓库根 > 子目录——从当前目录向上最多 4 层
//      （codex 语义：只取最近 4 层，深层不注入防 token 爆；子目录覆盖仓库根——越近越具体）
//   ② 注入上限可配：settings.projectDocMaxBytes（默认 32KiB，codex project_doc_max_bytes）
//   ③ @file 导入：@path/to/file 行内引用展开（gemini @import 同族——相对规则文件基准）
//   ④ 与自有记忆共存：AGENTS.md=项目层（本仓库规范），黑洞记忆=跨会话层（个人知识）
import { join, dirname, resolve } from 'node:path';
import { statSync, readFileSync } from 'node:fs';

export const RULES_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursorrules', '.clinerules', '.roomodes'] as const;
export const RULES_MAX_BYTES = 32768;
/** V4 P4-1：向上搜索层数上限（codex AGENTS.md guide——只取最近 4 层） */
export const RULES_MAX_DEPTH = 4;

/** @file 导入展开（gemini @import 同族）：`@./lib/config.md` 行替换为引用文件内容（有界+防循环） */
function expandAtImports(text: string, baseDir: string, maxBytes: number, seen = new Set<string>()): string {
  const importRe = /^@(\.?[\w./-]+)\s*$/gm;
  return text.replace(importRe, (_m, rel: string) => {
    const target = resolve(baseDir, rel);
    if (seen.has(target)) return '[循环引用已跳过]';
    try {
      const st = statSync(target);
      if (!st.isFile() || st.size > maxBytes) return `[导入 ${rel} 超限或非文件——已跳过]`;
      seen.add(target);
      const imported = readFileSync(target, 'utf8').slice(0, maxBytes);
      return expandAtImports(imported, dirname(target), maxBytes, seen); // 递归一层（seen 防环）
    } catch {
      return `[导入 ${rel} 不存在——已跳过]`;
    }
  });
}

/** 分层搜索一层（单目录内规则链首个存在者） */
function loadRulesFromDir(dir: string, maxBytes: number): { file: string; text: string; dir: string } | null {
  for (const f of RULES_FILES) {
    const p = join(dir, f);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.size > maxBytes) continue;
    let text = '';
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    return { file: f, text, dir };
  }
  return null;
}

/**
 * V4 P4-1 分层加载：全局层（dataDir）> 向上搜索（cwd 起最近 4 层——子目录覆盖仓库根）。
 * 首个命中层返回（codex 语义：越近越具体）；无命中 null。
 * 兼容旧调用形态：loadProjectRules(cwd)（无 opts 时无全局层、仅向上搜索）。
 */
export function loadProjectRules(cwd: string, opts?: { dataDir?: string; maxBytes?: number }): { file: string; text: string; layer: 'global' | 'repo' | 'subdir' } | null {
  const maxBytes = opts?.maxBytes ?? RULES_MAX_BYTES;

  // ① 全局层（dataDir 下——个人跨项目规范；codex 全局层对齐）
  if (opts?.dataDir) {
    const global = loadRulesFromDir(opts.dataDir, maxBytes);
    if (global) return { file: global.file, text: expandAtImports(global.text, global.dir, maxBytes), layer: 'global' };
  }

  // ② 向上搜索（cwd 起最多 4 层；depth 0 = cwd 本层 = subdir——子目录覆盖父目录）
  let dir = cwd;
  for (let depth = 0; depth < RULES_MAX_DEPTH; depth++) {
    const hit = loadRulesFromDir(dir, maxBytes);
    if (hit) {
      return { file: hit.file, text: expandAtImports(hit.text, hit.dir, maxBytes), layer: depth === 0 ? 'subdir' : 'repo' };
    }
    const parent = dirname(dir);
    if (parent === dir) break; // 到根
    dir = parent;
  }
  return null;
}

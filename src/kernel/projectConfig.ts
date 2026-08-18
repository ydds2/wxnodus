// src/kernel/projectConfig.ts — 项目级配置分层（B-05，gemini 四层配置对标：默认→全局→项目→CLI/env）
// 项目文件：<cwd>/.wxnodus/config.json 的 settings 段——键级覆盖全局 settings（浅合并，不深合并）。
// 读取策略：每次调用直接读+解析（文件极小，成本可忽略；不做 mtime 缓存——CI 实测 Windows NTFS
// 同毫秒内两次写入 mtimeMs 不变会返回陈旧内容，缓存正确性不可证故弃用）。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ProjectConfig { settings?: Record<string, any>; [k: string]: any }

export const projectConfigPath = (cwd: string): string => join(cwd, '.wxnodus', 'config.json');

/** 读项目配置（缺失/非法 → cfg null + error 诊断） */
export function readProjectConfig(cwd: string): { cfg: ProjectConfig | null; error?: string } {
  const p = projectConfigPath(cwd);
  try {
    if (!existsSync(p)) return { cfg: null };
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as ProjectConfig;
    return { cfg: parsed && typeof parsed === 'object' ? parsed : null };
  } catch (e: any) {
    return { cfg: null, error: String(e?.message ?? e).slice(0, 120) };
  }
}

/** 分层 settings：项目 settings 键级覆盖全局；无项目配置 → 原引用零拷贝（行为不变） */
export function layeredSettings(global: Record<string, any> | undefined, cwd: string): Record<string, any> | undefined {
  if (!global) return global;
  const { cfg } = readProjectConfig(cwd);
  const proj = cfg?.settings;
  if (!proj || typeof proj !== 'object') return global;
  return { ...global, ...proj };
}

/** 分层来源诊断（/config 展示：项目文件路径 / 是否加载 / 解析错误） */
export function settingsLayers(cwd: string): { projectPath: string; projectLoaded: boolean; error?: string } {
  const { cfg, error } = readProjectConfig(cwd);
  return { projectPath: projectConfigPath(cwd), projectLoaded: !!cfg, error };
}

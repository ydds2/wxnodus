// src/kernel/projectConfig.ts — 项目级配置分层（B-05，gemini 四层配置对标：默认→全局→项目→CLI/env）
// 项目文件：<cwd>/.wxnodus/config.json 的 settings 段——键级覆盖全局 settings（浅合并，不深合并）。
// 读取按 mtime 缓存（工具调用每次 statSync 一次，命中缓存零解析）；非法 JSON 诚实暴露诊断不崩。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface ProjectConfig { settings?: Record<string, any>; [k: string]: any }

const cache = new Map<string, { mtimeMs: number; cfg: ProjectConfig | null }>();

export const projectConfigPath = (cwd: string): string => join(cwd, '.wxnodus', 'config.json');

/** 读项目配置（缺失/非法 → cfg null + error 诊断；mtime 缓存） */
export function readProjectConfig(cwd: string): { cfg: ProjectConfig | null; error?: string } {
  const p = projectConfigPath(cwd);
  try {
    if (!existsSync(p)) {
      cache.set(p, { mtimeMs: -1, cfg: null });
      return { cfg: null };
    }
    const mtimeMs = statSync(p).mtimeMs;
    const hit = cache.get(p);
    if (hit && hit.mtimeMs === mtimeMs) return { cfg: hit.cfg };
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as ProjectConfig;
    const cfg = parsed && typeof parsed === 'object' ? parsed : null;
    cache.set(p, { mtimeMs, cfg });
    return { cfg };
  } catch (e: any) {
    cache.set(p, { mtimeMs: -1, cfg: null });
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

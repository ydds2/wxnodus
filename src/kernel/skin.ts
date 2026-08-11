// src/kernel/skin.ts — 皮肤数据源（开放兼容：/skin 真实生效）
// 皮肤文件：<dataDir>/skins/<name>.json（GatewaySkin 结构：colors/branding 键）
// 用户可手写皮肤文件或复制现有主题导出；settings.skin 存皮肤名，缺省 'default'
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface GatewaySkin {
  banner_hero?: string;
  banner_logo?: string;
  branding?: Record<string, string>;
  colors?: Record<string, string>;
  help_header?: string;
  tool_prefix?: string;
}

/** 加载皮肤文件（<dataDir>/skins/<name>.json）；'default'/空名 → null（内置主题） */
export function loadSkinFile(dataDir: string, name: string | undefined | null): GatewaySkin | null {
  const n = (name ?? '').trim();
  if (!n || n === 'default') return null;
  try {
    const raw = readFileSync(join(dataDir, 'skins', `${n}.json`), 'utf8');
    const j = JSON.parse(raw) as GatewaySkin;
    if (!j || typeof j !== 'object') return null;
    return j;
  } catch {
    return null; // 文件不存在/损坏：回退内置主题
  }
}

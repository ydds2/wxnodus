// src/kernel/toolTrim.ts — 按模型工具裁剪（supremacy 1.3 / 缺陷 A-04 落地，2026-08-18）
// 机制参考：codex 按模型分档工具面（文本/小模型不发全量 schema）——实现原创。
// 规则（能力驱动，确定性，默认 auto）：
//   1. 无视觉能力（imageIn !== true）→ 裁掉「图片输出」工具（browser_screenshot /
//      computer_screenshot / computer_observe 返回图像，文本模型不可消费——纯浪费 schema 与调用）
//   2. 小窗口 + 文本模型（maxContext ≤ 32k 且无视觉）→ 额外裁掉 GUI 文本会话套件
//      （browser 动作 / computer 动作 / UIA 树——文本体积大，小窗口装不下浏览器/桌面会话）；
//      视觉小窗口模型（如 glm-4v-flash）全保留（看图是其核心用途，不因窗口小砍动作面）
//   3. 目录未收录模型（自定义端点/离线降级）→ 不裁剪（诚实回退：未知能力不臆测）
// settings.toolTrim：'auto'（默认，按规则）| 'off'（全量，逃生门）；与 excludeTools /
// toolLazyLoad（动态检索激活）互为独立层级。
import { MODEL_CATALOG, type ModelEntry } from './providers.js';
import type { ToolDef } from './tools.js';

/** 图片输出/输入工具：返回图像给模型「看」或把图片送进视觉通道——文本模型消费不了 */
export const VISION_IMAGE_TOOLS = new Set(['browser_screenshot', 'computer_screenshot', 'computer_observe', 'view_image']);

/** GUI 文本会话套件：browser_*（除 screenshot）/ computer_*（除 screenshot/observe）/ computer_uia_* */
export const GUI_TEXT_RE = /^browser_(?!screenshot$)|^computer_(?!screenshot$|observe$)|^computer_uia_/;

export type ToolTrimMode = 'auto' | 'off';

export interface ToolTrimResult {
  tools: Record<string, ToolDef>;
  /** 被裁掉的工具名（顺序=注册顺序） */
  dropped: string[];
  tier: 'full' | 'lite';
  /** 人类可读裁剪理由（audit/UI 展示） */
  reasons: string[];
}

/** 目录能力查询（未收录 → null——调用方回退「不裁剪」） */
export function modelCapabilitiesFor(model: string | undefined, catalog: ModelEntry[] = MODEL_CATALOG): ModelEntry['capabilities'] | null {
  if (!model) return null;
  return catalog.find(m => m.modelId === model)?.capabilities ?? null;
}

/** 按模型裁剪工具表（纯函数：不修改入参；mode=off / 未知模型 → 原表返回） */
export function trimToolsForModel(
  model: string | undefined,
  tools: Record<string, ToolDef>,
  opts: { mode?: ToolTrimMode | string; catalog?: ModelEntry[] } = {},
): ToolTrimResult {
  if ((opts.mode ?? 'auto') === 'off') {
    return { tools, dropped: [], tier: 'full', reasons: [] };
  }
  const caps = modelCapabilitiesFor(model, opts.catalog);
  if (!caps) {
    // 未知能力不臆测：全量（自定义端点用户可自行 excludeTools / toolLazyLoad 控制）
    return { tools, dropped: [], tier: 'full', reasons: [] };
  }
  const imageIn = caps.imageIn === true;
  const lite = (caps.maxContext ?? Infinity) <= 32_000;
  const dropped: string[] = [];
  const keep: Record<string, ToolDef> = {};
  for (const [name, def] of Object.entries(tools)) {
    if (!imageIn && VISION_IMAGE_TOOLS.has(name)) { dropped.push(name); continue; }
    if (lite && !imageIn && GUI_TEXT_RE.test(name)) { dropped.push(name); continue; }
    keep[name] = def;
  }
  const reasons: string[] = [];
  if (!imageIn && dropped.some(d => VISION_IMAGE_TOOLS.has(d))) {
    reasons.push(`文本模型无视觉能力：裁掉 ${dropped.filter(d => VISION_IMAGE_TOOLS.has(d)).length} 个图片输出工具`);
  }
  if (lite && !imageIn) {
    const gui = dropped.filter(d => GUI_TEXT_RE.test(d));
    if (gui.length) reasons.push(`小窗口（≤32k）文本模型：裁掉 ${gui.length} 个 GUI 文本会话工具`);
  }
  return { tools: keep, dropped, tier: lite ? 'lite' : 'full', reasons };
}

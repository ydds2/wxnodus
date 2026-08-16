// src/wxnodus-ui/lib/layoutProfile.ts — 阶段 1：布局条件纯函数（几何/状态可见性/overlay 模式单一事实源）
// 输入：terminal tier + capabilities + 终端列数；输出：单栏宽度、状态段可见性、overlay 模式、glyph/spinner。
// 硬约束：正常 UI 永远是单栏——mainWidth 恒等于终端列数，本模块不产生任何第二列几何。
import type { TerminalCapabilities, TerminalTier } from './terminalTier.js';

export interface StatusSegments {
  /** 窄屏把上下文读out收敛为裸 token 数（不含视觉填充条） */
  compactCtx: boolean;
  /** 上下文填充条 */
  bar: boolean;
  /** 会话时长/空闲时钟 */
  duration: boolean;
  /** 压缩计数 */
  compressions: boolean;
  /** 语音段 */
  voice: boolean;
  /** 费用段 */
  cost: boolean;
  /** 余额段（💰，独立配置——未配置自动隐藏，不占预算） */
  balance: boolean;
  /** token 区间段（📊） */
  usage: boolean;
}

export interface LayoutProfile {
  tier: TerminalTier;
  /** 字形集直通（full/bmp/ascii），组件据此选变体 */
  glyphSet: 'full' | 'bmp' | 'ascii';
  /** 单栏主列宽 = 终端列数（不引入第二列，不设右栏保留区） */
  mainWidth: number;
  /** overlay 挂载模式：float（FloatBox 覆盖 transcript）/ none（no-vt 不挂载 TUI） */
  overlayMode: 'float' | 'none';
  /** spinner 帧集：full → braille；bmp/ascii → ascii 帧（与 branding.tsx 既有行为一致） */
  spinner: 'braille' | 'ascii';
  /** 状态栏渐进披露断点（与 appChrome.statusBarSegments 同一阈值——单一事实源） */
  status: StatusSegments;
}

/** 状态栏尾段渐进披露阈值：cost → voice → compressions → duration → bar，窄屏先砍低优先级段。 */
export const statusSegmentsFor = (cols: number): StatusSegments => {
  const w = Math.max(1, Math.floor(cols || 1));

  return {
    compactCtx: w < 72,
    bar: w >= 72,
    duration: w >= 76,
    compressions: w >= 80,
    voice: w >= 84,
    cost: w >= 96,
    // 余额优先级高于费用：72+ 即出（用户痛点段——钱最要紧）；
    // token 区间与费用同档（96+，信息密度高时才双展示）
    balance: w >= 72,
    usage: w >= 96,
  };
};

export const layoutProfileFor = (
  tier: TerminalTier,
  capabilities: TerminalCapabilities,
  cols: number,
): LayoutProfile => ({
  tier,
  glyphSet: capabilities.glyphSet,
  mainWidth: Math.max(1, Math.floor(cols || 1)),
  overlayMode: tier === 'no-vt' ? 'none' : 'float',
  spinner: capabilities.glyphSet === 'full' ? 'braille' : 'ascii',
  status: statusSegmentsFor(cols),
});

import type { Theme } from '../theme.js'
import type { Role } from '../types.js'

// 2026-08-19 全面替换（对标 Claude Code 家族）：用户 = dim「❯」+ 默认正文色
// （无 label 着色、无底色块）；助手/系统/工具均无字形 gutter（空白对齐列）
export const ROLE: Record<Role, (t: Theme) => { body: string; glyph: string; prefix: string }> = {
  assistant: t => ({ body: t.color.text, glyph: '  ', prefix: t.color.muted }),
  system: t => ({ body: '', glyph: '  ', prefix: t.color.muted }),
  tool: t => ({ body: t.color.muted, glyph: '  ', prefix: t.color.muted }),
  user: t => ({ body: '', glyph: t.brand.prompt, prefix: t.color.muted })
}

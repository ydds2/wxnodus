import { Box, Text, useStdout } from '@wxnodus/ink'
import { memo } from 'react'

import { accretionRule, brandBarLayout } from '../lib/brandRule.js'
import type { Theme } from '../theme.js'

// 常驻品牌顶栏（黑洞引擎差异化）：左品牌名（事件视界辉光色）+ 中间吸积盘渐变规则线 + 右上下文。
// 随窗口宽度渐进收缩；极窄终端（<24 列）整体让位。不随消息滚动消失。
export const BrandBar = memo(function BrandBar({
  rightLabel,
  t
}: {
  rightLabel: string
  t: Theme
}) {
  const term = useStdout().stdout?.columns ?? 80
  const layout = brandBarLayout(term, t.brand, rightLabel)

  if (!layout) {
    return null
  }

  const rule = accretionRule(layout.ruleWidth, {
    border: t.color.border,
    accent: t.color.accent,
    primary: t.color.primary
  })

  return (
    <Box flexDirection="row" flexShrink={0} marginBottom={1}>
      <Text bold color={t.color.primary} wrap="truncate-end">
        {layout.left}
      </Text>
      <Box justifyContent="center" width={layout.ruleWidth}>
        {rule.map((segment, index) => (
          <Text color={segment.color} key={index}>
            {segment.text}
          </Text>
        ))}
      </Box>
      {layout.right ? (
        <Text color={t.color.muted} wrap="truncate-end">
          {layout.right}
        </Text>
      ) : null}
    </Box>
  )
})

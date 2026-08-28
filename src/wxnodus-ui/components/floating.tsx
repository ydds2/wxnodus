// src/wxnodus-ui/components/floating.tsx — 共享浮层容器（UI 重设计 P0-3 自 appChrome 拆出）
// FloatBox：absolute 定位的常驻浮层壳（display 切换显隐——React 19 并发防错位约束由调用方维持）。
import { Box } from '@wxnodus/ink'
import { type ReactNode } from 'react'

export function FloatBox({
  children,
  color,
  display,
  borderStyle = 'single',
  noBorder = false
}: {
  children: ReactNode
  color: string
  display?: 'flex' | 'none'
  /** 边框样式（pager 内容自带边框时用 noBorder 去掉外层，避免双重边框） */
  borderStyle?: 'single' | 'double' | 'round' | 'bold' | 'singleDouble' | 'doubleSingle' | 'classic' | 'arrow' | 'dashed'
  /** 无边框：Box 收到 undefined borderStyle 即不渲染边框（ink 语义） */
  noBorder?: boolean
}) {
  return (
    <Box
      alignSelf="flex-start"
      borderColor={color}
      borderStyle={noBorder ? undefined : borderStyle}
      display={display}
      flexDirection="column"
      marginTop={1}
      opaque
      paddingX={1}
    >
      {children}
    </Box>
  )
}

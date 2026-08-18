// src/wxnodus-ui/components/diffRenderer.tsx — 全量 diff 回显组件
// gemini DiffRenderer.tsx:224-399 移植（同 ink 栈）：行号 gutter + +/- 色块 + 逐行着色 +
// hunk 折叠（opencode 语义，diffHunks 复用）；超大 diff 保护（codex diff_render.rs:591-598
// 对标）：仅前 maxLines 行高亮着色，余行合并单块（内容完整保留，仅着色降级——防节点爆炸）。
import { Box, Text } from '@wxnodus/ink'

import { DIFF_HILITE_MAX, diffLines, stripDiffFence, type DiffLineKind } from '../lib/diffHighlight.js'
import { buildFoldSegments, withDefaultFolds } from '../lib/diffHunks.js'
import { lineNumbersFor } from '../lib/diffGutter.js'
import type { Theme } from '../theme.js'

export interface DiffRendererProps {
  /** diff 正文（可带 ```diff 围栏，stripDiffFence 宽容剥离） */
  body: string
  /** 高亮行数上限（默认 DIFF_HILITE_MAX=400） */
  maxLines?: number
  t: Theme
}

export function DiffRenderer({ body, maxLines = DIFF_HILITE_MAX, t }: DiffRendererProps) {
  const lines = diffLines(stripDiffFence(body))
  const bounded = lines.slice(0, maxLines)
  const rest = lines.slice(maxLines)
  const segs = withDefaultFolds(buildFoldSegments(bounded))
  const numbers = lineNumbersFor(bounded)
  // gutter 宽度 = 最大行号位数（右对齐；无 hunk 时 0 宽不渲染 gutter）
  let maxNum = 0
  for (const n of numbers) {
    if (n !== null && n > maxNum) maxNum = n
  }
  const gutterWidth = maxNum > 0 ? String(maxNum).length : 0

  const lineColor = (kind: DiffLineKind) =>
    kind === 'add'
      ? t.color.statusGood
      : kind === 'del'
        ? t.color.error
        : kind === 'hunk'
          ? t.color.accent
          : kind === 'meta'
            ? t.color.muted
            : t.color.text

  // seg.index 是段序号而非行偏移——行号对齐必须走游标（segments 保序划分 bounded）
  let cursor = 0
  const row = (l: { kind: DiffLineKind; text: string }, num: number | null, key: number) => (
    <Box key={key} flexDirection="row">
      {gutterWidth > 0 ? (
        <Text width={gutterWidth + 2} color={t.color.muted} dimColor>
          {num === null ? '' : String(num)}
        </Text>
      ) : null}
      <Text color={lineColor(l.kind)}>{l.text}</Text>
    </Box>
  )

  // 无 meta/hunk 结构的纯文本（防御路径）：直接按行渲染——绝不静默丢内容
  if (!segs.length && bounded.length) {
    return (
      <Box flexDirection="column">
        {bounded.map((l, i) => row(l, null, i))}
        {rest.length ? (
          <Text color={t.color.muted}>{rest.map(l => l.text).join('\n')}</Text>
        ) : null}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {segs.map(seg => {
        if (seg.kind === 'meta') {
          const nums = numbers.slice(cursor, cursor + seg.lines.length)
          const block = seg.lines.map((l, i) => row(l, nums[i] ?? null, cursor + i))
          cursor += seg.lines.length
          return (
            <Box key={`m${seg.index}`} flexDirection="column">
              {block}
            </Box>
          )
        }
        const headerRow = row(seg.header, null, cursor)
        cursor += 1
        let bodyRows = null
        if (!seg.folded) {
          const bodyNums = numbers.slice(cursor, cursor + seg.body.length)
          bodyRows = seg.body.map((l, i) => row(l, bodyNums[i] ?? null, cursor + i))
        }
        cursor += seg.body.length
        return (
          <Box key={`h${seg.index}`} flexDirection="column">
            {headerRow}
            {seg.folded ? (
              <Text color={t.color.muted} dimColor>
                {`…${seg.body.length} 行已折叠（超长 hunk）`}
              </Text>
            ) : (
              bodyRows
            )}
          </Box>
        )
      })}
      {rest.length ? (
        <Text color={t.color.muted}>{rest.map(l => l.text).join('\n')}</Text>
      ) : null}
    </Box>
  )
}

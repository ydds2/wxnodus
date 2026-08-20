// tests/ui-diff-renderer.test.tsx — ③ 波 1：DiffRenderer 全量回显（行号 gutter/着色/折叠/超大截断）
import { describe, expect, it } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'

import { DiffRenderer } from '../src/wxnodus-ui/components/diffRenderer.js'
import { DEFAULT_THEME } from '../src/wxnodus-ui/theme.js'

const BODY = `diff --git a/x.txt b/x.txt
index 111..222 100644
--- a/x.txt
+++ b/x.txt
@@ -3,2 +3,2 @@
 ctx
-old line
+new line
`

describe('DiffRenderer（gemini DiffRenderer 移植）', () => {
  it('渲染行号 gutter + -/+ 行 + meta 行', () => {
    const { lastFrame } = render(<DiffRenderer t={DEFAULT_THEME} body={BODY} />)
    const frame = lastFrame()!
    expect(frame).toContain('3') // 行号（新侧起始 3）
    expect(frame).toContain('old line')
    expect(frame).toContain('new line')
    expect(frame).toContain('diff --git')
  })

  it('新文件（@@ -0,0 +1,N @@）行号从 1 起', () => {
    const { lastFrame } = render(
      <DiffRenderer t={DEFAULT_THEME} body={'@@ -0,0 +1,2 @@\n+alpha\n+beta\n'} />
    )
    const frame = lastFrame()!
    expect(frame).toContain('alpha')
    expect(frame).toContain('beta')
    expect(frame).toContain('1')
    expect(frame).toContain('2')
  })

  it('超长 hunk 默认折叠（折叠提示可见、内容隐藏）', () => {
    const body = ['@@ -1,25 +1,25 @@', ...Array.from({ length: 25 }, (_, i) => `+line${i}`)].join('\n')
    const { lastFrame } = render(<DiffRenderer t={DEFAULT_THEME} body={body} />)
    const frame = lastFrame()!
    expect(frame).toContain('25 行已折叠')
    expect(frame).not.toContain('line12') // 折叠内容不渲染
  })

  it('超大 diff 保护：maxLines 外余行合并单块（内容保留、着色降级）', () => {
    const body = ['@@ -1,6 +1,6 @@', ...Array.from({ length: 6 }, (_, i) => `+v${i}`)].join('\n')
    const { lastFrame } = render(<DiffRenderer t={DEFAULT_THEME} body={body} maxLines={4} />)
    const frame = lastFrame()!
    expect(frame).toContain('v0')
    expect(frame).toContain('v5') // 余行内容仍完整渲染（合并块）
  })

  it('无 diff 内容的纯文本安全渲染（不崩溃）', () => {
    const { lastFrame } = render(<DiffRenderer t={DEFAULT_THEME} body={'plain text\nno hunks'} />)
    expect(lastFrame()).toContain('plain text')
  })
})

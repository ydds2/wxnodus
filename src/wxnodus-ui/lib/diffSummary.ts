// src/wxnodus-ui/lib/diffSummary.ts — 阶段 6：修改分区数据投影（纯函数）
// 输入：streamSegments 中的 diff 段（pushInlineDiffSegment 产出的 ```diff 块）。
// 输出：按文件聚合的 +A/-D 摘要（参考 Aider 的一行式变更摘要 + Claude Code 的 per-file 统计）。
import type { Msg } from '../types.js'

export interface DiffFileSummary {
  path: string
  added: number
  removed: number
  /** 该文件的 diff 正文（展开用，含换行） */
  body: string
}

export interface DiffSummary {
  files: DiffFileSummary[]
  added: number
  removed: number
}

/** 摘掉 ```diff 围栏（也接受 ```patch 或裸正文——宽容读取，绝不吞内容）。 */
const stripFence = (text: string): string => {
  const trimmed = text.trim()

  if (/^```(?:diff|patch)\b/.test(trimmed)) {
    return trimmed
      .replace(/^```(?:diff|patch)[^\n]*\n/, '')
      .replace(/\n```\s*$/, '')
  }

  return trimmed
}

const PATH_RE = /^\+\+\+ b\/(.+)$|^--- a\/(.+)$/

const mergeFile = (files: DiffFileSummary[], next: Omit<DiffFileSummary, 'body'> & { body: string }) => {
  const existing = files.find(f => f.path === next.path)

  if (!existing) {
    return [...files, next]
  }

  return files.map(f =>
    f.path === next.path
      ? {
          ...f,
          added: f.added + next.added,
          removed: f.removed + next.removed,
          body: `${f.body}\n${next.body}`
        }
      : f
  )
}

export const diffSummary = (segments: readonly Msg[]): DiffSummary => {
  let files: DiffFileSummary[] = []

  for (const msg of segments) {
    if (msg.kind !== 'diff') {
      continue
    }

    const body = stripFence(msg.text)

    if (!body) {
      continue
    }

    let path = ''
    let added = 0
    let removed = 0

    for (const line of body.split('\n')) {
      const m = PATH_RE.exec(line)

      if (m) {
        path = (m[1] ?? m[2])!.trim()

        continue
      }

      if (line.startsWith('+++') || line.startsWith('---')) {
        continue
      }

      if (line.startsWith('+')) {
        added += 1
      } else if (line.startsWith('-')) {
        removed += 1
      }
    }

    if (!path) {
      continue
    }

    files = mergeFile(files, { path, added, removed, body })
  }

  return {
    files,
    added: files.reduce((sum, f) => sum + f.added, 0),
    removed: files.reduce((sum, f) => sum + f.removed, 0)
  }
}

/** 修改分区摘要文案：`修改 2 个文件 · +12 -3`（Aider 低噪声风格）。 */
export const changesLabel = (s: DiffSummary): string => {
  if (!s.files.length) {
    return ''
  }

  return `修改 ${s.files.length} 个文件 · +${s.added} -${s.removed}`
}

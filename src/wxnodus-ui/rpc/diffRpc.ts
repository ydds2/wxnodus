// src/wxnodus-ui/rpc/diffRpc.ts — C-02 拆分：diff 三 RPC（diffView/diffRevert/diffMark）
// 2026-08-19 从 wxGateway 提取（2628 行减负）——纯无状态方法（仅 dataDir/cwd），
// 结构类型子集（不 import wxGateway——避免环）；dispatch 薄壳保留在网关。
export interface DiffRpcKernel { dataDir: string; cwd: string }

/** 交互式 diff 查看：turn 源结构化视图——快照基线 + 当前 + 渲染行 + hunk 数；
 * 无 file 参数 = 全文件集聚合视图（文件分节 + 分节元数据 + ✓ 审阅标记） */
export async function diffViewRpc(kernel: DiffRpcKernel, params: Record<string, unknown>): Promise<unknown> {
  const file = String(params.file ?? '').trim()
  const { existsSync, readFileSync } = await import('node:fs')
  const { lineDiff, parseHunks } = await import('../../kernel/hunkApply.js')
  const { versionsOfFile, listShadows } = await import('../../kernel/undoShadows.js')
  const { loadDiffReviewed, hunkFingerprint } = await import('../../kernel/diffReviewed.js')
  const { resolve } = await import('node:path')
  const reviewed = loadDiffReviewed(kernel.dataDir)
  const cwd = kernel.cwd

  const targets: Array<{ abs: string; rel: string; base: string }> = []
  if (file) {
    const abs = resolve(cwd, file)
    if (!existsSync(abs)) return { ok: false, error: `文件不存在：${file}` }
    const versions = versionsOfFile(kernel.dataDir, abs)
    if (!versions.length) return { ok: false, error: '该文件无编辑快照（turn 源需先经 fs_edit/fs_write 编辑过；git 源请用 /diff <文件> git）' }
    targets.push({ abs, rel: file, base: versions[0]!.content })
  } else {
    const norm = (p: string) => p.replace(/\\/g, '/')
    const cwdNorm = norm(cwd)
    const latest = new Map<string, { content: string; ts: number }>()
    for (const s of listShadows(kernel.dataDir)) {
      if (!norm(s.path).startsWith(cwdNorm + '/')) continue
      const prev = latest.get(s.path)
      if (!prev || s.ts > prev.ts) latest.set(s.path, { content: s.content, ts: s.ts })
    }
    for (const [path, base] of latest) {
      if (!existsSync(path)) continue
      targets.push({ abs: path, rel: norm(path).startsWith(cwdNorm + '/') ? norm(path).slice(cwdNorm.length + 1) : path, base: base.content })
    }
    targets.sort((a, b) => a.rel.localeCompare(b.rel))
    if (!targets.length) return { ok: false, error: '无会话编辑快照——turn 源需要先经 fs_edit/fs_write 编辑过（git 源可用 /diff <文件> git）' }
  }

  const lines: string[] = []
  const sections: Array<{ abs: string; rel: string; hunks: number; start: number; end: number }> = []
  let changedFiles = 0
  for (const t of targets) {
    let cur = ''
    try { cur = readFileSync(t.abs, 'utf8') } catch { continue }
    const d = lineDiff(t.base, cur)
    if (!d) continue
    const hunks = parseHunks(d)
    const start = lines.length
    lines.push(`▶ ${t.rel}（${hunks.length} hunk${hunks.length > 1 ? 's' : ''}）`, '')
    for (const h of hunks) {
      const mark = reviewed.marks[t.abs]?.[hunkFingerprint(h)] ? '  ✓' : ''
      lines.push(h.header + mark)
      for (const l of h.lines) lines.push((l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') + l.text)
    }
    sections.push({ abs: t.abs, rel: t.rel, hunks: hunks.length, start, end: lines.length })
    changedFiles++
  }
  if (!changedFiles) return { ok: false, error: '会话内编辑过的文件与当前无差异（或已被还原）' }

  return {
    ok: true,
    aggregate: !file,
    file: file || undefined,
    changedFiles,
    sections: sections.map(s => ({ abs: s.abs, rel: s.rel, hunks: s.hunks, start: s.start, end: s.end })),
    lines,
  }
}

/** 交互式逐 hunk 回滚（无状态：基线=最新快照、当前=磁盘——每次重算，序号即序数） */
export async function diffRevertRpc(kernel: DiffRpcKernel, params: Record<string, unknown>): Promise<unknown> {
  const file = String(params.file ?? '').trim()
  const hunkIndex = Number(params.hunk_index ?? NaN)
  if (!Number.isInteger(hunkIndex) || hunkIndex < 1) return { ok: false, error: 'hunk 序号非法' }
  const { existsSync, readFileSync, writeFileSync } = await import('node:fs')
  if (!file || !existsSync(file)) return { ok: false, error: `文件不存在：${file}` }
  const { lineDiff, parseHunks, applyHunkToText, reverseHunk } = await import('../../kernel/hunkApply.js')
  const { versionsOfFile, snapshotFile } = await import('../../kernel/undoShadows.js')
  const versions = versionsOfFile(kernel.dataDir, file)
  if (!versions.length) return { ok: false, error: '无快照可回滚' }
  const cur = readFileSync(file, 'utf8')
  const hunks = parseHunks(lineDiff(versions[0]!.content, cur))
  const h = hunks[hunkIndex - 1]
  if (!h) return { ok: false, error: `hunk ${hunkIndex} 不存在（共 ${hunks.length} 个）` }
  const r = applyHunkToText(cur, reverseHunk(h))
  if (!r.ok) return { ok: false, error: `回滚失败：${r.error}` }
  snapshotFile(kernel.dataDir, file, cur)
  writeFileSync(file, r.text, 'utf8')
  return { ok: true, output: `已回滚 hunk ${hunkIndex}/${hunks.length}（快照已留存，/undo fs restore 可再滚回）` }
}

/** mark-reviewed：逐 hunk 审阅标记——内容指纹持久化（变更即失效，不跟随漂移） */
export async function diffMarkRpc(kernel: DiffRpcKernel, params: Record<string, unknown>): Promise<unknown> {
  const file = String(params.file ?? '').trim()
  const hunkIndex = Number(params.hunk_index ?? NaN)
  if (!Number.isInteger(hunkIndex) || hunkIndex < 1) return { ok: false, error: 'hunk 序号非法' }
  const { existsSync, readFileSync } = await import('node:fs')
  if (!file || !existsSync(file)) return { ok: false, error: `文件不存在：${file}` }
  const { lineDiff, parseHunks } = await import('../../kernel/hunkApply.js')
  const { versionsOfFile } = await import('../../kernel/undoShadows.js')
  const { markHunkReviewed, hunkFingerprint } = await import('../../kernel/diffReviewed.js')
  const versions = versionsOfFile(kernel.dataDir, file)
  if (!versions.length) return { ok: false, error: '无快照（turn 源需先经 fs_edit/fs_write 编辑过）' }
  const hunks = parseHunks(lineDiff(versions[0]!.content, readFileSync(file, 'utf8')))
  const h = hunks[hunkIndex - 1]
  if (!h) return { ok: false, error: `hunk ${hunkIndex} 不存在（共 ${hunks.length} 个）` }
  markHunkReviewed(kernel.dataDir, file, hunkFingerprint(h))
  return { ok: true, output: `已标记审阅 hunk ${hunkIndex}/${hunks.length}` }
}

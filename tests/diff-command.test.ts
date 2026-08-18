// tests/diff-command.test.ts — 波 3 ③ 7→8：/diff 快照对比 + per-hunk 应用（六家皆无差异化）
import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCommandBus } from '../src/app/CommandBus.js'
import { registerSessionCommands } from '../src/commands/ext/sessionCommands.js'
import { snapshotFile } from '../src/kernel/undoShadows.js'

const dir = mkdtempSync(join(tmpdir(), 'wxn-diffcmd-'))
const dataDir = join(dir, 'data')
mkdirSync(dataDir, { recursive: true })

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('/diff 快照对比 + per-hunk 应用', () => {
  it('快照→当前差异可见；revert <序号> 只回滚选中的 hunk（其余变更保留）', async () => {
    const f = join(dir, 'f.txt')
    writeFileSync(f, 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11\n', 'utf8')
    // 快照 = 原内容；当前 = 两处修改（line2、line10）
    snapshotFile(dataDir, f, readFileSync(f, 'utf8'))
    const cur = 'line1\nline2X\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10Y\nline11\n'
    writeFileSync(f, cur, 'utf8')

    const bus = createCommandBus()
    registerSessionCommands(bus as any, { cwd: dir, dataDir, config: { get: () => ({}), getKey: () => undefined, setKey: () => undefined }, db: undefined, bus: bus as any, agent: { getSessionId: () => 's' } } as any)

    const d = await (bus as any).execute('/diff f.txt')
    expect(d.output).toContain('-line2')
    expect(d.output).toContain('+line2X')
    expect(d.output).toContain('+line10Y')

    // 只回滚第 1 个 hunk（line2 变更恢复为快照）——line10 的变更不动
    const r = await (bus as any).execute('/diff f.txt revert 1')
    expect(r.output).toContain('已回滚 hunk 1/2')
    const after = readFileSync(f, 'utf8')
    expect(after).toContain('line2\n') // hunk1 回滚生效（恢复原 line2）
    expect(after).not.toContain('line2X')
    expect(after).toContain('line10Y') // hunk2 未动

    // 越界 hunk 诚实报错
    const bad = await (bus as any).execute('/diff f.txt revert 9')
    expect(bad.output).toContain('不存在')
  })
})

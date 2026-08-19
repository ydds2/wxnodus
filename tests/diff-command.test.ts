// tests/diff-command.test.ts — 波 3 ③ 7→8：/diff 快照对比 + per-hunk 应用（六家皆无差异化）
// P3 评估轮：三源扩展（opencode diff-viewer.tsx:46 git|branch|last-turn 对标）——git/branch 源真实 git 仓库集成
import { describe, expect, it, afterAll, beforeAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
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

// P3 评估轮：git/branch 三源（真实 git 仓库；git 不可用则整块跳过）
const gitOk = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0
describe.skipIf(!gitOk)('/diff git 三源（opencode DiffMode 对标）', () => {
  const gdir = mkdtempSync(join(tmpdir(), 'wxn-gitdiff-'))
  const file = join(gdir, 'g.txt')
  const bus = createCommandBus()
  const ctx = { cwd: gdir, dataDir: join(gdir, 'data'), config: { get: () => ({}), getKey: () => undefined, setKey: () => undefined }, db: undefined, bus: bus as any, agent: { getSessionId: () => 's' } } as any

  beforeAll(() => {
    mkdirSync(join(gdir, 'data'), { recursive: true })
    spawnSync('git', ['init', '-b', 'master'], { cwd: gdir, encoding: 'utf8' })
    spawnSync('git', ['config', 'user.email', 't@t'], { cwd: gdir })
    spawnSync('git', ['config', 'user.name', 't'], { cwd: gdir })
    writeFileSync(file, 'v1\nv2\n', 'utf8')
    spawnSync('git', ['add', '.'], { cwd: gdir })
    spawnSync('git', ['commit', '-m', 'base'], { cwd: gdir, encoding: 'utf8' })
    registerSessionCommands(bus as any, ctx)
  })
  afterAll(() => rmSync(gdir, { recursive: true, force: true }))

  it('git 源：工作区 vs HEAD 可见未提交改动；无改动诚实报无差异', async () => {
    writeFileSync(file, 'v1\nv2X\n', 'utf8')
    const d = await (bus as any).execute('/diff g.txt git')
    expect(d.output).toContain('工作区 → HEAD')
    expect(d.output).toContain('-v2')
    expect(d.output).toContain('+v2X')
    writeFileSync(file, 'v1\nv2\n', 'utf8')
    const none = await (bus as any).execute('/diff g.txt git')
    expect(none.output).toContain('无差异')
  })

  it('branch 源：工作区 vs 指定分支 merge-base；缺分支名/非法分支名诚实报错', async () => {
    spawnSync('git', ['checkout', '-b', 'other'], { cwd: gdir, encoding: 'utf8' })
    writeFileSync(file, 'v1\nv2-other\n', 'utf8')
    spawnSync('git', ['commit', '-am', 'other'], { cwd: gdir, encoding: 'utf8' })
    spawnSync('git', ['checkout', 'master'], { cwd: gdir, encoding: 'utf8' })
    writeFileSync(file, 'v1\nv2-master\n', 'utf8')
    const d = await (bus as any).execute('/diff g.txt branch other')
    expect(d.output).toContain('分支 other')
    expect(d.output).toContain('v2-master')
    const missing = await (bus as any).execute('/diff g.txt branch')
    expect(missing.output).toContain('用法')
    const bad = await (bus as any).execute('/diff g.txt branch "x y"')
    expect(bad.output).toContain('分支名非法')
  })

  it('branch 源 merge-base 语义：目标分支自身新提交不混入（opencode vcs.ts:373 对标）', async () => {
    // 状态自包含：丢弃前一用例遗留的未提交改动
    spawnSync('git', ['checkout', '--', 'g.txt'], { cwd: gdir, encoding: 'utf8' })
    // other 分支再前进一个提交；master 工作区相对 merge-base 的 diff 不受 other 新提交影响
    spawnSync('git', ['checkout', 'other'], { cwd: gdir, encoding: 'utf8' })
    writeFileSync(file, 'v1\nv2-other2\n', 'utf8')
    spawnSync('git', ['commit', '-am', 'other2'], { cwd: gdir, encoding: 'utf8' })
    spawnSync('git', ['checkout', 'master'], { cwd: gdir, encoding: 'utf8' })
    writeFileSync(file, 'v1\nv2-master\n', 'utf8')
    const d = await (bus as any).execute('/diff g.txt branch other')
    expect(d.output).toContain('共同祖先')
    expect(d.output).toContain('v2-master')
    expect(d.output).not.toContain('v2-other2')
    // 恢复干净工作区（后续用例不继承）
    spawnSync('git', ['checkout', '--', 'g.txt'], { cwd: gdir, encoding: 'utf8' })
  })

  it('非 git 仓库诚实报错', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'wxn-nogit-'))
    mkdirSync(join(plain, 'data'), { recursive: true })
    writeFileSync(join(plain, 'p.txt'), 'x', 'utf8')
    const plainBus = createCommandBus()
    registerSessionCommands(plainBus as any, { cwd: plain, dataDir: join(plain, 'data'), config: { get: () => ({}), getKey: () => undefined, setKey: () => undefined }, db: undefined, bus: plainBus as any, agent: { getSessionId: () => 's' } } as any)
    const r = await (plainBus as any).execute('/diff p.txt git')
    expect(r.output).toContain('不是 git 仓库')
    rmSync(plain, { recursive: true, force: true })
  })
})

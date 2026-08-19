// tests/workspace-rpc.test.ts — P1 工作台：status/doctor 结构化数据构建 + adapter 体检端口契约
import { describe, expect, it } from 'vitest'
import { buildWorkspaceDoctor, buildWorkspaceStatus, nextWorkspaceKind, type WorkspaceRpcKernel } from '../src/wxnodus-ui/rpc/workspaceRpc.js'
import { createTuiPresentationAdapter, type TuiDoctorRow } from '../src/presentation/tui/tuiPresentationAdapter.js'

const makeDb = (overrides: { integrity?: string; throwOn?: string } = {}) => ({
  prepare: (sql: string) => {
    if (overrides.throwOn && sql.includes(overrides.throwOn)) {
      throw new Error('db broken')
    }
    return {
      get: () => {
        if (sql.includes('integrity_check')) return { integrity_check: overrides.integrity ?? 'ok' }
        if (sql.includes('messages_fts')) return { c: 42 }
        if (sql.includes('archived')) return { c: 3 }
        return { c: 10 }
      },
      all: () => [],
      run: () => ({ changes: 0 })
    }
  }
})

describe('buildWorkspaceStatus（内核端口侧 status 行）', () => {
  const kernel: WorkspaceRpcKernel = {
    settings: { model: 'deepseek-v4-pro', mode: 'smart' },
    cwd: 'C:\\dev\\shop',
    config: { get: () => ({ providers: [], activeProvider: null, balanceMonitor: {} }) },
    adapter: { data: { sessions: { list: () => [{ id: 'a' }, { id: 'b' }] }, doctor: () => [] } }
  }

  it('分节含会话/模型与目录/环境，行值真实来自端口', () => {
    const d = buildWorkspaceStatus(kernel, { commandCount: 47, skillCount: 3 })
    expect(d.sections.map(s => s.label)).toEqual(['会话', '模型与目录', '环境'])
    const rows = d.sections.flatMap(s => s.rows)
    expect(rows).toContainEqual({ k: '模型', v: 'deepseek-v4-pro', tone: 'ok' })
    expect(rows).toContainEqual({ k: '目录', v: 'C:\\dev\\shop', tone: 'ok' })
    expect(rows).toContainEqual({ k: '会话', v: '2 个（Ctrl+X 浏览/恢复）', tone: 'ok' })
    expect(rows).toContainEqual({ k: '命令', v: '47 个（/help 全目录）', tone: 'ok' })
    expect(rows).toContainEqual({ k: '技能', v: '3 个（/skills 管理）', tone: 'ok' })
    expect(rows).toContainEqual({ k: '后台活动', v: '无', tone: 'muted' })
  })

  it('未配置模型如实 muted 提示（不假装已配置）', () => {
    const d = buildWorkspaceStatus({ ...kernel, settings: {} }, { commandCount: 0, skillCount: 0 })
    const rows = d.sections.flatMap(s => s.rows)
    expect(rows).toContainEqual({ k: '模型', v: '未配置（/model set-key <密钥>）', tone: 'muted' })
  })
})

describe('buildWorkspaceDoctor（adapter 体检行透传）', () => {
  it('sections 单节 + 行透传；端口失败诚实降级', () => {
    const ok = buildWorkspaceDoctor({ adapter: { data: { doctor: () => [{ label: '数据库', value: '正常', tone: 'ok' }], sessions: { list: () => [] } } } } as unknown as WorkspaceRpcKernel)
    expect(ok.sections[0]!.rows).toEqual([{ label: '数据库', value: '正常', tone: 'ok' }])

    const bad = buildWorkspaceDoctor({ adapter: { data: { doctor: () => { throw new Error('x') }, sessions: { list: () => [] } } } } as unknown as WorkspaceRpcKernel)
    expect(bad.sections[0]!.rows[0]!.tone).toBe('bad')
  })
})

describe('nextWorkspaceKind', () => {
  it('三标签循环：status → doctor → sessions → status', () => {
    expect(nextWorkspaceKind('status')).toBe('doctor')
    expect(nextWorkspaceKind('doctor')).toBe('sessions')
    expect(nextWorkspaceKind('sessions')).toBe('status')
  })
})

describe('adapter.data.doctor()（真实体检端口）', () => {
  it('正常库 → 全部检查项 ok/muted 语义', () => {
    const adapter = createTuiPresentationAdapter({ db: makeDb(), agent: {} as never, settings: { model: 'glm-4.6' }, dataDir: 'C:\\data' })
    const rows: TuiDoctorRow[] = adapter.data.doctor()
    const labels = rows.map(r => r.label)
    expect(labels).toEqual(['配置中心', '数据库', '黑洞记忆', '全文索引', '模型密钥', '当前模型'])
    expect(rows.find(r => r.label === '数据库')).toMatchObject({ value: '正常', tone: 'ok' })
    expect(rows.find(r => r.label === '黑洞记忆')).toMatchObject({ value: '10 条（其中 3 条已归档压缩，仍可检索）' })
    expect(rows.find(r => r.label === '全文索引')).toMatchObject({ value: '42 条可检索', tone: 'ok' })
    expect(rows.find(r => r.label === '当前模型')).toMatchObject({ value: 'glm-4.6', tone: 'ok' })
  })

  it('数据库完整性异常 → bad 如实上报', () => {
    const adapter = createTuiPresentationAdapter({ db: makeDb({ integrity: 'row 12 missing' }), agent: {} as never, settings: {} })
    const rows = adapter.data.doctor()
    expect(rows.find(r => r.label === '数据库')).toMatchObject({ value: '异常（row 12 missing）', tone: 'bad' })
  })

  it('检查项执行失败 → bad 降级（不抛穿）', () => {
    const adapter = createTuiPresentationAdapter({ db: makeDb({ throwOn: 'messages_fts' }), agent: {} as never, settings: {} })
    const rows = adapter.data.doctor()
    expect(rows.find(r => r.label === '全文索引')).toMatchObject({ value: '未初始化', tone: 'muted' })
  })
})

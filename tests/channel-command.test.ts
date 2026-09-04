// tests/channel-command.test.ts — /channel 更新渠道命令契约（2026-09-04 · P3a）
// 锁定：registry 三表；切换持久化（settings.updateChannel）；无 feed 诚实；feed 双渠道渲染。
import { describe, it, expect, vi } from 'vitest'
import { createCommandBus } from '../src/app/CommandBus.js'
import { registerCoreHandlers } from '../src/commands/handlers.js'
import { SLASH, COMMAND_DESC, COMMAND_CAT } from '../src/commands/registry.js'

vi.mock('../src/kernel/selfUpdate.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/kernel/selfUpdate.js')>()
  return {
    ...orig,
    fetchLatestRelease: vi.fn(async (_feed: string, _cur: string, _f: unknown, _t: number, channel: string) => ({
      updateAvailable: true,
      latest: channel === 'snapshot' ? '4.1.0-snapshot.20260904' : '4.0.3',
      downloadUrl: null, sha256: null,
      notes: `版本清单渠道 ${channel} · 共 2 版本`,
    })),
  }
})

const makeBus = (settings: Record<string, unknown> = {}) => {
  const bus = createCommandBus()
  const saved: Array<[string, string]> = []
  const box = { ...settings }
  const ctx = {
    cwd: process.cwd(),
    db: { prepare: () => ({ run: () => {}, all: () => [] }) },
    config: {
      get: () => ({}),
      getKey: (ns: string, key: string) => (ns === 'settings' ? box[key] : undefined),
      setKey: (ns: string, key: string, value: string) => { if (ns === 'settings') { box[key] = value; saved.push([key, value]) } },
    },
  } as any
  registerCoreHandlers(bus, ctx)
  return { bus, box, saved }
}

describe('/channel 更新渠道（我的世界式版本列车）', () => {
  it('registry 三表注册', () => {
    expect(SLASH).toContain('/channel')
    expect(COMMAND_DESC['/channel']).toContain('渠道')
    expect(COMMAND_CAT['/channel']).toBe('⚙')
  })

  it('切换：/channel snapshot 持久化 settings.updateChannel；release 同', async () => {
    const { bus, box, saved } = makeBus()
    const r = (await bus.execute('/channel snapshot')).output
    expect(r).toContain('已切换')
    expect(r).toContain('snapshot')
    expect(box.updateChannel).toBe('snapshot')
    expect(saved).toEqual([['updateChannel', 'snapshot']])
    await bus.execute('/channel release')
    expect(box.updateChannel).toBe('release')
  })

  it('无 feed：诚实报未配置 + 用法指引', async () => {
    const { bus } = makeBus()
    const r = (await bus.execute('/channel')).output
    expect(r).toContain('当前渠道：release（稳定）')
    expect(r).toContain('未配置')
  })

  it('feed 已配置：渲染双渠道最新版本（release/snapshot 各取各的）', async () => {
    const { bus } = makeBus({ updateFeed: 'https://feed/manifest.json', updateChannel: 'snapshot' })
    const r = (await bus.execute('/channel')).output
    expect(r).toContain('当前渠道：snapshot（快照）')
    expect(r).toContain('release 最新：4.0.3（可升级）')
    expect(r).toContain('snapshot 最新：4.1.0-snapshot.20260904（可升级）')
  })
})

// tests/version-manifest.test.ts — 版本清单与双渠道（2026-09-04 · P3a）契约
// 锁定：parseVersionManifest 严格校验（非法 fail-closed）；selectVersion 按渠道选择；
// fetchLatestRelease 识别清单形态并按 channel 返回对应版本/url/sha256。
import { describe, it, expect } from 'vitest'
import { parseVersionManifest, selectVersion } from '../src/kernel/versionManifest.js'
import { fetchLatestRelease } from '../src/kernel/selfUpdate.js'

const manifest = {
  latest: { release: '4.0.3', snapshot: '4.1.0-snapshot.20260904' },
  versions: [
    { id: '4.0.3', type: 'release', url: 'https://x/wxnodus-4.0.3.zip', sha256: 'a'.repeat(64) },
    { id: '4.1.0-snapshot.20260904', type: 'snapshot', url: 'https://x/wxnodus-4.1.0-snap.zip', sha256: 'b'.repeat(64) },
  ],
}

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body } as unknown as Response)

describe('parseVersionManifest（严格校验 fail-closed）', () => {
  it('合法清单解析', () => {
    const m = parseVersionManifest(manifest)
    expect(m?.versions).toHaveLength(2)
    expect(m?.latest.release).toBe('4.0.3')
  })
  it('非法形态 → null（缺 latest/versions/条目 id/type）', () => {
    expect(parseVersionManifest(null)).toBeNull()
    expect(parseVersionManifest({ latest: {} })).toBeNull()
    expect(parseVersionManifest({ latest: { release: '1', snapshot: '2' } })).toBeNull()
    expect(parseVersionManifest({ latest: { release: '1', snapshot: '2' }, versions: [{ id: 'x' }] })).toBeNull()
    expect(parseVersionManifest({ latest: { release: '1', snapshot: '2' }, versions: [{ id: 'x', type: 'dev' }] })).toBeNull()
  })
})

describe('selectVersion（渠道选择）', () => {
  it('release 渠道取 latest.release 条目；snapshot 取快照条目', () => {
    const m = parseVersionManifest(manifest)!
    expect(selectVersion(m, 'release').entry?.id).toBe('4.0.3')
    expect(selectVersion(m, 'snapshot').entry?.id).toBe('4.1.0-snapshot.20260904')
  })
  it('latest 指向的条目缺失 → 诚实 null + 不一致说明', () => {
    const m = parseVersionManifest({ latest: { release: '9.9.9', snapshot: '1.0.0' }, versions: [{ id: '1.0.0', type: 'release' }] })!
    const sel = selectVersion(m, 'release')
    expect(sel.entry).toBeNull()
    expect(sel.notes).toContain('不存在')
  })
})

describe('fetchLatestRelease 清单形态（C）+ 渠道', () => {
  it('release 渠道：updateAvailable 按 isNewer、url/sha256 取自条目', async () => {
    const info = await fetchLatestRelease('https://feed/manifest.json', '4.0.2', () => Promise.resolve(okResponse(manifest)), 1000, 'release')
    expect(info.updateAvailable).toBe(true)
    expect(info.latest).toBe('4.0.3')
    expect(info.downloadUrl).toContain('4.0.3.zip')
    expect(info.sha256).toBe('a'.repeat(64))
    expect(info.notes).toContain('release')
  })
  it('snapshot 渠道：取快照版本（预发布字典序——4.1.0-snapshot > 4.0.2）', async () => {
    const info = await fetchLatestRelease('https://feed/manifest.json', '4.0.2', () => Promise.resolve(okResponse(manifest)), 1000, 'snapshot')
    expect(info.updateAvailable).toBe(true)
    expect(info.latest).toBe('4.1.0-snapshot.20260904')
    expect(info.downloadUrl).toContain('snap.zip')
  })
  it('旧双形态（A/B）不受渠道参数影响（向后兼容）', async () => {
    const info = await fetchLatestRelease('https://feed/v.json', '4.0.2', () => Promise.resolve(okResponse({ version: '4.0.5', url: 'https://x/z.zip' })), 1000, 'snapshot')
    expect(info.latest).toBe('4.0.5')
    expect(info.updateAvailable).toBe(true)
  })
  it('清单不一致（latest 条目缺失）→ 诚实不可用', async () => {
    const bad = { latest: { release: '9.9.9', snapshot: '1.0.0' }, versions: [{ id: '1.0.0', type: 'release' }] }
    const info = await fetchLatestRelease('https://feed/m.json', '4.0.2', () => Promise.resolve(okResponse(bad)), 1000, 'release')
    expect(info.updateAvailable).toBe(false)
    expect(info.notes).toContain('不存在')
  })
})

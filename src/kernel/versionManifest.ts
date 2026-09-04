// src/kernel/versionManifest.ts — 版本清单与双渠道选择（2026-09-04 · P3a）
// 我的世界 version_manifest 语义：官方 feed 根 { latest:{release,snapshot}, versions:[{id,type,url,sha256,minNode}] }。
// 严格校验（非法 → null fail-closed）；渠道选择 release（稳定，默认）/ snapshot（快照——正式版=快照冻结）。
export interface ManifestEntry {
  id: string
  type: 'release' | 'snapshot'
  url?: string
  sha256?: string
  minNode?: string
}

export interface VersionManifest {
  latest: { release: string; snapshot: string }
  versions: ManifestEntry[]
}

export function parseVersionManifest(raw: unknown): VersionManifest | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const latest = o.latest as Record<string, unknown> | undefined
  if (!latest || typeof latest.release !== 'string' || typeof latest.snapshot !== 'string') return null
  if (!Array.isArray(o.versions)) return null
  const versions: ManifestEntry[] = []
  for (const v of o.versions) {
    if (!v || typeof v !== 'object') return null
    const e = v as Record<string, unknown>
    if (typeof e.id !== 'string' || (e.type !== 'release' && e.type !== 'snapshot')) return null
    versions.push({
      id: e.id,
      type: e.type,
      ...(typeof e.url === 'string' ? { url: e.url } : {}),
      ...(typeof e.sha256 === 'string' ? { sha256: e.sha256 } : {}),
      ...(typeof e.minNode === 'string' ? { minNode: e.minNode } : {}),
    })
  }
  return { latest: { release: latest.release, snapshot: latest.snapshot }, versions }
}

export type UpdateChannel = 'release' | 'snapshot'

export interface ChannelSelection {
  channel: UpdateChannel
  latest: string | null
  entry: ManifestEntry | null
  notes: string
}

/** 按渠道从清单选择目标版本（isNewer 判定由调用方做——本函数只做清单内选择；latest 指向的条目缺失 → 诚实 null） */
export function selectVersion(m: VersionManifest, channel: UpdateChannel): ChannelSelection {
  const latest = m.latest[channel]
  const entry = m.versions.find(v => v.id === latest) ?? null
  return {
    channel,
    latest,
    entry,
    notes: entry
      ? `版本清单渠道 ${channel} · 共 ${m.versions.length} 版本`
      : `清单 latest.${channel}「${latest}」在 versions 中不存在（清单不一致——诚实不选）`,
  }
}

/** 渠道标签（命令/展示共用单一事实源） */
export const channelLabel = (channel: UpdateChannel): string => (channel === 'snapshot' ? 'snapshot（快照——正式版=快照冻结）' : 'release（稳定）')

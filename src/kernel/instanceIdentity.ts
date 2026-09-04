// src/kernel/instanceIdentity.ts — 实例身份（「网络下载后独一无二」T77）
// 用户需求：wxnodus 经过网络下载后，每一份都成为独一无二的产品。
// 落地：首次启动在 dataDir 生成一次性 instanceId（crypto.randomUUID——离线随机，
// 绝不联网登记），并确定性派生人类可读的「实例代号」（形容词·名词 序列号，源自
// instanceId 哈希——同 id 必得同代号，跨重启稳定）。/brand 是用户手工命名层，
// 实例身份是自动层：未手工命名前，TUI 品牌行/欢迎语/SDK 握手都以代号示人。
// 原子落盘（tmp+rename，Windows rename 覆盖竞态回读收口）；损坏文件诚实重生成。
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface InstanceIdentity {
  /** 格式版本（新增可选字段=兼容） */
  v: 1
  /** 一次性随机 UUID（实例唯一标识——SDK 握手/审计锚点） */
  instanceId: string
  /** 人类可读实例代号（确定性派生——「深空·织网者 7F3A」式） */
  codename: string
  /** 序列短码（哈希前 2 字节大写十六进制——代号的记忆锚） */
  serial: string
  /** 首次生成时刻（epoch ms） */
  createdAt: number
}

// 词表：16×16 = 256 组合 × 65536 序列——观感空间足够；2026-09-03 用户裁决：代号全英文（ASCII）
// 终端全字形安全（旧 conhost/ASCII 档不产生豆腐），国际场景零歧义。
const ADJECTIVES = [
  'Silent', 'Deep', 'Dusk', 'Blueshift', 'Solo', 'Distant', 'Lucent', 'Tidal',
  'Astral', 'Snowfall', 'Nightwatch', 'Candlelit', 'Rainy', 'Sunward', 'Windborne', 'Moonlit',
] as const
const NOUNS = [
  'Weaver', 'Navigator', 'Watcher', 'Maker', 'Riddler', 'Surveyor', 'Strategist', 'Beacon',
  'Stardust', 'Artisan', 'Ferryman', 'Operator', 'Horologist', 'Librarian', 'Cartographer', 'Tuner',
] as const

/** 从 instanceId 确定性派生代号与序列（纯函数——可单测；全 ASCII：形容词-名词 + 4 位大写十六进制） */
export function deriveCodename(instanceId: string): { codename: string; serial: string } {
  const h = createHash('sha256').update(instanceId, 'utf8').digest()
  const adj = ADJECTIVES[h[0]! % ADJECTIVES.length]!
  const noun = NOUNS[h[1]! % NOUNS.length]!
  const serial = h.subarray(2, 4).toString('hex').toUpperCase()
  return { codename: `${adj}-${noun} ${serial}`, serial }
}

function isValid(raw: unknown): raw is InstanceIdentity {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>
  return o.v === 1 && typeof o.instanceId === 'string' && o.instanceId.length >= 32
    && typeof o.codename === 'string' && o.codename.length > 0
    && typeof o.serial === 'string' && typeof o.createdAt === 'number'
}

const idFile = (dataDir: string) => join(dataDir, 'instance.json')

function generate(now: number): InstanceIdentity {
  const instanceId = randomUUID()
  const { codename, serial } = deriveCodename(instanceId)
  return { v: 1, instanceId, codename, serial, createdAt: now }
}

/**
 * 读取/生成本机实例身份（幂等——同 dataDir 落盘文件为唯一事实源，每次调用直读）。
 * 首启生成；已存在则原样返回（身份跨重启/升级稳定——「独一无二」一旦确立不再漂移）。
 * 损坏/不完整文件 → 重生成覆盖（诚实重建，不假装可读）。
 */
export function ensureInstanceIdentity(dataDir: string, opts: { now?: number } = {}): InstanceIdentity {
  const file = idFile(dataDir)
  const read = (): InstanceIdentity | null => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return isValid(parsed) ? parsed : null
    } catch { return null }
  }
  const existing = read()
  if (existing) {
    // 2026-09-03 用户裁决：代号全英文——存量中文代号一次性迁移（instanceId 恒稳定，
    // 显示层代号/serial 自洽重派生；迁移落盘失败本次仍返回英文代号，下次启动再试）
    if (/[^\x20-\x7E]/.test(existing.codename)) {
      const { codename, serial } = deriveCodename(existing.instanceId)
      const migrated = { ...existing, codename, serial }
      try { writeFileSync(file, JSON.stringify(migrated, null, 2) + '\n', 'utf8') } catch { /* 迁移落盘失败不阻断启动 */ }
      return migrated
    }
    return existing
  }
  const fresh = generate(opts.now ?? Date.now())
  try {
    // 原子写：tmp + rename（并发首启只有一份胜出；输家在 rename 异常时回读胜者）
    const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
    writeFileSync(tmp, JSON.stringify(fresh, null, 2) + '\n', 'utf8')
    try {
      renameSync(tmp, file)
    } catch {
      if (!existsSync(file)) throw new Error(`instance.json 落盘失败：${file}`)
      // Windows rename 不覆盖：他人已胜出——回读对方的身份（身份一致性优先于首创权）
      const winner = read()
      if (winner) return winner
      throw new Error('instance.json 竞态胜者不可读')
    }
  } catch {
    // 落盘失败（只读目录等）：身份仍返回（本次进程内可用），下次启动再试落盘——诚实降级
    return fresh
  }
  return fresh
}

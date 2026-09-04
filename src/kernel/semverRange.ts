// src/kernel/semverRange.ts — 版本范围匹配（2026-09-03 · P3b）
// Minecraft modpack targetWxnodus 兼容矩阵语义：">=4.0.2 <5"、"4.0.x"、"^4.0.0"、"~4.0.2"、"*"、精确版本。
// 纯函数零依赖；非法输入一律 false（fail-closed——绝不让不兼容包带病安装）。
export function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v).trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)]
}

const cmp = (a: number[], b: number[]): number => {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1
  }
  return 0
}

/** 单 token 匹配（comparator/通配/精确） */
function matchToken(version: number[], token: string): boolean {
  const t = token.trim()
  if (t === '*' || t === '') return true
  const m = /^(>=|<=|>|<|=|\^|~)?\s*v?(\d+)(?:\.(\d+|\*|x))?(?:\.(\d+|\*|x))?$/.exec(t)
  if (!m) return false
  const op = m[1] ?? '='
  const parts = [m[2]!, m[3] ?? '0', m[4] ?? '0']
  // 通配：1.2.x → >=1.2.0 <1.3.0
  const wildIdx = parts.findIndex(p => p === '*' || p === 'x')
  if (wildIdx >= 0) {
    const lo = parts.map((p, i) => (i < wildIdx ? Number(p) : 0))
    const hi = parts.map((p, i) => (i < wildIdx ? Number(p) : 0))
    hi[wildIdx - 1] = hi[wildIdx - 1]! + 1
    return cmp(version, lo) >= 0 && cmp(version, hi) < 0
  }
  const target = parts.map(p => Number(p))
  switch (op) {
    case '>=': return cmp(version, target) >= 0
    case '<=': return cmp(version, target) <= 0
    case '>': return cmp(version, target) > 0
    case '<': return cmp(version, target) < 0
    case '=': return cmp(version, target) === 0
    case '^': { // 兼容主版本：>=target < 主版本+1（0.x 特殊：0.x.y 锁次版本）
      const hi = target[0]! > 0 ? [target[0]! + 1, 0, 0] : [0, target[1]! + 1, 0]
      return cmp(version, target) >= 0 && cmp(version, hi) < 0
    }
    case '~': { // 锁次版本：>=target < 次版本+1
      const hi = [target[0]!, target[1]! + 1, 0]
      return cmp(version, target) >= 0 && cmp(version, hi) < 0
    }
    default: return false
  }
}

/** 范围匹配：空白/逗号分隔多 token 取 AND（任一非法 token → false fail-closed） */
export function versionInRange(version: string, range: string): boolean {
  const v = parseVersion(version)
  if (!v) return false
  const tokens = String(range ?? '').split(/[\s,]+/).map(t => t.trim()).filter(Boolean)
  if (!tokens.length) return false
  return tokens.every(t => matchToken(v, t))
}

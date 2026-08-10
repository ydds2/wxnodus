import { useEffect } from 'react'

import type { BatteryInfo } from './interfaces.js'
import { patchUiState } from './uiStore.js'

// A7：电池轮询（参考 useBatteryPoll 同款）——30s 间隔读 system.battery RPC，
// 无电池/不可用时置 null（状态条自动隐藏该段）
const BATTERY_POLL_MS = 30_000

const CATEGORIES = new Set(['bad', 'critical', 'dim', 'good', 'warn'])

function toBatteryInfo(r: unknown): BatteryInfo | null {
  if (!r || typeof r !== 'object') {
    return null
  }

  const o = r as Record<string, unknown>
  const percent = typeof o.percent === 'number' && Number.isFinite(o.percent) ? Math.max(0, Math.min(100, Math.round(o.percent))) : null
  const category = typeof o.category === 'string' && CATEGORIES.has(o.category) ? (o.category as BatteryInfo['category']) : 'dim'

  return {
    available: Boolean(o.available),
    category,
    percent,
    plugged: typeof o.plugged === 'boolean' ? o.plugged : null,
  }
}

export function useBatteryPoll(gw: { request<T>(method: string, params?: Record<string, unknown>): Promise<T> } | null) {
  useEffect(() => {
    if (!gw) {
      return
    }

    let cancelled = false
    let timer: NodeJS.Timeout | null = null

    const poll = async () => {
      try {
        const r = await gw.request<unknown>('system.battery')
        if (!cancelled) {
          patchUiState({ battery: toBatteryInfo(r) })
        }
      } catch {
        if (!cancelled) {
          patchUiState({ battery: null })
        }
      } finally {
        if (!cancelled) {
          timer = setTimeout(poll, BATTERY_POLL_MS)
        }
      }
    }

    void poll()

    return () => {
      cancelled = true

      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [gw])
}

import { useEffect } from 'react'

import type { BalanceUi, UsageRangeKind, UsageRangeUi } from '../bridge/interfaces.js'
import type { GatewayClient } from '../gatewayClient.js'
import type { GatewayEvent } from '../gatewayTypes.js'
import { balanceSegmentLabel } from '../lib/balanceStatus.js'
import { getUiState, patchUiState } from '../runtime/viewStore.js'

// 状态栏余额/token 监控（💰/📊 两个独立段，各自独立配置）：
// - 余额：挂载即拉 + 5 分钟轮询。gateway 侧另有 60s 防抖与内核侧 5 分钟
//   磁盘 TTL——换会话不重复打厂商 API；点击段可强制刷新。
// - token 区间：挂载即拉 + 每次 message.complete 刷新（回合结算后跨会话
//   聚合实时可见，无需等轮询）。
// 失败诚实：拉取失败保留上次值并标 ⚠，首拉失败显示「拉取失败」占位。
const BALANCE_POLL_MS = 5 * 60_000

const RANGES: readonly UsageRangeKind[] = ['today', '7d', '30d']

const asObj = (raw: unknown): Record<string, unknown> | null =>
  !raw || typeof raw !== 'object' || Array.isArray(raw) ? null : (raw as Record<string, unknown>)

function toBalanceUi(raw: unknown, prev: BalanceUi | null): BalanceUi | null {
  const o = asObj(raw)
  if (!o || o.configured !== true) {
    // 未配置余额 URL（或 balance.monitor.enabled=false）→ 段自动隐藏
    return null
  }

  if (o.ok === false || typeof o.balance !== 'string' || !o.balance.trim()) {
    return prev
      ? { ...prev, stale: true, updatedAt: Date.now() }
      : { label: '💰⚠ 拉取失败', configured: true, stale: true, updatedAt: Date.now() }
  }

  return {
    label: balanceSegmentLabel({
      balance: o.balance,
      currency: typeof o.currency === 'string' ? o.currency : undefined
    }),
    configured: true,
    stale: false,
    updatedAt: Date.now()
  }
}

function toUsageRangeUi(raw: unknown): UsageRangeUi | null {
  const o = asObj(raw)
  if (!o) {
    return null
  }

  return {
    range: RANGES.includes(o.range as UsageRangeKind) ? (o.range as UsageRangeKind) : 'today',
    total: typeof o.total === 'number' ? Math.max(0, Math.round(o.total)) : 0,
    updatedAt: Date.now()
  }
}

/** 状态栏 💰 点击——强制刷新（绕过 60s 防抖与内核 TTL）。返回 RPC promise 供上层 sys 反馈。 */
export function refreshBalance(gw: GatewayClient): Promise<unknown> {
  return gw.request<unknown>('balance.status', { force: true }).then(raw => {
    patchUiState(state => ({ ...state, balance: toBalanceUi(raw, state.balance) }))
    return raw
  })
}

/** 状态栏 📊 点击——轮换区间 today → 7d → 30d（与 /usage range 同链路，服务端持久化）。 */
export function cycleUsageRange(gw: GatewayClient): Promise<unknown> {
  const current = getUiState().usageRange?.range ?? 'today'
  const i = RANGES.indexOf(current)
  const next = RANGES[(i + 1) % RANGES.length]!
  return gw.request<unknown>('usage.range.set', { range: next }).then(raw => {
    patchUiState({ usageRange: toUsageRangeUi(raw) })
    return raw
  })
}

export function useBalanceMonitor(gw: GatewayClient | null) {
  useEffect(() => {
    if (!gw) {
      return
    }

    let cancelled = false
    let timer: NodeJS.Timeout | null = null

    const fetchBalance = async (force = false) => {
      try {
        const raw = await gw.request<unknown>('balance.status', { force })
        if (!cancelled) {
          patchUiState(state => ({ ...state, balance: toBalanceUi(raw, state.balance) }))
        }
      } catch {
        if (!cancelled) {
          patchUiState(state =>
            state.balance ? { ...state, balance: { ...state.balance, stale: true, updatedAt: Date.now() } } : state
          )
        }
      }
    }

    const fetchUsageRange = async () => {
      try {
        const raw = await gw.request<unknown>('usage.range')
        if (!cancelled) {
          patchUiState({ usageRange: toUsageRangeUi(raw) })
        }
      } catch {
        // 静默——段自然隐藏，不打扰主流程
      }
    }

    // 回合结束即刷新 token 区间（message.complete 的 usage 已由 eventAdapter
    // 合入会话 usage；这里补跨会话聚合视图）。
    const onEvent = (ev: GatewayEvent) => {
      if (ev.type === 'message.complete') {
        void fetchUsageRange()
      }
    }

    const loop = () => {
      if (cancelled) {
        return
      }

      timer = setTimeout(() => {
        void fetchBalance().finally(loop)
      }, BALANCE_POLL_MS)
    }

    gw.on('event', onEvent)
    void fetchBalance()
    void fetchUsageRange()
    loop()

    return () => {
      cancelled = true
      gw.off('event', onEvent)
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [gw])
}

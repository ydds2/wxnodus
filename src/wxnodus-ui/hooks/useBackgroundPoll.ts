// src/wxnodus-ui/hooks/useBackgroundPoll.ts — A24 后台活动轮询
// 仿 useBatteryMonitor：5s 间隔读 `background.status` RPC（终端/任务/定时一次性快照），
// 写入 $bgState（后台面板 + 摘要行数据源）。goal 进度不经轮询——由 background.goal
// 事件即时更新（eventAdapter）。
import { useEffect } from 'react'

import type { GatewayClient } from '../gatewayClient.js'
import { patchBgState, type BgCron, type BgJob, type BgTerm } from '../runtime/backgroundStore.js'

const BACKGROUND_POLL_MS = 5000

const TERM_STATUS: Record<string, BgTerm['status']> = { running: 'running', exited: 'exited' }

export function useBackgroundPoll(gw: GatewayClient | null) {
  useEffect(() => {
    if (!gw) {
      return
    }

    let cancelled = false
    let timer: NodeJS.Timeout | null = null

    const poll = async () => {
      try {
        const r = (await gw.request<unknown>('background.status')) as {
          cron?: BgCron[]
          jobs?: BgJob[]
          terms?: BgTerm[]
        } | null

        if (!cancelled && r) {
          patchBgState({
            terms: (r.terms ?? []).map(t => ({ ...t, status: TERM_STATUS[t.status] ?? 'exited' })),
            jobs: (r.jobs ?? []).slice(0, 12),
            cron: (r.cron ?? []).slice(0, 12),
          })
        }
      } catch {
        // 后台状态读失败保持上次快照（不闪烁清空）
      } finally {
        if (!cancelled) {
          timer = setTimeout(poll, BACKGROUND_POLL_MS)
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

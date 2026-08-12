// src/wxnodus-ui/runtime/backgroundStore.ts — A24 后台活动状态（终端/任务/定时/目标循环）
// 数据源：gateway `background.status` RPC（5s 轮询——useBackgroundPoll）+ `background.goal`
// 事件（goal 进度即时更新）。全部只读展示，零假数据；未装配项按空列表。
import { createAtom as atom } from '../../app/stores/engine.js'
import { useSyncExternalStore } from 'react'

export interface BgTerm {
  cwd: string
  exitCode: number | null
  id: string
  shell: string
  startedAt: number
  status: 'exited' | 'running'
}

export interface BgJob {
  created_at: number
  done_at: number | null
  exit_code: number | null
  goal: string
  id: string
  kind: string
  status: string
}

export interface BgCron {
  action: string
  enabled: boolean
  id: number
  last_run: number | null
  schedule: string
}

export interface BgGoal {
  active: boolean
  done: boolean
  maxRounds: number
  round: number
  text: string
}

export interface BgState {
  cron: BgCron[]
  goal: BgGoal | null
  jobs: BgJob[]
  terms: BgTerm[]
  ts: number
}

export const buildBgState = (): BgState => ({ cron: [], goal: null, jobs: [], terms: [], ts: 0 })

export const $bgState = atom<BgState>(buildBgState())

export const getBgState = () => $bgState.get()

export const patchBgState = (next: Partial<BgState>) =>
  $bgState.set({ ...$bgState.get(), ...next, ts: Date.now() })

const subscribeBg = (cb: () => void) => $bgState.listen(() => cb())

/** 后台状态订阅（详情面板/摘要行——与 useTurnSelector 同款 useSyncExternalStore） */
export const useBgSelector = <T>(selector: (state: BgState) => T): T =>
  useSyncExternalStore(
    subscribeBg,
    () => selector($bgState.get()),
    () => selector($bgState.get())
  )

export const resetBgState = () => $bgState.set(buildBgState())

/** 有后台活动（运行中终端/排队或运行任务/goal 循环）——摘要行与状态栏徽标用 */
export const bgActiveCount = (s: BgState): number =>
  s.terms.filter(t => t.status === 'running').length +
  s.jobs.filter(j => j.status === 'running' || j.status === 'queued').length +
  (s.goal?.active ? 1 : 0)

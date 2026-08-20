import { parseSlashCommand } from '../domain/slash.js'
import type { SlashExecResponse } from '../gatewayTypes.js'
import { asCommandDispatch, rpcErrorMessage } from '../lib/rpc.js'

import type { SlashHandlerContext } from '../bridge/interfaces.js'
import { findSlashCommand } from './slashRegistry.js'
import type { SlashRunCtx } from './slashTypes.js'
import { getUiState } from '../runtime/viewStore.js'
import { recordRecentAction } from '../runtime/recentActions.js'

export function createSlashHandler(ctx: SlashHandlerContext): (cmd: string) => boolean {
  const { gw } = ctx.gateway
  const { catalog } = ctx.local
  const { page, send, sys } = ctx.transcript

  const handler = (cmd: string): boolean => {
    const flight = ++ctx.slashFlightRef.current
    const ui = getUiState()
    const sid = ui.sid
    const parsed = parseSlashCommand(cmd)
    const argTail = parsed.arg ? ` ${parsed.arg}` : ''

    const stale = () => flight !== ctx.slashFlightRef.current || getUiState().sid !== sid

    const guarded =
      <T>(fn: (r: T) => void) =>
      (r: null | T): void => {
        if (!stale() && r) {
          fn(r)
        }
      }

    const guardedErr = (e: unknown) => {
      if (!stale()) {
        sys(`error: ${rpcErrorMessage(e)}`)
      }
    }

    const runCtx: SlashRunCtx = { ...ctx, flight, guarded, guardedErr, sid, stale, ui }

    // 统一处理 slash.exec / command.dispatch 的结构化响应
    const handleDispatch = (d: NonNullable<ReturnType<typeof asCommandDispatch>>): void => {
      if (d.type === 'exec' || d.type === 'plugin') {
        sys(d.output || '(no output)')

        return
      }

      if (d.type === 'alias') {
        handler(`/${d.target}${argTail}`)

        return
      }

      if (d.type === 'skill') {
        sys(`⚡ loading skill: ${d.name}`)

        if (d.message?.trim()) {
          send(d.message)
        } else {
          sys(`/${parsed.name}: skill payload missing message`)
        }

        return
      }

      if (d.type === 'send') {
        if (d.notice?.trim()) {
          sys(d.notice)
        }
        if (d.message?.trim()) {
          send(d.message)
        } else {
          sys(`/${parsed.name}: empty message`)
        }

        return
      }

      if (d.type === 'prefill') {
        // /undo returns prefill: drop the backed-up message text into
        // the composer so the user can edit and resubmit, instead of
        // submitting it immediately like 'send'.
        if (d.notice?.trim()) {
          sys(d.notice)
        }
        if (d.message) {
          ctx.composer.setInput(d.message)
        }
      }
    }

    const found = findSlashCommand(parsed.name)

    if (found) {
      // P2 增强：记录最近动作（命令面板「最近」区数据源）
      recordRecentAction(cmd)
      found.run(parsed.arg, runCtx, cmd)

      return true
    }

    if (catalog?.canon) {
      const needle = `/${parsed.name}`.toLowerCase()
      const exact = Object.entries(catalog.canon).find(([alias]) => alias.toLowerCase() === needle)?.[1]

      if (exact) {
        if (exact.toLowerCase() !== needle) {
          return handler(`${exact}${argTail}`)
        }
      } else {
        const matches = [
          ...new Set(
            Object.entries(catalog.canon)
              .filter(([alias]) => alias.startsWith(needle))
              .map(([, canon]) => canon)
          )
        ]

        if (matches.length === 1 && matches[0]!.toLowerCase() !== needle) {
          return handler(`${matches[0]}${argTail}`)
        }

        if (matches.length > 1) {
          sys(`ambiguous command: ${matches.slice(0, 6).join(', ')}${matches.length > 6 ? ', …' : ''}`)

          return true
        }
      }
    }

    gw.request<SlashExecResponse>('slash.exec', { command: cmd.slice(1), session_id: sid })
      .then(r => {
        if (stale()) {
          return
        }

        // 结构化响应（/skill:name 技能注入等）：走统一 dispatch 处理
        const d = asCommandDispatch(r)

        if (d) {
          return handleDispatch(d)
        }

        const body = r?.output || `/${parsed.name}: no output`
        const text = r?.warning ? `warning: ${r.warning}\n${body}` : body
        const long = text.length > 180 || text.split('\n').filter(Boolean).length > 2

        // pager 标题中文化（中文为主）：高频命令映射中文标题，未知命令回退首字母大写
        const PAGER_TITLES: Record<string, string> = {
          help: '命令帮助', status: '状态', doctor: '体检', memory: '记忆', hole: '黑洞检索',
          key: '密钥', model: '模型', config: '配置', perm: '权限', usage: '用量',
          compliance: '合规', audit: '审计', evidence: '证据', gate: '质量门', fdr: '保障',
          script: '剧本', skill: '技能', map: '仓库地图', build: '构建', deploy: '部署',
          sessions: '会话', logs: '日志', versions: '版本历史', snapshot: '快照', plan: '计划',
        }
        const title = PAGER_TITLES[parsed.name] ?? parsed.name[0]!.toUpperCase() + parsed.name.slice(1)

        long ? page(text, title) : sys(text)
      })
      .catch(() => {
        gw.request('command.dispatch', { arg: parsed.arg, name: parsed.name, session_id: sid })
          .then((raw: unknown) => {
            if (stale()) {
              return
            }

            const d = asCommandDispatch(raw)

            if (!d) {
              return sys('error: invalid response: command.dispatch')
            }

            handleDispatch(d)
          })
          .catch(guardedErr)
      })

    return true
  }

  return handler
}

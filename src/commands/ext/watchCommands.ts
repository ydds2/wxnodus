// src/commands/ext/watchCommands.ts — 常驻屏幕视频流命令面（2026-09-03 · P0+P1）
// 方案 docs/screenwatch-localvlm-modpack-plan-2026-09-03.md：
//   P0：ffmpeg gdigrab 实时视频捕捉 → 帧环缓冲 → 场景分段（stderr scene_score）→ 关键帧 OCR 摘要入黑洞
//   P1：MAA 式声明任务链 /watch chain（模板匹配 L0 档）——命中即记录 + trigger 事件 + 证据关键帧；
//        click/type 动作必须经审批桥（ctx.gateway.requestApproval）——无审批桥 fail-closed 仅记录。
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { lines } from '../outputFormat.js'
import type { HandlerCtx } from '../handlers.js'
import type { CommandBus } from '../../app/CommandBus.js'
import { createScreenStream, type ScreenStream } from '../../kernel/screenStream.js'
import { matchTemplate, loadTemplateFile, type GrayImage, type MatchHit } from '../../kernel/screenMatch.js'
import { describeScreen, setLocalVisionCacheDir } from '../../kernel/localVision.js'

let stream: ScreenStream | null = null
let lastSummary = ''
let summaryCount = 0
let tier: 'l1' | 'l2' = 'l1'

// ── P1：MAA 式任务链（声明式 JSON：triggers[模板+阈值+OCR 验证+动作]）──
interface ChainTrigger {
  id: string
  template: string
  templateImg: GrayImage
  threshold?: number
  verify?: { ocr: string }
  action: { kind: 'click' | 'type' | 'none'; x?: number; y?: number; text?: string }
}
interface WatchChain { name?: string; minIntervalMs: number; triggers: ChainTrigger[] }
let chain: WatchChain | null = null
let chainHits = 0
let lastChainRunAt = 0

async function executeChainAction(action: { kind: 'click' | 'type' | 'none'; x?: number; y?: number; text?: string }, hit: MatchHit): Promise<void> {
  if (action.kind === 'none') return
  // 动态 import（勿用 createRequire——测试 mock 必须可拦截；CJS 包 default 回退，vitest mock 无 default 会抛——try 回退命名空间）
  const mod = await import('robotjs') as unknown as Record<string, unknown>
  let robot: { getScreenSize(): { width: number; height: number }; moveMouse(x: number, y: number): void; mouseClick(): void; typeString(s: string): void }
  try { robot = (mod.default ?? mod) as typeof robot } catch { robot = mod as unknown as typeof robot }
  // 坐标映射：解码帧（≤640 宽）→ 真实屏幕像素
  const screen = robot.getScreenSize()
  const rx = Math.round((action.x ?? hit.x) * screen.width / hit.frameW)
  const ry = Math.round((action.y ?? hit.y) * screen.height / hit.frameH)
  if (action.kind === 'click') { robot.moveMouse(rx, ry); robot.mouseClick() }
  else robot.typeString(action.text ?? '')
}

async function runChain(ctx: HandlerCtx, frameJpeg: Buffer, workDir: string): Promise<void> {
  if (!chain) return
  const now = Date.now()
  if (now - lastChainRunAt < chain.minIntervalMs) return
  lastChainRunAt = now
  const needVerify = chain.triggers.some(t => t.verify?.ocr)
  let kfFile: string | null = null
  if (needVerify) {
    kfFile = join(workDir, 'keyframes', `chain-kf-${now}.jpg`)
    try { writeFileSync(kfFile, frameJpeg) } catch { kfFile = null }
  }
  for (const trig of chain.triggers) {
    try {
      const r = await matchTemplate(frameJpeg, trig.templateImg, { threshold: trig.threshold ?? 0.8 })
      if (!r.ok || !r.hit) continue
      const hit = r.hit
      chainHits++
      let verifyNote = ''
      if (trig.verify?.ocr && kfFile) {
        const { ocrWindowsImage } = await import('../../kernel/computer/ocr.js')
        const ocr = await ocrWindowsImage(kfFile)
        verifyNote = ocr.ok && ocr.text.includes(trig.verify.ocr)
          ? ` · OCR 验证通过「${trig.verify.ocr}」`
          : ` · OCR 验证未通过${ocr.ok ? '' : `（${ocr.error.slice(0, 40)}）`}`
      }
      const action = trig.action
      let actionNote = ''
      if (action.kind === 'none') {
        actionNote = '（观测链——不执行动作）'
      } else {
        const gw = ctx.gateway
        if (!gw?.requestApproval) {
          actionNote = '（动作待审批：审批桥未装配——fail-closed，仅记录命中）'
        } else {
          const name = action.kind === 'click' ? 'computer_click' : 'computer_type'
          const choice = await gw.requestApproval(name, { x: action.x ?? hit.x, y: action.y ?? hit.y, text: action.text ?? '', _reasonCode: 'watch-chain' })
          if (choice === 'deny') {
            actionNote = '（动作被拒绝）'
          } else {
            try {
              await executeChainAction(action, hit)
              actionNote = '（动作已执行）'
            } catch (e) { actionNote = `（动作执行失败：${String((e as Error)?.message ?? e).slice(0, 80)}）` }
          }
        }
      }
      const text = `[屏幕任务链命中 ${trig.id}] 模板@(${hit.x},${hit.y}) score=${hit.score.toFixed(3)}${verifyNote}${actionNote}`
      try { ctx.bus.emit('system.screen.watch', { kind: 'trigger', id: trig.id, x: hit.x, y: hit.y, score: hit.score, at: now }) } catch { /* 总线未装配静默 */ }
      try {
        ctx.mem.append(ctx.agent?.getSessionId?.() ?? 'default', 'assistant',
          `[屏幕观察 ${new Date(now).toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`)
      } catch { /* 记忆未装配静默 */ }
      lastSummary = text
      break // 一帧一命中（防多触发风暴）
    } catch (e) {
      // 单触发器失败不影响其余——但错误经事件总线可见（诊断诚实，不静默吞）
      try { ctx.bus.emit('system.screen.watch', { kind: 'chain-error', id: trig.id, error: String((e as Error)?.message ?? e).slice(0, 200), at: now }) } catch { /* 总线未装配静默 */ }
    }
  }
}

export function registerWatchCommands(bus: CommandBus, ctx: HandlerCtx): void {
  bus.register('/watch', async (args) => {
    const sub = args[0] ?? 'status'

    if (sub === 'chain') {
      const target = args[1]
      if (!target || target === 'off') { chain = null; return '任务链已清除（/watch chain <file> 重新装载）' }
      try {
        const file = resolve(ctx.cwd ?? process.cwd(), target)
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
        const rawTriggers = raw.triggers
        if (!Array.isArray(rawTriggers) || rawTriggers.length === 0) return '任务链格式错误：triggers 必须是非空数组（MAA 式：{triggers:[{id,template,threshold?,verify?,action?}]}）'
        const dir = dirname(file)
        const triggers: ChainTrigger[] = []
        for (const t of rawTriggers as Array<Record<string, unknown>>) {
          if (!t.id || !t.template) return `任务链触发器缺少 id/template：${JSON.stringify(t).slice(0, 120)}`
          const tp = resolve(dir, String(t.template))
          if (!existsSync(tp)) return `模板不存在：${String(t.template)}（相对任务链文件路径）`
          const r = await loadTemplateFile(tp)
          if (!r.ok) return `模板加载失败：${String(t.template)} — ${r.error}`
          const action = (t.action ?? { kind: 'none' }) as Record<string, unknown>
          if (!['none', 'click', 'type'].includes(String(action.kind))) return `action.kind 非法：${String(action.kind)}（none/click/type）`
          triggers.push({
            id: String(t.id), template: String(t.template),
            threshold: typeof t.threshold === 'number' ? t.threshold : undefined,
            verify: (t.verify as Record<string, unknown> | undefined)?.ocr ? { ocr: String((t.verify as Record<string, unknown>).ocr) } : undefined,
            action: {
              kind: String(action.kind) as 'click' | 'type' | 'none',
              x: typeof action.x === 'number' ? action.x : undefined,
              y: typeof action.y === 'number' ? action.y : undefined,
              text: action.text ? String(action.text) : undefined,
            },
            templateImg: r.img,
          })
        }
        chain = {
          name: typeof raw.name === 'string' ? raw.name : undefined,
          minIntervalMs: Number.isFinite(raw.minIntervalMs) ? Math.max(1000, Number(raw.minIntervalMs)) : 3000,
          triggers,
        }
        chainHits = 0
        return lines(' 屏幕任务链已装载 ', [
          ` 名称：${chain.name ?? '（未命名）'} · 触发器 ${triggers.length} 个 · 匹配间隔 ≥${chain.minIntervalMs / 1000}s`,
          ' 命中即记录（黑洞记忆 + trigger 事件 + 关键帧证据）；click/type 动作必须经审批桥（无审批桥 fail-closed 只记录）',
          ' 清除：/watch chain off · 状态：/watch status',
        ])
      } catch (e) { return `任务链装载失败：${String((e as Error)?.message ?? e).slice(0, 200)}` }
    }

    if (sub === 'start') {
      if (stream?.status().running) return '已在捕捉中——/watch status 查看（先 /watch stop 再换参数重启）'
      const num = (flag: string, def: number, lo: number, hi: number) => {
        const i = args.indexOf(flag)
        const n = Number(args[i + 1])
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : def
      }
      const fps = num('--fps', 5, 1, 10)
      const ring = num('--ring', 60, 5, 300)
      const backendArg = args[args.indexOf('--backend') + 1]
      const backend = backendArg === 'ddagrab' || backendArg === 'gdigrab' ? backendArg : 'auto'
      const tierArg = args[args.indexOf('--tier') + 1]
      tier = tierArg === 'l2' ? 'l2' : 'l1'
      if (tier === 'l2') setLocalVisionCacheDir(ctx.dataDir)
      const workDir = join(ctx.dataDir, 'watch')
      const newStream = createScreenStream({
        fps, ringSeconds: ring, backend, workDir,
        onEvent: (ev) => {
          try { ctx.bus.emit('system.screen.watch', ev) } catch { /* 总线未装配静默 */ }
          if (ev.kind === 'frame') {
            // P1：任务链在最新关键帧上按 minIntervalMs 节流匹配
            const kf = newStream.keyframe()
            if (kf) void runChain(ctx, kf.buf, workDir)
          }
          if (ev.kind === 'segment') {
            const kf = newStream.keyframe()
            if (!kf) return
            const kfFile = join(workDir, 'keyframes', `kf-${ev.at}.jpg`)
            try {
              writeFileSync(kfFile, kf.buf)
              void (async () => {
                try {
                  const { ocrWindowsImage } = await import('../../kernel/computer/ocr.js')
                  const r = await ocrWindowsImage(kfFile)
                  let text = r.ok ? `「${r.text.slice(0, 80)}」` : `（OCR：${r.error.slice(0, 40)}）`
                  // P2.1：本地视觉档（--tier l2）——moondream2 本机推理段摘要；失败诚实降级不阻断 OCR 摘要
                  if (tier === 'l2') {
                    const v = await describeScreen(kf.buf)
                    text += v.ok ? ` · VLM: ${v.text.slice(0, 80)}` : ` · VLM 不可用：${v.error.slice(0, 60)}`
                  }
                  lastSummary = text
                  summaryCount++
                  try {
                    ctx.mem.append(ctx.agent?.getSessionId?.() ?? 'default', 'assistant',
                      `[屏幕观察 ${new Date(ev.at).toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`)
                  } catch { /* 记忆未装配静默 */ }
                } catch { /* OCR 失败静默——诚实性由 summary 呈现 */ }
              })()
            } catch { /* 关键帧落盘失败不影响流 */ }
          }
        },
      })
      const r = await newStream.start()
      if (!r.ok) return r.error
      stream = newStream
      const st = newStream.status()
      return lines(' 屏幕视频流已启动 ', [
        ` 捕捉：ffmpeg（${st.backend === 'ddagrab' ? 'ddagrab · Desktop Duplication API——WGC 同层，低开销，可抓 UWP' : 'gdigrab · GDI——抓不到安全窗口/DRM'}，实时视频流 ${fps}fps · 环缓冲 ${ring}s · 识别档 ${tier === 'l2' ? 'l2（OCR + 本地 VLM moondream2）' : 'l1（OCR）'}）`,
        ` 事件：system.screen.watch（frame/segment/trigger/clip）· 段摘要入黑洞记忆（/hole 可召回）`,
        ` 任务链：/watch chain <task-chain.json>（MAA 式模板触发）· 回放：/watch clip 10 · 停止：/watch stop`,
      ])
    }

    if (sub === 'stop') {
      if (!stream) return '未在捕捉（/watch start 先启动）'
      await stream.stop()
      stream = null
      return `已停止屏幕视频流（本次共 ${summaryCount} 条段摘要、${chainHits} 次任务链命中入记忆）`
    }

    if (sub === 'clip') {
      if (!stream) return '未在捕捉（/watch start 先启动）'
      const n = Number(args[1])
      const seconds = Number.isFinite(n) ? Math.min(300, Math.max(1, Math.round(n))) : 10
      const r = await stream.clip(seconds)
      if (!r.ok) return `证据导出失败：${r.error}`
      return lines(' 回放证据已导出 ', [
        ` 文件：${r.file}`,
        ` sha256：${r.sha256}`,
        ` 帧数：${r.frames}（最近 ${r.seconds}s）——可经播放器回看，sha256 可入审计链`,
      ])
    }

    // status（默认）
    const st = stream?.status()
    if (!st?.running) return '未在捕捉——/watch start [--fps 5] [--ring 60] 启动实时视频流（gdigrab → 环缓冲 → 场景分段 → 模板任务链 → 记忆）'
    return lines(' 屏幕视频流状态 ', [
      ` 运行中：${st.fps}fps · 后端 ${st.backend === 'ddagrab' ? 'ddagrab（Desktop Duplication API）' : 'gdigrab（GDI）'} · 环缓冲 ${st.ringFrames} 帧 / ${st.ringSeconds}s · 场景段 ${st.segments}`,
      ` 任务链：${chain ? `${chain.name ?? '（未命名）'} · 命中 ${chainHits} 次` : '未装载（/watch chain <file>）'}`,
      ` 最近摘要：${lastSummary || '（尚无场景切换/命中）'}`,
      ` 停止：/watch stop · 回放：/watch clip 10`,
    ])
  })
}

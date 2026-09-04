// src/tui/paste.ts — bracketed paste 协议级粘贴通道（xterm DECSET 2004 · T76）
// 此前粘贴多行靠 <40ms 突发启发式（T70——ConPTY 无标记时的兜底，保留）；
// 本模块升级为协议级：启动发 \x1b[?2004h 请终端把粘贴内容包在 \x1b[200~ … \x1b[201~ 标记里，
// 标记内的 \r 一律归一为 \n（粘贴换行绝不触发提交），标记外字节原样透传（真实回车语义不变）。
// ink 的 stdin 契约（App.js handleSetRawMode）：isTTY 判定 + setEncoding + ref/setRawMode + readable 读取——
// 用 Transform 承接并把这些调用委托回真 stdin，ink 全程只看到变换后的字节流。
import { Transform } from 'node:stream'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const DECSET_ON = '\x1b[?2004h'
const DECSET_OFF = '\x1b[?2004l'

/** 尾部悬挂的「可能是标记前缀」字节长度（标记跨 chunk 分裂时暂扣，最长 marker-1=5） */
function partialMarkerLen(s: string, marker: string): number {
  const max = Math.min(marker.length - 1, s.length)
  for (let k = max; k > 0; k--) {
    if (s.endsWith(marker.slice(0, k))) return k
  }
  return 0
}

/** 粘贴段内换行归一：\r\n 与孤立 \r → \n（\n 保持） */
function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n')
}

// ═══ ⅩⅩⅩⅢ：SGR 鼠标序列过滤 ═══
// DECSET 1002h/1006h 启用后终端回送 \x1b[<button;col;row M/m 序列——
// 不过滤则进 ink 输入解析器被当普通文本渲染（乱码+干扰输入框）。
// 本过滤层：从流中剥离全部 SGR 序列 + 提取滚轮事件回调（上/下滚控制转录视口）。
const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g

export type MouseWheelCallback = (direction: 'up' | 'down') => void

/** 剥离 SGR 鼠标序列（跨 chunk 的 ESC 悬挂由 paste 滤层的 partialMarkerLen 同族机制处理） */
function stripSgrMouse(s: string, onWheel?: MouseWheelCallback): string {
  if (!s.includes('\x1b[<')) return s
  return s.replace(SGR_MOUSE_RE, (_match, cbRaw: string, _col: string, _row: string, _press: string) => {
    const cb = Number(cbRaw)
    // SGR 滚轮：cb ≥ 64（bit 6）—— 64=滚轮上 65=滚轮下
    if (onWheel && (cb & 64) !== 0) {
      onWheel((cb & 1) === 0 ? 'up' : 'down')
    }
    return '' // 剥离——不进 ink
  })
}

export interface PasteFilter {
  /** 送入一个 chunk，返回应立即下发的文本（悬挂前缀留在内部） */
  push(chunk: string): string
  /** 流终止时冲刷悬挂前缀（不丢字节） */
  flush(): string
  /** 超时冲刷悬挂前缀：25ms 无后续字节即证伪（如单独 Esc 键——绝不能被前缀悬挂卡死） */
  flushPartial(): string
  /** 调试/测试可见：当前是否处于粘贴块内 */
  readonly inPaste: boolean
  /** 是否有悬挂前缀字节（超时冲刷调度依据） */
  readonly hasPending: boolean
}

/**
 * 纯状态机：剥离粘贴标记 + 块内 \r 归一。
 * - 标记外字节原样透传（真实 Enter/方向键等 ink 语义零影响）；
 * - 标记可能跨 chunk 分裂（\x1b 与 [200~ 分两次到达）——尾部悬挂最长 marker-1 字节，下轮拼回再判；
 * - 悬挂被证伪（如 Insert 键 \x1b[2~ 只共享前缀 \x1b[2）→ 原样补发，绝不吞键。
 */
export function createPasteFilter(): PasteFilter {
  let inPaste = false
  let carry = ''
  return {
    get inPaste() { return inPaste },
    get hasPending() { return carry.length > 0 },
    push(chunk: string): string {
      let s = carry + chunk
      carry = ''
      let out = ''
      let i = 0
      while (i < s.length) {
        if (!inPaste) {
          const start = s.indexOf(PASTE_START, i)
          if (start === -1) {
            const hold = partialMarkerLen(s.slice(i), PASTE_START)
            carry = s.slice(s.length - hold)
            out += s.slice(i, s.length - hold)
            i = s.length
          } else {
            out += s.slice(i, start)
            inPaste = true
            i = start + PASTE_START.length
          }
        } else {
          const end = s.indexOf(PASTE_END, i)
          if (end === -1) {
            const hold = partialMarkerLen(s.slice(i), PASTE_END)
            carry = s.slice(s.length - hold)
            out += normalizeNewlines(s.slice(i, s.length - hold))
            i = s.length
          } else {
            out += normalizeNewlines(s.slice(i, end))
            inPaste = false
            i = end + PASTE_END.length
          }
        }
      }
      return out
    },
    flush(): string {
      const rest = carry
      carry = ''
      return inPaste ? normalizeNewlines(rest) : rest
    },
    flushPartial(): string {
      // 超时证伪：悬挂前缀原样下发（标记外字节不过换行归一——本就可能是真实按键序列）
      const rest = carry
      carry = ''
      return inPaste ? normalizeNewlines(rest) : rest
    },
  }
}

/** ink stdin 契约适配 + DECSET 2004 开关（T76 装配面） */
export interface PasteStdin {
  /** 传给 ink render({ stdin }) 的变换流（isTTY/setRawMode/ref 全部委托真 stdin） */
  stream: Transform
  /** 向终端发 \x1b[?2004h（仅 TTY——管道/测试不污染输出） */
  enable(): void
  /** 复位 \x1b[?2004l（退出前必调——否则终端粘贴行为残留） */
  disable(): void
  /** 拆管销毁（unmount 后真 stdin 回到 cli 自己手里） */
  dispose(): void
}

export function createPasteStdin(
  rawIn: NodeJS.ReadStream & { setRawMode?(mode: boolean): void },
  rawOut: NodeJS.WriteStream,
  opts: { onWheel?: MouseWheelCallback } = {},
): PasteStdin {
  // ⅩⅩⅫ：鼠标支持——SGR 编码解析（[<button;col;row M/m）
  // 当前为基础档：点击事件经 stdout 'mouse' 通道透传（App 层消费）；
  // DECSET 1002h+1006h 启用（按钮+SGR 编码）。
  const filter = createPasteFilter()
  // 悬挂前缀超时冲刷（25ms）：终端序列几乎总是原子送达——超时无后续即证伪是真实按键
  // （单独 Esc 键 = `\x1b` 恰为标记前缀——不超时冲刷会被无限悬挂成死键，e2e 实测教训）
  let carryTimer: NodeJS.Timeout | null = null
  const clearCarryTimer = () => { if (carryTimer) { clearTimeout(carryTimer); carryTimer = null } }
  const stream = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      clearCarryTimer()
      const filtered = stripSgrMouse(filter.push(String(chunk)), opts.onWheel)
      cb(null, filtered)
      if (filter.hasPending) {
        carryTimer = setTimeout(() => {
          carryTimer = null
          const out = filter.flushPartial()
          if (out) stream.push(out)
        }, 25)
        carryTimer.unref?.()
      }
    },
    flush(cb) {
      clearCarryTimer()
      cb(null, filter.flush())
    },
  })
  // ink 契约委托：isTTY 决定 useInput 是否可用；setRawMode/ref 是 ink 的原始模式管理入口
  Object.defineProperty(stream, 'isTTY', { get: () => rawIn.isTTY === true })
  ;(stream as unknown as { setRawMode(mode: boolean): void }).setRawMode = (mode: boolean) => {
    rawIn.setRawMode?.(mode)
  }
  ;(stream as unknown as { ref(): void }).ref = () => { rawIn.ref() }
  ;(stream as unknown as { unref(): void }).unref = () => { rawIn.unref() }
  rawIn.setEncoding?.('utf8')
  rawIn.pipe(stream)
  return {
    stream,
    enable() { if (rawOut.isTTY) rawOut.write(DECSET_ON) },
    disable() { if (rawOut.isTTY) rawOut.write(DECSET_OFF) },
    dispose() {
      clearCarryTimer()
      try { rawIn.unpipe(stream) } catch { /* 已拆 */ }
      try { stream.destroy() } catch { /* 已销毁 */ }
    },
  }
}

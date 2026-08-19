// src/wxnodus-ui/keymap/registry.ts — 键位注册表（UI 重设计 P0-1，2026-08-19）
// 定位：键位「文档 + 冲突检测」的单一事实源。运行时匹配仍走 config/keymap.ts
// （settings.keymap 覆盖层，语义不变）；本表与之对齐动作名，不双写逻辑。
// 诚实口径：只登记代码实测存在的键位（useKeyBindings/textInput/keymap.ts 逐一核对），
// 无「计划中」条目；跨层同时生效的重叠（如 ctrl+o 双触发）由 diagnoseKeymap 如实报告，
// 不在注册期掩盖——注册期仅对「同 scope 同键」报错（真正的重复定义）。
import { parseKeySpec, type KeySpec } from '../config/keymap.js'

export type BindingScope = 'global' | 'workspace' | 'prompt' | 'vim' | 'panel' | 'pager'

export interface KeyBinding {
  id: string
  /** 键位规范（'ctrl+k' / 'escape' / 'G' 等——parseKeySpec 语法，大小写敏感） */
  keys: string[]
  scope: BindingScope
  /** 动作名（与 settings.keymap 动作层对齐的语义名；纯展示用 human-readable） */
  action: string
  help: string
  /** 该动作在 settings.keymap 中可覆盖（pager 7 动作） */
  configurable?: boolean
}

/**
 * 全量键位清单——依据（均为 2026-08-19 代码实测）：
 * - useKeyBindings.ts：全局键（Ctrl+K/O/X/R/Shift+P/G/L/D/B/C、Shift+Tab、Esc 族、滚动族）
 * - textInput.tsx：prompt 键（Tab/Enter/@//、Ctrl+O 外部编辑器）
 * - config/keymap.ts DEFAULT_KEYMAP：pager 7 动作
 * - useKeyBindings pager 分支：[/] hunk、t/r/m diff、Enter 页尾关闭
 * - textInput vim 边界键：Esc / /搜索 / Ctrl+R redo（NORMAL 全语义键由 vimHandleKey 解释，不逐键登记）
 */
export const BUILTIN_BINDINGS: KeyBinding[] = [
  // ── 全局（转录流 + 空闲态；浮层阻断时挂起） ──────────────────────────
  { id: 'global.palette', keys: ['ctrl+k', 'ctrl+p'], scope: 'global', action: 'palette.toggle', help: '命令面板（再按关闭；Ctrl+P 为 VS Code 同款别名）' },
  { id: 'global.model-picker', keys: ['ctrl+o'], scope: 'global', action: 'modelPicker.open', help: '模型选择器（保留草稿）' },
  { id: 'global.sessions', keys: ['ctrl+x'], scope: 'global', action: 'sessions.open', help: '会话浏览器（恢复/切换/删除）' },
  { id: 'global.history', keys: ['ctrl+r'], scope: 'global', action: 'histSearch.open', help: '历史反向搜索（bash readline 同款）' },
  { id: 'global.screenshot', keys: ['ctrl+shift+p'], scope: 'global', action: 'capture.attach', help: '截图即问（文本模型自动走 GLM 识别）' },
  { id: 'global.interrupt', keys: ['ctrl+c'], scope: 'global', action: 'turn.interrupt', help: 'busy 中断 / 有输入清空 / 空闲提示退出方式' },
  { id: 'global.quit', keys: ['ctrl+d'], scope: 'global', action: 'app.quit', help: '退出（macOS 为 Cmd+D）' },
  { id: 'global.redraw', keys: ['ctrl+l'], scope: 'global', action: 'screen.redraw', help: '清选区 + 强制重绘' },
  { id: 'global.editor', keys: ['ctrl+g', 'meta+g'], scope: 'global', action: 'input.external-editor', help: '外部编辑器（Alt+G 到达时为 meta+g，兼容 VSCode/Cursor 占用）' },
  { id: 'global.perm-cycle', keys: ['shift+tab'], scope: 'global', action: 'perm.next', help: '权限模式循环（smart→auto→manual→plan→yolo→goal）' },
  { id: 'global.voice', keys: ['ctrl+b'], scope: 'global', action: 'voice.toggle', help: '语音录制开关（键位可配 /voice record-key）' },
  { id: 'global.esc', keys: ['escape'], scope: 'global', action: 'esc.multi', help: '多语义：队列编辑取消 → 选区清除 → 消息选中清除 → busy 双 Esc（1.5s 窗口）中断' },
  { id: 'global.scroll-half', keys: ['pageup', 'pagedown'], scope: 'global', action: 'transcript.half-page', help: '半视口滚动（保持 50% 连续）' },
  { id: 'global.scroll-line', keys: ['shift+up', 'shift+down'], scope: 'global', action: 'transcript.line', help: '逐行滚动' },
  { id: 'global.history-nav', keys: ['up', 'down'], scope: 'global', action: 'input.history-cycle', help: '空输入首行 ↑↓：队列/历史循环' },
  { id: 'global.dequeue', keys: ['cmd+k'], scope: 'global', action: 'queue.dequeue', help: 'macOS Cmd+K：取出下一排队任务（Win Ctrl+K 为命令面板）' },

  // ── 输入区（prompt；与 global 同时生效——重叠即双触发，见 diagnoseKeymap） ──
  { id: 'prompt.tab-accept', keys: ['tab'], scope: 'prompt', action: 'completion.insert', help: '补全接受（文本并入输入区）' },
  { id: 'prompt.enter-accept', keys: ['enter'], scope: 'prompt', action: 'completion.submit', help: 'Enter 双语义：slash 接受即提交 / path·agent 仅替换' },
  { id: 'prompt.comp-nav', keys: ['up', 'down', 'pageup', 'pagedown'], scope: 'prompt', action: 'completion.navigate', help: '补全弹窗导航（PgUp/PgDn 整页）' },
  { id: 'prompt.editor', keys: ['ctrl+o'], scope: 'prompt', action: 'input.external-editor', help: '草稿写临时文件→编辑器往返读回（失败保留草稿）' },
  { id: 'prompt.at-completion', keys: ['@'], scope: 'prompt', action: 'completion.at', help: '@ 双源补全（文件 / 子代理）触发' },
  { id: 'prompt.slash-completion', keys: ['/'], scope: 'prompt', action: 'completion.slash', help: '斜杠命令补全触发' },

  // ── vim（/vim 开启后生效；NORMAL 全语义键由 vimHandleKey 解释，不逐键登记） ──
  { id: 'vim.esc', keys: ['escape'], scope: 'vim', action: 'vim.to-normal', help: 'INSERT→NORMAL / 取消 vim 子状态' },
  { id: 'vim.search', keys: ['/'], scope: 'vim', action: 'vim.search', help: 'NORMAL 下 / 启动搜索' },
  { id: 'vim.redo', keys: ['ctrl+r'], scope: 'vim', action: 'vim.redo', help: 'NORMAL 下 Ctrl+R 重做' },

  // ── pager / 结构化 diff（打开时独占输入；7 动作可在 settings.keymap 覆盖） ──
  { id: 'pager.close', keys: ['escape', 'ctrl+c', 'q'], scope: 'pager', action: 'pagerClose', help: '关闭翻页器', configurable: true },
  { id: 'pager.up', keys: ['up', 'k'], scope: 'pager', action: 'pagerUp', help: '上移一行', configurable: true },
  { id: 'pager.down', keys: ['down', 'j'], scope: 'pager', action: 'pagerDown', help: '下移一行', configurable: true },
  { id: 'pager.half-up', keys: ['pageup', 'b'], scope: 'pager', action: 'pagerHalfUp', help: '上半页', configurable: true },
  { id: 'pager.half-down', keys: ['pagedown', 'space'], scope: 'pager', action: 'pagerHalfDown', help: '下半页', configurable: true },
  { id: 'pager.top', keys: ['g'], scope: 'pager', action: 'pagerTop', help: '到顶部', configurable: true },
  { id: 'pager.bottom', keys: ['G'], scope: 'pager', action: 'pagerBottom', help: '到底部', configurable: true },
  { id: 'pager.hunk-jump', keys: ['[', ']'], scope: 'pager', action: 'pager.hunk', help: 'hunk 跳转（仅含 @@ hunk 的 diff 内容）' },
  { id: 'pager.diff-tree', keys: ['t'], scope: 'pager', action: 'diff.tree', help: 'diff 文件树索引视图切换（↑↓ 选文件 · Enter 跳转）' },
  { id: 'pager.diff-revert', keys: ['r'], scope: 'pager', action: 'diff.revert', help: '回滚当前文件当前 hunk（确认面板真实执行）' },
  { id: 'pager.diff-mark', keys: ['m'], scope: 'pager', action: 'diff.mark', help: '标记 hunk 已审（内容指纹持久化，变更即失效）' },
  { id: 'pager.enter', keys: ['enter'], scope: 'pager', action: 'pager.page', help: '翻页；已到末页时关闭' },

  // ── 面板 / 选择器内（面板打开时独占输入；↑↓/Enter 为组件级通用语义） ──
  { id: 'panel.navigate', keys: ['up', 'down'], scope: 'panel', action: 'panel.navigate', help: '面板/选择器内 ↑↓ 导航' },
  { id: 'panel.select', keys: ['enter'], scope: 'panel', action: 'panel.select', help: '面板/选择器内 Enter 选择' },
  { id: 'panel.esc', keys: ['escape'], scope: 'panel', action: 'panel.close', help: 'Esc 关闭面板/选择器（组件级处理）' },
]

/** 注册表初始化结果（空 = 通过；同 scope 同键冲突 → throw，绝不静默） */
export interface RegistryIssue {
  id: string
  otherId: string
  chord: string
  scope: BindingScope
}

export interface OverlapReport {
  chord: string
  /** 同时生效的两层（同一时刻都会响应该键）——跨层重叠是「双触发候选缺陷」，不是误报 */
  ids: [string, string]
  scopes: [BindingScope, BindingScope]
}

export interface RegistryDiagnosis {
  issues: RegistryIssue[]
  overlaps: OverlapReport[]
}

/** 键位规范 → 规范字符串（'ctrl+k' / 'escape' / 'G'——展示与比较共用；空格键显示为 space） */
export function specToString(spec: KeySpec): string {
  const mods = `${spec.ctrl ? 'ctrl+' : ''}${spec.shift ? 'shift+' : ''}${spec.meta ? 'meta+' : ''}`
  return `${mods}${spec.key === ' ' ? 'space' : spec.key}`
}

/** 规范字符串解析（parseKeySpec 兼容语法）；非法返回 null（注册期即失败，不容忍坏键位） */
export function parseChord(chord: string): KeySpec | null {
  return parseKeySpec(chord)
}

/**
 * 注册期冲突检测：同 scope 同键 → 收集为 issue。
 * 同 scope 重复 = 真正的重复定义（两个绑定在同一层抢同一个键，其一必被遮蔽）。
 */
export function detectSameScopeConflicts(bindings: KeyBinding[]): RegistryIssue[] {
  const issues: RegistryIssue[] = []
  const seen = new Map<string, KeyBinding>()

  for (const b of bindings) {
    for (const raw of b.keys) {
      const spec = parseChord(raw)
      if (!spec) {
        throw new Error(`keymap registry: 非法键位规范「${raw}」@ ${b.id}`)
      }

      const chord = specToString(spec)
      const key = `${b.scope}\u0000${chord}`
      const other = seen.get(key)

      if (other) {
        issues.push({ id: b.id, otherId: other.id, chord, scope: b.scope })
      } else {
        seen.set(key, b)
      }
    }
  }

  return issues
}

/**
 * 跨层重叠诊断：global / prompt / vim 三层在空闲态**同时生效**——同键出现在这三层
 * 中的任意两层 = 一次按键两个动作（真实缺陷候选，如实报告）；pager / panel 层打开时
 * 独占输入（isBlocked 挂起 global/prompt），与其重叠属 scope 门控的正常设计，不报。
 */
export function diagnoseKeymap(bindings: KeyBinding[]): OverlapReport[] {
  const LIVE_SCOPES: BindingScope[] = ['global', 'prompt', 'vim']
  const byChord = new Map<string, KeyBinding[]>()

  for (const b of bindings) {
    if (!LIVE_SCOPES.includes(b.scope)) {
      continue
    }

    for (const raw of b.keys) {
      const spec = parseChord(raw)
      if (!spec) {
        continue
      }

      const chord = specToString(spec)
      const list = byChord.get(chord) ?? []
      list.push(b)
      byChord.set(chord, list)
    }
  }

  const overlaps: OverlapReport[] = []

  for (const [chord, list] of byChord) {
    if (list.length < 2) {
      continue
    }

    // 同一层内的重复已由 detectSameScopeConflicts 处理；此处只报跨层对。
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!
        const b = list[j]!

        if (a.scope === b.scope) {
          continue
        }

        overlaps.push({ chord, ids: [a.id, b.id], scopes: [a.scope, b.scope] })
      }
    }
  }

  return overlaps
}

/** 注册表初始化（组合冲突检测 + 跨层诊断）；issues 非空 → throw（lint 门禁候选） */
export function registerBindings(bindings: KeyBinding[] = BUILTIN_BINDINGS): RegistryDiagnosis {
  const issues = detectSameScopeConflicts(bindings)

  if (issues.length) {
    const detail = issues.map(i => `${i.id} ⇄ ${i.otherId}（${i.scope}/${i.chord}）`).join('；')
    throw new Error(`keymap registry: 同层键位冲突 ${issues.length} 处——${detail}`)
  }

  return { issues: [], overlaps: diagnoseKeymap(bindings) }
}

const SCOPE_ORDER: BindingScope[] = ['global', 'prompt', 'vim', 'pager', 'panel']
export const SCOPE_LABEL: Record<BindingScope, string> = {
  global: '全局（空闲态）',
  prompt: '输入区',
  vim: 'vim 模态（/vim 开启）',
  pager: 'pager / diff 工作台',
  panel: '面板 / 选择器',
  workspace: '工作台（P1 status/doctor/sessions 结构化——预留 scope，暂无绑定）',
}

/**
 * /help keys 文本生成（分组 + 每键一行：键位 / 动作 / 帮助）。
 * configurable 动作标注「可在 settings.keymap 覆盖」——注册表文档与覆盖层语义对齐。
 */
export function keymapDocs(bindings: KeyBinding[] = BUILTIN_BINDINGS): string[] {
  const rows: string[] = []

  for (const scope of SCOPE_ORDER) {
    const group = bindings.filter(b => b.scope === scope)

    if (!group.length) {
      continue
    }

    rows.push(`◈ ${SCOPE_LABEL[scope]}`)

    for (const b of group) {
      const keys = b.keys.join('/')
      const note = b.configurable ? '（settings.keymap 可覆盖）' : ''
      rows.push(`  ${keys.padEnd(16)} ${b.action.padEnd(22)} ${b.help}${note}`)
    }

    rows.push('')
  }

  rows.push('◈ 说明', '  vim NORMAL 全语义键由 vimHandleKey 解释（不逐键登记）；跨层重叠键见 audit §13.9x。')
  return rows
}

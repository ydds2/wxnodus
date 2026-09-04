// src/tui/commands.ts — 高频命令目录（组件无关——painter/engine 共用；长尾走 /help 全景索引页）
// 2026-09-03 美化：条目带分类符号（cat）——单一事实源取自 registry COMMAND_CAT（绝不手工复制第二份目录，
// 63 命令漂移类缺陷从结构上杜绝）；菜单行渲染「◈ /help 命令手册」。
import { COMMAND_CAT, CORE_COMMANDS } from '../commands/registry.js'
const QUICK_DEFS: Array<[cmd: string, desc: string]> = [
  ['/help', '命令手册（全目录 126）'],
  ['/model', '模型目录与密钥'],
  ['/build', '需求编译全流程'],
  ['/doctor', '全组件自检'],
  ['/memory', '三层记忆管理'],
  ['/hole', '记忆语义检索'],
  ['/perm', '权限规则'],
  ['/sessions', '会话列表/恢复'],
  ['/usage', '用量与成本'],
  ['/context', '上下文水位'],
  ['/offline', '离线生存模式'],
  ['/theme', '主题切换'],
  ['/undo', '撤销上一回合'],
  ['/new', '新会话'],
  ['/compact', '上下文压缩'],
  ['/status', '运行状态'],
  ['/paste', '剪贴板截图分析（33）'],
  ['/voice', '语音对话（34）'],
]
export const QUICK_COMMANDS: Array<{ cmd: string; desc: string; cat: string }> = QUICK_DEFS.map(([cmd, desc]) => ({
  cmd, desc, cat: COMMAND_CAT[cmd] ?? '',
}))

/** 会话内命令使用频序（kimi 斜杠菜单按使用频次上浮机制，实现原创——进程内即可，跨会话零持久化负担） */
const recency: string[] = []

/** 触碰频序：斜杠命令被提交时上浮至队首（菜单自适应个人习惯——高频命令零翻页） */
export function touchCommand(input: string): void {
  const key = input.trim().startsWith('/') ? input.trim().split(/\s+/)[0]!.toLowerCase() : null
  if (!key) return
  const i = recency.indexOf(key)
  if (i >= 0) recency.splice(i, 1)
  recency.unshift(key)
  if (recency.length > QUICK_COMMANDS.length) recency.pop()
}

/** 频序视图：用过的命令排前，未用过的保持目录定义序（stable） */
export function orderedQuickCommands(): Array<{ cmd: string; desc: string; cat: string }> {
  const rank = new Map(recency.map((c, i) => [c, i]))
  return [...QUICK_COMMANDS].sort((a, b) => {
    const ra = rank.get(a.cmd)
    const rb = rank.get(b.cmd)
    if (ra === undefined && rb === undefined) return 0
    if (ra === undefined) return 1
    if (rb === undefined) return -1
    return ra - rb
  })
}

/** 测试隔离：清空频序（进程内模块态——测试首尾调用） */
export function resetCommandRecency(): void {
  recency.length = 0
}

export function filterCommands(input: string): Array<{ cmd: string; desc: string; cat: string }> {
  const q = input.startsWith('/') ? input.slice(1).toLowerCase() : input.toLowerCase()
  // 上限放宽到 24：菜单可视窗口 8 行滚动翻页（用户反馈：命令无法翻页——此前 8 条截断看不到其余命令）
  return orderedQuickCommands().filter(c => c.cmd.toLowerCase().includes(q) || c.desc.includes(q)).slice(0, 24)
}

/**
 * 全目录菜单搜索（2026-09-03 用户裁决：「命令没有全部展示」——斜杠菜单从 19 条高频目录
 * 扩展到全量 registry 索引）。index 来自 cli 窄端注入的 commandIndex（cmd/desc/cat 单一事实源）；
 * index 为空（测试/未注入）回退高频目录。排序：用过优先（频序）→ 主干 → 名字序。
 */
export function searchAllCommands(input: string, index: Array<{ cmd: string; desc: string; cat: string }>): Array<{ cmd: string; desc: string; cat: string }> {
  const q = input.startsWith('/') ? input.slice(1).toLowerCase() : input.toLowerCase()
  const base = index.length > 0 ? index : orderedQuickCommands()
  const rank = new Map(recency.map((c, i) => [c, i]))
  return base
    .filter(c => c.cmd.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q))
    .sort((a, b) => {
      const ra = rank.get(a.cmd) ?? Number.MAX_SAFE_INTEGER
      const rb = rank.get(b.cmd) ?? Number.MAX_SAFE_INTEGER
      if (ra !== rb) return ra - rb
      const ca = CORE_COMMANDS.has(a.cmd) ? 0 : 1
      const cb = CORE_COMMANDS.has(b.cmd) ? 0 : 1
      if (ca !== cb) return ca - cb
      return a.cmd.localeCompare(b.cmd)
    })
}

/** 附件引用检测（原型 33 附件通道：@img/x.png 与 @path 引用——发送时经 kernel mentions 展开 +
 *  图片四层守卫（能力门/历史文本化/发送兜底/视觉降级）；最多 4 个防刷屏） */
export function detectAttachments(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const re = /@([^\s@]+\.[a-zA-Z0-9]{2,5})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null && out.length < 4) {
    const path = m[1]!
    if (!seen.has(path)) { seen.add(path); out.push(path) }
  }
  return out
}

// ── 全景索引（原型 53：registry COMMAND_DESC/CAT 经 cli 窄端注入 → 分组渲染）──

export interface IndexCommand { cmd: string; desc: string; cat: string }

/** 分类符号 → 中文组名（registry 分类符号唯一——原型 53 十一组对照） */
export const CAT_LABEL: Record<string, string> = {
  '◈': '对话', '⚙': '模型', '▤': '记忆', '◆': '构建', '⛨': '安全', '⬇': '离线',
  '◉': '系统', '❖': '视觉媒体', '⚿': '输入', '⛭': '网络集成', '◍': '协作',
  '☆': '工具', '⬡': '上下文',
}

/** 分组（稳定序 = CAT_LABEL 定义序；未知符号收归「其他」组尾——无孤儿命令自证） */
export function groupCommands(index: IndexCommand[]): Array<{ label: string; items: IndexCommand[] }> {
  const order = [...new Set([...Object.keys(CAT_LABEL).map(k => CAT_LABEL[k]!), '其他'])]
  const byLabel = new Map<string, IndexCommand[]>()
  for (const c of index) {
    const label = CAT_LABEL[c.cat] ?? '其他'
    const list = byLabel.get(label) ?? []
    list.push(c)
    byLabel.set(label, list)
  }
  return order.map(label => ({ label, items: byLabel.get(label) ?? [] })).filter(g => g.items.length > 0)
}

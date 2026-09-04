// src/tui/keys.ts — 快捷键单一事实来源（批次ⅩⅩⅤ：keySections() 渲染期构建——/lang 即切）
import { tuiT } from './i18n.js'
// src/tui/keys.ts — 快捷键单一事实来源（原型 30「动态生成·双列」的实现侧：
// 速查面板从本表生成——键位改动一处生效，面板/提示永不漂移）。
// 全部为已实现键位（零承诺漂移——绿色谎言零容忍）；原型 29/30 参考锚点见各节注释。

export interface KeySection {
  title: string
  rows: Array<[string, string]>
}

export function keySections(): KeySection[] {
  return [
  {
    title: tuiT('tui.keys.g.global'),
    rows: [
      ['Ctrl+C', tuiT('tui.keys.global.exit')],
      ['Esc', tuiT('tui.keys.global.esc')],
      ['Ctrl+T', tuiT('tui.keys.global.detail')],
      ['Ctrl+L', tuiT('tui.keys.global.clear')],
      ['Ctrl+S', tuiT('tui.keys.global.steer')],
      ['PgUp / PgDn', tuiT('tui.keys.global.page')],
    ],
  },
  {
    title: tuiT('tui.keys.g.composer'),
    rows: [
      ['Enter', tuiT('tui.keys.composer.enter')],
      ['Shift+Enter', tuiT('tui.keys.composer.newline')],
      ['/ 命令', tuiT('tui.keys.composer.slash')],
      ['Ctrl+↑↓', tuiT('tui.keys.composer.history')],
      ['↑↓', tuiT('tui.keys.composer.nav')],
    ],
  },
  {
    title: tuiT('tui.keys.g.chat'),
    rows: [
      ['Enter 排队', tuiT('tui.keys.chat.queue')],
      ['Ctrl+S', tuiT('tui.keys.chat.steer')],
      ['Esc', tuiT('tui.keys.chat.esc')],
    ],
  },
  {
    title: tuiT('tui.keys.g.overlay'),
    rows: [
      ['↑↓ / Enter', tuiT('tui.keys.overlay.select')],
      ['Esc', tuiT('tui.keys.overlay.esc')],
      ['Tab', tuiT('tui.keys.overlay.tab')],
      ['A（模型面板）', tuiT('tui.keys.overlay.a')],
    ],
  },
  {
    title: tuiT('tui.keys.g.entry'),
    rows: [
      ['/help', tuiT('tui.keys.entry.help')],
      ['/keys', tuiT('tui.keys.entry.keys')],
      ['/model · /theme · /config', tuiT('tui.keys.entry.panels')],
      ['/doctor · /build · /memory', tuiT('tui.keys.entry.core')],
      ['/paste · /voice', tuiT('tui.keys.entry.media')],
    ],
  },
  ]
}

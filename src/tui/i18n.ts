// src/tui/i18n.ts — TUI 文案 i18n 访问器（C-5 · 2026-08-30）
// catalog 复用 application/i18n 的 zh-CN/en 双语目录（tui.* 命名空间——键集两目录严格一致）；
// 语言源 = kernel 共享 Config 的 settings.lang（每渲染实时读取——/lang 即切即生效，无需重启）。
// TUI 零 DB/网络约束不变：catalog 是纯数据模块（静态 import）。
import { zhCN } from '../application/i18n/catalogs/zh-CN.js'
import { en } from '../application/i18n/catalogs/en.js'

export type TuiLang = 'zh-CN' | 'en'

/** 语言 getter（runtime 构造时装载——读 config settings.lang；默认中文） */
let getLang: () => TuiLang = () => 'zh-CN'

export function initTuiLang(getter: () => TuiLang): void {
  getLang = getter
}

/** 当前语言（组件渲染期调用——实时反映 /lang 切换） */
export function tuiLang(): TuiLang {
  return getLang()
}

/** 取 TUI 文案（{param} 占位替换；缺键回退中文目录再回退键名——绝不因翻译缺失崩渲染） */
export function tuiT(key: string, params?: Record<string, string | number>): string {
  const cat = getLang() === 'en' ? en : zhCN
  let s: string = (cat as Record<string, string>)[key] ?? (zhCN as Record<string, string>)[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v))
  }
  return s
}

// src/wxnodus-ui/lib/keyArg.ts — 工具调用关键参数提取（V4 UI 闭环·kimi 式 bullet 行）
// 机制参考 kimi-cli streamingjson extract_key_argument（增量 JSON 提取单关键参数）；
// 本实现为完整 JSON/正则两级提取（wxnodus 工具参数一次性携带，无需流式增量态）。
// 语义：工具行只显示「工具名 + 一个最关键参数」（path/command/query/url…）——
// 整段 JSON 参数平铺是「输出不重要信息」的来源之一。
const KEY_ARG_ORDER = [
  'path', 'file_path', 'file', 'filepath',           // 文件类工具：目标文件最关键
  'command', 'cmd', 'script',                        // bash/脚本：命令文本
  'query', 'q', 'search', 'pattern', 'expr',         // 检索类
  'url', 'uri', 'endpoint',                          // 网络类
  'name', 'id', 'sessionId',                         // 标识类
  'goal', 'prompt', 'text', 'content',               // 任务类兜底
] as const;

const MAX_LEN = 80;

/** 完整 JSON 提取：首个命中关键键的字符串值（按 KEY_ARG_ORDER 优先级） */
export function keyArgumentOf(argsText: string | undefined | null): string | null {
  if (!argsText) return null
  let obj: Record<string, unknown> | null = null
  try {
    const v = JSON.parse(argsText)
    if (v && typeof v === 'object' && !Array.isArray(v)) obj = v as Record<string, unknown>
  } catch { /* 半截 JSON（流式中途）——走正则级 */ }
  if (obj) {
    for (const key of KEY_ARG_ORDER) {
      const v = obj[key]
      if (typeof v === 'string' && v.trim()) return clip(v)
    }
    // 无关键键：取第一个字符串值字段（至少给一个可读线索）
    for (const v of Object.values(obj)) {
      if (typeof v === 'string' && v.trim()) return clip(v)
    }
    return null
  }
  // 正则级：半截 JSON 两级——完整键值对优先；未闭合串（流式中途）取到串尾
  for (const key of KEY_ARG_ORDER) {
    // 用字符串拼接构造正则体（避免模板串转义歧义）：KEY\s*:\s*"VALUE"
    const closedBody = '"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'
    const closed = new RegExp(closedBody).exec(argsText)
    if (closed?.[1]) {
      try { return clip(JSON.parse('"' + closed[1] + '"')) } catch { return clip(closed[1]) }
    }
    const openBody = '"' + key + '"\\s*:\\s*"([^\\\\"]*)$'
    const open = new RegExp(openBody).exec(argsText)
    if (open?.[1]) return clip(open[1])
  }
  return null
}

const clip = (s: string): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > MAX_LEN ? one.slice(0, MAX_LEN - 1) + '…' : one
}

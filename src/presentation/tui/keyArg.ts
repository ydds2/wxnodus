// src/presentation/tui/keyArg.ts — 工具关键参数提取（kimi code 风格化，2026-08-28）
// 机制参考：kimi-cli tools.extract_key_argument（按工具名取「最有信息量」的单一参数显示，
// 如 Read→file_path、Bash→command）——实现原创：wxnodus 工具表自建，回退语义相同
// （表外工具取首个非空字符串值；无字符串值取首键）。
export function extractKeyArgument(args: unknown, toolName: string): string {
  let obj: Record<string, unknown>;
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') {
    try { obj = JSON.parse(args) as Record<string, unknown>; } catch { return ''; }
  } else if (typeof args === 'object' && !Array.isArray(args)) {
    obj = args as Record<string, unknown>;
  } else {
    return '';
  }
  const key = KEY_ARG_TABLE[toolName];
  if (key) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const first = Object.keys(obj)[0];
  if (first === undefined) return '';
  const v = obj[first];
  return typeof v === 'string' ? v : `${first}=${JSON.stringify(v)}`;
}

const KEY_ARG_TABLE: Record<string, string> = {
  fs_read: 'path',
  fs_write: 'path',
  fs_edit: 'path',
  bash: 'command',
  ls: 'path',
  find_files: 'path',
  grep: 'pattern',
  http_get: 'url',
  http_request: 'url',
  web_search: 'query',
  memory_search: 'query',
  browser_navigate: 'url',
  browser_click: 'selector',
  browser_type: 'selector',
  delegate: 'goal',
  ask_user: 'question',
  notify: 'content',
  scaffold_build: 'name',
};

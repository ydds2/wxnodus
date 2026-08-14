// src/application/i18n/catalogs/zh-CN.ts — 中文消息目录（key 集与 en 严格一致）
export const zhCN = {
  'onboarding.selectLanguage': 'Select language / 选择语言\n\n  1. 中文\n  2. English',
  'onboarding.welcome': '系统语言已设为中文。欢迎使用 wxnodus！（/help 查看命令）',
  'config.argument.unknown': '未知参数',
  'config.argument.missing': '参数缺少值',
  'config.locale.invalid': '语言必须是 zh、zh-CN 或 en',
  'config.schema.invalid': '配置结构无效',
  'config.write.failed': '配置原子写入失败',
  'system.behavior': '遵循结构化策略与能力判定。',
  'cli.usage': `WxNodus V3 — 本地概念编译器 CLI

用法：
  wxnodus                    交互 TUI
  wxnodus -p "<需求>"        非交互单次执行
  wxnodus -p "<需求>" --json  agent 结果 JSON
  wxnodus -p "<需求>" --wire  总线事件流 JSONL
  wxnodus -C <目录>          指定工作目录
  wxnodus -s <会话ID>        指定会话
  wxnodus -p "需求" --strict-mcp-config  仅信任项目声明 MCP
  wxnodus --mcp-server              incoming MCP stdio 服务器（双工 discovery/tools）
  wxnodus --serve                   本地 AI 网关（HTTP，Bearer 认证）

选项：
  -p, --prompt <text>  非交互单次执行
      --json           -p 模式下输出 JSON
      --wire           -p 模式下输出 JSONL 事件流
      --strict-mcp-config 仅信任项目 .mcp.json 声明
      --mcp-server     incoming MCP stdio 服务器模式（需 WXNODUS_MCP_REQUEST_STATE_KEY）
      --serve          启动本地 AI 网关（--port 指定端口，默认 4789）
  -C, --cwd <dir>      工作目录
  -s, --session <id>   会话 ID
      --lang <zh-CN|en> 系统语言（首次启动选择；优先级 cli > env > workspace > user）
  -h, --help           帮助
  -v, --version        版本
`,
} as const;

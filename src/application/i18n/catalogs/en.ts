// src/application/i18n/catalogs/en.ts — English message catalog（key set 与 zh-CN 严格一致）
export const en = {
  'onboarding.selectLanguage': 'Select language / 选择语言\n\n  1. 中文\n  2. English',
  'onboarding.welcome': 'System language set to English. Welcome to wxnodus! (/help for commands)',
  'config.argument.unknown': 'Unknown argument',
  'config.argument.missing': 'Argument value is missing',
  'config.locale.invalid': 'Locale must be zh, zh-CN, or en',
  'config.schema.invalid': 'Configuration schema is invalid',
  'config.write.failed': 'Atomic configuration write failed',
  'system.behavior': 'Follow structured policy and capability decisions.',
  'cli.usage': `WxNodus V3 — Local Concept Compiler CLI

Usage:
  wxnodus                    interactive TUI
  wxnodus -p "<prompt>"      one-shot non-interactive run
  wxnodus -p "<prompt>" --json   agent result JSON
  wxnodus -p "<prompt>" --wire   JSONL event stream
  wxnodus -C <dir>           set working directory
  wxnodus -s <session-id>    select session
  wxnodus -p "prompt" --strict-mcp-config  trust project-declared MCP only
  wxnodus --mcp-server       incoming MCP stdio server (duplex discovery/tools)
  wxnodus --serve            local AI gateway (HTTP, Bearer auth)

Options:
  -p, --prompt <text>  one-shot non-interactive run
      --json           JSON output in -p mode
      --wire           JSONL event stream in -p mode
      --strict-mcp-config  trust project .mcp.json declarations only
      --mcp-server     incoming MCP stdio server mode (requires WXNODUS_MCP_REQUEST_STATE_KEY)
      --serve          start the local AI gateway (--port, default 4789)
  -C, --cwd <dir>      working directory
  -s, --session <id>   session id
      --lang <zh-CN|en>  system language (first-run choice; precedence cli > env > workspace > user)
  -h, --help           help
  -v, --version        version
`,
} as const;

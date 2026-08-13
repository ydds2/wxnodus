// src/cli/args.ts — 自研 CLI 参数解析器（替代 commander，零依赖）
// 支持：--flag / --flag value / -f value / -f=value / --flag=value / 位置参数
export interface CliOptions {
  prompt: string | null;
  json: boolean;
  wire: boolean;
  help: boolean;
  version: boolean;
  cwd: string | null;
  session: string | null;
  /** --strict-mcp-config：仅信任项目声明 MCP server（Claude Code 同款） */
  strictMcpConfig: boolean;
  /** --serve：启动本地 AI 网关（HTTP 服务，多前端共享 agent/记忆/权限） */
  serve: boolean;
  /** --port：网关监听端口（默认 4789） */
  port: number | null;
  /** --ephemeral：临时会话（Codex 对齐——不加载历史，结束后清理，不污染会话列表） */
  ephemeral: boolean;
  /** --output-schema <json>：--json 模式下输出结构校验（claude --json-schema / codex --output-schema 对齐，零依赖轻量校验） */
  outputSchema: string | null;
  positional: string[];
}

// 单一事实源：CLI flag 规范同时驱动解析器与 V3 兼容清单（src/compat/commandSurface.ts）
export const CLI_FLAG_SPEC: ReadonlyArray<{
  long: string;
  short?: string;
  key: keyof CliOptions;
  takeValue?: boolean;
  type: 'bool' | 'string';
}> = [
  { long: '--prompt', short: '-p', key: 'prompt', takeValue: true, type: 'string' },
  { long: '--json', key: 'json', type: 'bool' },
  { long: '--wire', key: 'wire', type: 'bool' },
  { long: '--help', short: '-h', key: 'help', type: 'bool' },
  { long: '--version', short: '-v', key: 'version', type: 'bool' },
  { long: '--cwd', short: '-C', key: 'cwd', takeValue: true, type: 'string' },
  { long: '--session', short: '-s', key: 'session', takeValue: true, type: 'string' },
  { long: '--strict-mcp-config', key: 'strictMcpConfig', type: 'bool' },
  { long: '--serve', key: 'serve', type: 'bool' },
  { long: '--port', key: 'port', takeValue: true, type: 'string' },
  { long: '--ephemeral', key: 'ephemeral', type: 'bool' },
  { long: '--output-schema', key: 'outputSchema', takeValue: true, type: 'string' },
];

const SPEC = CLI_FLAG_SPEC;

export function parseArgs(argv: string[]): CliOptions {
  const out: CliOptions = { prompt: null, json: false, wire: false, help: false, version: false, cwd: null, session: null, strictMcpConfig: false, serve: false, port: null, ephemeral: false, outputSchema: null, positional: [] };
  let i = 0;
  const findSpec = (tok: string): { spec: (typeof SPEC)[number]; inline?: string } | null => {
    for (const spec of SPEC) {
      if (tok === spec.long || (spec.short && tok === spec.short)) return { spec };
      if (spec.takeValue) {
        const prefix = spec.long + '=';
        if (tok.startsWith(prefix)) return { spec, inline: tok.slice(prefix.length) };
      }
    }
    return null;
  };
  while (i < argv.length) {
    const tok = argv[i]!;
    const hit = findSpec(tok);
    if (!hit) {
      if (tok.startsWith('-')) { /* 未知 flag 忽略（保持宽松） */ i++; continue; }
      out.positional.push(tok);
      i++;
      continue;
    }
    const { spec, inline } = hit;
    if (spec.type === 'bool') {
      (out as any)[spec.key] = true;
      i++;
    } else {
      const value = inline ?? argv[i + 1];
      (out as any)[spec.key] = value ?? null;
      i += inline !== undefined ? 1 : 2;
    }
  }
  if (out.port !== null) {
    const n = Number(out.port);
    out.port = Number.isFinite(n) && n > 0 ? n : null;
  }
  // P1-6：Git Bash MSYS 路径转换检测——`-p "/help"` 被改写为 `C:/Program Files/Git/help`，
  // 命令文本被破坏路由到 AI 层；给出明确修正指引（Windows Git Bash 特有）
  if (out.prompt && /(?:program files[\\/]git[\\/]|programfiles[\\/]git[\\/])/i.test(out.prompt)) {
    process.stderr.write(
      'wxnodus: -p 参数疑似被 Git Bash 的 MSYS 路径转换改写（如 /help → C:/Program Files/Git/help）\n' +
      '  修正：命令前加 MSYS_NO_PATHCONV=1（如 MSYS_NO_PATHCONV=1 wxnodus -p "/help"），\n' +
      '  或 MSYS2_ARG_CONV_EXCL="*" 全局禁用转换。\n'
    );
    process.exit(2);
  }
  return out;
}

export const USAGE = `WxNodus V3 — 本地概念编译器 CLI

用法：
  wxnodus                    交互 TUI
  wxnodus -p "<需求>"        非交互单次执行
  wxnodus -p "<需求>" --json  agent 结果 JSON
  wxnodus -p "<需求>" --wire  总线事件流 JSONL
  wxnodus -C <目录>          指定工作目录
  wxnodus -s <会话ID>        指定会话
  wxnodus -p "需求" --strict-mcp-config  仅信任项目声明 MCP

选项：
  -p, --prompt <text>  非交互单次执行
      --json           -p 模式下输出 JSON
      --wire           -p 模式下输出 JSONL 事件流
      --strict-mcp-config 仅信任项目 .mcp.json 声明
  -C, --cwd <dir>      工作目录
  -s, --session <id>   会话 ID
      --lang <zh-CN|en> 系统语言（首次启动选择；优先级 cli > env > workspace > user）
  -h, --help           帮助
  -v, --version        版本
`;

// W2-01：严格 pre-bootstrap parser 单一入口（unknown flag 不再忽略——onboarding 之前即可判定）
export { parsePreBootstrapArgs } from '../application/bootstrap/preBootstrapOnboarding.js';

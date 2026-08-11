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
  positional: string[];
}

const SPEC: Array<{ long: string; short?: string; key: keyof CliOptions; takeValue?: boolean; type: 'bool' | 'string' }> = [
  { long: '--prompt', short: '-p', key: 'prompt', takeValue: true, type: 'string' },
  { long: '--json', key: 'json', type: 'bool' },
  { long: '--wire', key: 'wire', type: 'bool' },
  { long: '--help', short: '-h', key: 'help', type: 'bool' },
  { long: '--version', short: '-v', key: 'version', type: 'bool' },
  { long: '--cwd', short: '-C', key: 'cwd', takeValue: true, type: 'string' },
  { long: '--session', short: '-s', key: 'session', takeValue: true, type: 'string' },
  { long: '--strict-mcp-config', key: 'strictMcpConfig', type: 'bool' },
];

export function parseArgs(argv: string[]): CliOptions {
  const out: CliOptions = { prompt: null, json: false, wire: false, help: false, version: false, cwd: null, session: null, strictMcpConfig: false, positional: [] };
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
  -h, --help           帮助
  -v, --version        版本
`;

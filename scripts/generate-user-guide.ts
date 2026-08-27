// scripts/generate-user-guide.ts — P2-16（2026-08-27）：离线用户手册生成（确定性）
// 产物：docs/user-guide.md（命令总览/退出码/安全模式/协议入口——气隙机器零网可查；
// 随 zip 安装包分发，见 scripts/package-installer.ts 的 staged 树）。
// 用法：npm run docs:user-guide
// 诚实纪律：手册由命令注册表（单一事实源）确定性生成——绝不手写第二份命令清单。
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_DESC, COMMAND_CAT, SLASH } from '../src/commands/registry.js';
import { WXNODUS_VERSION } from '../src/kernel/version.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
const version = pkg.version || WXNODUS_VERSION;

const categories = [...new Set(SLASH.map(c => COMMAND_CAT[c] ?? '其他'))];
const byCat = (cat: string) => SLASH.filter(c => (COMMAND_CAT[c] ?? '其他') === cat).sort();

const md = [
  '# wxnodus 用户手册（离线版）',
  '',
  `> 版本 ${version} · 由命令注册表确定性生成（\`npm run docs:user-guide\`）· 气隙/内网机器零网可查。`,
  '',
  '## 1. 快速开始',
  '',
  '```bash',
  'npm install && npm run build && npm link',
  'wxnodus                          # 交互模式（薄层 TUI）',
  'wxnodus -p "帮我做一个待办系统"    # 非交互单次执行',
  'wxnodus -p "你好" --json          # 结构化 JSON 结果',
  'wxnodus -p "你好" --wire          # 事件流 JSONL（stdin 帧 RPC 双向）',
  'echo 文件内容 | wxnodus -p "总结"  # stdin 管道（-p 为指令、stdin 为素材）',
  'wxnodus --serve                   # 本地 HTTP 网关（Bearer+CSRF+会话所有权）',
  'wxnodus --mcp-server              # incoming MCP stdio 服务器',
  'wxnodus -p "/acp server"          # ACP stdio（Zed/JetBrains 接入）',
  '```',
  '',
  '## 2. 命令总览',
  '',
  ...categories.map(cat => {
    const rows = byCat(cat);
    return [`### ${cat}`, '', '| 命令 | 说明 |', '|---|---|', ...rows.map(c => `| \`${c}\` | ${(COMMAND_DESC[c] ?? '').replace(/\|/g, '\\|')} |`), ''].join('\n');
  }),
  '## 3. 退出码协议',
  '',
  '| 码 | 语义 |',
  '|---|---|',
  '| 0 | 成功（终态 succeeded） |',
  '| 1 | 失败/受阻（终态非 succeeded） |',
  '| 42 | 输入错误（参数/配置不合法） |',
  '| 53 | 轮次上限 |',
  '',
  '（对齐 gemini headless 分类学；`--wire` 终态经 `agent.result.wireFinal` 六值：succeeded/failed/blocked/incomplete/inconclusive/cancelled。）',
  '',
  '## 4. 权限模式',
  '',
  '| 模式 | 语义 |',
  '|---|---|',
  '| smart（默认） | 只读放行；写/网络/危险确认 |',
  '| auto | 自动编辑：文件编辑自动接受；bash 按分级、危险确认 |',
  '| goal | loop-goal：目标驱动自主循环 |',
  '| manual | 全量确认（只读也确认） |',
  '| plan | 计划模式：只读放行、非只读计划审批 |',
  '| yolo | 完全访问（红线除外） |',
  '',
  '硬红线（.env/密钥文件等敏感写）任何模式不可绕过；规则优先级 deny > ask > allow（同 priority 平局裁决）。',
  '',
  '## 5. 模型与密钥',
  '',
  '- 任意 OpenAI 兼容端点：`/model add <模型ID[,ID2]> --base <URL> [--name 名称] [--key 密钥]`（内网私有端点见 `docs/private-endpoints.md`）；',
  '- 密钥 `/model set-key <密钥>`——AES-256-GCM 本机加密落盘，明文绝不落盘/回显；',
  '- 企业代理：`HTTP_PROXY/HTTPS_PROXY/NO_PROXY` 环境变量或 WinINET 系统代理自动生效；**私网段默认直连不经代理**（数据不出机红线）。',
  '',
  '## 6. 协议入口（第三方集成）',
  '',
  '| 入口 | 文档 |',
  '|---|---|',
  '| `--wire` 事件流 | `docs/wire-protocol.md` |',
  '| `--serve` HTTP 网关 | `docs/serve-protocol.md` |',
  '| ACP（Zed/JetBrains） | `docs/acp-zed-jetbrains.md` |',
  '',
  '## 7. 诊断与体检',
  '',
  '`wxnodus doctor`——配置/数据库完整性/审计链/黑洞记忆/原生依赖/策略层/网络代理/磁盘余量结构化体检（`doctor local` 离线）。',
  '',
].join('\n') + '\n';

// UTF-8 BOM 前置（docs/*.md 统一 BOM 口径——无 BOM 的 UTF-8 中文在部分 Windows 查看器按 ANSI/GBK 显示成乱码；
// ci 有 check:docs-encoding 门禁强制该口径，生成器必须同口径输出）
writeFileSync(join(ROOT, 'docs', 'user-guide.md'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(md, 'utf8')]));
console.log(`USER_GUIDE_OK: docs/user-guide.md（${SLASH.length} 条命令 · ${categories.length} 分类 · v${version}）`);

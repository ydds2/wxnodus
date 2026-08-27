# wxnodus 二开指南（扩展生态 · 只收不出）

> 版本：V1（2026-08-27）· 定位：像区块链代币一样允许任何人二开成体系——
> Apache-2.0 全开源、协议面版本化稳定、扩展面全部遵循开放标准；
> **只消费开源生态（npm registry / GitHub topic），不自建插件市场**；对外分享唯一通道 `/bundle`。
> 全部锚点 = 本仓源码 file:path（与本会话 7 路竞品深潜的引用标注同源）。

## 1. 扩展面总览（六类）

| # | 扩展面 | 开放标准 | 消费命令 | 核心锚点 |
|---|---|---|---|---|
| 1 | 插件 | `plugin.json` + `index.js`（自定义格式） | `/plugin install`（目录/zip/https）· `/market install <npm包> --type plugin` | `src/application/extensions/pluginInstaller.ts` |
| 2 | 技能 | **SKILL.md**（agentskills.io 兼容子集，跨品牌目录 `.claude/.agents/.codex/.gemini` 通吃） | `/skill list` / `skill_load` 工具 / `/market install <npm\|github> --type skill` | `src/kernel/skills.ts` |
| 3 | MCP（消费） | **MCP 协议**（stdio + Streamable HTTP；2024-11-05） | `/mcp add` / `/market install <npm包> --type mcp`（写 `.mcp.json`，Claude Code 生态兼容） | `src/kernel/mcp.ts` |
| 4 | MCP（供给） | **MCP 协议**（`--mcp-server` stdio / `--serve` /mcp Streamable HTTP）——把 wxnodus 本身当 MCP server | `wxnodus --mcp-server` | `src/cli/index.ts` |
| 5 | Hooks | 环境变量契约（本地进程）——userPromptSubmit/preToolUse/postToolUse/preCompact/postCompact/sessionStart/sessionEnd/stop/**notification**/subagentStart/Stop | settings.hooks 配置 | `src/kernel/hooks.ts` |
| 6 | 协议集成 | `--wire` 事件流（JSONL+stdin 帧 RPC）、`--serve` HTTP 网关（Bearer+CSRF）、**ACP**（Zed/JetBrains）、A2A | 任意语言消费 | `docs/wire-protocol.md` / `docs/serve-protocol.md` / `docs/acp-zed-jetbrains.md` |

## 2. 插件二开（最小可运行）

**目录结构**（`plugin.json` + `index.js`，与 `/forge` 生成物同构）：

```json
// plugin.json
{ "name": "my-plugin", "version": "1.0.0", "description": "示例",
  "tools": [{ "name": "my_hello", "description": "打招呼", "parameters": { "name": { "type": "string" } } }] }
```

```js
// index.js
export const tools = { my_hello: async (args) => `你好，${args.name ?? '世界'}` };
```

**安装与分发**：

```bash
/plugin install <目录|zip|https URL>   # 本地/URL 三源（URL 走 SSRF 三层 + sha256 证据）
/market install <npm包名> --type plugin  # npm 消费（registry SRI sha512 校验 + 安全解包）
/plugin enable <名称>                  # 启用（manifest→checksum→probe→沙箱门→owned scope 原子换入）
/bundle create my-pack && /bundle add my-pack plugin npm:<包> && /bundle export my-pack
# → tar.gz 离线分发（对方 /bundle import 装回）——「只收不出」的唯一分享通道
```

**安全约束（二开者须知）**：插件能力请求（workspace/network/process）走生产 ToolExecutionPipeline；Untrusted 插件强制沙箱（不可用时 quarantined，**绝不降级宣称安全**）；manifest 解析失败/路径穿越/损坏包一律拒装（`plugin-installer.test.ts` 锁定）。

## 3. 技能二开（SKILL.md）

```markdown
---
name: my-workflow
description: 三句话说明何时用
---

# 工作流正文（模型 skill_load 后照此执行）
1. …
```

- 目录约定：项目 `.wxnodus/skills/`、跨品牌 `.claude/skills/`、`.agents/skills/`、`.codex/skills/`、`.gemini/skills/`、用户 `data/skills/`（`src/kernel/skills.ts:54-90`——**一份 SKILL.md 六家通用**）；
- 消费：`/skill list` + `skill_load` 工具（模型自主触发）；`/market install github:<owner>/<repo> --type skill`；
- 生成：`/forge skill <工具名>`（工具签名 → SKILL.md 打包，组件化构建）。

## 4. MCP 双向

- **消费**：`/mcp add <名称> --command <...>`（stdio）/ `/mcp add-http <名称> <url>`（Streamable HTTP，SSE/JSON 双响应兼容）；`/market install <npm> --type mcp` 写 `.mcp.json`（npx 形式——Claude Code 生态标准）；lazy-respawn 自愈（30s 冷却防风暴）。
- **供给**：`wxnodus --mcp-server`（stdio）或 `wxnodus --serve` 的 `/mcp`（Streamable HTTP）——把 wxnodus 变成别家 agent 的 MCP 工具源。

## 5. Hooks（本地进程契约）

每个 hook = 独立本地进程；上下文经环境变量 `WXNODUS_HOOK_EVENT` / `WXNODUS_HOOK_DATA`（JSON）传入：
- `preToolUse`：输出 `DENY:` 开头即真实拦截工具（fail-closed 语义，`kf-026` 回归锁定）；
- `preCompact`：输出 `BLOCK` 可阻止自动压缩；
- `notification`：后台任务通知回流主线前触发（P2-15 接线，2026-08-27）——可观测/记录，hook 异常不阻断注入。

## 6. 协议面（版本化稳定承诺）

| 协议 | 版本 | 文档 | 稳定语义 |
|---|---|---|---|
| wire 事件流 | v1 | `docs/wire-protocol.md` | JSONL 信封 + stdin 帧 RPC（approval/clarify/secret/form.respond）+ `agent.result` 六终态 + 退出码 0/1/42/53 |
| serve 网关 | v1 | `docs/serve-protocol.md` | `/health(live)` / `/rpc` / `/events` SSE / `/mcp`；Bearer+CSRF+会话所有权三重防护 |
| ACP | stdio JSON-RPC | `docs/acp-zed-jetbrains.md` | Zed/JetBrains 接入；每 prompt 独立 Run、可取消 |
| 会话互操作 | — | `sessionImport.ts` | Claude Code / Codex JSONL 自动嗅探导入；`/export --md` |

**二开纪律**（用户长期约束的落地口径）：机制与语义可参考同类 CLI（codex/gemini-cli/opencode/kimi-cli/crush/aider），互通契约（MCP/ACP/AGENTS.md/SKILL.md/OpenAI 协议）自由遵循；实现须原创并如实记录差异（见 `docs/kimi-gap-alignment-ledger.md` 的台账纪律）。

## 7. 消费链证据（测试锚点）

| 链路 | 证据 |
|---|---|
| 插件三源安装 + 回滚 + 穿越拒绝 | `tests/plugin-installer.test.ts`（含 npm 链 3 用例，2026-08-27 补全） |
| npm/GitHub 市场搜索 + 技能/MCP 安装（SRI 校验） | `tests/kernel-market.test.ts` |
| SKILL.md 发现/解析/安装（跨品牌目录） | `tests/kernel-skills.test.ts` |
| MCP stdio/HTTP 双传输 + 自愈 | `tests/kernel-mcp.test.ts`、`tests/w2-mcp-duplex.contract.test.ts` |
| /bundle 导出导入往返 + 篡改拒装 | `tests/kernel-bundle.test.ts` |
| 插件沙箱生命周期 | `tests/plugin-sandbox-lifecycle.test.ts` |

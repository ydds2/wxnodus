# OASIS 全栈异构兼容平台 —— 融入 wxnodus 内核与命令的可行性裁决与实施规划（2026-09-03）

> 输入：OASIS 落地实施计划书 v2.0（企业级全栈异构兼容运行时平台）。
> 问题：该计划能否实现并融入 wxnodus 的内核与命令中？
> 结论先行：**不能整体照搬（它 80% 是企业基础设施平台，不属于本地 CLI 的内核）；但它的「统一编排哲学」在 wxnodus 中已经以标准协议形态实现约 60-70%——剩余部分可按五里程碑分步落地为命令面 + 内核服务。** 本文给出逐层映射、裁决理由、路线图与已落地的 M1 证据。

---

## 1. 裁决（三层）

| 层 | 裁决 | 理由 |
|---|---|---|
| **统一接入哲学**（异构组件注册/发现/通信/协作于同一运行时） | ✅ **已在 wxnodus 内核实现** | MCP（任意语言组件）、ACP/A2A（异构客户端/智能体）、wire/serve（异构前端）、plugins/skills（组件化）、correlationId+审计链+证据链（全链路治理）——wxnodus 就是「AI 组件域的 OASIS」，且零重写 |
| **可融入的命令面与内核服务**（注册表视图/拓扑/协议桥/遥测） | ✅ **分五里程碑落地**（M1 本轮已落地） | 见 §4；每步一个命令 + 一个内核服务 + 契约测试，可独立验收 |
| **企业基础设施平台部分**（微前端运行时/服务网格/K8s/CDC/分布式事务/密钥平台） | ❌ **不进入 wxnodus 内核** | wxnodus 是 Windows 本地 CLI（单进程、薄层、数据主权本机）；正确姿态是用 49 个内置工具**编排**这些设施，而不是在 Node 进程里**实现**它们。硬塞违反自身架构与「市场只收不出」等四战略约束（见 §5） |

---

## 2. OASIS 计划书七层 ↔ wxnodus 内核逐层映射

| OASIS 计划书（v2.0） | wxnodus 现状（已取证） | 差距与动作 |
|---|---|---|
| L1 接入层（Web/Desktop/Mobile/CLI/IDE/IoT） | ✅ TUI + `--wire`（JSONL 事件流）+ `--serve`（HTTP 网关，实测 Bearer 401 面）+ ACP（Zed/JetBrains，实测 initialize）+ VS Code 插件 + @wxnodus/sdk（实测握手） | 无差距——六入口全在且实测可用 |
| L2 统一网关层（API 网关/认证/流控/协议转换） | ⚠️ 部分：serve 网关 + outboundTargetPolicy（SSRF fail-closed）+ wire 双向 RPC（approval.respond 实测） | 协议转换（MCP↔A2A↔wire）缺统一入口 → **M3 /oasis bridge** |
| L3 统一协议层（服务发现/配置中心/事件总线/遥测） | ✅ 服务发现=MCP initialize/discovery（实测 stdio+HTTP）；配置中心=settings+config.yaml（/config 实测）；事件总线=bus（typed events，wire 事件流实测五事件）；遥测=correlationId+audit 哈希链+evidence+session-stream | 无差距——命名不同、机制同构 |
| L4 核心运行时（前端/后端/数据/中间件四运行时） | ✅ 前端运行时=TUI+wire 前端投影管线（W3-02）；后端运行时=组合根+runInvocation+KernelBridges；数据抽象=黑洞引擎（FTS5 中文 bigram+向量，实测）+evidence store+sqlite；中间件抽象=49 内置工具（fs/bash/browser/computer/LSP/apply_patch…全过 pipeline） | 「OASIS-RPC」=MCP JSON-RPC；「OASIS-MQ」=bus；无需自研新协议 |
| L5 框架适配层（React/Vue/Java/Go/MySQL/Kafka…） | ✅ 任意语言组件经 MCP 标准协议接入（官方 SDK 覆盖 Python/Go/Java/Rust/Node）——适配成本在组件侧，不在 wxnodus 侧 | `/mcp add` 即「零侵入接入」；改造量 0%，优于计划书 ≤5% 目标 |
| L6 异构应用/服务层 | ✅ 会话/任务/子代理/后台终端（/jobs /term /delegate 实测） | 无需新做 |
| L7 基础设施层（K8s/Istio/CI-CD/监控） | ✅ 工具编排而非内核实现：bash/kubectl/helm 等经 ToolExecutionPipeline 真实执行（K8s 集群可由 wxnodus 操作） | 不新建 Harbor/Vault——用 /bundle、密钥 AES-256-GCM（实测无明文）与用户既有设施 |

**结论**：计划书里所有「统一」类能力，wxnodus 内核都有对应物，且基于**标准协议**而非自研闭协议——这是 wxnodus 相对 OASIS 计划书自研方案（OASIS-RPC/OASIS-QL/OASIS-MQ）的架构级优势：互通性契约不算抄袭，生态即插即用。

---

## 3. 关键修正：OASIS 计划书里不适用于 wxnodus 的假设

| 计划书假设 | 修正 |
|---|---|
| 29 人 / 18 个月 / 1752 万元（企业平台项目制） | wxnodus 是单仓产品迭代——单人节奏，每里程碑 ≤1 个迭代（本文路线图 M1 已用 1 轮完成） |
| 自研 OASIS-RPC/OASIS-QL/OASIS-MQ/多语言 SDK | **零自研协议**：直接采用 MCP/ACP/A2A/CloudEvents 标准；多语言 SDK 复用官方生态 |
| 微前端运行时（wujie/qiankun/iframe 沙箱）进内核 | ❌ 不属于本地 CLI；前端异构已由 wire/serve 前端投影解决（任何前端渲染任意 OutputEvent） |
| Istio/Envoy Sidecar、CDC（Debezium）、2PC/Saga/TCC 协调器进内核 | ❌ 基础设施能力——wxnodus 用工具编排（bash/kubectl/helm），进程内永不实现第二套服务网格 |
| 监控大盘（Grafana 模板）/配置中心（Nacos/Apollo） | 以命令面形态落：/oasis status/topo + /eco 面板 + /config——CLI 优先，大盘按需经 --serve 供桌面端渲染 |

---

## 4. wxnodus 版 OASIS 路线图（命令面 + 内核服务，每步可验收）

| 里程碑 | 交付 | 内核/命令落点 | 验收标准 | 状态 |
|---|---|---|---|---|
| **M1 统一运行时门户** | `/oasis status`（全栈组件注册表：MCP×语言/插件/会话/任务/终端/生态/协议入口）+ `/oasis topo`（依赖拓扑） | `src/commands/ext/oasisCommands.ts` + registry 三表 + 契约测试 | 4 契约测试绿；空环境诚实零；三表一致 | ✅ **本轮已落地（见 §6 实测）** |
| M2 组件健康探针 | `/oasis health [名称]`：对已注册 MCP 逐个**真实 initialize 协商**（stdio/streamable-http 双传输；HTTP 先过 SSRF 策略）+ era/协议版本/延迟；坏组件报真因不假在线 | `oasisCommands.ts` + `mcpClientHost.connectMcp`（复用 /mcp connect 链路）+ `McpTransportPolicy` | 契约 9 用例绿；真机 1 活 1 死 → `✓ mini 5179ms` / `✗ dead — Connection closed`，1/2 零假装 | ✅ **本轮已落地（见 §6.2）** |
| M3 协议桥 | `/oasis bridge export <组件> --as agent-card`：把已注册 MCP 工具集导出为 A2A agent card；反向把 wxnodus 能力经 --mcp-server 对外发布（mcpServerWiring 已实测） | kernel/a2a + mcpServerWiring + 生成器 | MCP 工具 ↔ A2A 双向可调用（本地环回，同 kernel-protocols 测试模式） | 待做 |
| M4 全链路追踪视图 | `/oasis trace <correlationId>`：从审计链+session-stream+evidence 重建一次跨栈调用链（OASIS 3.3.4 的 CLI 形态） | audit/evidence/session-stream 三源合并投影 | 端到端 demo：wire 前端→命令→工具→审计，链路逐步可还原 | 待做 |
| M5 TUI 运行时面板 | 帮助面板第 4 页「运行时」：组件/拓扑/生态三视图（数据源=M1 命令面） | Overlays HelpPanel + runtime 窄端注入 | 面板与命令面零漂移（同一数据源） | 待做 |

**内核侧共用服务（M2 起）**：`componentRegistry`（统一发现接口：MCP/plugin/a2a/session/task 一源）——注册表视图不再散装查询，TUI/命令/wire 三前端共用。

---

## 5. 明确不做（尊重 wxnodus 架构与既有裁决）

1. **微前端运行时**（wujie/qiankun 集成）不进内核——前端异构已由 wire/serve 协议投影解决。
2. **第二套服务网格/CDC/分布式事务协调器**——用工具编排用户既有设施；进程内零实现。
3. **自研协议**（OASIS-RPC/QL/MQ）——一律采用标准协议（MCP/ACP/A2A），互通性契约优先。
4. **云平台依赖**（Nacos/Apollo/Harbor/Vault）——本地优先：settings+config.yaml+AES-256-GCM 密钥（已实测无明文）。
5. **组织/预算/发布节奏照搬**——按单仓迭代节奏执行，不引入企业项目制开销。

---

## 6. M1/M2 落地证据（本轮真实运行）

- registry 三表：SLASH=COMMAND_DESC=COMMAND_CAT=**122=122=122**（+1 /oasis），主干 47/扩展 75；`/help all` 实测 122 行 13 组。
- 契约测试 `tests/oasis-command.test.ts`：**9 用例**（三表注册/空环境诚实零/真实数据源渲染/未装配 fail-closed/health 全在线/部分失败报真因/单探过滤/SSRF fail-closed）——绿。
- 实测输出（`/oasis status`，空环境）：MCP 服务器 0 个（未配置——/mcp add 接入任意语言组件）、插件 0 个、会话 0 个、生态依赖 9/11 可用（缺项诚实列出）、协议入口全列。
- 实测输出（`/oasis topo`）：会话→模型→MCP 树→插件→任务/终端→记忆/审计 六段拓扑。
- **M2 真机探活**（真实 stdio 服务器 + 一个死服务器）：`✓ [Node] mini — era legacy · 协议 2025-03-26 · 5179ms`；`✗ [Node] dead — Connection closed`；汇总 `在线 1/2——全部真实 initialize 协商（零假装）`；单探 `/oasis health mini` → 1/1。
- 回归：`tui-selfbuilt/commands/compat-v3-manifest` 随跑绿；`docs/user-guide.md` 重生成至 122 条；docs 编码/链接/环依赖门禁绿。

### 6.1 每个里程碑的通用实现方法（方法论）

1. **数据源单一事实**：命令不建第二份目录——一律复用既有内核面（loadMcpConfig/getPlugins/db/probeEcosystem）。
2. **真实执行零假装**：探活走真实 SDK 协商；失败报真因；未装配面 fail-closed 明说。
3. **三表注册**：registry SLASH/COMMAND_DESC/COMMAND_CAT 同步 + 审计脚本核对 122=122=122。
4. **测试三层**：契约测试（vi.mock 内核面，锁定输出契约）→ 真机夹具（.tmp/mini-mcp-server.mjs 真实 stdio 服务）→ 门禁（build/test/一致性/文档）。
5. **文档同步**：user-guide 重生成 + 评估文档证据化。

### 6.2 M2 实现要点

1. 复用 `/mcp connect` 链路：`connectMcp(config, AbortSignal.timeout(20_000))`（mcpClientHost SDK 协商）+ `McpTransportPolicy.assertHttpTarget`（HTTP 目标 SSRF 先验——loopback 拒绝有契约测试锁定）。
2. 逐组件顺序探测（单轮上限 8 防资源风暴）；完成后 `dispose()` 回收连接。
3. 输出契约：成功 `✓ [语言] 名称 — era · 协议 · 延迟ms`；失败 `✗ [语言] 名称 — 真因`；汇总 `在线 N/M——零假装`。

### 6.3 M3/M4/M5 具体实现设计（下一步怎么做）

**M3 协议桥 `/oasis bridge`**：
- 正向：`connectMcp` 拿到 connected client → `listTools()` → 工具名/描述/JSON Schema 参数 → 生成 A2A agent-card.json（skills 映射），`--out <路径>` 落盘——任何 MCP 组件即刻变成可被 Zed/JetBrains/其他智能体发现的 agent。
- 反向：wxnodus 已有 `--mcp-server`（WxNodusMcpServer 对外发布 builtin 工具，实测 initialize 握手）——补 `--tools <白名单>` 参数即可选择性发布。
- 验收：本地环回（kernel-protocols 的 A2A 测试模式）：agent card → messages/send → bridge 转发 MCP 工具调用 → 应答闭环。

**M4 全链路追踪 `/oasis trace <correlationId>`**：
- 三源合并：audit 哈希链（库表）+ session-stream（会话事件）+ evidence store（dataDir/evidence/*.json，含 sha256 绑定）。
- 投影：按时间排序输出「前端/命令 → 工具调用 → 审批 → 证据收据」链路行；correlationId 未命中如实报无记录（零编造）。
- 验收：e2e mock 跑一个带工具回合后，`/oasis trace <corrId>` 还原 ≥4 段链路且各段有审计锚点。

**M5 TUI 运行时面板**：
- 把 `/oasis` 的取数抽为 `oasisView.ts` 共享模块（命令面与 TUI 同源——零漂移），HelpPanel 加第 4 页（Tab 循环 3→4），runtime 经窄端注入 dataDir/getPlugins/term。
- 验收：PTY 探针 Tab×3 到第 4 页，组件计数与 `/oasis status` 输出一致。

---

## 7. 对计划书本身的评价（一句话版）

OASIS v2.0 是**合格的企业平台立项书**（分层清晰、风险表与 KPI 专业），但它选错了「自研协议 + 全家桶」路线——在 2026 年的生态里，标准协议（MCP/ACP/A2A/OTel/CloudEvents）已经把「异构组件统一运行时」从 18 个月的平台工程降维成「一个注册表 + 一个桥 + 一个视图」。wxnodus 的内核已站在正确一侧；本路线图把它补完即可。

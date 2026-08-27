# wxnodus 4.0 CLI 完整架构说明

> 版本：2026-08-27 · 基于仓库当前状态（UI 已移除，仅非交互入口）· 证据纪律：关键落点带 `file:line`；本轮未精读处标 ⚠️ 并注明锚点来源。

---

## 1. 定位与设计原则

**一句话定位**：Windows 原生 · 数据不出机 · 无账号无订阅 · 任意 OpenAI 兼容端点的开源 AI agent CLI。

**四条产品约束（用户裁定，长期有效，一切架构决策的过滤器）**：

1. **只收不出**：不建自托管市场/账号体系——消费开源生态（npm registry / GitHub topic 聚合）+ `/bundle` 离线整包分发；
2. **CLI 主体对齐同类**：交互形态、可靠性机制、命令面语义对齐 codex/gemini-cli/opencode/kimi-cli/crush/aider——抄「机制与语义」不抄「代码与文案」，实现一律按本仓架构重写；
3. **独有功能冻结维护 + 离线运行能力裁撤**：黑洞记忆、`/build` 概念编译器、UIA 桌面控制、合规链、winSandbox、ACP/A2A、`/jobs`+`/cron`、成本计价只修缺陷不扩特性；离线对话/离线看图/无 key 可用层软着陆移除（`WXNODUS_LEGACY_OFFLINE=1` 逃生开关）；
4. **用户两大权力**：自主升级权（`wxnodus update`，绝不自动装）+ 用户产物迁移兼容权（任何破坏产物兼容的改动必须带迁移器）。

**技术底座**：Node ≥22 · TypeScript 严格 ESM（`module: NodeNext`）· better-sqlite3（+sqlite-vec+FTS5）· AES-256-GCM 密钥加密 · robotjs+playwright-core（computer use）。

---

## 2. 架构总览：七层 + 两条横贯总线

```
┌─────────────────────────────────────────────────────────────────┐
│ presentation/    四个前端适配器（每种入口一个）                       │
│   cli/  http/  wire/  shared/  tui/(投影管线残部)                  │
├─────────────────────────────────────────────────────────────────┤
│ bootstrap/       组合根：装配全部依赖、桥接、生命周期、资源回收        │
│   cliComposition.ts  compositionRouting.ts  create*Frontend.ts    │
├─────────────────────────────────────────────────────────────────┤
│ application/     应用服务层（21 个竖向模块）                         │
│   tools/ sessions/ memory/ models/ mcp/ computer/ build/ …        │
├─────────────────────────────────────────────────────────────────┤
│ domain/          领域层（15 个竖向模块，纯逻辑、可单测）               │
│   tools/(管线) security/(pdp) effects/ sessions/ …                │
├─────────────────────────────────────────────────────────────────┤
│ infrastructure/  基础设施层（17 个模块，只干活不决策）                 │
│   sqlite/ fs/ process/ http/ mcp/ skills/ browser/ code/ …        │
├─────────────────────────────────────────────────────────────────┤
│ kernel/          内核（110 文件）——agent 循环/流式/工具/权限/记忆/    │
│                  沙箱/供应商/子代理/事件/持久化                       │
├─────────────────────────────────────────────────────────────────┤
│ store/  migrations/  release/  policy/  compliance/  build/       │
│   持久化   schema/数据  发布链    规则链     审计链    需求编译         │
└─────────────────────────────────────────────────────────────────┘
        横向一：protocol/   跨层契约（RunContext/事件/命令/结果）
        横向二：kernel/events.ts 类型化事件总线（kernel→UI 唯一通道）
```

**依赖规则（架构红线）**：
- 依赖只允许上层→下层；`domain/` 不 import `application/` 与 `infrastructure/`；`kernel/` 不 import `application/`。
- 跨层数据走 `protocol/` 契约类型（`runs.ts` 的 RunContext、`events.ts` 的 WxEvent、`commands.ts` 的命令协议）。
- 横向通知一律走事件总线（`kernel/events.ts`），不直接互相调用——这是「kernel→UI 唯一通道」纪律的由来（`src/kernel/events.ts:1`）。
- 全部动态导入 `await import()`；本仓禁用 `require()`（NodeNext ESM 下不存在——曾造成一个灰度功能静默失效，见 kernel-eval-2026-08-27 §3-1）。

**竖向切片**：`application/` `domain/` `infrastructure/` 三层按业务域同构切分（autonomy/build/capabilities/computer/config/extensions/forge/hooks/mcp/memory/models/personalization/pty/quality/release/runs/sessions/tools/voice）——加一个新业务域 = 三层各加一个同名目录，而非在既有模块里堆文件。

---

## 3. 目录与模块职责总表

### 3.1 内核 `src/kernel/`（110 文件，全部核心机制）

| 簇 | 文件 | 职责 |
|---|---|---|
| 主循环 | `agent.ts`（~1900 行） | 回合循环状态机、工具执行与审批链、缓存/去重/并行调度、压缩、循环检测、子代理 |
| 流式 | `llmStream.ts` | 严格 SSE 解析、错误分类重试、idle watchdog、等待网络模式、429 限额状态 |
| 上下文 | `systemPrompt.ts` `historyNormalize.ts` `toolOutput.ts` `imageHistory.ts` `repoMap.ts` `mentions.ts` `projectScan.ts` | 系统提示组装/历史归一化/输出 offload·掩码·蒸馏/图片摘要/仓库地图 |
| 工具 | `tools.ts`（~109KB） `toolArgs.ts` `applyPatch.ts` `hunkApply.ts` `toolTrim.ts` `diffReviewed.ts` `undoShadows.ts` `search.ts` | 内置工具定义、schema 校验、补丁应用三级容错、模型能力裁剪、撤销影子 |
| 权限安全 | `permissions.ts` `winSandbox.ts` `posixSandbox.ts` `osSandbox.ts` `execPolicy.ts` `ssrf.ts` `secretDetect.ts` `blockedHosts.ts` `redact.ts` `fileCrypto.ts` | 权限模式裁决、bash 分级、沙箱（双态令牌/Low IL）、SSRF/密钥防护 |
| 记忆 | `memory.ts` `memoryInbox.ts` `curator.ts` | 黑洞引擎三层记忆（working/archival/recall）+ FTS5 中文 bigram + 向量 |
| 供应商 | `providers.ts` `modelRegistry.ts` `offlineModel.ts` `vision.ts` `cost.ts` `balance.ts` `providerPrompts.ts` `llmOnce.ts` | 模型目录、密钥解析、图片能力门、成本五维计价、余额查询、分族提示词——DeepSeek 专用适配见 §6.10 |
| 协作 | `subagentTypes.ts` `agents.ts` `a2a.ts` `acp.ts` `taskRunner.ts` | 子代理定义、agent 间协议（A2A）、Agent Client Protocol |
| 扩展 | `mcp.ts` `plugins.ts` `skills.ts` `hooks.ts` | MCP 客户端、插件运行时、技能、生命周期钩子 |
| 事件持久化 | `events.ts` `sessionStream.ts` `sessionImport.ts` `sessionLineage.ts` `checkpoint.ts` `audit.ts` `artifactMigration.ts` `versionChange.ts` | 事件总线/jsonl 轮转/会话流/检查点/审计哈希链/产物迁移 |
| 杂项 | `browser.ts` `computer/` `voice.ts` `video.ts` `term.ts` `cronExpr.ts` `market.ts` `selfUpdate.ts` `doctor.ts` | 浏览器、桌面控制、语音视频、PTY、cron、市场、自升级、自诊断 |

### 3.2 装配与入口

| 位置 | 职责 |
|---|---|
| `src/cli/index.ts` | **唯一 CLI 入口**：解析 args → 按入口形态分流（-p / --wire / --serve / stdin / --mcp-server / ACP）→ 装配组合根 → 统一 shutdown（`src/cli/index.ts:348-373`） |
| `src/cli/serve.ts` `headlessGateway.ts` `stdinPipe.ts` `lifecycle.ts` `consoleBootstrap.ts` `terminalTier.ts` `runCompletionGate.ts` | HTTP 网关（Bearer+CSRF+会话所有权）、wire headless 网关（stdin 帧 RPC）、stdin 管道、生命周期、控制台引导、终端能力档、完成判定门 |
| `src/bootstrap/cliComposition.ts` | 组合根：`createCliComposition(deps)` 装配 db/bus/mem/agent/toolExecution/runInvocation/delegateManager，经 `KernelBridges` 注入 presentation（`src/bootstrap/cliComposition.ts:38,98`） |
| `src/bootstrap/bootstrap{Kernel,Extensions,Presentation,Repositories,Shutdown,Config}.ts` | 分阶段装配与资源生命周期；`compositionRouting.ts` 按入口形态路由组合方案 |
| `src/bootstrap/create{Application,CliFrontend,HttpFrontend,WireFrontend}.ts` | 三前端工厂（TUI 已移除） |

### 3.3 应用/领域/基础设施（竖向切片）

| 层 | 关键模块与文件 | 职责 |
|---|---|---|
| `application/` | `tools/agentToolSurface.ts` `toolExecutionWiring.ts` `toolExecutors.ts` `redlineGate.ts` `defaultToolPolicy.ts` `toolEvidenceStore.ts`；`sessions/sessionService.ts`；`memory/memoryService.ts`；`runs/`；`gatewayService.ts` `createGatewayService.ts`；`commandRegistry.ts` `commandService.ts` `commandGrammar.ts` | 工具面暴露与执行接线、会话/记忆/运行/网关服务、命令注册与 NL 路由 |
| `domain/` | `tools/toolCatalog.ts` `toolDescriptor.ts` `toolExecutionPipeline.ts`（⚠️ 11 端口管线，审计锚点：releaseUnapplied/settleAppliedUnverified 补偿顺序）`toolIds.ts`；`security/pdp.ts` `approvalGrant.ts`；`effects/` | 工具目录与执行管线（决定/执行/补偿）、安全决策点、副作用建模 |
| `infrastructure/` | `sqlite/authorizationUnitOfWork.ts`（⚠️ reserve/commit/release 授权预算）；`fs/safeWorkspaceFs.ts`（⚠️ Windows 句柄级 TOCTOU/重解析点防护，全仓工程标杆）；`process/processSupervisor.ts`（taskkill 兜底+deadline）；`http/`（ssrf/blockedHosts IPv6/NAT64）；`code/`（LSP/检索）；`skills/` `mcp/` `plugins/` `browser/` | 数据/文件/进程/网络/LSP/扩展的真实执行 |

### 3.4 展示层 `src/presentation/`（UI 移除后保留的四个 headless 前端）

| 前端 | 适配器 | 消费形态 |
|---|---|---|
| CLI（-p） | `cli/cliGatewayAdapter.ts` + `shared/inProcessAdapter.ts` | 进程内事件→控制台流式输出（QuickEdit 加固） |
| HTTP（--serve） | `http/httpGatewayAdapter.ts` + `csrfPolicy.ts` `httpSecurity.ts` `httpSessionIsolation.ts` `httpTokenStore.ts` | Bearer+CSRF+会话所有权三重防护的本地 HTTP 网关 |
| Wire（-p --wire） | `wire/wireGatewayAdapter.ts` + `cli/headlessGateway.ts` | stream-json 事件流（stdin 帧 RPC），审批/澄清经 stdin 应答、超时 fail-closed |
| 投影管线 | `tui/frontend.ts` `tui/state/` `tui/effects/`（无 React 依赖的事件→状态纯投影，供 wire/http 共享终态判定） | 完成态 parity 校验的数据源 |

### 3.5 数据与周边

| 位置 | 职责 |
|---|---|
| `src/store/db.ts` `config.ts` | SQLite 门面（会话/消息/记忆/用量/审计/检查点/授权）+ 配置原子写 |
| `src/migrations/db/` `config/` | schema 迁移器链与配置迁移 |
| `src/protocol/` | `runs.ts`（RunContext/六终态/聚合）、`events.ts`、`commands.ts`、`gateway.ts`、`completionTransport.ts`、`cancellableExecution.ts`——**跨层唯一契约面** |
| `src/policy/` | 硬红线与政策规则源（SENSITIVE_WRITE 等，`permissions.ts#SENSITIVE_WRITE` 引用） |
| `src/compliance/` | 合规链（证据/审计/合规检查） |
| `src/build/` `src/forge/` | 需求编译器（spec→分解→脚手架→验证→证据链） |
| `src/release/` | 发布链（freeze-candidate/finalize） |
| `src/lib/` | markdown 渲染等共享工具（UI 删除后仅 /render 消费） |
| `src/compat/` `src/legacy` | 兼容层与旧会话适配 |
| `packages/` | `vscode-ext/`（VS Code 扩展）；`wxnodus-ink/` 仅剩 dist/node_modules 构建残留（源码已随 UI 删除，不再参与构建） |
| `scripts/` | 门禁/审计/证据/混沌/钻探脚本（bench、check-cycles、drill-wave*、release 校验等） |

---

## 4. 启动与装配（组合根流程）

`wxnodus -p "…"` 一次启动的装配顺序（`src/cli/index.ts` → `cliComposition.ts:98`）：

```
1. args 解析（cli/args.ts）→ 入口形态判定
2. dataDir 唯一事实源（cli/index.ts:71——agent 规则/会话事件/浏览器/离线缓存同一目录）
3. config → store（config 原子写、损坏恢复）→ db（SQLite+迁移器链）
4. 代码索引 / 记忆仓储 / 黑洞记忆 mem / 事件总线 bus
5. toolExecution（domain 管线 + infrastructure 执行器）→ agent（kernel createAgent）
   ——AgentOptions：db/bus/mem/config/callModel/onApproval/onClarify/agentToolRunner/onCommand…
6. runInvocation + delegateManager（命令路由与 /jobs 委派）
7. 前端装配：-p → cliGatewayAdapter；--serve → httpGatewayAdapter；--wire → headlessGateway
   ——审批桥/澄清桥/密码桥/表单桥经 KernelBridges 注入（cliComposition.ts:38-50）
8. 命令注册（application/commandRegistry）+ NL 路由（commandGrammar/commandService）
9. shutdown 聚合：serve/keepalive/SIGINT/SIGTERM 共用一条关闭路径（cli/index.ts:352）
   ——组合根资源 + CLI 层资源一并释放；MCP 子进程 closeAll 纳入统一清理
```

**关键纪律**：组合阶段任何一步失败必须走 `shutdown()` 收口（MCP 孤儿进程、端口占用假启动等历史缺陷都是这个面）；审批链「fail-closed」——未装配 onApproval 时默认拒绝（`src/kernel/agent.ts:714`）。

---

## 5. 运行时架构：一次 `-p` 调用的完整生命周期

```
用户输入 ──▶ RunContext 创建（protocol/runs.ts，六终态机）
        ──▶ 会话归属（sessionService / agentSessionContext——多会话/子会话隔离）
        ──▶ 命令层拦截：斜杠命令/NL 路由命中 → 本地执行（不进模型）
        ──▶ agent.run(prompt)
              │
              ├─ 回合循环 loop()（每轮）：
              │   1. 门控：abort / 预算硬停 / 余额自停 / maxTurns
              │   2. 注入：steerQueue → noticeQueue（jobs 回流）→ 上下文水位检查
              │   3. 压缩：micro-compaction → 全量 compact → （失败时）413 强压重发
              │   4. 历史归一化 mergeAdjacentMessages → callWithAbort
              │   5. callModel → llmStream（SSE 解析/watchdog/重试/降级）
              │      └─ onToken/onReasoning → bus.emit（agent.token/reasoning.delta）
              │      └─ onToolCallReady（批次2）→ cacheable 工具流式中途提前执行
              │   6. 结果分流：
              │      text → 入历史 → agent.message → 回合结束
              │      tool_call → 批量执行：
              │         a. 权限裁决链（规则 deny/allow/ask → modeVerdict → 会话授权
              │            → AI 预审 → 人工审批 → preToolUse hook）【fail-closed】
              │         b. domain 工具执行管线（⚠️ 11 端口，含超时/补偿）
              │         c. 并行调度：纯只读批次并行（槽位保序）；含写整批串行
              │         d. 输出处理：vault 脱敏 → offload/包裹/截断 → 蒸馏 → 掩码
              │         e. cacheable 入缓存；写工具清空缓存
              │         f. 循环检测（签名+短哈希+LLM 辅助判定）→ 下一轮
              │   7. 终态：轮次耗尽→强制总结→诚实兜底文案
              └─ 事件贯穿：agent.start/token/tool/stage/message/end + sessionStream
                 + audit 哈希链 + usage_stats + checkpoint（自动快照限 10 份）
        ──▶ 终态归一（protocol/runs.ts normalizeAgentRunStatus：succeeded/failed/
            blocked/incomplete/inconclusive/cancelled）
        ──▶ completionTransport → 前端输出 → 退出码语义化（0 成功 / 1 失败 /
            42 输入错误 / 53 轮次上限——对齐 gemini headless 分类学）
```

---

## 6. 内核机制详解

### 6.1 Agent 回合循环（`kernel/agent.ts`）

- **单实例多会话**：`setSessionId` 热切换；回合级状态（`turn` 引用）与会话级状态（`sessionFlags` Map、`sessionClocks` Map）严格分离——C1 中断竞态修复与 B-2 预算标志跨会话污染修复都落在这里。
- **确定性结局单一事实源**：`lastToolOutcome: verified|failed|other`（`agent.ts:763`）被 anyFail 终止、消息 parts 错误标记、verifiedEffects 计数三处消费——废除「输出含『失败/异常』子串」内容猜测（A-5 根治）。
- **三类失控防护**：未知工具连续轮终止（maxUnknownToolRounds）、同工具连续失败终止（maxConsecutiveFail）、签名级循环检测（签名=name+args+输出短哈希，滑动窗口；提醒→LLM 辅助判定→硬停三级）。全部 settings 可配、夹取防误配（EFF，`agent.ts:246-258`）。
- **终态诚实**：ok 绝不从文本长度推导——完成声明（`[GOAL_DONE]` 等）且零验证副作用 → `incomplete`；轮次耗尽兜底文案显式 `ok=false`（`agent.ts:1719-1721`）。

### 6.2 LLM 流式传输层（`kernel/llmStream.ts`）

- **严格 SSE 解析器**：字段级解析、`[DONE]` 语义、尾帧宽容（B-17）、tool_calls index 0..63 校验、usage/思考字段提取。
- **错误分类重试**：FailureKind 十四类（401/403/404/413/429/500/503/529/connect/abort/malformed-sse/premature-eof/stream-error）——4xx 不重试（密钥错立即反馈）、429 尊重 Retry-After、529 更长退避、对称 jitter ±25% 防风暴。
- **等待网络模式**：connect 类失败走独立预算（默认 10min、60s 封顶指数退避），不占降级槽位；每次重试发 `onRetryNotice`（「网络中断，第 n 次重连…」）——断网 1 分钟不再报废整轮（A-10 根治）。
- **idle watchdog 双档**：首 chunk 30s + chunk 间隔 60s + 全程硬顶 30min（settings 可配）——替代 120s 一刀切，TimeoutError 经 `firedKind()` 区分不再误判 premature-eof（A-9 根治）。
- **降级链**：同 provider 目录内按能力（非图片输入模型）顺序降级，`onDegrade` 通知。
- **429 限额状态**：x-ratelimit-* 头解析 → 会话级状态 → 「额度 HH:mm 重置」可见（B-19 落地）。

### 6.3 上下文工程管线（组装→归一化→压缩→保护）

**组装**（`agent.ts` loop 顶部）：
1. 系统提示（会话冻结时钟保前缀缓存稳定）→ 项目规范（AGENTS.md 分层加载：全局>向上4层，字节上限可配）→ 首轮一次性轻注入（顶层结构一行+技能名清单+可选 repo_map ≤400 token）→ 历史（working 窗口，图片 parts 一律文本化）→ 中断恢复工具产出回放（有界 6 条×300 字）→ 召回（黑洞 hybrid，本会话限定，3 条×300 字截断标注）→ 用户消息（多模态 parts）。

**归一化**：发送前 `mergeAdjacentMessages`（`historyNormalize.ts`）合并相邻 user+user / system+system；永不合并 tool 与带 tool_calls 的 assistant（OpenAI 配对唯一性）——碎片化注入不打断 DeepSeek 前缀缓存。

**压缩三级**（`agent.ts:1305-1415`）：
1. micro-compaction：旧工具结果（尾部 6 条外）截 500 字，省一次摘要 LLM 调用；
2. 全量 compact：真实 usage（+EMA 校准）过阈值（默认 75%，settings.compactionThreshold）→ 摘要调用（独立请求，priorSummary 合并锚定）→ 内存消息替换 + DB compactSmart 联动；
3. 413/context-length 语义捕获 → 强制压缩 → 自动重发一次（compactedThisTurn 防循环）。

**保护三件套**（`toolOutput.ts`）：offload（>50KB/2000 行落盘+头尾预览+续读提示，绝不静默截断）、mask（保护最新 50k token，保护窗外超 30k 才掩码，幂等）、wrapLimit（untrusted 包裹面阈值 settings 化）。

### 6.4 工具系统

**定义→装配→执行三层**：
- `ToolDef`：schema（OpenAI function 格式）+ `danger`（权限单一事实源）+ `cacheable`（纯读声明，缺省 false fail-closed）+ `canonical.namespace`（agent/mcp/plugin）+ `extractImages` 等可选钩子。
- `assembleTools()` 是唯一装配点（初始化与热重载共用）：排除名单 → demo 过滤 → 模型能力裁剪（toolTrim 三档）→ 懒加载注入 tool_search——B-10「热重载丢 tool_search」根治。
- 执行前顺序：schema 校验（toolArgs）→ 权限规则（execpolicy 首词索引加速 bash）→ modeVerdict → 会话授权（approveForSession）→ 低危自动放行 → AI 预审（autoReview，默认关）→ 人工审批 → preToolUse hook → domain 管线执行（RunContext 强制绑定，缺则 fail-closed）→ 输出后处理。

**并行调度**（`agent.ts:1573-1596`）：纯只读批次 Promise.all 并行（槽位保序）；含任一 danger 整批串行（写后读顺序与审批链语义）；manual 模式下只读也串行（防并发弹窗）。

**去重与缓存**（E 机制，kimi `toolset.py:370-423` 语义对齐·实现原创）：回合级 toolCache（cacheable 才入；写工具清空）；批内 inflight Map 补 Promise.all 并发竞态洞；重复槽位带「已合并」诚实标记；各槽位保留自身 tool_call_id。

**坏参数自纠**：JSON 解析失败不执行，回「参数 JSON 无效：<片段>」哨兵消息（`ARGS_PARSE_ERROR_KEY`，`agent.ts:1483-1489`）——opencode InvalidTool 同族。

### 6.5 权限与安全

- **模式**：yolo/auto/smart/manual/plan/goal 六档（modeVerdict 单一裁决函数）。
- **bash 分级**：分段切分（换行/`&`/`|`/`$()`/反引号递归分类，`permissions.ts:206-244`）——伪装只读的多行破坏命令走审批（S-2 根治）；只读白名单加严（单行、无 `$()`、无管道、无重定向才判 readonly）。
- **红线**：SENSITIVE_WRITE 正则（.env/.ssh/id_rsa 等）对 fs_write/fs_edit/apply_patch targets/bash 重定向统一检查（A-22 下沉修复）。
- **沙箱**：winSandbox 双态令牌（受限令牌/Low IL 路径经本机实测校准，`winSandbox.ts`）；posix/os 沙箱跨平台兜底；sandboxFastPath 双速权限试点（⚠️ 接线死代码，见 kernel-eval-2026-08-27 §3-1）。
- **密钥**：AES-256-GCM，机器指纹派生 key（hostname::platform::arch::username），明文绝不落盘/回显；provider 归属校验防「智谱密钥发往 deepseek」（`providers.ts:76-113`）；env 密钥优先级链（`WXNODUS_<PROVIDER>_KEY` > `WXNODUS_API_KEY` > 加密槽位）。
- **网络**：ssrf/blockedHosts 覆盖 IPv6 映射/NAT64；browser 每次导航重跑 authorizeOutboundUrl（B-14）。
- **图片四层守卫**（ZCode deepseek-v4-pro 400 事故防御纵深）：能力门注入（`providers.ts:169-172`）→ 历史 contentToText → 发送前 textifyForModel 兜底（`providers.ts:291-299`）→ 文本模型走视觉通道识别为文本。
- **提示注入**：外部工具输出统一 `<untrusted_tool_result>` 包裹 + 包裹面护栏 + vault 值输出脱敏（`redact.ts`）。

### 6.6 黑洞记忆（`kernel/memory.ts`，冻结维护轨）

三层结构：**working**（活跃窗口，压缩联动收缩）/ **archival**（归档，全文保留）/ **recall**（召回，FTS5 中文 bigram + sqlite-vec 向量混合检索）。`memoryInbox.ts` 异步入箱；`curator.ts` 摘要策展（⚠️ 历史缺陷：只统计 default 会话，M-1 已修）。跨会话 recall（cross-session-recall.test.ts）与图片摘要（imageHistory.ts）是护城河面。

### 6.7 子代理与任务系统

- **子代理**：独立 agent 实例（独立 abort）+ 深度限制（默认 3，可配）+ 只读工具集（写/执行/委派/外联/提问排除，danger 动态剔除）+ preToolUse 钩子继承 + 通知不回流防污染（backgroundNotify:false）。
- **任务系统**：taskRunner（`/jobs` 后台真进程/子代理/并行双线）→ `jobs.complete` 事件 → 主线 noticeQueue 回流（B 机制）；cron（cronExpr，dom/dow 标准 vixie OR 语义已修）。

### 6.8 事件总线与持久化

- `kernel/events.ts`：类型化事件（31 种映射）+ AsyncLocalStorage RunContext 注入（`withinRun`）+ `finalizeRun` 一次性封口（sealed——run.final 只发一次，终态诚实）。
- 落盘分级：`agent.token`/`reasoning.delta` 不落盘（高频）；低频事件全量 jsonl + 4MB 轮转（.1 保留上一代）。
- `sessionStream.ts`：会话事件流（user/model/tool/compact/end）可重放审计。
- `checkpoint.ts`：回合结束自动快照，保留最近 10 份（`messagesUpTo` 上界增量化），/rewind 回滚。
- `audit.ts`：审计哈希链（工具裁决/执行/红线全留痕）。
- `usage_stats`：五维用量（输入/输出/缓存命中/缓存未命中/推理 token）+ 成本计价。

### 6.9 模型供应商层（`kernel/providers.ts`）

模型目录（MODEL_CATALOG：deepseek/kimi/zhipu/offline 四族 14 条，含能力位 imageIn/thinking/maxContext）→ 目录未收录模型不裁不拦（自定义端点零破坏）→ 未知窗口不写 max_tokens（钳制字段缺省即诚实）→ 视觉能力名启发式（VISION_NAME_RE）+ 目录权威判定 → o 系/gpt-5 省略 temperature、max_completion_tokens 字段分流（B-18）。

### 6.10 DeepSeek Harness——内核 DeepSeek 专用适配层（横切关注点）

**定义**：不是独立模块，而是横跨 7 个文件的「端点特性适配」机制集合——DeepSeek API 的独有行为各自落点到最近的责任层。**设计原则：适配层不改变通用协议语义，只消除端点差异**（与「未知端点零破坏」同一哲学：目录外模型走通用通道，目录内模型享受适配）。

| # | 端点特性 | 落点（file:line） | 适配机制 |
|---|---|---|---|
| 1 | 端点识别 | `providers.ts:45-51` detectProvider | baseURL 含 deepseek → provider 归属（密钥槽/提示词/目录的派生源） |
| 2 | 密钥归属 | `providers.ts:60,90` + `resolveApiKey` `:76-113` | `WXNODUS_DEEPSEEK_KEY` 优先 + 加密槽位归属校验——防「智谱密钥发往 deepseek → 401」（历史缺陷，已修复） |
| 3 | 思考字段强制回传 | `providers.ts:36-42` 别名表 + `llmStream.ts:417-426` 首命中解析 + `agent.ts:1454-1458` 原字段名回传 | `reasoning_content` 上游传入必须原样回传，否则 400（实测驱动——注释明言 deepseek 实测） |
| 4 | 自动前缀缓存 | `agent.ts:230-232` sessionClocks 冻结 + `providers.ts:212-223` 固定键序重建 + `historyNormalize.ts:29-39` 相邻合并 + `llmStream.ts:290-291` cache hit/miss 记录 | 字节稳定三件套协同——内容相同 ⇒ 请求前缀字节相同 ⇒ 缓存命中；命中/未命中 token 进五维计价 |
| 5 | 专属提示段 | `providerPrompts.ts:16-22` DEEPSEEK_BODY + `agent.ts:1093-1094` 注入 | 把端点真实行为告知模型（回传纪律/缓存/窗口/语言）；只写真实 API 差异不写营销文案（诚实工程红线）；provider 由 model/端点派生且会话内不变 → 前缀缓存不受影响 |
| 6 | 窗口派生与输出钳制 | `providers.ts:135-138` 目录窗口（64k/128k）+ `maxContextFor` `:185-188` + `agent.ts:1267-1294` | 压缩阈值/输出钳制 = 目录真实窗口 − 输出预留；未知模型不写 max_tokens（零破坏） |
| 7 | 图片守卫 | `providers.ts:169-172` imageStrategy + `:291-299` textifyForModel + `agent.ts:1006-1037` 视觉通道降级 | deepseek-v4-pro 纯文本拒收 image_url（400 unknown variant，ZCode 事故）→ 四层纵深：能力门→历史文本化→发送前兜底→视觉模型识别为文本 |
| 8 | 余额查询 | `balance.ts:2-25`（hostRe + 官方 /user/balance 解析） | 取证标注官方文档（api-docs.deepseek.com）；解析失败诚实 null |
| 9 | 成本计价 | `cost.ts:40-44`（官方价目含 cacheRead/cacheWrite） | 五维计价只收录官方公布价；未公布按输入价 ×1.25 估算（aider 口径，`cost.ts:74`）——成本绝不虚高 |
| 10 | 限流/断网 | `llmStream.ts:99-156,580-611` | 429 尊重 Retry-After、等待网络模式 60s 封顶——通用机制，DeepSeek 高峰期直接受益 |

**Harness 不变量（并入 §11 的增量）**：
- **DSH-1 回传同名字段**：解析用哪个思考字段名，回传就必须用同名字段（别名表首命中即契约）；
- **DSH-2 前缀稳定**：任何进入 DeepSeek 请求前缀的内容会话内必须字节稳定（时间戳冻结/键序固定/合并幂等）；
- **DSH-3 图片零泄漏**：dataUrl 绝不进入非视觉 DeepSeek 模型请求体；
- **DSH-4 成本诚实**：未收录价目按标注口径估算，绝不虚高或虚低。

**与竞品 provider 层的架构差异**：
- kimi-cli：`ChatProvider` 实例抽象 + `find_kimi_provider`（kimisoul.py:1365）——provider 实例承载模型参数/客户端/重试恢复；wxnodus 是「目录能力位 + 横切适配函数」，无 provider 实例概念；
- opencode：多协议 SDK 生态（ai-sdk）；wxnodus 只有 OpenAI 兼容单协议 + 字段别名表；
- **取舍**：wxnodus 放弃多协议 SDK，换取「任意 OpenAI 兼容端点零配置可用」与「目录外模型零破坏」——DeepSeek Harness 是这一取舍下端点适配的最小充分集。

---

## 7. 跨层协议（`src/protocol/`）

| 契约 | 内容 |
|---|---|
| `runs.ts` | RunContext（runId/correlationId/sessionId/actorId/source）+ 六终态（succeeded/failed/blocked/incomplete/inconclusive/cancelled）+ 归一化与聚合函数 |
| `events.ts` | WxEvent 信封（id/type/payload/ts/runId/correlationId/sessionId/actorId） |
| `commands.ts` | 命令协议（注册/解析/NL 路由接口） |
| `gateway.ts` | 网关 RPC 协议（-p/--wire/--serve 共用） |
| `completionTransport.ts` | 完成态传输（wire/http/cli 三前端共享终态判定） |
| `cancellableExecution.ts` | 可取消执行契约（abort 语义跨层统一） |

---

## 8. 非交互入口矩阵（UI 移除后的全部产品面）

| 入口 | 形态 | 前端适配 | 输出 | 退出码 |
|---|---|---|---|---|
| `wxnodus -p "…"` | 单次执行 | cliGatewayAdapter（进程内） | 流式文本 + QuickEdit 加固 | 0/1/42/53 语义化 |
| `wxnodus -p "…" --wire` | headless 事件流 | headlessGateway + wireGatewayAdapter | stream-json 帧（stdin 帧 RPC 双向） | 同上 |
| `wxnodus --serve` | 本地 HTTP 网关 | httpGatewayAdapter | JSON RPC（Bearer+CSRF+会话所有权；command 白名单） | 服务生命周期 |
| `echo "…" \| wxnodus` | stdin 管道 | stdinPipe | 流式文本 | 同上 |
| `wxnodus --mcp-server` | incoming MCP stdio | 与 --serve /mcp 同一 ports 构造 | MCP 协议（JSON-RPC） | — |
| ACP（`/acp server`） | Agent Client Protocol | acp.ts | ACP 会话 | — |
| `wxnodus`（TTY 无参） | 交互 TUI（P2/Q1 2026-08-27 重建——薄层：wire 事件→ANSI 纯函数，审批复用 wire 网关契约） | `presentation/tui/interactiveLoop.ts` | 流式文本 + 语义色 | 交互会话 |

审批/澄清/密码/表单在 headless 下经 stdin 帧应答，**超时 fail-closed**（deny/空串/null）。

---

## 9. 数据与持久化布局

```
data/
├── wxnodus.db            # SQLite 主库（sessions/messages/usage_stats/checkpoints/
│                         #   audit/grant/授权预算表 + FTS5 + sqlite-vec）
├── config.json           # 配置（原子写：随机 tmp + rename 重试）
├── events.jsonl (+.1)    # 事件流（低频全量，4MB 轮转）
├── permissions.json      # 权限规则（deny>allow>ask）
├── undo-shadows/         # 编辑撤销影子（可选挂 git ref）
├── truncations/          # 工具输出 offload 落盘（<session>/<ts>-<tool>-<hash>.log）
├── sessions/<id>/        # 会话事件流（sessionStream）
├── agents/ skills/ plugins/  # 自定义 agent/技能/插件（本地自用）
├── projects/             # /build 产物
├── crashes/              # 本地崩溃报告（不出机）
└── models/               # 离线模型（裁撤轨 D：deprecation 警告期，可手动清理）
```

**可靠性纪律**：WAL + 会话边界 checkpoint；restore 前清理 -wal/-shm；/backup 用在线备份 API 而非 cpSync；JSONL 为源、SQLite 为索引（竞品共识架构，见 master-plan §3.2 主题 5）。

---

## 10. 构建 / 测试 / 发布链

```
npm run build      → tsc（NodeNext 严格 ESM，单级构建，无子包打包）
npm test           → vitest（2539 用例：单测/契约/集成/混沌/红队五层）
npm run ci         → 九命令门禁（typecheck src+tests / test / known-failures gate /
                     discovery / coverage / lint / cycles / docs-links / bench）
ratchet            → 复杂度/行数棘轮（文件拆分降档登记）
scripts/bench/     → 性能基准（shortHash/diff/bigramZh/注入量/探测开销——不回退）
scripts/drill-*    → 波次钻探（恢复/安全/混沌场景）
发布链              → scripts/package-installer.ts 产 zip（manifest sha256 闭包+SBOM+ABI）
                     → V4 C1：`--node24-binary <file>` / `--node24-download` 注入 Node 24（ABI 137）
                       侧车二进制——install.ps1 按本机 ABI 三路裁决（默认/侧车替换/诚实拒绝）
                     → 干净机装包冒烟 → freeze-candidate → finalize-release
自升级              → wxnodus update [--check|--skip|--rollback|--file <zip>]（气隙一等公民）
产物迁移            → 产物清单 manifest + 迁移器链（dry-run→原子应用→失败整体回滚）
```

**门禁哲学**：每个缺陷修复 = 新增单测 → tsc → 相关用例绿 → 波次专属验收（真实 cmd.exe 场景电池）→ 全量九命令。已知失败（known-failures gate）显式登记，不静默放行。

---

## 11. 关键不变量清单（改动须知——任何改动不得退化）

1. **事件闭环**：任何回合结束必须发 `agent.message`+`agent.end`；`run.final` 每 Run 只发一次（finishEarly/finalizeRun 契约）。
2. **审批 fail-closed**：未装配 onApproval = 拒绝；所有放行路径必须留痕（audit 表）或发 notice。
3. **缓存失效纪律**：任何写/执行工具执行后 toolCache 整体清空；cacheable 必须真实纯读。
4. **前缀缓存稳定**：system prompt 时间戳按会话冻结；消息字段固定键序序列化；相邻同角色合并保持确定性幂等；tool 与带 tool_calls 的 assistant 永不合并。
5. **图片守卫**：dataUrl 绝不进入纯文本模型请求体（四层防线）。
6. **诚实标注**：截断/缓存/合并/蒸馏/提前执行/掩码必须带显式标注文案；ok 绝不从文本长度推导。
7. **终态归一**：所有入口的完成态经 `protocol/runs.ts` 六终态归一后出。
8. **多会话隔离**：回合级/会话级状态分离（turn 引用 / sessionFlags Map）；预算/告警/降级状态绝不跨会话污染。
9. **窗口未知不写字段**：自定义端点零破坏原则（maxTokens/temperature 等按能力决定是否写）。
10. **数据不出机**：密钥 AES-GCM 加密槽位；崩溃报告本地落盘；审计哈希链本地。

---

## 12. 架构如何长成：竞品影响来源（机制参考·实现原创）

| 机制面 | 参考来源（语义） | 本仓落点 | 差异 |
|---|---|---|---|
| 回合步骤管线（通知→注入→归一化→LLM→工具→生长→结局） | kimi-cli `kimisoul.py` 2e.x | agent.ts loop 单函数内聚 | kimi 为独立步骤类，本仓单循环内聚 |
| 流式中途工具派发 | kimi on_tool_call（⚠️ 锚点未复核） | llmStream onToolCallReady + earlyRuns | 仅 cacheable 只读先行（fail-closed） |
| 压缩（真实 usage+结构化输出+提早触发） | Anthropic 官方 compaction + opencode isOverflow | agent.ts 三级压缩 | 阈值参数化与三级结构为本仓原创 |
| 流中断语义 | gemini RETRY 事件 | agent.token reset 标志 | 同名语义、事件体不同 |
| 编辑容错 | aider 四级降级 + opencode 行尾归一 | applyPatch 三级 + eol 保真 | 三级而非四级（省略号匹配未做） |
| 双速权限 | Claude Code 沙盒内免审批 | permissions sandboxFastPath | ⚠️ 接线死代码待修 |
| 错误分类 | gemini ToolErrorType / codex RespondToModel | lastToolOutcome + 哨兵回喂 | 确定性结局而非内容猜测 |

---

## 13. 已知缺陷与演进路线

- **当前缺陷**：见 `docs/kernel-eval-2026-08-27.md`（§3 九项，最高优先级 = agent.ts:676 `require()` 接线死代码）。
- **进行中**：kimi-cli 差距对齐批次2（流式中途派发，未提交——修 kernel-eval §3-2 后合入，届时 5/7）。
- **路线**：见 `docs/wxnodus-4.0-hardening-plan-2026-08-21.md`（H0 收口/H1 收敛/H2 对齐补差）与 `docs/wxnodus-master-upgrade-plan-2026-08-21.md`（六波两轨 98 卡总纲，含波次依赖与门禁）。

---

*本文档为架构快照：与源码同步演进，重大结构变更（新增分层/入口/协议）应回改本文档相应章节。*

# WxNodus V3.x 全面更新完善计划（总纲 · 2026-08-21）

> **文档定位**：本计划是 wxnodus 走向「100% 全面试用正常」的**唯一总纲**。缺陷证据底册为 `production-readiness-plan-2026-08-21.md`（纯源码审计，5 路深审，全部 file:line 锚点，下称【审计】）；本计划在其上融合 6 家竞品本地源码取证（下称【竞品源码】）与 5 路网络文档调研（下称【网络调研】，全部附 URL）形成最终执行方案。
> **纪律**：每项任务三源齐备（本仓源码锚点 + 竞品机制锚点 + 网络佐证/用户战略）方可入册；实现遵守 AGENTS.md「参考机制不抄代码」；每波收口跑全量门禁（§7）。

---

## 第 0 章 输入源与可信度声明

| 源 | 内容 | 可信度 |
|---|---|---|
| 【审计】 | wxnodus 全量源码 5 路深审：8 S / 26 A / 42 B / 30+ C 缺陷，全部 file:line；基线 tsc 零错 + 3158 测试全绿（缺陷均系测试未覆盖的实战面） | 高（多处本机实证、多路交叉验证） |
| 【竞品源码】 | 6 家本地克隆（codex/gemini-cli/opencode/kimi-cli/crush/aider）逐文件机制取证 20 条差距，全部 repo file:line | 高 |
| 【网络调研】 | ①Codex+Claude Code ②Gemini+Kimi ③OpenCode+Crush ④Aider+品类痛点 ⑤可靠性最佳实践 7 主题（Anthropic 工程博客体系/sqlite.org/OWASP 等），全部 URL | 高（官方文档与 release notes 逐条核对；2 处文献缺口已如实标注） |
| 【用户战略】 | 2026-08-21 四条产品约束（§1.1） | 最高（用户裁决，覆盖一切优先级判断） |

---

## 第 1 章 产品战略与北极星

### 1.1 战略约束（用户定，2026-08-21，长期有效）

**约束一：插件市场「只收不出」**（**2026-08-28 用户修订**：数据主权口径放宽——数据**可出机**，方式=用户显式动作：`/bundle publish` 推送自有 Git remote、或用户自行上传 GitHub 等开源平台、或自迭代。发布侧仍不建 wxnodus 托管服务/账号体系——「出机」永远经用户自己的 remote 与凭据；本节其余（不建市场/托管）不变）
- 不建自托管市场。`/market` 永远是「开放生态目录聚合器」：npm registry + GitHub topic 等公开源拉取 → 校验（SSRF/sha256/staging）→ 本地安装。消费开源生态即市场。
- 用户自制插件仅本地自用；对外分享唯一通道是 `/bundle` 整包（skill/MCP/插件/配置规整打包 → tar.gz 离线分发 → 对方一键装回）。
- **决策规则**：任何「建目录服务/建托管/建账号体系」类提案一律否决；`/market` 只修缺陷与新增**公开源接入**，不做发布侧。

**约束二：CLI 主体对齐同类**
- 交互形态、可靠性机制、命令面语义按业界标准模仿参考完善（对齐基准 = 本计划 §3 调研的 6 家 + 品类共识）。
- 对齐方式 = 抄「机制与语义」，不抄代码与文案；互通契约（AGENTS.md、SKILL.md、MCP、OpenAI 协议、stream-json 事件流）按标准实现。

**约束三：独有功能全面冻结维护 + 离线能力裁撤（2026-08-21 用户二次裁决）**
- 黑洞记忆、概念编译器 `/build`、UIA 桌面控制、合规链、winSandbox、ACP/A2A、`/jobs`+`/cron`、成本计价体系等进入**冻结维护态**：修缺陷、保兼容、保测试绿，不再扩张新独占特性。
- **离线能力裁撤**（用户裁决：「离线能力在 CLI 中并没有优势」）：
  - 裁撤：离线对话（offlineModel 全链：模型下载/推理/`offline:` 路由/相关 settings 与命令）、离线看图（vision 的 moondream2 + Windows OCR 兜底通道）、无 key/无网可用层（`deterministic.ts` 确定性工具、`/build` 规则脑模具、NL `/hole` 本地兜底路由）；
  - **保留**：语音（whisper+SAPI，交互方式而非离线运行能力）、气隙升级（`update --file`，升级通道）、黑洞记忆与本地向量嵌入（属记忆体系维护轨 M-1，非离线运行能力）、「数据不出机」（数据本地存储 ≠ 离线运行——定位仍成立，但不再宣称可离线使用）；
  - 裁撤采用**软着陆**（Buddy 事件教训【网络调研①】：功能下线无缓冲引发 2071 赞反弹）：一个次版本的 deprecation 警告期 + `WXNODUS_LEGACY_OFFLINE=1` 逃生开关 + 文档迁移指引，随后版本物理移除；
- **决策规则**：独有功能新需求默认「不做」；涉及被裁撤面的缺陷卡直接作废（A-15 哈希税、A-8 加密劫持等随代码移除消失）。

**约束四：用户的两大权力**
- **自主升级权**：用户完全控制何时升级（`wxnodus update` 检查+自助升级，非强制、可跳过、可回退；参考 codex 0.128 `codex update`、kimi-code 0.37 Windows 自动更新、crush update 比对机制【网络调研①③】）。
- **自定义产物迁移兼容权**：升级新版时用户产物全量兼容——插件/skills/MCP 配置/会话/记忆/主题/键位/密钥档案/权限规则/自定义命令。要求建立「用户产物清单 + 迁移框架」（现有 `migrations/db` 只覆盖 DB schema，需扩至文件系统级）。
- **决策规则**：任何会破坏用户产物兼容性的改动必须携带迁移器，否则不许合入。

### 1.2 产品定位陈述

**wxnodus = Windows 原生 · 数据不出机 · 无账号无订阅的开源 AI agent CLI。**

（2026-08-21 调整：去除「可完全离线」宣称——离线运行能力裁撤；「数据不出机」保留：会话/记忆/密钥/审计全部本地存储，运行需网络与模型密钥。）

市场空位佐证【网络调研】：
- Windows 在主流 CLI 中长期二等公民（Claude Code 要求 Docker 容器沙盒；Gemini「Windows 上几乎不可用」issue #10197；Kimi 1.42 前 PowerShell 后端问题多）；
- **Gemini CLI 个人版已死**（2026-06-18 强制迁移 Antigravity，公告帖 6 赞 vs 298 踩，社区分叉涌現）——「开源+不被强制迁移」空位扩大；
- OpenCode 爆出 CVE-2026-22812（默认 HTTP server+CORS 全开=浏览器 RCE）并陷 issue 治理失控（3690+ 开放）。

### 1.3 目标用户与核心场景

1. **中文 Windows 开发者**（主力）：cmd/Windows Terminal 原生、GBK 环境零乱码、中文免记命令路由；
2. **隐私敏感用户**：数据不出机（会话/记忆/密钥全本地）、无账号无订阅、任意 OpenAI 兼容端点自主可控；
3. **多模型用户**：多 provider 路由、成本透明（µUSD 定点计价）、断网/限流可自愈。

### 1.4 护城河清单（任何改动不得退化）

`safeWorkspaceFs` 句柄级防护、11 端口证据管线、事件闭环纪律（finishEarly+终态诚实判定）、winSandbox 双态令牌、黑洞三层记忆+FTS bigram+本地向量、概念编译器验证闭环、`/market` 开放生态聚合+供应链校验、AES-256-GCM 密钥加密、成本五维定点计价、语音双通道（whisper+SAPI）、3158 测试锁定。

### 1.5 成功度量（实战可用性 KPI）

| 维度 | 现状 | 目标 | 度量法 |
|---|---|---|---|
| 会话数据丢失 | 存在理论窗口（S-5） | 0 | 混沌测试：undo/checkpoint 全路径注入崩溃 |
| 越权执行/读取 | 存在绕过链（S-2/3/4） | 0 | 红队用例集全绿 |
| 中文 Windows 高频路径 | bash 乱码/fs_edit 高频失败 | 全部正确 | 真实 cmd.exe 场景电池（§7.3） |
| 断网恢复 | ~几十秒后任务报废 | 断网 ≤10min 自动续跑 | mock 断网端到端 |
| 升级兼容 | 仅 DB schema 迁移 | 用户产物 0 丢失 | 迁移器测试 + 老版本数据夹具 |
| 裁撤彻底性 | 离线代码仍在（含 A-15 哈希税等缺陷面） | 裁撤面代码物理移除+逃生开关+文档指引 | 裁撤轨验收（D-1~D-4） |

---

## 第 2 章 现状基线

### 2.1 工程基线
- 构建 tsc 零报错；全量 413 文件/3158 用例全绿（11 skipped）；CI 九命令绿。
- 工作区 99 文件/+9276 行未提交增强（RunContext 上下文、llmStream 结构化重试 FailureKind、serve 会话所有权、子代理会话隔离）——**开工前先按主题分批入库**，避免混流。

### 2.2 审计四大根因（详见【审计】§1）
1. 安全/预算机制被接线层短路；2. 中文 Windows 高频路径系统性缺陷；3. 运行时工程（编码/超时/状态作用域/启发式）弱于安全工程；4. 渲染链架构缺口被补丁累积掩盖。

### 2.3 与竞品能力对照（网络调研更新版）

| 能力域 | wxnodus 现状 | 业界标杆 | 差距判定 |
|---|---|---|---|
| 断网/限流自愈 | ~7 次重试后报废（A-10） | codex turn 级断线重连+durable queue；opencode 重试上限+jitter；crush mid-stream 恢复 | **大**（波 2 核心） |
| 流中断语义 | 半截拼接+丢弃成功响应（A-3/4） | gemini RETRY 事件清屏重画；opencode mid-stream 错误保留重试 | 大 |
| 上下文压缩 | 字符估算 85% 触发、超限不自动压（A-13） | Anthropic 官方 compaction（真实 usage+结构化输出+提早触发）；kimi 413→压缩重试+保留前向计划；opencode 保留完整近轮 | 大 |
| 编辑可靠性 | fs_edit 零容错（S-6） | crush v0.88 空白自动纠正+行尾保真；aider 四级降级；opencode 行尾归一 | **大且竞品刚验证** |
| 权限体验 | system-touch 被短路+审批疲劳风险 | Claude「沙盒内即免审批」双速模型（实测 -84% 弹窗）；codex 三维矩阵+auto_review | 中（wxnodus 有 winSandbox 可承接双速） |
| 错误反馈 | JSON 坏吞 `{}`、cryptic 错误（A-12） | Anthropic 范式「码+解释+建议」；opencode InvalidTool 回喂 | 中 |
| 会话持久化 | events.jsonl+SQLite（好基础） | kimi wire.jsonl 全量线级+vis 回放；codex rollout+fork/归档 | 中（已有骨架，补 fork/导出） |
| 自诊断 | /doctor 部分 | codex doctor（端点/代理/更新连通性全链路） | 中 |
| 用量透明 | /cost+/usage 五维（**领先**） | 两家最大怨气恰是额度不透明 | wxnodus 优势项，保持 |
| Windows 原生 | 深度适配（独有） | 全员二等公民 | **wxnodus 优势项** |
| 离线运行 | 曾有四模态 | 全员缺位 | **裁撤（用户裁决 2026-08-21：离线在 CLI 中无优势）**——语音/气隙升级/本地记忆向量保留 |

### 2.4 竞品反面教材（避免重蹈）【网络调研】
- OpenCode：prompt cache 频繁 miss（AGENTS.md 每轮重注入、turn-0 日期破坏前缀）；pruning 无差别丢弃 40k 外工具结果；compaction 摘要质量差；HTTP server 默认全开酿 CVE。
- Claude Code：harness 开销 33k token（读 prompt 前）vs opencode 7k——**wxnodus 需自查系统提示开销档位**；Buddy 事件（2071 赞反弹）——功能下线必须有开关或缓冲。
- Codex：MultiAgentV2 加密消息致审计轨迹不可读（#28058）——wxnodus 证据链设计勿犯；限额消耗暴增不可解释是第一大怨气——成本透明是信任根基。

---

## 第 3 章 网络调研关键发现 → wxnodus 对策映射

### 3.1 品类痛点 15 条对策（痛点清单见【网络调研④】）

| # | 品类痛点 | wxnodus 对策 | 承接任务 |
|---|---|---|---|
| 1 | context rot | 真实 usage 压缩+结构化快照+提早触发 | A-13/W-1 |
| 2 | agent 重试跑飞烧钱 | 重试上限+jitter+可见信号+doom_loop 防抖 | A-10/11/W-2 |
| 3 | 「我明白了」死循环 | 确定性失败判定+同参缓存+循环检测已有，补 doom_loop | A-5/W-2 |
| 4 | system prompt token 开销 | 自查并压减注入开销（对齐 opencode 7k 档） | W-3 |
| 5 | 成本不可预测 | 已有五维计价（优势项）；补重试烧钱可见性 | 维护+R-4 |
| 6 | 审批疲劳 | 双速权限（沙盒内免审批）+会话级规则 | W-4 |
| 7 | 监督/复核疲劳 | diff 高亮+per-hunk 回滚已有；补 LSP 诊断回灌 | B-21 |
| 8 | 长任务成本失控 | 预算硬停已有+轮次上限诚实兜底已有；补断线续跑防白烧 | A-10 |
| 9 | Windows 二等公民 | **主场**：修 bash GBK 三连/渲染矩阵/conhost | A-1/波 3 |
| 10 | 厂商锁定 | 多 provider 已有；补模型中途切换缓存提示 | W-5 |
| 11 | AI 代码信任度下降 | 证据链+验证闭环（优势项）；编辑后诊断回灌 | B-21 |
| 12 | 熟手变慢 | 免记命令路由保留（确定性工具层裁撤——路由本身不依赖离线能力） | 维护+D-3 |
| 13 | 编辑可靠性 | fs_edit 三级容错+BOM/行尾保真 | S-6/B-8/9 |
| 14 | 离线缺位 | **不承接**（用户裁决：离线在 CLI 中无优势，离线运行能力裁撤） | 裁撤轨 D |
| 15 | 会话中途换模型副作用 | 换模型提示缓存失效+上下文分布漂移警告 | W-5 |

### 3.2 可靠性最佳实践七主题技术决策（【网络调研⑤】全文见来源）

1. **流式可靠性**：错误分类重试（429 尊重 Retry-After、529≠429、4xx 不可重试）；三段式 failover（重试→冷却→降级链）；mid-stream 失败不可透明重试（丢弃重发或续传，UI 必须收到明确事件）；**idle watchdog 替代全程超时**（Node fetch 默认 300s headers timeout 暗坑）。
2. **上下文工程**：压缩以**真实 usage** 触发（Anthropic 官方 API 即此设计）；阈值 60-80% 提早（95% 会造成 5-15 分钟连环超限失败）；输出结构化（summary+recent_turns+preserved_requests+next_steps）；「JSON 比 Markdown 不易被模型改坏」；工具结果裁剪是特性；cache 断点=系统提示独立+对话独立，压缩输出须保前缀一致以续命中。
3. **Agent 循环**：工具错误三分类（可重试/可自纠——错误消息「码+解释+建议+文档链接」/致命早停）；级联错误按置信度早停；子代理判据（>15 步/token 大/可并行/需隔离；coordinator 只收摘要）；「**只测试后标记通过**」。
4. **TUI**：DEC 2026 探测启用（Windows Terminal 尚未支持，不能作正确性依赖）；conhost 需 ENABLE_VIRTUAL_TERMINAL_PROCESSING 检测回退；resize 一律整帧重算。
5. **数据可靠性**：SQLite WAL `synchronous=NORMAL` 只防崩溃不防掉电（会话边界主动 checkpoint）；长读事务饿死 checkpoint；**升级 SQLite ≥3.51.3**（修 2026-03 WAL-Reset 竞争 bug）；「JSONL 为源 + SQLite 为索引」；文件写全 temp+rename（Windows rename-over 需处理）。
6. **安全**：lethal trifecta 框架（工具输出=未信任输入，已有 `<untrusted_tool_result>` 基础）；单 LLM+system prompt 防注入公认不可靠→dual LLM/action gap；**双速权限**（沙盒内免审批）；本地端口默认 127.0.0.1+随机 token。
7. **输出容错**：JSON 三级（partial parser→修复库→回喂是最后手段）；补丁匹配前 CRLF/空白归一是标配；schema 设计减少错误发生（响应只留必要字段）。

---

## 第 4 章 更新计划总纲（六波 + 两轨）

```
波 0 止血（S 级：数据/安全/瘫痪）─────────── 2-3 天   【约束一~四全部受益】
波 1 高频路径（bash/编辑/流式/中文）───────── 1 周     约束二：对齐同类
波 2 鲁棒性机制（重连/压缩/自愈/错误分类）─── 1-2 周   约束二+痛点 1/2/8
波 3 架构收敛（渲染矩阵/性能税/发布链）────── 1-2 周   痛点 9
波 4 对齐同类 CLI（交互标准/互操作）───────── 1 周     约束二：AGENTS.md/退出码/doctor
波 5 用户权力（自升级/产物迁移/只收不出收口）─ 1-2 周  约束一+约束四
─────────────────────────────────────────────
维护轨 M（贯穿）：独有功能冻结维护（黑洞记忆/build/UIA/合规/winSandbox/ACP/语音）
裁撤轨 D（波 0.5，与波 1 并行启动）：离线能力软着陆移除（约束三 2026-08-21 二次裁决）
```

依赖关系：波 0→1→2 严格串行（波 1 依赖波 0 的预算修复，波 2 依赖波 1 的流式语义）；波 3/4 可与波 2 并行（不同文件面）；波 5 依赖波 3 的发布链闭环；裁撤轨 D 在波 0 后立即启动（早移除早减负——A-8/A-15 等缺陷卡随之作废省修复量，波 1 的 A-8 卡执行前先查裁撤进度）；维护轨每波穿插。

---

## 第 5 章 任务卡详册

> 编号沿用【审计】（S-x/A-x/B-x/C-x）；新增任务用 W-x（网络调研驱动）/U-x（用户战略驱动）。每卡：背景（三源）→ 方案 → 验收 → 回归面/风险。

### 波 0：止血（数据不丢、不越权、不瘫痪）

**P0-1【S-5】replaceSessionMessages 事务包裹** · 半小时
- 背景：`store/db.ts:258-277` DELETE+重插无事务，undo/checkpoint 恢复中崩溃=全会话消息永久丢失；调用方 `sessionCommands.ts:636`、`tuiPresentationAdapter.ts:207` 均无外层事务。
- 方案：函数体包 `db.transaction(() => {...})()`。
- 验收：mock 中途抛错断言消息原样保留的单测。
- 风险：极低（better-sqlite3 同步事务）。

**P0-2【S-4】view_image 工作区边界** · 2 小时
- 背景：`kernel/tools.ts:1428-1450` 直读任意路径 + base64 外发云端视觉端点（`agent.ts:1410-1412`），danger:false。
- 方案：复用 `safeWorkspaceRead`；越界返回显式错误。
- 验收：越界 ×3 形态拒绝单测；红队用例「注入诱导读密码管理器截图」被拒。

**P0-3【S-1】预算代际轮换 + 可视 + 可清零** · 半天
- 背景：`cliComposition.ts:205` budget id 恒定 → `securityProvisioning.ts:40-46` 永不轮换 → 50 bash/100 网络/200 写后**终身瘫痪且重启无效**；全仓无重置路径。
- 方案：① `budget.id` 加启动代际（`budget-cli-v1-<yyyymmdd>`）；② `/perm budget status|reset`；③ `/status`、`/doctor` 显示剩余额度。
- 验收：启动两次同 id 不重置/换 id 重置/撞上限 reset 恢复三单测。
- 语义：CLI 单机 limits=并发护栏而非终身配额，与 reserve/commit/release 设计意图对齐。

**P0-4【S-2】bash 分级切分补全** · 1 天
- 背景：`kernel/permissions.ts:220` 切分缺 `\n`/单`&`/`$()`/管道 `|`；多行命令 `cat file\nRemove-Item -Recurse src` 被判只读，smart 模式自动放行。
- 方案：① 正则补 `\r?\n`、`&`、`|`；`$(`/反引号段提取后**递归 classifyBashSingle**；② 只读白名单加严：单行、无 `$(`、无管道、无重定向才可判 readonly，否则降 unknown 走审批。
- 验收：多行伪装 ×8、`$()` 嵌套、管道尾接删除红队用例；既有合法只读命令零回归。
- 回归面：全部权限/审批用例。

**P0-5【S-3】system-touch 真弹窗 + grep/ls 边界** · 1 天
- 背景：`agentToolSurface.ts:259` 无条件 mark + `cliComposition.ts:206-211` 对 `agent:*` 直接 consume → 系统路径强确认被秒过；`tools.ts:503,520` grep/ls 无 pathBoundary → 零确认 `grep password C:/Users/...` 越权链。
- 方案：① approver 对 `SYSTEM_TOUCH_REQUIRES_CONFIRMATION` 强制走 `bridges.approver` 真弹窗（mark 仅对非 system-touch 生效）；② grep/ls/find_files 过 `validateWorkspaceTarget`。
- 验收：agent 工具命中系统路径必弹窗、工作区外路径被拒单测；红队「注入读敏感路径」用例绿。

**P0-6【S-7】/gateway 与 /a2a 认证** · 半天
- 背景：`handlersExt.ts:1128-1213,1286-1337` 零认证零 CSRF，CORS simple request 可跨站驱动 `/perm yolo`。**网络佐证**：OpenCode 同型缺陷酿成 CVE-2026-22812（默认 HTTP server+CORS 全开=浏览器 RCE）。
- 方案（对齐【网络调研⑤】主题 6：本地端口 127.0.0.1+随机 token）：复用 `serve.ts:419-464` 的 Bearer+evaluateCsrf；强制 `Content-Type: application/json` + Origin 白名单；command 侧对齐 serve 的白名单语义。
- 验收：无 token 401/text/plain 拒/跨站 Origin 拒三单测。

**P0-7【S-6】fs_edit 三级容错 + 行尾保真** · 1 天
- 背景：`tools.ts:190-236` 精确 indexOf 零容错；**同仓 `applyPatch.ts:156-168,227` 已有 exact→trimEnd→reindent+eol 探测未回灌**。竞品锚点：aider `editblock_coder.py:134-187` 四级降级；opencode `edit.ts:23-27,126-128` 行尾归一；**crush v0.88 刚修完同型**（空白自动纠正+LF 归一保原行尾）。网络佐证：【调研⑤】主题 7「CRLF/空白归一是标配预处理」。
- 方案：applyPatch 的 blockMatches 思想搬入 fs_edit：探测文件 eol → oldText/newText 归一匹配 → 失败降 trimEnd/reindent → 写回保持原 eol。
- 验收：CRLF/LF/混合 × 精确/缩进漂移/尾空白 6 组单测；真实 cmd 会话编辑 CRLF 文件一次成功。

**P0-8【A-3/A-4】重试语义双修** · 1 天
- 背景：`agent.ts:1232-1242` 重试成功后 `continue` 丢弃已成功响应（重复流式+双倍计费）；`agent.ts:1225-1240`+`presentationReducer.ts:212-213` 重发前零事件 → 半截与全文拼接显示。竞品锚点：gemini `geminiChat.ts:76-105` RETRY 事件（UI should discard partial content）；opencode v1.18.14 mid-stream 错误保留重试。【调研⑤】主题 1：mid-stream 失败不可透明重试。
- 方案：① 重试成功落入正常 res 处理；② 重发前 emit `stream.retry` → gateway 翻译为带 reset 标志的 message.delta → reducer 清空 streaming 段。
- 验收：mock 一败一成断言不发起第三次调用；断流后 UI 无拼接。

### 波 1：高频路径（每一次对话/命令/编辑都正确）

**P1-1【A-1】bash 中文 Windows 三连根治** · 2 天 · **本波最重**
- 背景：`tools.ts:381-385,395` PS 5.1 输出按 UTF-8 解码（OEM/GBK 下 dir 中文全乱码）；`-Command` 直传 CJK 受 argv 编码影响（空/损坏→挂死）。**同仓已掌握修法未回灌**：`hooks.ts:37-43` 已实测 `-EncodedCommand`、`winSandbox.ts:63` 已设 OutputEncoding。竞品锚点：**Kimi 1.42 把 Windows shell 后端从 PowerShell 切 git-bash**（同类问题竞品解法）；codex 0.78「PowerShell 强制 UTF-8」。
- 方案：① `-EncodedCommand`（UTF-16LE base64）；② 命令前缀 `[Console]::OutputEncoding=[Text.Encoding]::UTF8;`；③ stdout/stderr 用 `TextDecoder` 流式增量解码（`llmStream.ts:190` 已是正确写法）；④ 评估 git-bash 存在时优先路由（探测链 git-bash → PowerShell 兜底），对齐 Kimi 路线但保持 PowerShell 兜底（Windows 原生定位）。
- 验收：GBK 字节流解码单测；真实 cmd：中文文件名 dir/git log/echo 中文全正确；CJK 命令往返无挂死。
- 风险：bash 主路径改动——双终端（cmd+Windows Terminal）实测，全量 bash 用例回归。

**P1-2【A-2】bash 超时可调** · 半天
- 背景：`tools.ts:321,370` 硬编码 60s，npm install 必死。竞品锚点：opencode `shell.ts:540-564` timeout 是 schema 参数+超时提示引导重试；Claude Code `BASH_DEFAULT_TIMEOUT_MS/BASH_MAX_TIMEOUT_MS` 双档 env。
- 方案：schema 加 `timeout_ms`（默认 60s，上限 10min，settings.bashTimeoutMs 覆盖默认）；超时返回语引导「更大 timeout_ms 重试或转 /jobs」；有输出到达时重置空闲计时（区分挂死与长任务）。
- 验收：短超时参数生效、上限夹取、npm install 全程跑完（真实机）。

**P1-3【A-5】失败判定确定性化** · 半天
- 背景：`agent.ts:1327,1353-1356` 中文「失败/异常」子串计数 → grep 中文代码库必误杀（5 次硬停）。竞品锚点：gemini `tool-error.ts` 结构化 ToolErrorType（recoverable/fatal）。【调研⑤】主题 3：错误分类而非内容猜测。
- 方案：anyFail 改用 `lastToolOutcome==='failed'`（:685 已有未用）；子串启发式仅 MCP/外部工具兜底且标注来源。
- 验收：连续读含「失败」字样日志 10 次不终止；真实失败仍计数终止。

**P1-4【A-7】HTTP body Buffer 聚合** · 1 小时
- 背景：`serve.ts:100-117`+`handlersExt.ts:1133-1134` 逐 chunk toString → 中文跨 TCP 分包损坏。
- 方案：Buffer[] 聚合 + end 时 concat 解码，两处同改；顺带统一 64KB 限流语义。
- 验收：多字节字符切字节边界模拟分包单测。

**P1-5【A-8】「加密」意图劫持修复** · ~~1 小时~~ **作废（2026-08-21 裁撤裁决）**——`deterministic.ts` 随 D-3 整层移除，缺陷不复存在；裁撤落地前若用户实测踩坑，按原方案临时收紧正则。

**P1-6【A-12】工具参数 JSON 坏回喂自纠** · 半天
- 背景：`agent.ts:1694-1696` safeJson 吞 `{}`。竞品锚点：opencode `invalid.ts` InvalidTool 回喂；codex `function_call_error.rs` RespondToModel。【调研⑤】主题 7：回喂是最后手段、错误消息要「码+解释+建议」。
- 方案：解析失败不执行，回「参数 JSON 无效：<片段>——请重发合法 JSON」工具结果；附 Anthropic 范式的结构化错误格式。
- 验收：坏 JSON 不执行空参、模型收到可自纠错误单测。

**P1-7【A-16】PowerShell 属性探测税废除** · 1 天
- 背景：`windowsPathClassifier.ts:162-188` 每次带 path 工具调用同步 spawn PowerShell（150-800ms，阻塞事件循环）。双路交叉验证。
- 方案：① `attrib` 替代（毫秒级）；② path+mtime LRU 缓存；③ 读类工具跳过属性探测（仅写类 system-touch 启用）。
- 验收：同文件二次调用零 spawn；连续 10 文件操作 <200ms 总探测开销基准。

**P1-8【A-17】路径分类器归一化** · 半天
- 背景：`windowsPathClassifier.ts:106,134-143` 被 8.3 短名/尾点/正斜杠三类别名绕过（已实证）。
- 方案：`realpathSync.native` + `path.win32.normalize` + 统一斜杠后比对；`other` 但工作区外绝对路径默认升确认。
- 验收：三类别名 × 实文件红队用例。

**P1-9【B-8/B-9】hunk 回写行尾保真 + BOM 保真** · 半天
- 背景：`hunkApply.ts:66,98,108` join('\n') 直写 → 单 hunk 回滚整文件行尾翻转（applyPatch.ts:227 已有正确做法）；`tools.ts:165-183` fs_write 覆盖静默去 BOM。竞品锚点：opencode Bom 拆分处理。
- 方案：applyHunkToText 按原 eol 恢复；safeWorkspaceWrite 层检测保留 BOM、fs_read 前剥。

**P1-10【B-10】tool_search 进装配链** · 1 小时
- 背景：`agent.ts:614-626,1592-1612` updateTools 重建即丢 tool_search（/mcp add、/plugin reload 后懒加载入口失效）。双路交叉验证。竞品锚点：codex 0.143 MCP tool search 默认开启。
- 方案：注册移入 assembleTools。

**P1-11【B-22】plugin install 二进制保真** · 1 小时
- 背景：`handlersExt.ts:526-535` utf8 字符串往返复制 → 二进制插件必损坏。约束一直接受害面。
- 方案：Buffer 直拷或 cpSync。

**P1-12【W-2】doom_loop 防抖** · 半天
- 背景：竞品锚点 opencode permissions「同输入重复 3 次即拦截询问」；crush v0.43 工具死循环检测。wxnodus 已有同参 ≥3 循环终止（读缓存合并止血）但无「降级为人工确认」档。
- 方案：同工具同参第 3 次命中 → 拦截转审批面板（附前两次结果对比），用户可放行/终止；区别于直接终止（保留用户裁量）。
- 验收：mock 三连同参弹审批；放行后第 4 次继续。

### 波 2：鲁棒性机制（断网/限流/超限/崩溃自愈，对齐品类共识）

**P2-1【A-10/A-11/W-6】重连工程** · 2-3 天 · **本波最重**
- 背景：`llmStream.ts:5-8`（4 次/10s 封顶）+ agent 层 3 次 ≈ 断网 1 分钟任务报废；全程零可见信号（假死观感）。竞品锚点：**codex 0.148 turn 级断线重连+durable user-message queue**（消息落盘）；opencode 重试上限+jitter 防风暴；crush v0.85 mid-stream 恢复；kimi print_background_mode steer。技术决策：【调研⑤】主题 1 全文（429 尊重 Retry-After、529≠429、三段式 failover、connect 类无限等网）。
- 方案：① 错误分类重试器：429（Retry-After 优先）/529（更长退避）/connect（**等待网络模式**：60s 封顶指数退避至可配上限默认 10min，Esc 可中止）/4xx 不重试；② 重试上限+jitter（防风暴，对齐 opencode v1.18.17）；③ 全程 `system.notice` 可见（「网络中断，第 n 次重连…Ns 后重试」「限流中…」）；④ durable queue：用户消息在等待重连期间落盘（断电/退出不丢，重启恢复继续）——复用 events.jsonl 骨架。
- 验收：mock 断网 60s 恢复任务续跑；429 期间状态栏可见重试信号与恢复时刻；重连中途 Ctrl+C 干净退出且消息不丢。
- 风险：重试语义大改——三类端到端（断网/429/慢端点）+ 全量 llmStream 用例。

**P2-2【A-9】idle watchdog 替代全程超时** · 半天
- 背景：`llmStream.ts:390-391` 120s 全程超时杀长流式；TimeoutError 误判 premature-eof 连带 8 分钟假死。【调研⑤】主题 1：「距上一 chunk N 秒判死流」是标准做法；Node fetch 300s headers timeout 暗坑需显式处理。
- 方案：首 chunk 超时（如 30s）+ chunk 间隔空闲超时（如 60s）双档；全程上限放大可配（默认 30min）。
- 验收：慢端点长流式全程不断；真死流 60s 内判死并按类重试。

**P2-3【A-13/W-1】压缩工程对齐 Anthropic compaction** · 2 天
- 背景：`agent.ts:1159-1164` 字符估算 85% 触发（代码/JSON 偏差大）；413/超限只提示手动 /compact（`providers.ts:293`）。竞品锚点：**Anthropic 官方 compaction（真实 usage 触发+结构化输出）**；**kimi 0.20.2「413→压缩→重试」+ 0.22 摘要保留前向计划**+三参数显式化（compaction_trigger_ratio/reserved_context_size/pending 预估）；opencode v1.18.17 保留完整近轮。【调研⑤】主题 2：提早压缩（60-80%）防连环超限。
- 方案：① 每轮以真实 `usage.promptTokens`（:501 已有）校准估算系数；② 触发阈值降 75%（可配 settings.compactionThreshold，对齐 gemini compressionThreshold）；③ 压缩输出结构化（summary+近期轮次+保留请求+**前向计划**——kimi 佐证）；④ 捕获 413/context-length 语义错误 → 强制 compact → 自动重发一次；⑤ micro-compaction：旧工具结果先裁剪、对话保留（Anthropic clear_tools 思路，对齐 kimi 0.12 默认开启）。
- 验收：真实 usage 触发单测；413 自动压缩重发端到端；压缩后前缀一致性保 cache 命中（对照请求字节稳定）。

**P2-4【A-24】审批/澄清 pending 多路化** · 1 天
- 背景：`wxGateway.ts:98-99,2615-2637` 单槽覆盖不解决旧 Promise → 并发审批挂死回合；无超时。同文件 secrets/forms 已是 Map+timer+id 正确形态。
- 方案：改 Map<request_id,{resolve,timer}>；事件带 id 路由；超时 fail-closed；消除 clarifyRespond 跨通道误答死代码（1884-1896）；cancelForeground 补清 pendingClarify。
- 验收：并发双审批各自可答；超时自动 deny；单测覆盖。

**P2-5【A-26】error 事件作用域化** · 半天
- 背景：`wxGateway.ts:454-464`+`eventAdapter.ts:920-938` 任意后台 RPC 失败全局广播并复位 busy（「错误刷屏」同源）。
- 方案：error 加 scope（rpc/transient/core）；UI 仅 prompt.submit/agent.error 来源走 recordError，其余降 pushActivity 不动 busy。

**P2-6【B-13】MCP lazy-respawn 自愈** · 1 天
- 背景：`mcp.ts:409-417` server 退出后调用持续失败需手动重连。竞品锚点：crush `lifecycle.go` reconcile 状态机；opencode v1.18.11 MCP SSE 重连循环修复（反面：重连风暴）。
- 方案：调用时发现已关闭 → 自动重连一次（30s 失败冷却防风暴）→ 失败诚实回「server 已退出：<原因>」。
- 验收：杀 server 进程后下一次调用自动恢复；重连失败不风暴（冷却计数单测）。

**P2-7【B-20】中断恢复回放工具结果** · 1 天
- 背景：`agent.ts:1046-1052` 历史重建过滤 tool 消息 →「继续完成」名不副实。竞品锚点：gemini `geminiChat.ts:736-756` functionResponse 跨轮可见+INTERRUPTED 占位符保协议形态。
- 方案：被打断回合的 tool 消息（或摘要，有界最近 N 条）纳入回放；格式保 OpenAI 协议配对完整。
- 验收：打断后「继续」能看到此前工具产出（mock 断言消息序列含 tool role）。

**P2-8【B-21】LSP 诊断自动回灌** · 1-2 天
- 背景：`tools.ts:1407-1411` lsp_diagnostics 是模型可调但不自动接线。竞品锚点：opencode `edit.ts:197-205` touchFile+diagnostics 回灌；**crush LSP 工具化到 lsp_rename/lsp_replace_symbol**；Gemini 文档警告 LSP 内存/失同步成本——**默认关、按语言开**（吸收两家立场）。
- 方案：fs_edit/apply_patch 成功后异步拉该文件诊断（语言服务器可用才拉，300ms 超时兜底对齐 crush v0.46）；非空截断附结果尾部；settings.lspFeedback 默认 off。
- 验收：TS 文件编辑注入类型错误 → 诊断出现在工具结果；LSP 不可用时零开销。

**P2-9【B-23】/goal 假完成根治** · 半天
- 背景：`handlersExt.ts:2073-2094` 裸 `✅` 判完成 + 验证「任意最新旧项目」。
- 方案：移除裸 includes（保留 isCompletionClaim 行首判定）；任务前记基线目录，仅验证本轮新建/变更项目。对齐【调研⑤】主题 3「只测试后标记通过」。

**P2-10【B-19/W-7】429 限额状态面板** · 半天
- 背景：llmStream 只认 Retry-After，无会话级限流状态。竞品锚点：codex `turn.rs` update_rate_limits（额度/重置时刻进状态栏）。品类佐证：两家最大怨气均为额度不透明。
- 方案：解析 x-ratelimit-*/reset 子集 → 会话级缓存 → 状态栏「额度 HH:mm 重置」；与已有 💰 低余额警示同源整合。

**P2-11【B-24】Ctrl+C 双语义** · 1 小时
- 背景：`cli/index.ts:1014-1019` 300ms 无条件退出，与注释「运行中中断/空闲退出」矛盾。
- 方案：第一次只中断 Run+提示「再按退出」；退出放第二次或空闲态。

**P2-12【B-25/B-26/B-31/B-32】生命周期毛边一揽子** · 1 天
- kernel 阶段 MCP 泄漏（`cliComposition.ts:175,216-219` phase 内 catch 先 closeAllMcp）；/jobs follow 取消信号（`handlersExt.ts:1561-1584`）；管线 timeoutMs 执行超时（Promise.race）；hooks/UIA 同步 spawn 改异步（`hooks.ts:53-59`、`uia.ts:274`）。

### 波 3：架构收敛（渲染矩阵/性能/发布链）

**P3-1【A-25】INLINE 坐标系修复** · 1 天
- 背景：`log-update.ts:812-832` `_viewportY` 弃用 → 主屏 CUP 全错位。UI 审计系统性结论：三写路径×两屏幕模式×三能力档矩阵只有一格被测。
- 方案：CUP 行号减 viewportY；`y-viewportY<0` 跳过；主屏 CR+相对兜底。

**P3-2 渲染矩阵不变式与全格测试** · 3-4 天 · **架构专项**
- 背景：5 个 conhost commit 是补丁掩盖架构缺口；四个带外写入源（textInput 直写/forceRedraw 裸 ERASE/终端 clamp/ConPTY 吞帧）各自打补丁无统一不变式。
- 方案：① 显式不变式文档化（内容行 vs 终端行坐标系、每路径的锚定策略）；② 「帧首锚定」统一（alt-screen 已有 CURSOR_HOME_PATCH，补主屏）；③ 矩阵测试：{非conhost差分, conhost脏行段, 全量切片}×{alt-screen, INLINE}×{modern, cmd, no-vt} 每格至少一个渲染快照测试；④ forceRedraw 的 ERASE 并入 diff patch 序列首部（受 BSU/ESU 保护，B-34）；⑤ DEC 2026 DECRQM 探测启用（WT 未支持则降级，对齐【调研⑤】主题 4）。
- 验收：矩阵快照全绿；cmd 实测 overlay 按键零白闪；B-33 末列冻结与 B-36 主屏 resize 一并收口。

**P3-3【A-21】事件流落盘分级+轮转** · 1 天
- 背景：`events.ts:75` 每 token appendFileSync（单日数百 MB）。竞品佐证：crush SQLite 写放大 issue 群（33ms 全量重写）同病；kimi 轮转。
- 方案：token/reasoning.delta 不落盘或 250ms 缓冲合并；events.jsonl 大小上限+轮转（低频事件全量保留保重放）；sessionStream 同步改异步+5MB 轮转。
- 验收：长回复落盘次数 ≤回复秒数/0.25；重放完整性用例绿。

**P3-4【A-15】离线校验缓存** · ~~半天~~ **作废（2026-08-21 裁撤裁决）**——`offlineModel.ts` 随 D-1 全链移除，哈希税不复存在。

**P3-5【A-18/A-19/A-20 + B-37/38/41/42】发布链闭环** · 2-3 天
- 安装器补根 package.json（版本 0.0.0+Node 门槛根治）；taskkill 兜底+deadline；spec 两轮校验；SBOM 闭包断言+ABI 预检；VSCode 扩展 shell/dataDir/互斥；verify.ts 等 exit 再 respawn+探活轮询；迁移备份轮转。
- **W6 管线新增「装上能跑对」自校验**：干净虚拟机装包→`wxnodus --version` 非 0.0.0→冒烟会话。

**P3-6【B-1/B-2/B-3/B-4/B-5/B-6/B-7】数据一致性一揽子** · 2 天
- undoShadows 最旧版本（分组取 ts 最大）；预算标志跨会话 Map 化；快照前提（compactSmart 改新增摘要行不覆写）；WAL 卫生（restore 前 rm wal/shm+rename 失败终止）；audit 链单语句哈希+verifyAudit；授权 status 状态机；/backup 在线备份 API。
- **新增：SQLite ≥3.51.3 升级评估**（better-sqlite3 绑定版本，修 WAL-Reset 竞争 bug——【调研⑤】主题 5）。

**P3-7【W-3】系统提示开销审计** · 1 天
- 背景：OpenCode 批评文+HN 对照（33k vs 7k）。wxnodus 未知档位。
- 方案：实测当前每轮注入 token 量（system+召回+工具 schema）；对照竞品定档；压减非必要注入（工具 schema 按需、召回有界）。
- 验收：注入量基准入 `npm run bench`；目标对齐 opencode 7k 档（≤10k）。

### 波 4：对齐同类 CLI（交互标准与互操作）

**P4-1【U】AGENTS.md 互操作标准** · 1 天
- 背景：Codex/Claude Code/Kimi/Crush/OpenCode 全部采用 AGENTS.md 分层（全局>仓库根>子目录，最近 4 层）；Claude 社区 issue #31005（426 赞）在要。wxnodus 已有 /init 生成（AGENTS.md 存在），需核对分层加载与上限语义。
- 方案：对齐分层搜索（向上最多 4 层）+`project_doc_max_bytes` 注入上限+`@file` 导入；保持与自有记忆体系共存（AGENTS.md=项目层、黑洞=跨会话层）。

**P4-2【W-8】stream-json 语义化退出码与事件流** · 1-2 天
- 背景：竞品锚点 gemini headless（退出码 0/1/42 输入错误/53 轮次上限）+stream-json 事件分类；codex exec --json+--output-schema。
- 方案：`-p --json` 退出码语义化（沿用并补 42/53 档）；stream-json 事件对齐品类分类学（init/message/tool_use/tool_result/error/result）；修 B-29 inferTextCompletion 误判（显式 completion 优先，删信息词启发式）。
- 验收：CI 脚本可按退出码分支；事件流与文档一一对应。

**P4-3【W-9】`wxnodus doctor` 全链路自诊断** · 1-2 天
- 背景：竞品锚点 codex doctor（端点保护/网络代理/更新连通性）。wxnodus /doctor 已有档案一致性，需扩全链路。
- 方案：新增检查项——端点连通（探活当前 provider）、代理链路、更新通道可达、SQLite 完整性（integrity_check+audit 链 verify）、原生依赖 ABI、磁盘余量、渲染终端能力档位；输出结构化报告（exit code 可判）。

**P4-4【W-10】会话 fork/export/import 对齐** · 1-2 天
- 背景：竞品锚点 codex resume/fork/exec fork/归档//import（从 Claude Code/Cursor 迁移）；kimi /fork//export/import-from-cc-codex；claude --fork-session。
- 方案：① `/sessions fork`（复制会话分叉不污染原线程——wxnodus 有 checkpoint 骨架，fork=新会话+消息复制）；② `/export`（Markdown+JSON 双格式）；③ `/import` 增强（竞品会话格式导入：claude/codex 的 JSONL——降低切换成本的增长手段，**kimi 实证有效**）。

**P4-5【A-23】vim 接线修复 + 双 Esc 门控** · 1 天
- 背景：`textInput.tsx:1005-1012,1521-1533` Esc 死代码 → vim 整体不可用（vimCore 836 行纯函数完好）；useKeyBindings 双 Esc（:685）与 vim 肌肉记忆冲突。
- 方案：vim 分支上移 pass-through 之前；双 Esc 前加 vim 门控；**补 handler 接线层集成测试**（纯函数单测已好、接线零覆盖是盲区）。
- 网络佐证：Antigravity 迁移抱怨「缺 vim 支持」是流失原因之一——vim 可用性是真实需求。

**P4-6【W-5】模型中途切换缓存提示** · 半天
- 背景：品类痛点 15（切模型→cache 全失效+分布漂移）。wxnodus /model 会话中可切。
- 方案：切换时 sticky 提示「切换后缓存前缀失效、首次响应变慢」；状态栏缓存节省展示已有（保持）。

**P4-7【B-14~B-18/B-27/B-28/B-30】B 级精选一揽子** · 2 天
- browser 重定向逐跳 SSRF（framenavigated 重跑 authorizeOutboundUrl）；term sanitizedEnv；cron dom/dow OR 语义；`[DONE]` 尾帧宽容；temperature 按模型省略（o 系/gpt-5 类 400）；/import 会话错位；/warp 入 SLASH；/computer click 坐标校验；MCP stdio TextDecoder 增量解码（B-12）；apply_patch 敏感写下沉（A-22 补遗：executeTool 层统一 SENSITIVE_WRITE 检查）。

### 波 5：用户权力（自升级 + 产物迁移 + 只收不出收口）

**P5-1【U-1】`wxnodus update` 自升级** · 2-3 天
- 背景：约束四。竞品锚点：codex 0.128 `codex update`；kimi-code 0.37 Windows 单二进制自动更新；crush update.go release 比对（dev 版跳过）；crush issue #1142 自更新是高需求。
- 方案：① 启动后台单次查 release（GitHub Release API，wxnodus 已有私有 release 通道——S-01 已备）；② 新版 banner+/update 指引，**绝不自动安装**（用户裁决权）；③ `wxnodus update [--check|--skip <ver>]`：下载→sha256 校验→staging 原子换入→重启提示；④ `--rollback` 回退上一版（保留 N-1 包）；⑤ 离线/私有部署：`wxnodus update --file <zip>` 本地包安装（复用 installer 链）。
- 验收：模拟 release feed 的升级/跳过/回退端到端；失败（断网/校验不过）保持旧版可运行。

**P5-2【U-2】用户产物迁移框架** · 3-4 天 · **本波最重**
- 背景：约束四。现状 `migrations/db/registry.ts` 只覆盖 DB schema；文件系统级用户产物无迁移框架。
- 方案：① **产物清单**（manifest）：data/ 下全部用户资产的声明式清单（插件/skills/MCP 配置/.mcp.json/自定义命令/主题/键位/权限规则 permissions.json/密钥档案（加密态迁移）/会话库/events.jsonl/记忆库/项目产物 data/projects）；② 启动时版本比对：产物 schema 漂移 → 迁移器链（每迁移器=旧形态→新形态纯函数+dry-run 校验+原子应用+回滚备份）；③ `/migrate status` 命令：列出产物兼容状态与已执行迁移；④ 迁移失败 fail-safe：保持旧目录可用+明确报告，绝不半迁移。
- 对齐【调研⑤】主题 5：temp+rename、JSON 比 Markdown 抗损坏、迁移前 VACUUM 备份已有（沿用）。
- 验收：构造 v3.0 老数据夹具 → 升级 → 全产物兼容断言；迁移中断注入 → 旧数据完好。

**P5-3【U-3】「只收不出」市场收口** · 1-2 天
- 背景：约束一。`/market` 已是双源聚合（npm+GitHub topic），`/bundle` 已有整包打包/一键装。
- 方案：① 文档与命令面口径统一为「开放生态聚合器」（消费侧）；② `/bundle` 强化：含版本指纹与依赖清单的 manifest → 对方安装时校验兼容性（wxnodus 版本/skills/MCP 版本）；③ 自制插件分享路径唯一化文档（bundle→离线分发）；④ `/market` 新增公开源接入评估（GitHub awesome 列表/SKILL.md 仓库 topic）——只增消费源。
- 验收：bundle 打包→干净环境装回→插件/skill/MCP 全部可用；manifest 不兼容时明确拒绝。

**P5-4【B-28/B-40 + C 级】收尾清理批** · 2 天
- /warp 入目录；evidence fingerprint 含文件名；complianceCheck 改查 audit 表；scaffold/forge 注入转义；FTS 外部内容表化+deleteMessage 清 FTS；bigramZh 单字成 token；/sql PRAGMA 白名单收窄；curator//memory 会话 id 化；voice 死正则；loopJudge 整词锚定；execServer 临时文件清理；config.ts 原子写加固（随机 tmp 名+rename 重试）。

### 维护轨 M：独有功能冻结维护（贯穿各波）

规则：只修缺陷/保兼容/保测试，不做新独占特性。分配到各波的维护卡：
- M-1（波 1 附带）：黑洞记忆——修 curator 只统计 default、imageHistory FTS 不刷新、absorbCount 硬编码（B/C 级三件）。
- M-2（波 2 附带）：/build——spec 前向依赖两轮校验（A-20 已入 P3-5 前移至波 0.5 可选）、verify 探活轮询、evidence 指纹/合规检查修正。
- M-3（波 3 附带）：winSandbox——双速权限试点（W-4）：`sandbox=on` 时工作区内低危写免审批（对齐 Claude「沙盒内即免审批」，实测 -84% 弹窗），**沙盒外维持现状强审批**；settings 双速开关默认关，先灰度。
- M-4（波 4 附带）：UIA/computer——runPs 异步化（P2-12 已含）、EncodedCommand 对齐、click 坐标校验。
- M-5（波 5 附带）：ACP/A2A——sessions Map 泄漏、notification 回包协议修正。
- M-6（全程）：合规链——audit 链 verify 单语句化（P3-6 已含）+证据轮转。

### 裁撤轨 D：离线能力软着陆移除（波 0.5 启动，约束三 2026-08-21 二次裁决）

> 裁撤范围：离线对话、离线看图、无 key/无网可用层。保留：语音、气隙升级、黑洞记忆/本地向量（归维护轨 M-1）、「数据不出机」定位。
> 软着陆纪律（Buddy 事件教训【网络调研①】：Claude Code 移除 /buddy 状态栏宠物引发 2071 赞反弹）：先警告期+逃生开关，再物理移除。

**D-1 离线模型全链移除** · 2 天
- 范围：`kernel/offlineModel.ts`（推理/下载/就绪校验）、agent 的 `offline:` 前缀路由与密钥隔离分支、模型档案中 offline 档位、`/offline` 相关命令与 settings 键、「缺模型即拉取」管线、相关测试（kernel-offlineModel.test.ts 等）。
- 软着陆：首版 deprecation 警告（「离线模型将于下版移除，数据目录 data/models 可手动清理」）+ `WXNODUS_LEGACY_OFFLINE=1` 逃生开关；次版物理删除代码与逃生开关。
- **作废卡**：A-15（每次推理全量 SHA-256 哈希税——代码移除即消失）。
- 验收：默认路径零 offline 引用（grep 全仓）；逃生开关开启时旧功能可用且警告可见；测试全绿。

**D-2 离线看图通道移除** · 1 天
- 范围：`kernel/vision.ts` 的 moondream2 本地视觉分支与 Windows OCR 兜底（`:41-58,114-167`）；`computer_observe` 无 key 时的 OCR 兜底 → 改为诚实失败（「视觉描述需要配置视觉模型密钥」）；`/vision` 命令收敛为云端视觉模型单通道。
- 保留：`/capture` 截图、`view_image` 图片输入（云端视觉模型通道，含 P0-2 边界修复）。
- 验收：无 key 时 observe/图片识别诚实引导配置；视觉模型已配时行为不变；vision 相关测试更新后全绿。

**D-3 无 key/无网可用层移除** · 1-2 天
- 范围：`src/commands/deterministic.ts` 确定性工具层（base64/计算器白名单）、`/build` 规则脑模具分支（build 全链依赖 LLM——无 key 时诚实引导 `/key set`，不再有规则脑兜底编译）、NL 路由中 `/hole` 本地记忆兜底降级分支收敛（NL 命令路由本身保留——它不依赖离线能力，属免记命令体验）。
- 注意：`intent.ts` 的 NL 路由主链保留（痛点 12 对策）；仅移除「无 key 时假装可用」的兜底层。
- **作废卡**：A-8（「加密…」意图劫持——deterministic.ts 移除即消失；P1-5 卡作废）。
- 验收：无 key 首启引导路径仍诚实（/key set 指引，agent.ts:334-343 语义保留）；NL 路由高频命令不受影响；测试全绿。

**D-4 裁撤配套** · 1 天
- 文档口径同步：README/帮助/官网性文案去除「无 key 也能用」「离线模型/离线看图」宣称（「数据不出机」「无账号无订阅」保留）；CHANGELOG deprecation 声明；用户已有离线模型文件的清理指引（data/models 磁盘占用说明）。
- settings 迁移器：`WXNODUS_LEGACY_OFFLINE` 未开启时清洗 settings 中 offline 残留键（接入 P5-2 迁移框架的最早实践用例）。
- 依赖面核查：确认无其他模块 import 被移除面（grep + tsc 全量验证）。
- 验收：`npx tsc --noEmit` 零错；全量测试绿；文档无残留宣称（grep 「离线模型|离线看图|规则脑」=0）。

---

## 第 6 章 里程碑路线图

| 里程碑 | 内容 | 出口判据（全部门禁绿） | 预估 |
|---|---|---|---|
| M0 基线整理 | 未提交 99 文件分主题入库；波 0 全部 8 卡 | 混沌/红队用例绿；undo 路径崩溃注入零丢失 | 3-4 天 |
| M0.5 裁撤软着陆 | 裁撤轨 D-1~D-4（与波 1 并行启动） | 默认路径零 offline 引用；逃生开关可用；文档口径同步 | 4-5 天 |
| M1 高频正确 | 波 1 全部 12 卡（P1-5 作废→11 卡） | 真实 cmd 中文场景电池全绿；npm install 全程 | 1 周 |
| M2 自愈可用 | 波 2 全部 12 卡 | 断网 10min 续跑；413 自动压缩；并发审批零挂起 | 1.5 周 |
| M3 架构收敛 | 波 3 全部 7 卡 | 渲染矩阵快照全格绿；装包干净机冒烟绿 | 1.5 周 |
| M4 业界对齐 | 波 4 全部 7 卡 | AGENTS.md 分层生效；退出码语义化；doctor 全链路 | 1 周 |
| M5 用户权力 | 波 5 全部 4 卡 | 升级/回退/迁移端到端；bundle 干净环境装回 | 1.5 周 |
| 合计 | —— | —— | **约 7-8 周** |

并行建议：M2 与 M3 可双线（不同文件面）；维护轨/离线轨穿插不占主线。

---

## 第 7 章 验证与质量门禁体系

### 7.1 每卡门禁（合入前）
新增单测 → `npx tsc --noEmit` → 相关既有用例全绿 → 波次专属验收项。

### 7.2 每波门禁（收口前）
全量 `npx vitest run`（413 文件，含 known-failures gate）→ `npm run ci`（九命令）→ `npm run bench`（性能不回退：shortHash/diff/bigramZh/diffLines 四基准 + 新增注入量/探测开销基准）→ 手动冒烟（§7.3 之一）。

### 7.3 真实场景电池（波 1 起每波全跑，Windows 本机）
1. **中文路径电池**：cmd.exe + Windows Terminal 双终端 × {启动、中文输入、GBK 目录 dir、git log 中文、echo 中文、CRLF 文件编辑、单字中文记忆检索}；
2. **长任务电池**：npm install 全程、30+ 轮工具任务无中断、/jobs 后台+取消；
3. **鲁棒电池**（波 2 起）：断网 60s 恢复续跑、429 模拟限流可见、并发审批、Ctrl+C 中断不退出；
4. **渲染电池**（波 3 起）：{cmd, Windows Terminal}×{默认 alt-screen, INLINE} 滚动/resize/overlay 按键/末列滚动条；
5. **升级电池**（波 5）：装旧版→造产物→升级→断言兼容→回退→断言可用。

### 7.4 专项门禁
- 红队用例集（波 0 建，持续扩充）：多行伪装 ×8、$() 嵌套、注入读敏感路径、view_image 越界、/gateway 跨站、8.3 别名——全部期望拒绝；
- 混沌用例（波 0 建）：undo/checkpoint/压缩/迁移全路径中途崩溃注入——断言数据完好；
- 渲染矩阵快照（波 3 建）：9 格全绿后方可动写入策略。

### 7.5 发布链门禁（波 3 起）
W6 管线新增「装上能跑对」：干净虚拟机装包 → 版本非 0.0.0 → Node 门槛拦截 → 冒烟会话 → 卸载干净。

---

## 第 8 章 风险登记册

| # | 风险 | 概率/影响 | 缓解 |
|---|---|---|---|
| R-1 | P1-1 bash 主路径大改引入新回归 | 中/高 | 双终端实测+全量 bash 用例；EncodedCommand 与 git-bash 路由均设逃生开关（settings.bashEngine） |
| R-2 | P2-1 重试语义重构致重试风暴/白烧 | 中/高 | 上限+jitter（opencode 教训）；三类 mock 端到端；重试计数与烧钱量进 /cost |
| R-3 | P3-2 渲染矩阵测试本身脆弱（快照漂移） | 中/中 | 快照仅锚定行为断言（末列/坐标/清屏次数）非字节全等；环境档位显式 mock |
| R-4 | P5-2 迁移框架覆盖不全致用户产物损坏 | 低/极高 | 产物清单驱动+dry-run+原子应用+回滚备份+老数据夹具测试；失败 fail-safe 保持旧目录 |
| R-5 | 独有功能维护与主线争资源 | 高/中 | 维护轨只随波附带（M-1~M-6 明确分配），独立提案一律进积压 |
| R-6 | 竞品语义对齐破坏既有用户习惯（如退出码变化） | 中/中 | 语义变化走 settings 开关+迁移期兼容（Buddy 事件教训：变化要有开关） |
| R-7 | SQLite/better-sqlite3 升级原生 ABI 兼容 | 中/高 | 波 3 评估时连带 installers ABI 预检（P3-5）；预发布通道先验证 |
| R-8 | 双速权限（M-3）放宽审批面 | 低/高 | 默认关+灰度+沙盒外强审批不变+审计标注「沙盒放行」来源 |
| R-9 | 裁撤离线能力引发存量用户反弹（Buddy 事件同型：2071 赞） | 中/中 | 软着陆：deprecation 警告期一个次版本+`WXNODUS_LEGACY_OFFLINE=1` 逃生开关+清理指引+CHANGELOG 显式声明 |
| R-10 | 裁撤引发依赖连锁断裂（offlineModel/vision/deterministic 的隐式 import 面） | 中/中 | D-4 依赖面核查（全仓 grep+tsc 全量）；裁撤与波 1 同文件面冲突时裁撤先行 |
| R-11 | 「数据不出机」宣称与「不再离线」被误解为数据上云 | 低/高 | D-4 文档明确区分：数据仍全本地（会话/记忆/密钥），仅运行需网络与模型密钥 |

---

## 第 9 章 附录

### 9.1 来源索引
- 【审计】`docs/production-readiness-plan-2026-08-21.md`（本仓，纯源码 5 路深审）
- 【竞品源码】`Desktop\cli-compare\{codex,gemini-cli,opencode,kimi-cli,crush,aider}`
- 【网络调研】关键来源（节选）：
  - Anthropic 工程博客：effective-context-engineering / writing-tools-for-agents / multi-agent-research-system / effective-harnesses-for-long-running-agents；Compaction API 文档
  - OpenAI Codex：developers.openai.com/codex/{config-reference,sandboxing,noninteractive,best-practices}；releases（rust-v0.149.0，2026-08-20）
  - Claude Code：code.claude.com/docs/{settings,sandboxing,common-workflows}；CHANGELOG 2.1.238；issues #45596(Buddy)/#16157/#41447
  - Gemini CLI：geminicli.com/docs 全站；迁移公告（developers.googleblog.com）；discussion #27274
  - Kimi：moonshotai.github.io/kimi-cli 与 kimi-code 文档+releases（1.42 PowerShell→git-bash；0.20.2 413→压缩重试）
  - OpenCode：opencode.ai/docs 全站；CVE-2026-22812（cy.md）；wren.wtf 批评文；releases v1.0-v1.18.19
  - Crush：charmbracelet-crush.mintlify.app；repo docs/config+FUTURE.md；releases v0.85-v0.90
  - Aider：aider.chat/docs（edit-formats/repomap/git/leaderboards）；HISTORY
  - 可靠性：sqlite.org/wal.html；avi.im/sqlite-fsync；contour DEC 2026 文档；learn.microsoft.com console VT；OWASP LLM Injection Cheat Sheet；simonwillison.net lethal trifecta；LiteLLM routing docs；Chroma context-rot 研究
  - 品类痛点：HN #47559293/#48770319/#48883275/#47962775；Reddit r/ChatGPTCoding r/LocalLLaMA r/ClaudeAI r/codex；DORA 2025；METR RCT

### 9.2 任务总索引（98 张卡，其中 2 张作废）
- 波 0（8）：P0-1~P0-8 ← S-1/2/3/4/5/6/7 + A-3/4
- 裁撤轨（4）：D-1~D-4 ← 约束三二次裁决（离线对话/看图/无 key 层软着陆移除；语音/气隙升级/记忆向量保留）
- 波 1（11 生效）：P1-1~P1-12，其中 P1-5（A-8）作废 ← A-1/2/5/7/12/16/17 + B-8/9/10/22 + W-2
- 波 2（12）：P2-1~P2-12 ← A-9/10/11/13/24/26 + B-13/19/20/21/23/24/25/26/31/32 + W-1/6/7
- 波 3（6 生效）：P3-1~P3-7，其中 P3-4（A-15）作废 ← A-18/19/20/21/25 + B-1~7/33/34/36/37/38/39/40/41/42 + W-3 + SQLite 升级
- 波 4（7）：P4-1~P4-7 ← U/AGENTS.md + W-8/9/10/5 + A-23 + B-11~18/27/28/30
- 波 5（4）：P5-1~P5-4 ← U-1/2/3 + B-28/B-40 + C 级清理批（P5-1 含气隙升级 --file，保留项）
- 维护轨（6）：M-1~M-6（含语音死正则等 C 级随 M 轨消化）
- 未入波 C 级（长期积压，随波附带消化）：uia EncodedCommand、grep -- 注入、plugins NL 筛选、skills name 清洗、acp 泄漏、browser headless 不可达分支、wxGateway 拆分预案（协议方法再增即拆）、zip ZIP64、evidence 轮转、DNS rebinding 记录项。

### 9.3 与战略约束的映射自检
- 约束一（只收不出）：P5-3 收口；无任何建市场任务 ✓
- 约束二（对齐同类）：波 1/2/4 全部对齐卡 + AGENTS.md/退出码/doctor/fork-import 互操作 ✓
- 约束三（独有全面冻结+离线裁撤）：M-1~M-6 维护卡无新特性；裁撤轨 D-1~D-4 覆盖离线对话/看图/无 key 层；语音/气隙升级/记忆向量按用户裁决保留 ✓
- 约束四（用户权力）：P5-1 自升级（含 --file 气隙包）+ P5-2 产物迁移，R-4 列最高影响风险 ✓

---

*本计划为活文档：每波收口后在 §6 里程碑表标记状态并回填实际偏差；新增发现走【审计】同格式入册后在此登记卡号。*

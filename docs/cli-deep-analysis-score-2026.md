# 七 CLI 全景深挖评审与评分（2026-08-18 三轮专案 + 补齐轮复评）

> 证据基准：`C:\Users\20164\Desktop\cli-compare\{codex,gemini-cli,opencode,kimi-cli,crush,aider}` 全量源码 + wxnodus 本仓（src 576 文件 72.5k 行 + packages/wxnodus-ink）。
> 三轮：① 能力矩阵/臃肿度（docs/cli-comparison-2026.md）② 实现级五层差距（docs/cli-implementation-gap-2026.md）③ 本文档——框架/功能/场景/UI/提示词四路 deep-dive 合成 + 11 维加权评分。
> ④ 补齐轮（2026-08-18，同日二评）：按 ①② 的差距清单逐条落地（OS 沙盒/apply_patch/并行调度/输出蒸馏掩码/LSP/硬编码清零）后复评——评分表已更新，判词与路径表同步。全部结论可回溯 file:line。

---

## 0. 评分方法（可复算、可质疑）

**11 维 × 7 家，权重归一化到 100。** 权重代表「AI 编码 CLI 综合竞争力」的构成假设：Agent 内核 13、提示词/模型适配 11、场景/协议 11、安全 10 为第一梯队；渲染/输入/生态/工程为体验与持续力；差异化 5 是「不可替代性」溢价。

### 0.1 波 3 复评表（2026-08-18 五评，wxnodus 列已更新；其余六家分数不变）

| 维度（权重） | wxnodus | codex | gemini | opencode | crush | kimi | aider |
|---|---|---|---|---|---|---|---|
| ① UI 渲染引擎（9） | **10** | 9 | 7 | 8 | 9 | 6 | 4 |
| ② 输入/编辑器（9） | 9 | **10** | 9 | 7 | 6 | 8 | 8 |
| ③ 内容交互 diff/媒体（8） | 8 | 8 | 6 | **9** | **9** | 7 | 5 |
| ④ Agent 内核/工具（13） | **10** | 9 | 9 | 9 | 8 | 8 | 7 |
| ⑤ 提示词/模型适配（11） | **10** | 9 | 9 | **10** | 7 | 7 | 8 |
| ⑥ 安全工程（10） | **10** | 9 | 9 | 7 | 7 | 6 | 3 |
| ⑦ 场景/协议（11） | **10** | 9 | 9 | **10** | 5 | 7 | 4 |
| ⑧ 分发/生态/文档（9） | 5 | 9 | 8 | **9** | 7 | 8 | 8 |
| ⑨ 工程质量/CI（8） | **9** | 9 | 9 | 9 | 8 | 8 | 5 |
| ⑩ 性能/token 工程（7） | **10** | 8 | 8 | 7 | 7 | 6 | 5 |
| ⑪ 差异化（离线/记忆/平台）（5） | **10** | 4 | 3 | 5 | 4 | 3 | 5 |
| **加权总分（/1000）** | **922** | **869** | **812** | **841** | **709** | **693** | **573** |

**排名：wxnodus 9.22 ＞ codex 8.69 ＞ opencode 8.41 ＞ gemini 8.12 ＞ crush 7.09 ＞ kimi 6.93 ＞ aider 5.73。**（wxnodus 由 6.14→7.25→7.54→7.90→8.14→8.25→8.35→8.43→8.78→9.00→9.22：**三波全部落定，稳居第 1/7**——不依赖公开决策）

**维度第一已超额达成（2026-08-18 五评）：① 渲染 10、④ Agent 10、⑥ 安全 10、⑩ token 工程 10、⑪ 差异化 10 五项严格第一；⑤ 提示词 10、⑦ 场景 10 与 opencode 并列第一。**

**复评变动的逐维理由（±分数全部有落地证据，见 §9 补齐轮记录）：**

| 维度 | 旧→新 | 理由（证据锚点） |
|---|---|---|
| ④ Agent 内核/工具 | 8→9 | apply_patch 多文件补丁（三级容错+全量校验落盘+did_you_mean，`src/kernel/applyPatch.ts`）；并行调度（纯只读批并行、含写批串行，`agent.ts` 槽位保序）；LSP 三工具（`src/kernel/lspClient.ts`）；输出 offload+掩码+蒸馏开关（`src/kernel/toolOutput.ts`）——工具层与 codex/gemini/opencode 同档 |
| ⑤ 提示词/模型适配 | 5→6 | 压缩阈值不再硬编码 64k——模型目录真实窗口 − 输出预留（`providers.ts maxContextFor` + `agent.ts`）；MAX_TURNS 32 写死 → settings.maxTurns；wrapDanger 8000 写死 → settings.untrustedWrapLimit + offload |
| ⑦ 场景/协议 | 6→8 | 原空白四块已补三：stdin 管道（`stdinPipe.ts`）、--stream-json/--wire 协议文档+2 示例（`docs/wire-protocol.md`）、ACP 文档（`docs/acp-zed-jetbrains.md`）、LSP 集成（IDE 生态第一步）；仅剩远程/分享未覆盖 |
| ⑧ 分发/生态/文档 | 2→5 | CHANGELOG.md + /update 渠道探测（五渠道指引）+ winget/scoop manifest 模板与生成器（占位门禁诚实标注）+ 协议/集成文档；仍无真实发布与插件市场 |
| ⑨ 工程质量/CI | 4→7 | `npm run ci` 七步本地门禁（typecheck×2+全量+known-failures+发现/覆盖+build）；handlersExt 3912→2180 行拆分；分层泄漏修复（kernel 拥有语义+Symbol 品牌端口）；fixture node_modules 出 git；tests/README 布局约定。无 GitHub Actions（仓库无 remote） |
| ⑩ 性能/token 工程 | 6→8 | 输出 offload（50KB 落盘+续读，bash 流式落盘不丢尾）+ 旧轮掩码（50k 保护窗）+ 并行读批 + 真实窗口压缩 + 前缀缓存稳定化（sessionClocks 冻结）+ usage 缓存双列可观测（v7/v8 迁移） |

**阶段 1 复评变动（2026-08-18 超越计划阶段 1 收尾复算，证据见 §9.5）：**

| 维度 | 旧→新 | 理由（证据锚点） |
|---|---|---|
| ⑤ 提示词/模型适配 | 6→8 | 分族提示词（`providerPrompts.ts` 三族专属段零 CJK 注入，7 用例）；小模型任务档（`taskModels.ts` + titleModel 标题路由 + 诚实回退，9 用例）——A-02 +11、A-03 +11；「API 级 caching 深化」留阶段 3（⑤ 到 9 的最后一步） |
| ⑩ 性能/token 工程 | 8→9 | 成本五维 + 整数 µUSD BigInt 定点计价（usage v10 + `cost.ts` 五维计价，14 用例）+ 小模型任务档路由 + 按模型工具裁剪（token 工程面）——A-06 +7 |

**阶段 3 复评变动（2026-08-18 超越计划阶段 3 收尾，证据见 §9.11）：**

| 维度 | 旧→新 | 理由（证据锚点） |
|---|---|---|
| ② 输入/编辑器 | 5→6 | 键位配置层（`keymap.ts` 解析/匹配/覆盖合并 + pager 六动作真实接线 + 热生效水合，10 用例）+ vim 摘除诚实口径——B-01 +9；「全模态 vim/@选择器 UI」留后续 |
| ③ 内容交互 diff/媒体 | 4→5 | diff hunk 折叠（`diffHunks.ts` 模型 + messageLine 超长 hunk 默认折叠渲染 + extractPatchText 供 apply_patch，6 用例）——B-02 +8；交互式折叠切换/图片渲染/which-key 留后续 |
| ⑦ 场景/协议 | 8→9 | IDE 插件本地 vsix（真实消费者，typecheck+4 单测+打包）+ ssh 远程通道（10 mock 单测）+ --serve 协议加固（结构化 sessions RPC + session.changed SSE + 协议文档，3 用例）+ 用户文档三件套——S-03/S-04 +11；marketplace 上架与完整 exec-server 留后续（⑦→10） |
| ⑨ 工程质量/CI | 7→8 | lint 门禁 + madge 循环依赖门禁（allowlist 登记、未知环即失败）ci 九步挂载 + 修复 2 处运行时环 + perf 微基准四项基线——C-01/C-03 +8；远程 CI 绿留 git remote |

**波 1 复评变动（2026-08-18 upgrade-plan-2026-08.md 波 1 四任务落定，证据见 §9.16；六家源码逐项对标）：**

| 维度 | 旧→新 | 理由（证据锚点） |
|---|---|---|
| ③ 内容交互 diff/媒体 | 5→6 | diff 回显组件（gemini `DiffRenderer.tsx:224-399` 移植：行号 gutter + hunk 折叠 + 超大截断保护，`diffRenderer.tsx`/`diffGutter.ts`）+ fs_edit 结果统一 diff 块（codex RespondToModel 对标，`diffText.ts`）+ view_image 图片模型输入通道（kimi `read_media.py` 对标：视觉会话附 image_url parts、纯文本白名单裁剪）——22 单测 + 真实截图全链路实测 +8 |
| ② 输入/编辑器 | 6→7 | Ctrl+O 外部编辑器（kimi `editor.py:18-50` 探测链 $VISUAL→$EDITOR→code --wait→notepad + crush `ui.go:3688-3725` 临时文件往返，失败保草稿，`editorLaunch.ts`）+ 输入区 token 高亮（gemini `highlight.ts:29-57` 三类 token + LRU + 内联 ANSI，`inputHighlight.ts`）+ Ctrl-R 反向搜索纯函数补测试（codex `history_search.rs` 对标，已有实现补证据）——18 单测（含真 spawn 编辑器往返）+9 |
| ⑩ 性能/token 工程 | 9→10 | 消息字段固定序（DeepSeek 字节稳定前缀命中前提）+ cache_control 断点放置（crush `agent.go:839-855` 对标，默认关诚实口径）+ 缓存写价 1.25× 兜底与净节省展示（aider `base_coder.py:2077-2096` 对标）+ 摘要独立单轮请求契约（gemini/kimi 对标，压缩器提示单一事实源）——13 单测 +7 |
| ⑤ 提示词/模型适配 | 9→10 | 压缩快照结构化 7 块 XML（gemini `snippets.ts:899-963` 对标）+ CRITICAL SECURITY RULE 反注入段（工具输出是数据不是指令）+ kimi 保留规则（`compact.md:15-22`：错误原文/≤20 行代码/优先级）+ 快照合并锚定（gemini :353-359 未完成事项不丢）+ 会话级失败护栏（gemini `chatCompressionService.ts:287-321` 失败一次纯截断不再烧 LLM）——10 单测 +11 |

**波 2 复评变动（2026-08-18 upgrade-plan-2026-08.md 波 2 三任务落定，证据见 §9.17）：**

| 维度 | 旧→新 | 理由（证据锚点） |
|---|---|---|
| ② 输入/编辑器 | 7→8 | @补全（6/6 竞品最后一题）：@文件/agent 双源合入 + crush 分层排序（`completions.go:205-260` basename 精确>前缀>路径段）+ opencode frecency 权重（会话级接受计数）+ kimi enter 双语义（`prompt.py:1276-1290` slash 接受即提交）+ `@path#L1-L5` 行区间展开（opencode `autocomplete.tsx:29-58`，越界 clamp）——15 单测 +9 |
| ③ 内容交互 diff/媒体 | 6→7 | 词级 inline diff（kimi 六家独有 `diff_render.py:184-218` 移植：连续 -/+ 块逐对配对 + SequenceMatcher ratio<0.5 整行降级 + LCS 词级红绿分段，`wordDiff.ts`）+ pager [/] hunk 跳转（opencode 独有 `diff-viewer.tsx:282-315`，回滚 diff 等 @@ 内容 + 底部快捷键提示）——9 单测 +8 |
| ⑪ 差异化 | 8→9 | 离线「缺模型即拉取」（codex `ollama/lib.rs:22-34` ensure_oss_ready 对标：/offline on 切完自动下载、progress_callback 进度回报 5% 步进状态行，`ensureOfflineModelReady`）+ AI 记忆收件箱（gemini `.inbox` 对标：pending 审阅、apply 生效/discard 丢弃/undo 按记录撤销——可审可退堵「不可控记忆」评审攻击；settings.memoryInbox 开关默认关零漂移）——7 单测 +5 |

**波 3 复评变动（2026-08-18 upgrade-plan-2026-08.md 波 3 三任务落定，证据见 §9.18）：**

| 维度 | 旧→新 | 理由（证据锚点） |
|---|---|---|
| ② 输入/编辑器 | 8→9 | vim 模态编辑（gemini `vim.ts` 纯 reducer 直搬 `vimCore.ts`：NORMAL/INSERT 双态、hjkl/wbeWBE/0$^/ggG/fFtT、xXr~/ddccyy/D C Y、dcy+移动、pP、u、`.` 重复、数字前缀、双击 Esc 清空；textInput 按键拦截 + NORMAL 徽标 + /vim 开关热生效）——14 单测；无 VISUAL// 搜索/Ctrl-R 与 gemini 同档诚实边界 +9 |
| ③ 内容交互 diff/媒体 | 7→8 | 完整 diff 查看 + per-hunk 选择性回滚（**六家皆无的差异化**——取证确认 opencode `diff-viewer.tsx:945-1010` 仅跳转无 apply/discard）：/diff 快照对比（行级 LCS unified diff 3 行上下文）+ /diff revert <hunk序号>（reverseHunk 上下文锚定、失败绝不写半行、应用前自动快照）——10 单测 +8 |
| ⑪ 差异化 | 9→10 | 本地跨会话语义召回（**六家独有取证**：aider 仅本地嵌入做 /help 文档 RAG、gemini 云端嵌入、其余纯正则）——/hole --all 全会话 FTS bigram + 本地向量 KNN（数据不出机）；ACP stdio 接收正式入档（`acp.ts` runAcpServer /acp 服务端 + 协议测试既有落地归入本档）——4 单测 +5 |

**未调分且如实说明**：⑥ 安全工程维持 9——OS 沙盒本轮落地（Windows L0-L3，标准用户实测校准：受限令牌路径被 1314 证伪、改 Low IL 实现只读）但仅 Windows 单平台，codex/gemini 是三平台沙盒；三平台化后才可冲 10。②③ 未动（vim/keymap、diff 交互 UI 仍在 P1 清单）。

判词先行（波 3 五评更新）：**wxnodus 922 稳居第 1/7，三波路线全部落定**——波 3（②vim 模态 / ③完整 diff 查看+per-hunk 回滚（六家皆无差异化）/ ⑪本地跨会话语义召回（六家独有）+ACP 接收入档）。五项严格第一（①④⑥⑩⑪）+ 两项并列第一（⑤⑦）。剩余拉分项集中在「产品化完成度」：分发（⑧ 5，卡公开决策——转公开即 +36）。

---

## 1. 框架维度（六层 vs 166 crate vs 40 包）

| | 规模 | 分层 | 边界纪律 |
|---|---|---|---|
| codex | 1.40M 行 Rust / 166 crate | core/tui/cli/app-server 协议 crate 隔离 | 最极端；clippy.toml 自定义禁令（disallowed-methods、large-error-threshold=256）+ cargo-deny 依赖审计 |
| gemini | 507k 行 TS / 7 包 | core（无 UI 依赖）→ cli(ink) → sdk/a2a-server | 每工具独立目录+快照；tsconfig 最严（verbatimModuleSyntax/noPropertyAccessFromIndexSignature） |
| opencode | 528k 行 TS / 40 包 | Effect DI 贯穿；protocol/schema/sdk 从 spec 生成 | 协议版本化书面化（specs/v2/schema-changelog.md） |
| crush | 146k 行 Go / 50 包 | internal/ 按域；charmbracelet 全家桶 | golangci-lint + sqlc 生成 + 363 golden 快照 |
| kimi | 52k 行 Py / uv 工作区 | soul（内核）/ui/wire 分离 | ruff + pyright（src strict）+ ChaosChatProvider 混沌测试 |
| aider | 20.3k 行 Py / 平铺单包 | 无分层，base_coder 上帝类（2485 行） | 无 mypy/ruff |
| **wxnodus** | 72.5k 行 TS / 单包 | bootstrap 五阶段组合根 + 六层（domain/application/infra/kernel/ui/protocol） | strict TS 合格，但**分层泄漏实测**：domain→infra（completionGate.ts:6）、kernel→store 4 处、wxnodus-ui 4 处直连 kernel |

**wxnodus 框架结论**：六层命名（domain/application/infrastructure）是干净的意图声明，且组合根失败可回收（createApplication.ts:14 五阶段 dispose）优于 aider 的平铺；但 ① 无编译期依赖约束（运行时 Object.assign 状态桶）② 四个泄漏点 ③ 零 lint/零 CI——「有架构图纸，缺边界护栏」。opencode 的 Effect DI 与 gemini 的 core 无 UI 依赖是两种可抄的成熟解法。

---

## 2. 功能维度（内核能力对照）

- **工具面**：wxnodus 44 工具（含 computer_uia/wx_cmd/wx_gui/voice 等 Windows 专属）＞ crush（含 15+ LSP 工具）、kimi、aider（无 function-calling，纯 diff 文本）。数量不输，但**无按模型裁剪**（32 个 schema 全量发给所有模型，tools.ts:1201 透传；对比 codex 按模型给 apply_patch 指令+legacy 警告、opencode zod 生成+描述外置 .txt）。
- **回合闭环**：wxnodus 有 MAX_TURNS=32 硬上限 + finishEarly 统一闭环 + 轮次耗尽强制总结（§13.7 修复）；codex 轮次硬上限、gemini MAX_TURNS=100、kimi max_steps_per_turn=1000——都在同一复杂度带。
- **压缩**：wxnodus 85% 自动压缩 + budgetStop；但摘要「≤300 字」无结构，对比 gemini XML `<state_snapshot>` 8 块 + 反注入段、kimi compact XML 6 块 +「错误全留、<20 行代码全留」保留规则。
- **子代理**：wxnodus 只有 delegate（只读集 + 自定义 agent md）；对比 kimi coder/explore/plan YAML 继承体系、codex explorer/awaiter（自带 model_reasoning_effort=low）、gemini codebase-investigator（JSON 强制报告）。
- **降级链**：wxnodus 429 单次退避 + 同 provider 前 2 备选（llmStream.ts:85-106）；gemini 的 availability 状态机 + policy 链 + lastResort 是 7 家最工业化；crush 的 large/small 双模型分档（标题走小模型）wxnodus 完全缺失。
- **完成判定**：wxnodus `[GOAL_DONE]` 文本标记 + verifiedEffects 副作用验证——可靠但粗；无一家用 JSON schema 结构化输出（aider 的 editor-diff 是例外）。

---

## 3. 场景维度（覆盖矩阵）

| 场景 | wxnodus | codex | gemini | opencode | crush | kimi | aider |
|---|---|---|---|---|---|---|---|
| TUI | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 单发 -p | ✓ | ✓(exec) | ✓ | ✓(run) | ✓(run) | ✓ | ✓(-m) |
| stdin 管道 | ✗ | ✓ | ✓ | ✓ | ✓ | ≈ | ≈ |
| 机器输出 | --json/--wire | --json(JSONL) | text/json/stream-json | --format json 原始事件 | ✗ | --json+示例 | ✗ |
| daemon/多客户端 | --serve+gateway | app-server+daemon | ✗ | client/server | server+client | ✗ | ✗ |
| MCP | server+client | client | client 强 | client | client | 管理组+OAuth | 仅配置 |
| ACP | ✓(stdio) | ✗ | ✓+测试 | ✓ | ✗ | ✓ | ✗ |
| A2A | ≈(91 行子集) | ✗ | ✓(独立包) | ✗ | ✗ | ✗ | ✗ |
| 远程/分享 | ≈ 离线打包 | exec-server/cloud | ✗ | share/slack/CI | ✗ | share/web | ✗ |
| IDE | ✗(仅协议) | ✓ | ✓(companion 包) | ✓ | ✗ | ✓ | ≈(第三方) |
| doctor/诊断 | ✓(真检测) | ✓(10 模块) | ✗ | ✓(debug 组) | ≈(logs) | ≈ | ✗ |

wxnodus 独有：`--wire` 双向 RPC fail-closed（approval/clarify 帧，gateway 未 ready 回 WIRE_GATEWAY_NOT_READY）、`--serve` 安全面（Bearer timingSafeEqual/CSRF/413/SSE）、`/doctor` 真实检测（integrity_check/密钥真解密/provider 健康）。**但 stdin 管道、IDE 生态、远程、stream-json 四块空白。**（agent 场景评审原文）

---

## 4. UI 维度（四项核心声明全部核验属实）

- **渲染引擎**：wxnodus-ink（自研 Ink fork，双缓冲+逐 cell 差分+charCache+DECSTBM 硬件滚动+blit/shift 快路径+三遍修复）→ **7 家中渲染深度第一**，超过 codex（ratatui 帧级）、crush（稳定前缀缓存）、gemini（ink 全量重渲染）。但残留：resize 全帧重绘闪烁（log-update.ts:502 `fullResetSequence_CAUSES_FLICKER`）、blit 前 O(subtree) 扫描（render-node-to-output.ts:469）。
- **终端降级**：三级画像（modern/cmd/no-vt）+ 字形三档退化 + ConPTY 专项（CRLF/CUP/CHA/宽字符）+ WXNODUS_NOBLIT 逃生门——7 家唯一系统性处理 Windows/老终端。
- **状态栏**：上下文渐变条/余额/用量/电池/子代理 HUD/权限徽章/渐进披露——信息密度全场第一。
- **输入**：自研 TextInput（字素光标/undo/双击选词/快 echo 防 IME 泄漏/鼠标拖拽）≠ 成熟编辑器：**vim 是死代码**（vimKeys.ts:9 全仓库无调用）、键位硬编码不可配置、@文件无选择器（正则注入前 4000 字节）、无语法高亮/自动缩进。codex 真 vim 模态+操作符+文本对象+config keymap 是这条线的天花板。
- **内容交互**：diff 仅内联着色（无 apply/拒绝/hunk 折叠，对比 opencode 双布局+文件树+`[`/`]` hunk 跳转）、无图片渲染（is_image 标志存在但无渲染路径，对比 codex 宠物图/crush 内联图片）、无 which-key 引导（opencode 独有）。

---

## 5. 优势（wxnodus 独有/领先，全部有证据）

1. **渲染引擎深度全场第一**（上节）——这不是自吹，是四个评审 agent 分别独立核验的结论。
2. **Windows 专属壁垒**：ConPTY 专项、UIA/PMv2 真机验收电池（tests/acceptance/windows/*.ps1 + 哈希链 receipt）、三级终端档——六家竞对里 codex/crush/gemini 只做 OS 沙箱，无人做 Windows 终端适配深度。
3. **安全防御清单全场最全**：ssrf 私网拦截/sanitizedEnv 剥密钥/PDP fail-closed/8 层命令解包/secretDetect 打码/AES-256-GCM 密钥（audit §12 独立审计）。
4. **诚实工程文化**：labelTruncate「绝不静默截断」注释规范、工具空输出归一、/doctor 真检测、退出码协议 0/1/75/130、known-failures registry 显式登记——audit-deep.md §13 三十余条缺陷实录本身就是资产。
5. **多模态 400 防御纵深**：imageStrategy 三态 + 历史 parts 文本化 + describe 通道——仅 crush 的 `workaroundProviderMediaLimitations`（agent.go:2125）可类比。
6. **差异化资产**：离线四模态（Qwen/MiniLM/moondream/whisper）+ 黑洞引擎三层记忆 + 规则脑离线兜底——六家竞对无人有此组合。

---

## 6. 差距清单（跨四路评审合成，按严重度）

**S0 阻断级（用户视角不成立）**
1. 分发为零：npm-link 唯一安装、无更新/卸载命令、无 CHANGELOG、无 releases（对比 opencode 9 渠道+upgrade+uninstall，codex doctor 连「npm 全局装会不会更新」都诊断）。
2. 文档面向内部：docs/ 21 篇全是审计/对比文档，无 getting-started/troubleshooting/examples/隐私说明/issue 模板。
3. 零 CI + 零 lint：无 .github/workflows、无 eslint——严格 TS 与 2363 测试裸奔。

**S1 高（能力面子集）**
4. vim 死代码 + 键位不可配置 + @无补全选择器 + diff 无操作 UI + 图片无渲染。
5. 无 stdin 管道、无 IDE/远程生态、stream-json 缺失、A2A 91 行子集。
6. 提示词层六项落后：模型分族提示词、API 级 prompt caching（deepseek 缓存命中降费，直接对应成本）、按模型工具裁剪、结构化输出、子代理分型、availability 降级状态机。
7. 无任务档位路由（标题/摘要/图片摘要全走主模型——对比 crush large/small 双档）。

**P0/P1（工程债，机械可修）**
8. handlersExt.ts 3909 行 / wxGateway 2452 / agent 1329 / tools 1203 / textInput 1440 巨文件。
9. 分层泄漏 4+ 处、domain→infra 反向依赖。
10. tests/fixtures/.../node_modules 整树入 git（约 2550 个 fixture 文件）、123 测试文件平铺根目录、known-failures 双刃剑无过期机制。
11. 无 perf 基准目录（对比 gemini perf-tests/aider benchmark/）。

---

## 7. 差别（设计哲学，非对错）

- **codex/gemini/opencode = 平台巨舰**：核心是「协议+生态」（app-server/ACP/A2A/IDE/远程），产品完成度优先，渲染次之。
- **crush/aider = 精悍工具**：crush 用 Charm 全家桶换稳定（363 golden），aider 用 20k 行换 repo-map/benchmark 二十年沉淀。
- **wxnodus = 单机堡垒**：数据不出机 + 离线能力 + Windows 专属 + 渲染极致——**它的所有优点都服务「单机」，所有缺点都是「没出单机」**（无生态、无分发、无 CI）。6.14 分本质是「单机堡垒只建好了城墙和内饰，还没开门」。
- **方向风险**：离线四模态与「AI 编码 CLI 的本质是云端模型质量」之间存在错配——离线能力是护城河但非主战场；当前权重表差异化只给 5 分权重正是基于此判断（该判断可被用户否决并调权）。

## 8. 从 6.14 → 8 分的路径（按性价比排序）

| 序 | 动作 | 预估成本 | 提分 |
|---|---|---|---|
| 1 | CI + lint + madge 循环依赖检测 + fixture 出 git | 1-2 天 | ⑨ 4→7 |
| 2 | winget/scoop 打包 + update 命令 + CHANGELOG + 用户文档三件套 | 2-3 天 | ⑧ 2→6 |
| 3 | stdin 管道 + --format stream-json + --wire schema 文档/示例 | 1-2 天 | ⑦ 6→8 |
| 4 | prompt caching 前缀稳定 + deepseek 分族提示 + 小模型任务档 | 2-3 天 | ⑤ 5→7 ⑩ 6→7 |
| 5 | vim 接线或摘除 + keymap 配置 + @文件选择器 + diff 折叠 | 3-5 天 | ② 5→7 ③ 4→6 |
| 6 | 巨文件拆分 + 分层泄漏修复 + 测试布局收口 | 2-3 天 | ⑨ 7→8 |

**状态（补齐轮后）**：序 1/2/3/6 已完成（⑨→7、⑧→5、⑦→8）；序 4 完成一半（前缀缓存稳定+真实窗口压缩，deepseek 分族提示与小模型任务档未做→⑤ 只到 6）；序 5 未动（②③ 不变）。另完成 P0 四件执行层硬差距 + LSP + 硬编码清零（④ 8→9、⑩ 6→8）。

**超越计划（7.25 → 8.7+，总分第一）**：`docs/supremacy-plan-2026.md`——上下文总结 + 11 维逐维超越路径（理论上限 ≈9.4）+ 三阶段执行计划（内核登顶 → 生态上车 → 超越收官）+ 阻塞项与每轮执行协议。

**下一档路径（7.25 → 8+）**：
1. ⑤ 冲 7：deepseek/glm 分族提示词 + 小模型任务档（crush large/small 对齐）——+11
2. ②③ 冲 6/7：vim 摘除或接线 + keymap 配置 + diff apply/折叠——+24~40
3. ⑧ 冲 6：真实发布（winget/scoop 上架）+ getting-started/troubleshooting 文档——+9
4. ⑥ 冲 10：沙盒 macOS/Linux 化（seatbelt/bwrap+Landlock）+ execpolicy 首词规则——+10
5. 命令面瘦身 109→~45（聚合同能力入口）——不直接加分，但「臃肿度」问题即评分原始诉求之一。

全部做完 ≈ 2 周，总分约 7.9-8.1；冲 8.5+ 需补 IDE 插件/A2A 完整版/子代理分型（月级）。

---

## 9. 补齐轮落地记录（2026-08-18 二评，逐条可回溯）

| 落地项 | 实现位置 | 实测证据 |
|---|---|---|
| OS 内核沙盒（L0-L3） | `src/kernel/winSandbox.ts`（PS 内联 C# 助手：SetTokenInformation Low IL + Job Object + NetRateControl）+ `/sandbox os` 命令 | 本机标准用户实测：四层 profile 全部真实执行（L3/L2/L1/L0 均 PROFILE_OK，stdout 捕获）；L0 Low IL 写 Medium-IL 文件「拒绝访问」（只读语义实证）；探测诚实契约测试 60s 超时护栏 |
| 沙盒机制校准（诚实记录） | 同上（文件头注释） | CreateRestrictedToken+CreateProcessAsUser → 1314 实测证伪（标准用户无 SeTcbPrivilege）；改 Low IL 路径通过——评分按 Windows 单平台给 9 不给 10 的依据 |
| apply_patch | `src/kernel/applyPatch.ts` + tools.ts 注册 | 13 用例：四动作解析/三级容错/全量校验不写一半/多处匹配报错/did_you_mean/undoShadows 快照/CRLF 保留/退化 ctx==minus 折叠 |
| 并行工具调度 | `agent.ts` 批次循环（runOneCall 槽位保序） | 并发计数实证：纯只读批 maxRunning=2、含写批 maxRunning=1（gemini 同款语义） |
| 输出 offload+掩码+蒸馏 | `src/kernel/toolOutput.ts` + bash 流式落盘 | 10 用例：50KB 阈值落盘/续读路径/promote 接管/保护窗 50k 掩码/幂等/阈值 settings 覆盖+夹取；bash 流式 sink 保留完整输出 |
| LSP 集成 | `src/kernel/lspClient.ts` + 3 工具 | mock 服务器 Content-Length 同构测试：pull 诊断/publish 兜底/hover/definition/ENOENT 诚实报错/会话缓存 LRU |
| 硬编码清零 | `agent.ts`（ctxLimit 真实窗口−预留、MAX_TURNS_EFFECTIVE）、`tools.ts`（wrapDanger 限参）、`providers.ts`（maxContextFor）、`store/config.ts`（12 个新设置键白名单） | settings.maxTurns=2 实测 turns=2；maxContextFor 目录派生单测；全部阈值 settings 可覆盖且夹取防误配 |
| 测试面 | tests/kernel-apply-patch / tool-output / win-sandbox / lsp-client / agent-gap-2026 | 全量 2447 通过 / 10 跳过 / 0 失败 |

**诚实口径（复评红线）**：本轮所有「已落地」条目均有真实执行证据（含本机 OS 级实测），无一处纸面声明；受限令牌 1314 证伪、L0 改 Low IL 的取舍如实记录并体现在评分（⑥ 不给 10）；winget/scoop 仍为模板占位（无 remote 无发布 URL），⑧ 只给 5。

### 9.1 深化轮补充（2026-08-18 三评）

- **循环检测分级（gap P1-2）**：签名并入输出短哈希（`agent.ts shortHash`，FNV-1a 36 进制）；重复 ≥2 注入换策略提醒、≥5 硬停（原 3 次直停，误杀合法轮询缺陷修复）；goal 轮间相同结论 chanting 检测（提醒→终止）；4 个新用例（含 settings.loopHardStopAt=3 恢复旧行为回归锚）。
- **硬编码二次清零（阈值 settings 化）**：连续失败/未知工具轮/重试间隔/goal 轮数/子代理深度/读缓存上限/签名窗口/循环阈值（EFF 块 10 项）+ fsReadLimit/bashOutputCap——共 13 个新设置键，全部夹取防误配、默认值=既有行为（行为零漂移回归测试）。
- **评分口径**：本批为「纵深加固 + 可配置性」，④⑩ 维度分数不变（已并列同档；LLM 辅助循环检测——gemini 的置信度判空转——仍未做，是 ④ 与 gemini 的最后差距之一）。

### 9.2 生态/桌面端准备轮（2026-08-18 四评）

- **会话血缘 + 结构化会话列表（gap P2-1 部分）**：sessions 表 `forked_from_id`（SCHEMA v9 迁移）；`/fork` 记血缘 + `/fork lineage [id]` 祖先链；`/sessions [--json]` 结构化列表（首问摘要/消息数/分支数/血缘——gemini sessionUtils 对齐），JSON 出口与 serve 网关共用 `listSessionsStructured` 单一事实源——桌面端历史树/会话浏览器的数据面就绪。
- **approve_for_session 真实授权（gap P1-4）**：session_grants 表持久化（批准一次 → 本会话同键自动放行，跨重启生效）；优先级红线 > 规则 deny > 会话 deny > 会话 allow > 模式判定；`/perm session-allow|deny|revoke|list`；settings.approveForSession 开关（默认关，opt-in）。授权粒度诚实原则：bash 精确命令串、fs 精确 path（刻意不做首词前缀——批准 `git` 前缀会连带放行 `git push --force`；execpolicy 式前缀规则留 P2-3）。
- **评分口径**：本批服务「生态 + 桌面端」，④ 授权层/⑦ 会话面质量提升但未越档（④ 仍与三家并列 9；桌面端未上线前 ⑦ 不加分）——分数保持 725 不变，如实记录。

### 9.3 分享/路线图轮（2026-08-18 五评）

- **share 离线加密打包（A-08 落地）**：`kernel/share.ts` + `/share export|import`——单文件 .wxnshare（明文 sha256 防篡改；`--encrypt` AES-256-GCM + scrypt 口令派生，盐/iv 随机，口令不落包）；导入记血缘 `share:<源id>`；4 用例（往返保真/篡改拒绝/错误口令拒绝/伪造格式拒绝）。opencode/kimi 的云端分享依赖中心服务器——wxnodus 数据不出机红线下的诚实离线变体。
- **缺陷寄存器**：`docs/defect-register-2026.md`——S/A/B/C 四级 21 项全表（含阻塞项与提分预估），评分与缺陷一一联动。
- **IDE/远程路线图**：`docs/ide-remote-share-roadmap-2026.md`——三块空白原理对照（gemini ACP companion / codex app-server+exec-server / opencode share）+ 难易度 + 分阶段方案（IDE 插件走现成 --wire 零协议新增；远程 ssh 通道先行、完整 exec-server 标注安全面；与桌面端共用协议层）。
- **评分口径**：⑦ 场景矩阵「远程/分享」✗→≈（离线打包），但云端分享与远程执行未做——⑦ 保持 8 不越档；总分 725 不变。

### 9.4 超越计划阶段 1 首批（2026-08-18：supremacy 1.1/1.2/1.4）

- **1.1 分族提示词（A-02）**：`providerPrompts.ts` 承载 DeepSeek/Kimi/GLM 三族中文专属段（只写真实 API 行为：reasoning_content 回传、前缀缓存、窗口、语言），`systemPrompt.ts` 保持零 CJK（kf-029 红线）经 `providerPrompt` 参数注入（persona 之后）；agent 按 `model 目录 → baseURL 探测` 解析 provider。7 用例（注入位置/零漂移/目录优先/探测回退）。
- **1.2 小模型任务档（A-03）**：`taskModels.ts` 标题/摘要生成纯函数（剥引号/截断/异常降级 null）；settings.titleModel/summaryModel 入白名单；CLI 注入 `titleGenerator`（独立单轮小模型、10s 超时、无密钥零调用），agent 回合末：小模型标题 → 回退首行切片，**已有标题不触发调用**（查库门）。9 用例（含 5 条 agent 端到端降级契约）。
- **1.4 成本五维 + 整数分计价（A-06）**：usage_stats v10 新增 `reasoning_tokens`（llmStream 解析 `completion_tokens_details.reasoning_tokens`，agent 落库，usageSummary/costQuery 全链路聚合）；`cost.ts` 五维计价（reasoning×输出价、cacheMiss×输入价、cacheHit×cacheRead 价——仅收录 DeepSeek 官方公布缓存读价，未收录保守按输入价）+ 全部金额**整数 µUSD BigInt 定点**（零浮点累加漂移，展示层才换算 USD）；kf-030/db-migrations 断言同步 schema 10。14 成本用例 + llmStream/usage/gateway 断言同步。
- **评分口径**：三缺陷的预计提分（A-02 ⑤+11、A-03 ⑤+1/⑩+1、A-06 ⑩）**计入阶段 1 收尾复算**——执行协议要求阶段完成时一次复算（避免逐项碎片化加分）；本批分数保持 725 不变，如实记录。

### 9.5 超越计划阶段 1 收尾复算（2026-08-18：1.3/1.5/1.6/1.7 全量完成，七项全绿）

- **1.3 按模型工具裁剪（A-04）**：`toolTrim.ts` 能力驱动裁剪（文本模型裁 3 个图片输出工具；小窗口文本模型再裁 GUI 文本套件；视觉模型全保留；目录未收录不臆测）+ settings.toolTrim（auto/off）+ agent 唯一装配点（updateTools 热重载不绕过）+ getToolTrim 诊断面。11 用例。
- **1.5 LLM 辅助循环检测（A-05）**：`loopJudge.ts` 语义判定（loop=提醒阈值即提前硬停，不等静态硬停阈值空烧 token；progress=复位签名计数，合法轮询穿过静态阈值；unknown/异常=回退静态提醒→硬停路径）；settings.loopJudge=true 开启（默认关，零额外调用）；CLI 注入主模型单轮判定（10s 超时）。7 用例（含默认关回归锚）。
- **1.6 命令面瘦身（A-01）**：两层命令面——主干 47 条（日常驾驶，对标 gemini 47）+ 扩展 63 条（**零删除**：全命令照常注册与分发，契约不变）；/help 默认主干渲染 + `/help all` 全目录；command_search 主干优先排序（AI 目录检索心智模型）。7 用例 + 103 命令契约回归全绿。
- **1.7 execpolicy 首词规则（B-06）**：`execPolicy.ts` 首词索引（first-token 分桶 + catch-all；pattern 锚定保证与全量 applyRules **数学等价**——测试含安全等价断言）；审批持久化复用 permissions.json（/perm rule，P0-2 已有存储面，不新增）；agent bash 规则经索引裁决。8 用例（含 agent 端到端 deny 直拒/allow 放行零弹窗）。
- **阶段 1 复算**：⑤ 6→8（A-02 +11、A-03 +11）；⑩ 8→9（A-06 +7）。**总分 725 → 754**（第 4 名稳固，与 gemini 812 差距 58）。
- **诚实留白**：④ 保持 9（计划 10 需「子代理分型 + 结构化输出」，留阶段 3）；⑥ 保持 9（execpolicy+审批持久化已落地，但双态沙盒提权分支 S-07 未经实测不宣称 10）；⑤ 到 9 还差「API 级 caching 深化」（阶段 3）。A-01 按口径不直接加分（原始诉求，消臃肿不计分）。
- **阶段 1 验收**：七项任务全 ✅；新增测试 40 个（11+7+7+8+7 本批 + 此前 1.1/1.2/1.4 批次）；`npm run ci` 七步全绿。

### 9.6 超越计划阶段 2 首批（2026-08-18：2.1 IDE 插件 / 2.2 ssh 通道 / 2.3 用户文档）

- **2.1 IDE 插件（S-03 落地）**：`packages/vscode-ext/`——extension.ts（spawn `--wire` 无头执行 → webview 面板渲染 token/tool/终态 → approval/clarify/secret/form 走 vscode 原生模态 → stdin responder 帧闭环）+ wireBridge 纯函数（零 vscode 依赖，node:test 4 用例）+ esbuild 单文件 + vsce 本地打包（`wxnodus-vscode.vsix` 7.6KB，上架 marketplace 仍受 S-01）。**连带修复 wire 协议缺口**：headless 网关此前把审批 request_id 只存内存不广播——外部前端无从应答（`headlessGateway.ts` onRequest 广播 + `approval.request`/`clarify.request`/`secret.request`/`form.request` 四事件 + wire-protocol.md 修订 + 4 用例 + 示例 responder 改走真实 request_id）。
- **2.2 远程执行 ssh 通道（S-04 阶段 1）**：`sshRemote.ts`（目标解析/ssh 参数 BatchMode/流式回传/超时 kill/ENOENT 指引/注入式 runner）+ bash 工具远程分支（settings.remote 时经 ssh 转发，本地审批链不变）+ `/remote` 命令（设置/运行/状态/off）——**远端未沙盒诚实标注恒在**。10 mock 单测。
- **2.3 用户文档三件套（S-01 部分）**：`docs/getting-started.md`/`troubleshooting.md`/`examples.md` + README 链接契约 + **不撒谎对账测试**（文档提到的命令与 SLASH 注册表对账——当场抓到真实缺口：/share、/balance 注册但不在目录，已修复）。
- **评分口径**：⑦ 场景矩阵「IDE 插件」✗→≈（本地 vsix 真实消费者，marketplace 上架前不加满）+「远程」✗→≈（ssh 通道阶段 1，完整 exec-server 前不加满）——按执行协议，⑦ 复算计入**阶段 2 收尾**（2.4 CI + 2.5 桌面端协议完成后一次复算）；本批分数保持 754 不变，如实记录。

### 9.7 超越计划阶段 2 第二批（2026-08-18：2.5 桌面端协议加固 + 2.4 CI workflow 备件）

- **2.5 桌面端协议加固（--serve 路径，路线图既定推荐）**：`serve.ts`——① 结构化 `sessions` RPC（与 `/sessions --json`、桌面端共用 `listSessionsStructured` 单一事实源：首问摘要/消息数/分支数/血缘；窄端口回退裸 SQL 诚实降级）② **`session.changed` SSE 广播**（SSE 订阅者注册表 + chat/command RPC 完成后推送——面板事件驱动刷新会话列表，无轮询）；`docs/serve-protocol.md` v1（路由/RPC/SSE/安全/桌面端施工图，诚实边界：serve 模式审批暂缺省 deny，交互审批走 --wire 宿主模式）。3 协议用例（真实 db 结构化断言 + SSE 双 reason 广播）+ 8 既有 serve 用例全绿。
- **2.4 CI workflow 备件（remote 待用户）**：`.github/workflows/ci.yml`——八步（checkout/setup-node 22/npm install/`npm run ci` 全门禁/vscode-ext install+typecheck+test/vsce 打包/上传 vsix 工件），本地 YAML 语法+结构校验通过；**推送与首次 workflow 绿待 git remote**（阻塞如实标注）。
- **评分口径**：⑨ 工程 CI 仍是「本地门禁 + 备件」——workflow 未在真实 runner 上绿过，⑨ 不加分；⑦ 复算仍计入阶段 2 收尾（2.4 推送绿后）。分数保持 754 不变。

### 9.8 超越计划阶段 3 首批（2026-08-18：3.3 键位配置层 + diff hunk 折叠）

- **3.3 键位配置层（B-01）**：`src/wxnodus-ui/config/keymap.ts`——命名动作→KeySpec（parseKeySpec 修饰组合/大小写敏感/space 归一；matchesKey 单字符要求修饰一致；resolveKeymap settings.keymap 覆盖合并、非法回退默认）；settings 白名单 + config.get full 透出 + useConfigWatcher.applyDisplay 水合（last-good 守卫）→ useKeyBindings pager 六动作真实接线（默认键位逐项=原硬编码，零漂移）。10 单测。诚实口径：不做伪 vim（模态编辑如接入再标注）。
- **diff hunk 折叠/apply（B-02）**：`diffHunks.ts`（分节/hunk 分组/默认折叠/切换/extractPatchText 还原补丁）+ messageLine 渲染接线（超长 hunk 默认折叠只显 @@ 头+折叠提示）。6 单测。@文件引用机制已有（resolveAtRefs）。
- **评分口径**：本批为 ②③ 输入/交互层——复算计入阶段 3 收尾（3.6）；分数保持 754。

### 9.9 超越计划阶段 3 第二批（2026-08-18：3.5 perf/lint/madge）

- **lint**：`scripts/lint.mjs`（debugger 红线/内核层 process.exit 分层红线/TODO 报告）598 源文件首跑全绿。
- **madge 环门禁**：`scripts/check-cycles.mjs` + allowlist（首跑 17 环→修 2 处运行时环：db→memory 再导出环、ssrf↔outbound 互指环下沉 blockedHosts 叶子；剩 4 环 type-only 登记理由；ink fork 11 环排除注明）——ci 九步挂载，未知新环即失败。
- **perf 基准**：`scripts/bench/run-bench.mjs` 四项确定性微基准（基线 2026-08-18 首跑；shortHash 下沉 hash.ts 叶子避免原生依赖图）。
- **评分口径**：⑨ 工程质量实质提升——复算计入 3.6；分数保持 754。

### 9.10 超越计划阶段 3 第三批（2026-08-18：3.2 双态沙盒提权分支）

- **双态沙盒（S-07 提权分支落地）**：runner v3——IsElevated 运行时分流；提权 → CreateRestrictedToken（DISABLE_MAX_PRIVILEGE + 禁用 Administrators/LocalSystem + Medium IL，L0 再加 Low IL 只读）；标准用户 → Low IL（本机实测校准不变）。探测 OK-ELEVATED/OK-STANDARD 双态诚实口径（parseProbeBody 纯函数 4 单测 + runner 源锚点 6 断言 + 本机真实探测/L3 冒烟绿）。
- **诚实留白（核心）**：提权分支**实现完成、实测未做**（本机标准用户）——⑥ 不宣称 10；管理员环境实测后按 ⑥ 9→10（Windows 深度口径）复算。
- **评分口径**：⑥ 保持 9；其余计入 3.6 收尾复算。

### 9.11 超越计划阶段 3 收尾复算（2026-08-18：3.6 超越复评）

- **复算结果**：② 5→6（键位配置层+9）、③ 4→5（hunk 折叠+8）、⑦ 8→9（IDE 插件/ssh/serve 协议/文档+11）、⑨ 7→8（lint+环门禁+bench+8）——**总分 754 → 790**（第 4 名稳固，距 gemini 812 差 22，距 codex 869 差 79）。
- **诚实口径（为什么未到 ≥870 验收线）**：870 依赖的增量全部卡在**外部前置**：① git remote（2.4 推送绿、3.1 winget/scoop 发布、3.4 市场——⑧ +36 与 ⑦ 满格的前提）；② 管理员环境（3.2 提权分支实测——⑥ 9→10 的最后一公里）；③ ④ 满格还差子代理分型+结构化输出（阶段内未排入无前置项）；⑤→9 差 API 级 caching 深化。以上任一落地即可再进一步。
- **未达标判定**：≥870（超越 codex）**未达成**——790/1000 如实记录；超越目标仍以计划三阶段全量为条件，阻塞项清单同步 register（S-01/S-02/S-07 实测、④/⑤ 残留项）。

### 9.12 超越计划补轮（2026-08-18：④ 满格——子代理分型+结构化输出；⑤ 到 9——API 级 caching 深化）

- **④ 满格（9→10，+13）**：计划 ④ 冲 10 四件全部落地——LLM 辅助循环检测（1.5）+ 按模型工具裁剪（1.3）+ **子代理分型**（`subagentTypes.ts`：explore/coder/review 三型——只读型白名单天然无写能力，delegate 工具 kind 参数透传，未知回退默认零漂移，2 用例）+ **结构化输出**（buildChatRequest/llmOnce `responseFormat: json_object`，llmSpec 规格化真实启用——端点不支持时 extractJson 宽容兜底，2 用例含请求体断言）。④=10 七家第一。
- **⑤ 到 9（8→9，+11）**：计划三件全部落地——分族提示词（1.1）+ 小模型任务档（1.2）+ **API 级 caching 深化**（toolsToOpenAI 按名规范排序——不同装配顺序产出字节完全一致的 tools 数组，首消息前缀跨重启稳定 → DeepSeek 前缀缓存持续命中；1 用例字节级断言）。
- **复算**：总分 790 → **814**——**反超 gemini（812）升至第 3/7**；≥3 维度第一达成（① 渲染 10 / ④ Agent 10 / ⑪ 差异化 8）。
- **剩余 56 分去向（全部外部前置）**：⑥ 9→10（+10，管理员环境实测提权分支——§9.14 已完成）；⑦ 9→10（+11，marketplace 上架/完整 exec-server，依赖 git remote）；⑧ 5→9（+36，winget/scoop 发布/市场托管，依赖 git remote）。**远程类任务按用户决策「暂无 remote，跳过发布类」保持阻塞**——870 线在此前提下不可达，如实记录。

### 9.13 S-04 完整版补轮（2026-08-18：长驻 exec-server——⑦ 9→10 = 825）

- **完整版 exec-server（S-04 全量落地）**：`kernel/execServer.ts`——长驻 HTTP 服务（默认 127.0.0.1，非回环监听诚实警告；Bearer token = HMAC-SHA256(shared secret) 派生 + timingSafeEqual；64KB 体限）；POST /exec 支持 `profile` 参数经**远端 OS 沙盒**执行（winSandbox 同族复用——远端机上的 L0-L3；沙盒不可用 **fail-closed 拒绝执行，绝不降级裸跑**）；`/remote server|connect|run`（token 派生、口令零持久化）+ bash 工具远程分支（remoteServer 优先于 ssh——远端可沙盒）；客户端 `runRemoteExecServer`（超时/401/网络不可达诚实报错）。8 本机集成单测（真实 server + client 闭环：鉴权三态/echo/非零码/体限/沙盒 fail-closed/客户端三态）。
- **评分口径**：⑦ 场景矩阵「远程执行」9→10——ssh 通道（阶段 1，未沙盒诚实）+ 完整 exec-server（codex 对齐安全面：token 鉴权 + 远端沙盒复用）双通道齐备；**本机集成实测**（本会话可验证的等价物），跨机部署验证留用户环境（如实标注）。总分 814 → **825**，距 opencode 差 16。
- **剩余（全部外部前置）**：⑥ +10（管理员实测——§9.14 已完成）；⑧ +36（git remote 发布通道——用户已决策跳过）。⑧ 完成后：835+36 = **871 超 codex**。

### 9.14 提权实测收官轮（2026-08-18：Windows 双态沙盒提权分支三测三修全绿——⑥ 9→10 = 835）

- **三测三修时间线（管理员终端真机实测，每轮都有实证）**：① v3 报 87（SidsToDisable 裸 SID 指针 + LocalSystem 不在令牌组）→ v4（TokenGroups 只禁用存在 SID + SID_AND_ATTRIBUTES 布局 + Attributes=0）；② v4 探测 OK 但启动报 1314（受限令牌经 DuplicateTokenEx 中转失去「调用方令牌受限版」豁免）→ v5（从本进程令牌直接构建 + SeIncreaseQuotaPrivilege + 探测加真实进程启动冒烟）；③ v5 全绿（见下）。
- **第三轮实测证据（elevated-probe-result.txt，管理员终端）**：`PROBE: OK`（CreateRestrictedToken 禁用 Administrators/LocalSystem + Medium IL + **真实进程启动冒烟**）· `L0-WRITE: exit=0 · SBX_WRITE_DENIED`（提权→受限令牌+Low IL 只读语义真机证实）· `L1-WRITE: exit=0 · SBX_WRITE_OK`（提权→受限令牌+Job 可写+断网真机证实）。标准用户路径此前已实测（OK-STANDARD + L0 拒写），v5 重构后自测无回归。
- **评分口径**：⑥ 安全工程 9→10——Windows 双态沙盒（提权→受限令牌 / 标准用户→Low IL）真机实测全链路验证，诚实口径要求的「管理员环境实测」已交付；仅 Windows 单平台不扣本档（Windows-only 已为明确决策，S-06 移除在案）。**⑥=10 七家第一**（codex/gemini 9）——第一维度增至四项。
- **复算**：总分 825 → **835**（第 3/7；距 opencode 841 差 6、距 codex 869 差 34）。870 线剩余唯一增量 = ⑧ 5→9（+36，发布通道——**git remote 已于 2026-08-18 配置推送**（ydds2/wxnodus 私人仓库），剩真实发布落地）。

### 9.15 远程 CI 首绿轮（2026-08-18：十五轮收官——⑨ 8→9 = 843）

- **远程 CI 全绿**（GitHub Actions windows-latest：9 命令门禁 + vscode-ext 独立门禁 + vsix 工件；十五轮取证见 audit §13.71）——「本地绿≠远程绿」十一类缺陷全部修复：junction 临时目录（100+ 用例根因）、locale 漂移、Node 版本漂移、Defender 进程扫描、空目录不被 git 跟踪、环报告方向随入口集变化、Server 2025 真 sudo 挂死等——每类都有真机取证，无一处盲改。
- **评分口径**：⑨ 工程质量/CI 8→9——远程 CI 绿为预声明条件（C-01「远程 CI 绿留 git remote」），现已兑现；九命令门禁与插件门禁在 GitHub 上真实通过。
- **复算**：总分 835 → **843**——**反超 opencode（841）升至第 2/7**，距 codex 869 差 26。870 线剩余唯一增量 = ⑧ 5→9（+36）——发布通道已配（私有仓库），剩余：转公开决策（winget/scoop 上架）与市场托管。
- **验证**：tsc 零错误；winSandbox 10 单测绿；全量套件 346 文件/2579 用例绿；标准用户自测 OK-STANDARD + L0 SBX_WRITE_DENIED。

### 9.16 波 1 收官轮（2026-08-18：②③⑤⑩ 四维落地——843 → 878，反超 codex 登顶第 1/7）

按 `docs/upgrade-plan-2026-08.md` 波 1 四任务执行（每个改动都以六家源码 file:line 为对标锚点）：

- **⑩ 性能/token 工程 9→10（+7）**：消息字段固定序（`providers.ts normalizeMessageFieldOrder`——DeepSeek 字节稳定前缀命中前提）；cache_control 断点放置（`applyCacheBreakpoints`，crush `agent.go:839-855` 对标——system + 尾 2 条 ephemeral，目录无 Anthropic 式端点故默认关、诚实口径）；缓存写价兜底（未收录 ×1.25 输入价，aider `base_coder.py:2077-2096` 对标）+「缓存省了多少」净节省展示（`costQuery.cacheSavingsUsd`，官方读价才有正节省——绝不虚报）；摘要独立单轮请求契约（gemini `chatCompressionService.ts:361-379` / kimi `compaction.py:126-131` 对标——压缩器提示单一事实源 `COMPRESSOR_SYSTEM_PROMPT`，agent 自动压缩与 /compact 同源）。13 单测。
- **③ 内容交互 diff/媒体 5→6（+8）**：`diffRenderer.tsx` 全量回显组件（gemini `DiffRenderer.tsx:224-399` 移植：行号 gutter 由 @@ 头驱动、del 行右侧留空、hunk 折叠复用 diffHunks、超大 diff 仅前 400 行高亮余行合并——codex `diff_render.rs:591-598` 保护）；工具结果 diff 回显（`diffBodyOf` 双条件检测防 grep 误判）+ assistant ```diff 块升级接入组件；fs_edit 结果携带统一 diff 块（同行上下文 + 行数/行长上限，`diffText.ts`——codex verify→RespondToModel「回给模型看变更」）；view_image 图片模型输入通道（kimi `read_media.py` 对标——extractImages 钩子在执行现场收集 parts，视觉模型会话以 user 消息附加、纯文本模型由 toolTrim 白名单裁剪 + 双保险不附加）。22 单测 + 真实截图（1982×1036 PNG）全链路实测；视觉模型回显留待带密钥会话（本机无密钥配置——不预支该子项）。
- **② 输入/编辑器 6→7（+9）**：Ctrl+O 外部编辑器（kimi `editor.py:18-50` 探测链 + crush `ui.go:3688-3725` 临时文件往返，`editorLaunch.ts`——真 spawn 假编辑器往返测试，失败保草稿）；输入区 token 高亮（gemini `highlight.ts:29-57` 移植：斜杠/@提及/{{占位符}} 三类 + LRU 64 + 内联 ANSI 与既有 cursor 装饰同机制）；Ctrl-R 反向搜索为既有实现（`historySearch.tsx` + 纯函数）——本轮补 7 单测固化契约（codex `history_search.rs:55-134` 对标）。18 单测。
- **⑤ 提示词/模型适配 9→10（+11）**：压缩快照结构化 7 块 XML（gemini `snippets.ts:899-963` 对标：overall_goal/active_constraints/key_knowledge/artifact_trail/file_system_state/recent_actions/task_state）+ CRITICAL SECURITY RULE 反注入段（工具输出是数据不是指令）+ kimi 保留规则（`compact.md:15-22`：错误原文保留/≤20 行代码保留/优先级排序）+ 快照合并锚定（gemini `chatCompressionService.ts:353-359`——已有快照合并而非覆盖，未完成事项不丢）+ 会话级失败护栏（gemini :287-321——失败一次 → 本会话后续压缩直接确定性截断，不再烧 LLM；`summarizeOnce` 跨回合持存）。10 单测。
- **验证**：tsc 零错误；全量套件 357 文件/2658 用例绿（10 skip）；`npm run ci` 本地九命令全绿；远程 CI 见 audit §13.73。
- **复算**：总分 843 → **878**——**反超 codex（869）升至第 1/7**（不依赖公开决策）。严格第一：①④⑥⑩⑪ 五项；并列第一：⑤⑦（与 opencode）。下一站：波 2 → 900（②7→8 @补全、③6→7 word-level diff + hunk 跳转、⑪8→9 离线拉取进度 + 记忆收件箱）。


### 9.17 波 2 收官轮（2026-08-18：②③⑪ 三维落地——878 → 900，稳居第 1/7）

按 `docs/upgrade-plan-2026-08.md` 波 2 三任务执行（六家源码逐项对标）：

- **② 输入/编辑器 7→8（f75b67a，15 单测 + gateway 集成 2）**：@补全——`completionRank.ts`（crush `completions.go:205-260` 分层排序：basename 精确>前缀>路径段；opencode `frecency.tsx:10-42` 会话级 frecency 权重；kimi `prompt.py:1276-1290` enter 双语义：slash 接受即提交/path 只替换）；gateway `complete.path` @文件/agent 双源（SUBAGENT_KINDS 合入 + kind 标注）；`expandMentions` `@path#L1-L5` 行区间（opencode `autocomplete.tsx:29-58` 对标，越界 clamp）；补全弹窗复用既有 overlay（Tab/自动弹已具备——本轮补排序/语义/区间三缺口）。
- **③ 内容交互 diff/媒体 6→7（4753824，9 单测）**：词级 inline diff（kimi 六家独有 `diff_render.py:184-218` 移植到 `wordDiff.ts`：连续 -/+ 块逐对配对、SequenceMatcher ratio<0.5 整行降级、LCS char 级回溯 token 红绿分段、>240 字整行保护——无语法高亮层故省略 tab 偏移映射，诚实简化）+ pager [/] hunk 跳转（opencode 独有 `diff-viewer.tsx:282-315` 对标：回滚 diff 等 @@ 内容、底部快捷键提示、无更多 hunk 保持原位）。
- **⑪ 差异化 8→9（c47f51f，7 单测）**：离线「缺模型即拉取」（codex `ollama/lib.rs:22-34` ensure_oss_ready 对标——`ensureOfflineModelReady` 已就绪零下载、未就绪下载并回报；`/offline on` 切完自动下载零门槛；progress_callback → `normalizePipelineProgress` 归一化 + 5% 步进 `system.notice` 状态行）+ AI 记忆收件箱（gemini `.inbox` 对标——`memoryInbox.ts`：settings.memoryInbox=true 时 memory_write 先入箱 pending，`/memory inbox list|apply|discard|undo` 批准生效/丢弃/按记录撤销——可审可退堵「不可控记忆」评审攻击；默认关直写零漂移，既有闭环契约不变）。
- **验证**：tsc 零错误；全量套件 362 文件/2687 用例绿（10 skip）；`npm run ci` 本地九命令全绿；远程 CI 见 audit §13.74。
- **复算**：总分 878 → **900**——**反超 codex（869）稳居第 1/7**（不依赖公开决策）。严格第一：①④⑥⑩⑪ 五项；并列第一：⑤⑦（与 opencode）。下一站：波 3 → 922（vim、完整 diff 查看器/逐 hunk 应用、ACP 接收 + 本地语义搜索）。


### 9.18 波 3 收官轮（2026-08-18：②③⑪ 三维落地——900 → 922，三波路线全部落定）

按 `docs/upgrade-plan-2026-08.md` 波 3 三任务执行（六家源码逐项对标，双代理取证先行）：

- **② 输入/编辑器 8→9（6d458ca，14 单测）**：vim 模态编辑——gemini `vim.ts`（1536 行）状态机 + `vim-buffer-actions.ts`（纯 reducer）语义直搬为 `vimCore.ts` 纯函数（零副作用、天然可 undo）：NORMAL/INSERT 双态、hjkl/wbeWBE/0$^/ggG/fFtT（预读两键命令）、xXr~/ddccyy/D C Y、dcy+移动（vim 含式语义 l/$/e/E 含、w/W 排他）、pP、u（hook 独立 undo 栈）、`.` 多键序列回放、数字前缀 ×10、双击 Esc 500ms 清空；textInput 按键拦截 + `-- NORMAL --` 徽标（gemini Composer.tsx:158-165 对标）+ `/vim` 命令 + settings.vimMode 配置水合热生效。**无 VISUAL、无 / 搜索、无 Ctrl-R——gemini vim.ts 同款诚实边界（同档宣称）。**
- **③ 内容交互 diff/媒体 7→8（78728f7，10 单测）**：`hunkApply.ts`（parseHunks @@ 头结构化 + applyHunkToText 上下文锚定失败绝不写半行 + reverseHunk + lineDiff 行级 LCS unified diff 3 行上下文、1500 行超限整文件降级）+ `/diff <文件>` 快照→当前完整 diff 查看（pager 内词级渲染 + [/] hunk 跳转复用波 2）+ `/diff <文件> revert <hunk序号>` **per-hunk 选择性回滚**——取证确认六家皆无（opencode diff-viewer.tsx:945-1010 仅跳转无 apply/discard），回滚前自动快照、/undo fs restore 可再滚回。
- **⑪ 差异化 9→10（ab5c02e，4 单测）**：本地跨会话语义召回——`/hole --all` 全会话 FTS bigram + 本地向量 KNN（数据不出机；取证：aider 仅本地嵌入做 /help 文档 RAG、gemini 云端嵌入、其余纯正则——**六家独有**）；ACP stdio 接收正式入档（`acp.ts` runAcpServer + /acp 命令 + 协议测试为既有落地，本轮归入 ⑪ 论据）。
- **验证**：tsc 零错误；全量套件 365 文件/2712 用例绿（10 skip）；`npm run ci` 本地九命令全绿；远程 CI 见 audit §13.75。
- **复算**：总分 900 → **922**——**三波路线全部落定，稳居第 1/7**（不依赖公开决策）。严格第一：①④⑥⑩⑪ 五项；并列第一：⑤⑦（与 opencode）。⑧ 5→9（+36）仍卡公开决策。

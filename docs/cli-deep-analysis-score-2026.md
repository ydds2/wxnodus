# 七 CLI 全景深挖评审与评分（2026-08-18 三轮专案 + 补齐轮复评）

> 证据基准：`C:\Users\20164\Desktop\cli-compare\{codex,gemini-cli,opencode,kimi-cli,crush,aider}` 全量源码 + wxnodus 本仓（src 576 文件 72.5k 行 + packages/wxnodus-ink）。
> 三轮：① 能力矩阵/臃肿度（docs/cli-comparison-2026.md）② 实现级五层差距（docs/cli-implementation-gap-2026.md）③ 本文档——框架/功能/场景/UI/提示词四路 deep-dive 合成 + 11 维加权评分。
> ④ 补齐轮（2026-08-18，同日二评）：按 ①② 的差距清单逐条落地（OS 沙盒/apply_patch/并行调度/输出蒸馏掩码/LSP/硬编码清零）后复评——评分表已更新，判词与路径表同步。全部结论可回溯 file:line。

---

## 0. 评分方法（可复算、可质疑）

**11 维 × 7 家，权重归一化到 100。** 权重代表「AI 编码 CLI 综合竞争力」的构成假设：Agent 内核 13、提示词/模型适配 11、场景/协议 11、安全 10 为第一梯队；渲染/输入/生态/工程为体验与持续力；差异化 5 是「不可替代性」溢价。

### 0.1 补齐轮复评表（2026-08-18 二评，wxnodus 列已更新；其余六家分数不变）

| 维度（权重） | wxnodus | codex | gemini | opencode | crush | kimi | aider |
|---|---|---|---|---|---|---|---|
| ① UI 渲染引擎（9） | **10** | 9 | 7 | 8 | 9 | 6 | 4 |
| ② 输入/编辑器（9） | 5 | **10** | 9 | 7 | 6 | 8 | 8 |
| ③ 内容交互 diff/媒体（8） | 4 | 8 | 6 | **9** | **9** | 7 | 5 |
| ④ Agent 内核/工具（13） | **9** | **9** | **9** | **9** | 8 | 8 | 7 |
| ⑤ 提示词/模型适配（11） | 6 | 9 | 9 | **10** | 7 | 7 | 8 |
| ⑥ 安全工程（10） | **9** | **9** | **9** | 7 | 7 | 6 | 3 |
| ⑦ 场景/协议（11） | 8 | 9 | 9 | **10** | 5 | 7 | 4 |
| ⑧ 分发/生态/文档（9） | 5 | 9 | 8 | **9** | 7 | 8 | 8 |
| ⑨ 工程质量/CI（8） | 7 | 9 | 9 | 9 | 8 | 8 | 5 |
| ⑩ 性能/token 工程（7） | 8 | 8 | 8 | 7 | 7 | 6 | 5 |
| ⑪ 差异化（离线/记忆/平台）（5） | **8** | 4 | 3 | 5 | 4 | 3 | 5 |
| **加权总分（/1000）** | **725** | **869** | **812** | **841** | **709** | **693** | **573** |

**排名：codex 8.69 ＞ opencode 8.41 ＞ gemini 8.12 ＞ wxnodus 7.25 ＞ crush 7.09 ＞ kimi 6.93 ＞ aider 5.73。**（wxnodus 由 6.14→7.25，升至第 4/7 名，反超 crush 与 kimi）

**复评变动的逐维理由（±分数全部有落地证据，见 §9 补齐轮记录）：**

| 维度 | 旧→新 | 理由（证据锚点） |
|---|---|---|
| ④ Agent 内核/工具 | 8→9 | apply_patch 多文件补丁（三级容错+全量校验落盘+did_you_mean，`src/kernel/applyPatch.ts`）；并行调度（纯只读批并行、含写批串行，`agent.ts` 槽位保序）；LSP 三工具（`src/kernel/lspClient.ts`）；输出 offload+掩码+蒸馏开关（`src/kernel/toolOutput.ts`）——工具层与 codex/gemini/opencode 同档 |
| ⑤ 提示词/模型适配 | 5→6 | 压缩阈值不再硬编码 64k——模型目录真实窗口 − 输出预留（`providers.ts maxContextFor` + `agent.ts`）；MAX_TURNS 32 写死 → settings.maxTurns；wrapDanger 8000 写死 → settings.untrustedWrapLimit + offload |
| ⑦ 场景/协议 | 6→8 | 原空白四块已补三：stdin 管道（`stdinPipe.ts`）、--stream-json/--wire 协议文档+2 示例（`docs/wire-protocol.md`）、ACP 文档（`docs/acp-zed-jetbrains.md`）、LSP 集成（IDE 生态第一步）；仅剩远程/分享未覆盖 |
| ⑧ 分发/生态/文档 | 2→5 | CHANGELOG.md + /update 渠道探测（五渠道指引）+ winget/scoop manifest 模板与生成器（占位门禁诚实标注）+ 协议/集成文档；仍无真实发布与插件市场 |
| ⑨ 工程质量/CI | 4→7 | `npm run ci` 七步本地门禁（typecheck×2+全量+known-failures+发现/覆盖+build）；handlersExt 3912→2180 行拆分；分层泄漏修复（kernel 拥有语义+Symbol 品牌端口）；fixture node_modules 出 git；tests/README 布局约定。无 GitHub Actions（仓库无 remote） |
| ⑩ 性能/token 工程 | 6→8 | 输出 offload（50KB 落盘+续读，bash 流式落盘不丢尾）+ 旧轮掩码（50k 保护窗）+ 并行读批 + 真实窗口压缩 + 前缀缓存稳定化（sessionClocks 冻结）+ usage 缓存双列可观测（v7/v8 迁移） |

**未调分且如实说明**：⑥ 安全工程维持 9——OS 沙盒本轮落地（Windows L0-L3，标准用户实测校准：受限令牌路径被 1314 证伪、改 Low IL 实现只读）但仅 Windows 单平台，codex/gemini 是三平台沙盒；三平台化后才可冲 10。②③ 未动（vim/keymap、diff 交互 UI 仍在 P1 清单）。

判词先行（补齐轮更新）：**wxnodus 不再是偏科生，而是「单机堡垒已开门」**——渲染引擎单科满分不变；补齐轮把「执行层四件硬差距」（OS 沙盒/apply_patch/并行调度/输出蒸馏）+ LSP + 硬编码清零全部落地，工具层与三大平台巨舰同档（④ 并列满分档）；分发（5）与输入交互（5/4）仍是拉分项，工程 7 分仍差在「无远程 CI、无市场」。它输给头部的仍然是「产品化完成度」（IDE 插件/远程/市场），而不是「技术深度」。

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

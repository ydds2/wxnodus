# 七 CLI 全景深挖评审与评分（2026-08-18 三轮专案）

> 证据基准：`C:\Users\20164\Desktop\cli-compare\{codex,gemini-cli,opencode,kimi-cli,crush,aider}` 全量源码 + wxnodus 本仓（src 576 文件 72.5k 行 + packages/wxnodus-ink）。
> 三轮：① 能力矩阵/臃肿度（docs/cli-comparison-2026.md）② 实现级五层差距（docs/cli-implementation-gap-2026.md）③ 本文档——框架/功能/场景/UI/提示词四路 deep-dive 合成 + 11 维加权评分。
> 全部结论可回溯 file:line；行号基于本次克隆快照。

---

## 0. 评分方法（可复算、可质疑）

**11 维 × 7 家，权重归一化到 100。** 权重代表「AI 编码 CLI 综合竞争力」的构成假设：Agent 内核 13、提示词/模型适配 11、场景/协议 11、安全 10 为第一梯队；渲染/输入/生态/工程为体验与持续力；差异化 5 是「不可替代性」溢价。

| 维度（权重） | wxnodus | codex | gemini | opencode | crush | kimi | aider |
|---|---|---|---|---|---|---|---|
| ① UI 渲染引擎（9） | **10** | 9 | 7 | 8 | 9 | 6 | 4 |
| ② 输入/编辑器（9） | 5 | **10** | 9 | 7 | 6 | 8 | 8 |
| ③ 内容交互 diff/媒体（8） | 4 | 8 | 6 | **9** | **9** | 7 | 5 |
| ④ Agent 内核/工具（13） | 8 | **9** | **9** | **9** | 8 | 8 | 7 |
| ⑤ 提示词/模型适配（11） | 5 | 9 | 9 | **10** | 7 | 7 | 8 |
| ⑥ 安全工程（10） | **9** | **9** | **9** | 7 | 7 | 6 | 3 |
| ⑦ 场景/协议（11） | 6 | 9 | 9 | **10** | 5 | 7 | 4 |
| ⑧ 分发/生态/文档（9） | 2 | 9 | 8 | **9** | 7 | 8 | 8 |
| ⑨ 工程质量/CI（8） | 4 | 9 | 9 | 9 | 8 | 8 | 5 |
| ⑩ 性能/token 工程（7） | 6 | 8 | 8 | 7 | 7 | 6 | 5 |
| ⑪ 差异化（离线/记忆/平台）（5） | **8** | 4 | 3 | 5 | 4 | 3 | 5 |
| **加权总分（/1000）** | **614** | **869** | **812** | **841** | **709** | **693** | **573** |

**排名：codex 8.69 ＞ opencode 8.41 ＞ gemini 8.12 ＞ crush 7.09 ＞ kimi 6.93 ＞ wxnodus 6.14 ＞ aider 5.73。**

判词先行：**wxnodus 不是残次品，是重度偏科生**——渲染引擎与安全防御两个单科满分，但生态分发（2/10）与工程质量（4/10）两科不及格，把总分拉到了 6.14。它输给头部的是「产品化完成度」，而不是「技术深度」；它输给 aider（5.73）的恰好反过来，是「工业化不足但技术野心更大」。单项细节见下。

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
| 远程/分享 | ✗ | exec-server/cloud | ✗ | share/slack/CI | ✗ | share/web | ✗ |
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

全部做完 ≈ 2 周，总分约 7.5-7.8；冲 8.5+ 需补 IDE 插件/A2A 完整版/子代理分型（月级）。**用户若选择启动，默认从序 1（零风险工程化）开始。**

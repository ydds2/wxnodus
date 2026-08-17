# 同类 CLI 全量源码比对（wxnodus vs 6 家开源）

> 数据采集：2026-08-18，浅克隆 6 个开源 CLI 全量源码至 `Desktop\cli-compare\`（codex / gemini-cli / opencode / kimi-cli / crush / aider）。
> Claude Code 闭源无法获取（其架构经公开资料推断，仅作参照）。所有数字以克隆快照实测为准；wxnodus 为自数据。
> 结论先行：**wxnodus 的能力面不输竞品（很多方面独有），但「命令面」比竞品肥 2~3 倍，是主要臃肿点；真正的差距在 OS 级沙盒、并行调度、结构化补丁、工具输出蒸馏四件事上。**
> **2026-08-18 补齐轮更新**：这四件事 + LSP 集成 + 硬编码清零已全部落地（本文件 §3 矩阵与 §4 清单已同步更新为 ✓/已完成，见各条「补齐轮」注记；评分见 cli-deep-analysis-score-2026.md §0）。

## 1. 总览

| | wxnodus | codex | gemini-cli | opencode | kimi-cli | crush | aider |
|---|---|---|---|---|---|---|---|
| 语言 | TypeScript | Rust | TypeScript | TypeScript | Python | Go | Python |
| 核心代码行 | **77k** | 1.40M | 254k | 560k | 52k | 96k | 20k |
| 测试 | 275 文件/2.4k 用例 | 553 rs 测试文件 | 894 文件 | 722 文件 | 209 文件 | 1.3k 函数 | 41 文件 |
| 内置工具 | **44** | ~24 | ~30 | 17 | 17 | 27 | 0（编辑格式） |
| slash 命令 | **109** | 58 | 47 | 2+动态 | 40 | 17+动态 | 43 |
| TUI 框架 | 自研 ink fork | ratatui 自研 | ink | @opentui 自研 | prompt_toolkit | bubbletea | prompt_toolkit |
| 权限模型 | 6 模式+8 红线 | 审批策略×Guardian×内核沙盒×hooks | Policy 引擎(TOML) | 规则 ask/allow/deny | yolo/afk/会话授权 | yolo+白名单+持久授权 | 只读集合+逐项确认 |

**体量解读**：wxnodus 以 codex 1/18、gemini 1/3 的代码量，做到了同等能力面（工具数甚至更多）——单从「人均功能密度」看是最高效的；但命令面 109 个是竞品的 2~3 倍（竞品把功能做成「工具+配置」，wxnodus 把功能做成「工具+命令+状态栏段」三线齐发）。

## 2. 架构层对比

| 维度 | 竞品主流做法 | wxnodus 做法 | 评价 |
|---|---|---|---|
| 主循环 | 每轮压缩→渲染上下文→模型→工具→回灌（各家同构） | 同构（agent.ts 回合循环 + MAX_TURNS 32 + 签名级循环检测 + 读缓存） | 持平；codex 无硬上限改用「压缩滚动+加权 token 预算」值得借鉴 |
| 工具执行 | gemini 有**并行调度**（连续可并行工具成批执行）；其余串行 | 串行 | 差距：多工具回合慢一倍以上 |
| 工具输出 | gemini 有**蒸馏/掩码**（长输出先摘要/遮罩再进上下文） | 只有截断标注（§13.14 系列） | 差距：大输出仍全量进上下文 |
| 代码编辑 | codex/opencode **apply_patch**（原生多文件 hunk 补丁） | fs_edit（单文件单处 SEARCH/REPLACE） | 差距：多文件改动要多次调用 |
| 权限 | codex/gemini 有 **OS 内核沙盒**（mac seatbelt / Linux bwrap+Landlock / Windows 受限令牌） | 模式分级+审批+红线（无 OS 隔离） | **最大安全差距** |
| 配置 | gemini 四层（system/user/workspace/默认）；opencode 分层 config | settings.json 单层 + providers | 差距：无项目级配置继承 |
| 会话 | codex/gemini/kimi 有**会话浏览器**（列表+预览+恢复） | /sessions 文本列表 + /resume | 可用，体验弱一档 |
| 成本 | opencode Decimal 精确阶梯计价；aider $/message+session | /cost 参考价目+状态栏 $ | 持平（更诚实的口径） |

## 3. 功能矩阵（✓ 有 / ≈ 部分 / ✗ 无）

| 功能 | wxnodus | codex | gemini | opencode | kimi | crush | aider |
|---|---|---|---|---|---|---|---|
| 自动压缩 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| 循环/失控检测 | ✓ 签名级 | ✓ 软预算 | ✓ **LLM 辅助** | ✓ doom-loop | ✓ 防重复 | ✓ SHA 签名 | ✗ |
| 记忆文件(AGENTS.md) | ✓ /init | ✓ /import | ✓ | ✓ | ✓ | ✓ | ✗ |
| 持久向量记忆 | ✓ **黑洞引擎** | ≈ memories 双管道 | ✗ | ✗ | ✗ | ✗ | ✗ |
| 子代理 | ✓ delegate/swarm/duo/arena | ✓ spawn_agent 族 | ✓ invoke_agent | ✓ task 树 | ✓ Agent 工具 | ✓ agent/task | ≈ 双角色 |
| Plan 模式 | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ≈ /architect |
| Hooks | ✓ 12 类 | ✓ 5 类 | ✓ | ≈ 事件 | ✓ 7 类 | ✓ PreToolUse | ✗ |
| MCP | ✓ 客户端+服务端 | ✓ 客户端+服务端 | ✓ | ✓ | ✓ | ✓ | ✗ |
| Skills | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| 插件 | ✓ 本地 | ✓ **+市场** | ≈ | ✓ **+市场** | ✓ | ✗ | ✗ |
| OS 内核沙盒 | ✓ Windows | ✓ 三平台 | ✓ | ✗ | ✗ | ✗ | ✗ |
| 结构化补丁 apply_patch | ✓ | ✓ | ≈ replace | ✓ | ≈ | ≈ | ✓ 编辑格式 |
| 并行工具调度 | ≈ 只读批并行 | ≈ | ✓ | ≈ | ≈ | ✗ | ✗ |
| 工具输出蒸馏/掩码 | ✓ offload+掩码 | ≈ | ✓ | ✗ | ✗ | ✗ | ✗ |
| 后台任务 | ✓ jobs/term/cron | ≈ | ✓ | ≈ | ✓ | ✓ | ✗ |
| 语音 | ✓ | ✓ 实时 | ✓ | ✗ | ✓ | ✗ | ✓ |
| 视觉 | ✓ GLM/本地 moondream | ✓ view_image | ≈ | ≈ | ✗ | ≈ | ≈ 图像输入 |
| Computer Use 桌面控制(UIA) | ✓ **独有** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 离线本地模型 | ✓ **四模态** | ✓ ollama/lmstudio | ✗ | ✗ | ✗ | ≈ | ✗ |
| LSP 集成 | ≈ 诊断/hover/定义 | ≈ | ✗ | ✓ | ✗ | ✓ 8 工具 | ✗ |
| vim 键位 | ✗ | ✓ | ✓ | ≈ | ✗ | ✗ | ✓ |
| 主题 | ≈ 2 套 | ≈ | ✓ | ✓ **33 套** | ✓ | ≈ | ✗ |
| OAuth/账号登录 | ✗（仅 key） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Web/桌面 UI | ✗ | ✓ app-server | ✗ | ✓ 桌面+Web | ✓ Web | ≈ server | ≈ streamlit |
| 会话浏览器 | ≈ | ✓ | ✓ | ≈ | ✓ | ✓ | ≈ |
| 分享 share | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ |
| 成本显示 | ✓ 参考价目 | ✓ token/预算 | ✓ 配额 | ✓ 精确计价 | ✓ /usage | ✓ | ✓ $ 计费 |
| 余额/预算硬停 | ✓ **独有** | ≈ rollout budget | ≈ 配额 | ✗ | ✗ | ✗ | ✗ |
| 合规五项(存证/标注/审计/许可/robots) | ✓ **独有** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 确定性工具(calc/sql/hash…) | ✓ **独有** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

## 4. 差距清单（wxnodus 缺什么，按价值排序）

**P0（用户可直接感知）——2026-08-18 补齐轮：第 1-4 条已全部落地，状态如下**
1. **OS 内核沙盒** ✅ 已落地：Windows L0-L3（L0=Low IL 只读+断网，L1=Job+断网，L2=Job+限速 10KB/s，L3=Job 遏制；`src/kernel/winSandbox.ts`，能力探测诚实降级——标准用户实测校准：CreateRestrictedToken+CreateProcessAsUser 被系统 1314 拒绝，改 SetTokenInformation(Low IL) 路径）。**仍缺**：macOS/Linux 平台（codex/gemini 三平台）。
2. **并行工具调度** ✅ 已落地：纯只读批次 Promise.all 并行、含写批次整批串行（gemini scheduler 同款语义；`agent.ts` 槽位保序回填）。
3. **apply_patch 结构化补丁** ✅ 已落地：多文件 Add/Update/Delete/Move + @@ 锚定，三级匹配容错（精确→行尾空白→重缩进）+ 全量校验后落盘（绝不写一半）+ 逐块报错带 did_you_mean（`src/kernel/applyPatch.ts`）。
4. **工具输出蒸馏/掩码** ✅ 已落地：超 50KB/2000 行落盘 offload + 头尾预览 + 续读路径（bash 流式落盘保留完整输出）；旧轮掩码（保护窗 50k/触发 30k）；蒸馏开关默认关（`src/kernel/toolOutput.ts`）。
5. **硬编码清零** ✅ 已落地（生产级红线）：压缩阈值 64k 写死 → 模型目录真实窗口 − 输出预留；wrapDanger 8000 写死 → settings.untrustedWrapLimit + offload；MAX_TURNS 32 写死 → settings.maxTurns（1..200 夹取）；全部阈值 settings 可覆盖且夹取防误配。

**P1（体验/生态）**
6. 会话浏览器（列表+预览+恢复，codex resume_picker / gemini SessionBrowser）
7. LLM 辅助循环检测（gemini 30 轮后让 LLM 判断是否空转）
8. 配置分层（项目级 `.wxnodus/config` 继承 user 级）
9. 主题系统（opencode 33 套 JSON 主题最易抄）
10. vim 键位 / 键位自定义
11. 插件市场与远端技能安装
12. Web UI（kimi FastAPI / opencode Tauri 桌面）

**P2（小众）**：~~LSP 集成~~ ✅ 已落地基础版（lsp_diagnostics/hover/definition 三工具，settings.lsp.servers 可配任意服务器 + 内置 typescript-language-server 探测）、OAuth 登录流、share 分享、远程执行环境（codex exec-server）、GitHub PR 集成。

## 5. wxnodus 独有/领先（竞品没有的）

1. **Windows 原生零依赖渲染器**（0.04s 首帧）——竞品全部依赖第三方渲染（ink/ratatui/bubbletea/prompt_toolkit），wxnodus 是唯一重写渲染管线的。
2. **全离线四模态**（文本 Qwen / 向量 embedding / 视觉 moondream / 语音 whisper）——竞品只有 codex（ollama 拉取）沾边。
3. **黑洞引擎持久向量记忆**（FTS5+sqlite-vec 三层）——竞品普遍无持久向量记忆（codex memories 仅文本检索）。
4. **Computer Use（UIA 元素级桌面控制）**——6 家竞品无一具备。
5. **合规五项落地**（授权存证/AI 生成标注/审计哈希链/许可证扫描/robots 护栏）——深度合成办法场景唯一。
6. **余额监控 + 预算硬停**——唯一的「花到 0 元自动停」护栏（codex rollout budget 是内部计费单元，性质不同）。
7. **确定性工具命令面**（毫秒级 calc/sql/hash/units…）——竞品无此层（都走模型或 shell）。

## 6. 臃肿度与作用重叠（核心问题：是不是相似且臃肿）

**结论：功能设计方向与竞品一致（同构），不「另类」；但命令面存在系统性冗余——竞品 1 个入口做的事，wxnodus 常做 3~5 个。**

功能密度对照（命令数 / 核心代码行）：
- codex 58 命令 / 1400k 行；gemini 47 / 254k；kimi 40 / 52k；**wxnodus 109 / 77k**——命令密度是竞品 2~5 倍，是唯一「命令比代码长得快」的。

内部重叠清单（同一能力多个入口）：

| 能力 | wxnodus 入口数 | 竞品对照 |
|---|---|---|
| 记忆检索 | 3（/memory search、/hole、memory_search 工具） | gemini /memory 一个 |
| 会话管理 | 5（/sessions /resume /new /fork /checkpoint） | codex resume/fork/archive 3 个 |
| 网络抓取 | 5（/claw /web /search /browser + http_get/web_search 工具） | codex 无专属命令（全工具） |
| 多代理 | 5（/delegate /swarm /duo /arena /agent） | 竞品 1 个 task/agent 工具 |
| 回滚机制 | 4（/undo /checkpoint /versions /snapshot） | codex 1（git 回滚）/gemini rewind+restore |
| 成本观测 | 3（/usage /cost /balance） | opencode 1（status 栏+stats） |
| 提问用户 | 2（ask_user、clarify 工具） | 竞品 1 个 |
| 确定性工具 | 11（/calc /hash /base64 /uuid /rand /json /timer /sql /fs /units /csv） | 竞品 0（shell 承担） |

**瘦身建议（可保留特色，砍掉重复）**：
- 确定性工具 11 个 → 聚合成 `/tool <name> <args>` 一个命令（能力不变，命令面 -10）；
- 多代理 5 个 → 保留 `/delegate`（工具已是 agent 面），swarm/duo/arena 并入其子命令；
- 回滚 4 个 → `/undo` 为主，checkpoint/versions/snapshot 并入 `/undo` 子命令；
- 网络 5 个 → 命令面保留 `/search /claw`，其余归工具；
- 成本 3 个 → 一个 `/stats` 聚合面板（含 balance/usage/cost 三节）。
- 目标：109 → ~45 命令，与竞品同档，同时不损失任何能力（工具面 44 个不变）。

## 7. 一句话总结

> wxnodus 不是功能少，而是「入口多」：能力面（48 工具）已达竞品水准、且有 7 项独有优势；「OS 沙盒、并行调度、apply_patch、输出蒸馏」四件硬差距与 LSP/硬编码问题已全部补齐（2026-08-18 补齐轮）；真正的臃肿在 109 个命令——砍到 ~45 个（聚合同能力入口）即与竞品同构同档，且保留全部特色。评分已从 6.14 升至 7.25（第 4/7 名，见 cli-deep-analysis-score-2026.md）。

---

附：各竞品主循环/工具注册/权限/TUI 关键坐标（取证用）

| CLI | 主循环 | 工具注册 | 权限 | TUI |
|---|---|---|---|---|
| codex | `codex-rs/core/src/session/turn.rs:281` | `spec_plan.rs:120 build_tool_router` | `tools/approvals.rs` + `execpolicy/` | `codex-rs/tui/src/app.rs`（ratatui） |
| gemini | `packages/core/src/core/client.ts:614 processTurn`（MAX_TURNS=100） | `config/config.ts:3955 registerCoreTools` | `policy/policy-engine.ts:234` | `packages/cli/src/ui/App.tsx`（ink） |
| opencode | `packages/opencode/src/session/prompt.ts:1088 while(true)` | `tool/registry.ts:231` | `permission/index.ts:40` | `packages/tui/src/app.tsx`（@opentui/solid） |
| kimi | `src/kimi_cli/soul/kimisoul.py:1000` | `soul/toolset.py:229` | `soul/approval.py:130` | `ui/shell/__init__.py`（prompt_toolkit） |
| crush | 循环在外部库 `charm.land/fantasy`；组装 `internal/agent/agent.go:566` | `coordinator.go:679 buildTools` | `permission/permission.go:181` | `internal/ui/model/ui.go`（bubbletea） |
| aider | `aider/coders/base_coder.py:876 Coder.run` | 无工具表（编辑格式） | 只读集合+confirm_ask | `aider/io.py`（prompt_toolkit） |

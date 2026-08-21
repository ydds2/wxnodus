# WxNodus V4.0 计划（2026-08-21 · 新仓库起点）

> **文档定位**：wxnodus 4.0 的版本级总计划。以**输出体系重设计**为龙头主线，继承 V3.x 计划（`wxnodus-master-upgrade-plan-2026-08-21.md`，下称【V3 计划】）的全部缺陷修复与机制对齐任务，在全新仓库（本目录 `Desktop/wxnodus4.0`）组织为 4.0 版本目标。
> **输入源**（本会话全部上下文）：①纯源码审计【V3 计划】之底册 `production-readiness-plan-2026-08-21.md`（8S/26A/42B/30C，全带 file:line）；②6 家竞品本地源码机制取证；③5 路网络调研（Codex+Claude Code / Gemini+Kimi / OpenCode+Crush / Aider+品类痛点 / 可靠性最佳实践）；④用户战略约束（四条 + 离线裁撤二次裁决）；⑤输出体系现状侦察（本日）。
> **旧仓处置**：`Desktop/WxNodusV3CLI` 原样保留为历史档案（git 历史可溯）；本仓 `git init` 新历史，首提交 = 迁移基线（45MB/1802 文件纯源代码，构建与测试状态见 §6.1）。

---

## 第 1 章 战略约束（继承确认，长期有效）

**约束一：插件市场「只收不出」**——不建自托管市场；`/market` 永远是开放生态目录聚合器（npm registry + GitHub topic 等公开源）；用户自制插件仅本地自用，对外分享唯一通道 `/bundle` 整包离线分发。任何「建目录/托管/账号」提案一律否决。

**约束二：CLI 主体对齐同类**——交互、可靠性机制、命令面语义按业界标准模仿参考完善；抄「机制与语义」不抄代码与文案；互通契约（AGENTS.md、SKILL.md、MCP、OpenAI 协议、stream-json）按标准实现。

**约束三：独有功能全面冻结维护 + 离线能力裁撤（2026-08-21 二次裁决）**
- 黑洞记忆、`/build`、UIA 桌面控制、合规链、winSandbox、ACP/A2A、`/jobs`+`/cron`、成本计价体系：冻结维护态（修缺陷/保兼容/保测试绿，不扩张新独占特性）。
- **裁撤**：离线对话（offlineModel 全链）、离线看图（moondream2+OCR 兜底）、无 key/无网可用层（deterministic 工具/规则脑/NL 兜底）——用户裁决「离线能力在 CLI 中并没有优势」。
- **保留**：语音（whisper+SAPI）、气隙升级（`update --file`）、黑洞记忆/本地向量、「数据不出机」定位（数据全本地存储 ≠ 离线运行）。
- 裁撤走软着陆：一个次版本 deprecation 警告 + `WXNODUS_LEGACY_OFFLINE=1` 逃生开关 + 文档指引，随后物理移除（Buddy 事件教训：功能下线无缓冲引发 2071 赞反弹）。

**约束四：用户的两大权力**——自主升级权（`wxnodus update`：检查+自助升级，非强制/可跳过/可回退）；自定义产物迁移兼容权（插件/skills/MCP 配置/会话/记忆/主题/键位/密钥档案/权限规则全量兼容迁移——文件系统级迁移框架，超越现有 DB-only）。

---

## 第 2 章 输出体系重设计（V4.0 龙头主线 L0）

### 2.1 现状诊断（2026-08-21 源码侦察实证）

当前输出体系是 2026-08-19「全面替换（对标 Claude Code/Codex/Gemini 极简 inline 格式）」后的形态，但存在六个结构性问题：

| # | 问题 | 源码证据 |
|---|---|---|
| D1 | **失败着色靠正则猜测内容，不用结构化结局** | `messageLine.tsx:305` 工具结果着色 `/失败\|错误\|异常\|error\|failed/i` 猜前 200 字；`:210-216` 事件消息颜色三段正则猜测。而内核**已有**确定性 outcome（`agent.ts:685` lastToolOutcome、11 端口管线终态）——与【V3 计划】A-5（「失败/异常」子串误杀回合）**同病根**：结构化信号存在但消费方不用 |
| D2 | **组件膨胀、职责混杂** | statusBar.tsx 962 行、thinking.tsx 1242 行、markdown.tsx 1184 行；messageLine.tsx 457 行内嵌 8 种消息形态分发 |
| D3 | **格式演进靠全量打补丁，无稳定规范** | 7 个连续 commit（输出降噪二批→格式全面替换→更完善→体系收口→mockup 一致性→…）每次全局替换式修改——没有「单一规范 + 渐进变更」机制 |
| D4 | **TUI 与 -p 两套输出代码路径** | `-p` 流式输出（agent.token→stdout）独立实现（commit a3ad809），与 TUI 渲染层零共享；stream-json/退出码语义未对齐品类（P4-2 缺口） |
| D5 | **死组件残留** | todoPanel.tsx 仍存在但 messageLine:228 已 `return null`（对标「清单不占对话流」）；peerTrail/diffRenderer/streamingMarkdown 各自为政 |
| D6 | **字形/颜色语义无单一事实源** | glyphs.ts 与 theme 各处散布；accent/error/warn 的使用约定只存在于历史 commit 信息里 |

### 2.2 竞品输出体系研究结论（本会话调研汇总）

- **Claude Code**（品类事实标准）：`⏺ 动作行`（工具名+参数摘要）+ `⎿ 缩进结果行`（成功 dim / 失败红——**由结构化结局决定**）；流式文本直接打印；思考默认不可见可展开；回合尾 token 用量行；状态栏单行极简；无边框卡片。harness 开销 33k token（读 prompt 前）是反面教材。
- **Codex**：思考折叠 + 工具执行行 + reasoning summary（granular 格式可配）；`exec --json` JSONL 事件流（thread.started/turn.started/item.*/turn.completed）+ `--output-schema` 强制结构化。
- **Gemini**：`--output-format stream-json`（init/message/tool_use/tool_result/error/result 分类学）+ **语义化退出码（0/1/42 输入错误/53 轮次上限）**。
- **OpenCode**：harness 开销 7k（对照组标杆）；错误回喂模型自纠（InvalidTool）。
- **品类共识**（【网络调研⑤】主题 3/7）：工具错误一律「码+解释+建议」结构化——渲染层同理：状态由结构决定，不由内容猜测。

### 2.3 V4.0 输出体系设计

#### 设计原则（五条）
1. **单一事实源**：输出形态由类型化输出事件（OutputEvent）决定；渲染层 = 纯函数 `(OutputEvent, Theme, Density) → 行序列`，100% 可单测/快照测。
2. **结构化 outcome 贯通**：内核管线终态（lastToolOutcome / 11 端口结果 / run 终态）直达渲染层——全仓**消灭输出侧正则猜测**（D1 与 A-5 一次根治）。
3. **一套模型、三个后端**：TUI（ink 组件）/ ANSI 纯文本（`-p` 人读档）/ JSON（`-p --json`、stream-json）消费同一 OutputEvent 流——D4 根治。
4. **规范先行、版本化变更**：输出规范（形态/字形/语义色/折叠协议）是一份独立 spec 文档 + 类型定义，格式变更走 spec 版本号，禁止再「全量替换式」打补丁（D3 根治）。
5. **密度三档**：`cozy / compact / dense`（现有 density 扩展），所有形态在三档下有定义。

#### 统一输出模型（OutputEvent 分类学）

```ts
type OutputEvent =
  | { kind: 'user';            text: string; attachments?: string[] }
  | { kind: 'assistant';       text: string; streaming?: boolean }
  | { kind: 'reasoning';       text: string; tokens: number; streaming?: boolean }
  | { kind: 'tool-start';      name: string; argsSummary: string }
  | { kind: 'tool-result';     name: string; outcome: 'ok'|'failed'|'denied'|'cached'|'timeout';
                                preview: string; tokens?: number; durationMs?: number }
  | { kind: 'diff';            file: string; body: string }
  | { kind: 'command';         name: string; output: string; exitCode?: number }
  | { kind: 'notice';          level: 'info'|'warn'|'error'; scope: 'core'|'rpc'|'transient'; text: string }
  | { kind: 'turn-summary';    turns: number; tokens: number; costUsd: number; durationMs: number }
  | { kind: 'session-event';   type: string; text: string }   // ◈ 时间线（切换/恢复/后台任务）
```

生成侧：flowStore / eventAdapter（现有 bus→GatewayEvent→flowStore 链）扩展一个 `toOutputEvent()` 映射层——内核事件带全结构化字段（outcome/tokens/duration 从管线与 usage 取），映射纯函数化。

#### 回合叙事格式规范（TUI 端）

| 事件 | 形态 | 语义色 |
|---|---|---|
| user | `❯ 文本`（保持现状，dim） | muted；长粘贴折叠 `[long message]` |
| assistant | 纯 markdown，无边框无徽标（保持） | text |
| tool-start | `⏺ 工具名 参数摘要` | accent（进行中带 spinner 尾点） |
| tool-result | `⎿ 预览`（缩进 2） | **outcome 着色**：ok=muted dim / failed=error / denied=warn / cached=muted+`⟳` / timeout=warn+`⏱` |
| reasoning | `▸ 推理 (N tokens)` 折叠，展开 dim 全文 | muted（纳入统一折叠协议） |
| diff | DiffRenderer（保持，词级红绿已有） | +/- 语义色 |
| command | 命令名 accent + 输出 dim（多行 dim 块） | muted |
| notice | core 级入对话流（warn/error 着色）；rpc/transient 只入活动区不刷屏（联动 A-26） | level 语义色 |
| turn-summary | `◦ N 轮 · X tokens · $Y · Zs` 回合尾单行 | muted dim |
| session-event | `◈ 文本` 单行 | 类型语义色（由事件 type 映射，非正则） |

**语义色总表（单一事实源，进 spec）**：accent=动作/可交互；error=失败（仅结构化判定）；warn=需注意/被拒；muted=元信息/结果；ok 仅用于终态确认行。

#### 折叠统一协议
四类折叠（reasoning / tool-result 全文 / 长输出 / diff hunk）共用一套交互：`▸/▾ 标题 (计数)` + 展开限高（滚动）+ 点击或 Ctrl+O 切换；折叠默认规则进 spec（如工具结果 >3 行折叠为一行预览）。

#### 流式渲染分级
L1 直播文本（80ms 节流保留）+ `stream.retry` 清屏重画（继承 A-4 修复）；L2 工具活动行（进行中单行 spinner，完成转 tool-result）；L3 思考流（折叠标题实时 token 计数）。

#### 状态栏收敛
statusBar 962 行拆解：`segments 纯函数`（model | cost | session | budget | net | state 六段，数据全部来自结构化状态——余额 low/限流 reset/预算余量，分别联动 S-1 修复、P2-10、B-19）+ 单行渲染壳（≤150 行）。段落显隐按密度档。

#### 非交互输出（`-p`，一套事件流三档）
- `text`（默认）：ANSI 纯文本，语义同 TUI（⏺/⎿/折叠以缩进替代）；
- `--json`：单结果对象；
- `--output-format stream-json`：OutputEvent JSONL 流（对齐品类分类学）；
- 退出码语义化：0 成功 / 1 一般错误 / 42 输入错误 / 53 轮次上限（对齐 gemini，合并【V3 计划】P4-2 与 B-29 修复）。

#### 组件架构（目标形态）

```
src/wxnodus-ui/output/            ← 新增（L0 产物）
  spec.ts            OutputEvent 类型 + 形态映射纯函数（单一事实源，全可测）
  renderers/tui.ts   ink 渲染器（消费 spec 映射）
  renderers/ansi.ts  -p text 档渲染器
  renderers/json.ts  -p json/stream-json 档
components/messageLine.tsx        457 → ~150 行（壳化：仅分发 OutputEvent → 渲染器）
components/statusBar.tsx          962 → 壳 + segments 纯函数模块
components/todoPanel.tsx          删除（D5）
components/thinking.tsx           并入统一折叠协议（1242 → 收敛进 spec+渲染器）
```

组件行数预算（进 CI lint 规则）：单 UI 组件 ≤400 行，超限必须拆纯函数模块。

#### 渲染测试矩阵（补「接线层零测试」盲区——A-23 教训）
`OutputEvent.kind（10 类） × density（3 档） × 主题（明/暗）` 快照测试 = 60 格基线；行为断言（折叠交互/outcome 着色/流式重置）单测。矩阵先行，实现渐进迁移。

### 2.4 L0 实施卡（7 张，约 8-10 天）

| 卡 | 内容 | 量 | 依赖 |
|---|---|---|---|
| L0-1 | 输出规范 spec：OutputEvent 类型 + 形态/语义色/折叠协议定义 + spec 文档（版本化 v1） | 1 天 | — |
| L0-2 | **结构化 outcome 贯通**：管线终态/lastToolOutcome/usage → flowStore 结构化字段 → 渲染层；删除 messageLine 两处正则着色与事件三段正则 | 1-2 天 | 与 A-5 修复同批（同根因） |
| L0-3 | TUI 渲染器迁移：spec.ts + renderers/tui + messageLine 壳化 + 折叠统一 + turn-summary 行 | 2-3 天 | L0-1/2 |
| L0-4 | 状态栏 segments 化（962 行拆解） | 1-2 天 | L0-1 |
| L0-5 | `-p` 三档输出 + 语义化退出码（合并 P4-2/B-29） | 1-2 天 | L0-1 |
| L0-6 | 渲染快照矩阵（60 格）+ 行为单测 + 组件行数 lint 规则 | 1 天 | L0-3 |
| L0-7 | 组件清理：todoPanel 删、thinking 并入、dead code 扫除 | 1 天 | L0-3/6 |

与【V3 计划】的联动：L0-2 与波 0 的 A-5 同批修（一次改动两处受益）；L0-6 的快照矩阵为波 3 渲染架构收敛（P3-2 九格矩阵）提供基准分类学——**L0 先行立分类，P3-2 按此收敛写入策略**。

---

## 第 3 章 V4.0 工作流（L0-L4 + 裁撤/维护轨）

> 全部任务卡细节（锚点/方案/验收/回归面）见【V3 计划】第 5 章——本章只列 V4.0 视角的组织与增量。

### L0 输出体系重设计（龙头，§2.4 七卡，8-10 天）

### L1 止血 + 高频路径 + 裁撤（=【V3 计划】波 0 + 波 1 + 裁撤轨 D，约 2 周）
- 波 0 八卡原样执行（S-5 事务包裹 → S-4 view_image 边界 → S-1 预算代际 → S-2 bash 分级切分 → S-3 system-touch 真弹窗 → S-6 fs_edit 容错 → S-7 /gateway 认证 → A-3/4 重试语义双修）；其中 **A-5 失败判定确定化与 L0-2 合并执行**（同根因：结构化 outcome 贯通）。
- 波 1 十一卡（P1-5 已作废）：bash 中文三连（P1-1，含 git-bash 路由评估）、超时可调、HTTP body 中文、JSON 回喂自纠、PowerShell 探测税、路径归一化、hunk/BOM 保真、tool_search 装配、plugin install 二进制、doom_loop 防抖。
- 裁撤轨 D-1~D-4（离线对话/看图/无 key 层软着陆移除；A-15 随之作废）。
- V4.0 增量：**package.json version → 4.0.0-alpha.1**（L1 收口时）；AGENTS.md 重写为 V4.0 口径（战略约束四条 + 输出 spec 引用 + 裁撤声明）。

### L2 鲁棒性（=波 2 十二卡，1.5 周）
重连工程（P2-1：分类重试/connect 等网/上限+jitter/durable queue/全程可见信号）、idle watchdog、Anthropic 式压缩（真实 usage/提早触发/413 自动压/micro-compaction/保留前向计划）、审批 pending 多路化、error 事件作用域化（与 L0 notice scope 联动）、MCP lazy-respawn、中断回放工具结果、LSP 诊断回灌、/goal 假完成根治、429 状态面板（与 L0-4 状态栏段联动）、Ctrl+C 双语义、生命周期毛边一揽子。

### L3 架构收敛（=波 3 六卡，1.5 周，服务 L0）
渲染矩阵不变式与九格全测（以 L0 分类学为基准）、INLINE 坐标修复、事件流落盘分级+轮转、发布链闭环（安装器 package.json/Node 门槛/ABI/「装上能跑对」自校验）、数据一致性一揽子（含 SQLite ≥3.51.3）、系统提示开销审计（对齐 opencode 7k 档）。

### L4 对齐 + 用户权力（=波 4 七卡 + 波 5 四卡，2 周）
AGENTS.md 分层标准、会话 fork//export//import（kimi 实证的迁移增长手段）、vim 接线修复、模型切换缓存提示、B 级精选一揽子；`wxnodus update` 自升级（含 `--file` 气隙包）、用户产物迁移框架、只收不出收口、C 级清理批。

### 裁撤轨 D（并入 L1）与维护轨 M（贯穿）
M-1~M-6 照【V3 计划】（黑洞记忆/build/UIA/合规/ACP/语音——含 voice 死正则等 C 级随轨消化）。

---

## 第 4 章 里程碑路线图

| 里程碑 | 内容 | 出口判据 | 预估 |
|---|---|---|---|
| V4-M0 基线 | 本仓 `git init` + 首提交（迁移基线）；npm install/build/全量测试三绿；未提交 99 文件增强按主题分批入库 | 三绿 + `git log` 干净分层 | 1-2 天 |
| > **M0 执行记录（2026-08-21）**：git 基线已建（f75a7fa3 迁移基线 1396 文件 + docs-links 暂缓提交）；install/build/test 三绿（3153 通过/0 失败/12 skipped）；electron 夹具产物与 docs/superpowers 测试 fixture 已就位（前者本地复制，CI 用 build-fixtures.ps1 重建）；docs-links.test.ts 暂缓（三件套未随迁，待重写为 V4 文档契约）；**剩余：99 文件增强按主题分批入库**（当前已全部在基线提交内，拆分为主题提交可选）。 | | | |
| V4-M1 输出体系 | L0 全部 7 卡 | 60 格快照矩阵绿；TUI/-p 同源；全仓输出侧零正则猜测（grep 验证） | 8-10 天 |
| > **M1 执行记录（2026-08-21）**：L0 七卡全部落地——spec v1 单一事实源（OUTPUT_SPEC_VERSION=1 十类事件）/RenderBlock 中间表示/TUI 渲染器/六段状态栏（密度显隐）/-p 三档/60 格快照矩阵+输出侧 lint/组件清理。 | | | |
| V4-M2 止血+高频+裁撤 | L1 全部（波 0+波 1+D 轨）；version 4.0.0-alpha.1 | 红队/混沌用例绿；真实 cmd 中文电池全绿；裁撤面零 offline 引用 | 2 周 |
| > **M2 执行记录（2026-08-21）**：波 0 八卡+波 1 生效 11 卡+裁撤 D 轨（软着陆三件套）全部落地，version 4.0.0-alpha.1。 | | | |
| V4-M3 鲁棒性 | L2 全部 | 断网 10min 续跑；413 自动压缩；并发审批零挂起 | 1.5 周 |
| > **M3 执行记录（2026-08-21）**：波 2 十二卡全部落地（等待网络模式/idle watchdog 双档/413 强压重发/审批多路化等）。 | | | |
| V4-M4 架构收敛 | L3 全部 | 渲染九格矩阵绿；干净虚拟机装包冒烟绿；bench 不回退 | 1.5 周 |
| > **M4 执行记录（2026-08-21）**：波 3 生效六卡全部落地（渲染 18 格矩阵契约/注入开销守卫 6689 tokens/「装上能跑对」冒烟/L4 lint ratchet）。 | | | |
| V4-M5 对齐+权力 | L4 全部 | 升级/回退/迁移端到端；AGENTS.md 分层生效；doctor 全链路 | 2 周 |
| > **M5 执行记录（2026-08-21）**：波 4 七卡+波 5 四卡全部落地——AGENTS.md 分层（全局>子目录>仓库根 4 层+projectDocMaxBytes+@file 导入）/stream-json 退出码/doctor 全链路（14 项+CLI exit code）/会话互操作（export --md+竞品 JSONL 嗅探）/vim 接线修复（A-23 Esc 死代码根因+接线层集成测试）/模型切换缓存提示/B 级一揽子九项/wxnodus update 自升级（三原则）/产物迁移框架（清单+dry-run+原子+整体回滚）/只收不出收口（发布侧物理删除+bundle 版本指纹）/P5-4 清理批九项。version **4.0.0-rc.1**，3441 测试全绿+lint 绿。 | | | |
| 发布 | 4.0.0-rc（内测分发，复用 S-01 私有 release 通道）→ 4.0.0 | §5 全门禁 + 发布链自校验 | — |

**总计约 7-9 周**。并行：L0 与 L1 的波 0 可部分并行（不同文件面）；L3 与 L2 可并行；裁撤轨 D 在波 0 后立即启动。

---

## 第 5 章 验证与质量门禁

### 5.1 每卡：新增单测 → `npx tsc --noEmit` → 相关既有用例绿。
### 5.2 每里程碑：全量 `npx vitest run` → `npm run ci`（九命令）→ `npm run bench`（四基准 + M4 起新增注入量/探测开销/渲染帧基准）→ 手动电池之一。
### 5.3 真实场景电池（M2 起全跑，Windows 本机）
1. 中文路径电池：cmd + Windows Terminal × {启动/中文输入/GBK dir/git log/echo 中文/CRLF 编辑/单字检索}；
2. 长任务电池：npm install 全程、30+ 轮任务、/jobs 后台+取消；
3. 鲁棒电池（M3 起）：断网 60s 续跑、429 可见、并发审批、Ctrl+C 中断不退出；
4. 渲染电池（M1/M4）：{cmd, WT}×{alt-screen, INLINE}×{cozy,compact,dense} 滚动/resize/overlay/末列；
5. 升级电池（M5）：装旧版→造产物→升级→兼容断言→回退→可用断言。
### 5.4 专项：红队用例集（M2 建）、混沌崩溃注入集（M2 建）、输出快照矩阵（M1 建，60 格）、「装上能跑对」虚拟机冒烟（M4 起）。

---

## 第 6 章 风险登记册

| # | 风险 | 概率/影响 | 缓解 |
|---|---|---|---|
| V-R1 | L0 渲染层大改引发 TUI 回归（历史上渲染是事故多发区） | 中/高 | 快照矩阵先行 + 渐进迁移（OutputEvent 并行存在，逐 kind 切换，每步全量绿）；与 P3-2 九格矩阵互为基准 |
| V-R2 | 输出规范 v1 设计缺陷导致再次「全量替换」 | 中/中 | spec 版本化 + 变更走 spec diff 评审；60 格快照使任何格式变更显式化 |
| V-R3 | 新仓丢 git 历史致考古困难 | 低/中 | 旧仓保留档案（本计划头部声明）；新仓 M0 首提交注明源 commit（234de6b） |
| V-R4 | L1 期间 99 文件增强入库与止血修复冲突 | 高/中 | M0 严格分主题入库先行；波次修复基于入库后基线 |
| V-R5 | 裁撤反弹 / 误解「数据不出机」 | 中/中 | 软着陆三件套（警告期+逃生开关+指引）；文档明确「数据仍全本地，仅运行需网络」 |
| V-R6 | bash 主路径大改（P1-1）回归 | 中/高 | settings.bashEngine 逃生开关；双终端实测；全量 bash 用例 |
| V-R7 | 重试语义重构致风暴/白烧 | 中/高 | 上限+jitter；三类 mock 端到端；重试烧钱进 /cost（P2-1） |
| V-R8 | 产物迁移覆盖不全 | 低/极高 | 产物清单+dry-run+原子应用+回滚备份+老数据夹具（继承 P5-2 设计） |

---

## 第 7 章 新仓库工程规范（V4.0 起生效）

1. `git init` 新历史；分支模型：每 L 线一分支（`l0-output` / `l1-stability` / …），master 只收里程碑收口合并。
2. 版本：M1 收口 → `4.0.0-alpha.1`；M5 收口 → `4.0.0-rc.1`；发布 `4.0.0`。
3. AGENTS.md 于 M1 重写：战略四约束 + 输出 spec（v1）引用 + 裁撤声明 + 「文档仅 docs/ 两份计划 + 输出 spec」口径。
4. 文档纪律：本仓 docs/ 仅保留——`production-readiness-plan-2026-08-21.md`（缺陷底册）、`wxnodus-master-upgrade-plan-2026-08-21.md`（V3 任务卡详册）、`wxnodus-v4-plan-2026-08-21.md`（本文）、L0-1 产出的输出 spec；新文档须经战略约束校验。
5. 组件行数预算：单 UI 组件 ≤400 行（lint 强制，L0-6 落地）。
6. 输出侧禁令：渲染层禁止内容正则猜测状态（必须消费结构化 outcome）——lint 规则 + 快照矩阵守护。

---

## 第 8 章 任务总索引（V4.0 视角）

- **L0（7）**：L0-1 spec / L0-2 outcome 贯通（=A-5 同批）/ L0-3 TUI 渲染器 / L0-4 状态栏 / L0-5 -p 三档（=P4-2+B-29）/ L0-6 快照矩阵+lint / L0-7 组件清理
- **L1 = 波 0（8）+ 波 1 生效 11（P1-5 作废）+ 裁撤 D（4，A-15 作废）+ V4 增量（version/AGENTS.md）**
- **L2 = 波 2（12）**
- **L3 = 波 3 生效 6（P3-4 作废）**
- **L4 = 波 4（7）+ 波 5（4）**
- **维护轨 M（6）贯穿；C 级积压随波消化**
  - **M-1 执行记录（2026-08-21）**：黑洞记忆三件套闭环——curator 会话化 / imageHistory FTS 刷新（改走 updateMessage）/ absorbCount（即 /memory 概览 default 硬编码）均已修；审计同段附带两项同批修复（-p --json usage 会话对齐、ACP sessions LRU 界 64）。
- 合计生效任务卡 ≈ 95 + L0 新增 7 − 重复合并 2（A-5、P4-2）≈ **100 张**；全部细节锚点见【V3 计划】第 5 章。

---

*活文档：每里程碑收口在 §4 标记状态并回填偏差；新发现走【V3 计划】同格式入册后在此登记。*

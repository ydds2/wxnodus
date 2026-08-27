# WxNodus 输出规范 v1（Output Spec）

> **单一事实源**：`src/wxnodus-ui/output/spec.ts`（`OUTPUT_SPEC_VERSION = 1`）。
> 本文档是规范的书面形态；两者不一致时以 spec.ts 为准并当日修正文档。
> **变更纪律**：任何格式/语义变更必须递增 `OUTPUT_SPEC_VERSION`、更新本文档变更记录、同步快照矩阵（`tests/v4-output-spec-matrix.test.ts` 与 L0-6 渲染器矩阵）——禁止「全量替换式」打补丁（V3 输出体系七连改的教训）。
> 渲染侧禁令：**渲染层禁止内容正则猜测状态**（颜色/折叠/终态由结构化字段决定，lint 守护，L0-6 落地）。

## 1. 设计原则（五条）

1. **单一事实源**：输出形态由类型化事件（OutputEvent 十类）决定；渲染层 = 纯函数 `(OutputEvent, Density) → RenderBlock[]`，全可单测/快照测。
2. **结构化 outcome 贯通**：内核管线终态直达渲染层——工具成败/超时/被拒/缓存由 `ToolOutcome` 字段决定颜色，不由内容猜测。
3. **一套模型三后端**：TUI（ink 组件）/ ANSI 纯文本（`-p` 人读档）/ JSON（`-p --json`、stream-json）消费同一 `RenderBlock` 中间表示。
4. **规范先行、版本化变更**：本 spec 即规范；格式变更走版本号，快照矩阵显式化一切变化。
5. **密度三档**：`cozy / compact / dense`，所有形态在三档下有定义。

## 2. 事件分类学（OutputEvent 十类）

| kind | 字段 | 语义 |
|---|---|---|
| `user` | text, attachments? | 用户输入（含附件名列表） |
| `assistant` | text, streaming? | 模型回复（markdown 正文，渲染器解析；streaming=直播中） |
| `reasoning` | text, tokens, streaming? | 思考流（默认折叠） |
| `tool-start` | name, argsSummary | 工具动作开始（进行中） |
| `tool-result` | name, **outcome**, preview, tokens?, durationMs? | 工具结果；outcome ∈ ok/failed/denied/cached/timeout（结构化终态） |
| `diff` | file, body | 文件变更（渲染器走 DiffRenderer） |
| `command` | name, output, exitCode? | 命令执行输出（exitCode≠0 → error 色） |
| `notice` | level, **scope**, text | 系统通知；scope ∈ core/rpc/transient——**rpc/transient 不进对话流**（活动区分流，A-26 同源） |
| `turn-summary` | turns, tokens, costUsd, durationMs | 回合尾摘要行 |
| `session-event` | **type**, text | 会话时间线（切换/恢复/后台任务）；type 结构化映射颜色 |

## 3. 形态规范（glyph · 颜色 · 缩进）

| 事件 | glyph | 颜色 | 缩进 | 密度差异 |
|---|---|---|---|---|
| user | `❯ ` | muted | 0 | 三档同 |
| assistant | —（markdown） | text | 1 | 三档同 |
| tool-start | `⏺ ` | accent | 0 | streaming spinner 三档同 |
| tool-result | `⎿ ` | **按 outcome**（下表） | 1 | compact/dense 追加时长 `(1.2s)`；cozy 无时长（Claude Code 口径） |
| reasoning | `▸ ` 折叠 | muted（dense 加 dim） | 1 | dense=完全不可见仅 badge 行 |
| diff | —（DiffRenderer） | +/- 语义 | 1 | 词级红绿三档同 |
| command | — | muted dim（exitCode≠0 → error 不 dim） | 1 | 折叠阈值 cozy 5 行 / compact 2 / dense 1 |

> 状态栏六段（L0-4，`statusBarSegments.ts`）：cozy 全段（model·cost·session·budget·net·state）；
> compact 隐 budget 与 effort 徽标（**保留 net**——重连可见性优先于密度简化）；dense 仅 model·cost·state。
> cost 段水位着色：上下文 ≥85% error / ≥75% warn；balance 低余额红（结构化 low 标记）。
| notice | `· /⚠ /✖ ` | level 色 | 1 | scope≠core → 不产出块 |
| turn-summary | `◦ ` | muted dim | 1 | 三档同 |
| session-event | `◈ ` | type 映射 | 0 | 三档同 |

### ToolOutcome → 颜色/标记（结构化，零正则）

| outcome | 颜色 | dim | 标记 |
|---|---|---|---|
| ok | muted | ✓ | — |
| cached | muted | ✓ | `⟳ ` |
| denied | warn | — | `⊘ ` |
| timeout | warn | — | `⏱ ` |
| failed | error | — | —（红色即失败） |

### 语义色总表（单一事实源）

`accent`=动作/可交互 · `error`=失败（**仅结构化判定**）· `warn`=需注意/被拒 · `muted`=元信息/结果 · `ok`=终态确认 · `text`=正文。主题映射（明/暗）由渲染器经 ThemeColors 完成，spec 主题无关。

### session-event type → 颜色

`session.switched|restored|started` → accent；`job.completed|save.completed|restore.completed` → ok；`job.failed|session.error` → error；其余 → muted。

## 4. 折叠协议（统一交互）

四类折叠（reasoning / tool-result 全文 / command 长输出 / diff hunk）共用：
- 形态：`▸/▾ 标题 (计数)` 折叠标题行；展开限高（滚动）；点击或 Ctrl+O 切换。
- 规则（`collapsePolicy`）：reasoning 恒折叠；tool-result 预览 >3 行（cozy）/ >1 行（compact/dense）折叠，badge=N 行；command 输出 >5/2/1 行折叠。
- 折叠态显示首行预览（工具结果）/文件名（diff）。

## 5. 三后端约定

- **TUI**：RenderBlock → ink 组件（messageLine 壳化分发，L0-3）。
- **ANSI（-p text 档）**：RenderBlock → 缩进+语义色 ANSI 序列（折叠以缩进层级替代，L0-5）。
- **JSON（-p --json / stream-json）**：OutputEvent 直接序列化（分类学对齐品类：init/message/tool_use/tool_result/error/result，L0-5）。

## 6. 快照矩阵

- 规格层（本版）：`SPEC_MATRIX_KINDS(10) × SPEC_DENSITIES(3)` = 30 格（`tests/v4-output-spec-matrix.test.ts`）。
- 渲染器层（L0-6）：30 格 × 明/暗主题 = 60 格快照 + 行为断言（折叠交互/outcome 着色/流式重置）。

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| 1 | 2026-08-21 | V4 L0-1 初版：十类事件、形态/语义色/折叠协议、密度三档、三后端约定、30 格规格层矩阵 |

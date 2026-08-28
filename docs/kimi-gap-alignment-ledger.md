# kimi-cli 差距对齐台账（活文档）

> 起因：原差距清单随 `ee63a5b2`（UI 删除提交）一并丢失（kernel-eval-2026-08-27 §5 建议持久化）。本台账为唯一权威记录，对齐项落地时同步更新。
> 机制参考·实现原创：每项注明 kimi 锚点与本仓实现差异。

| # | 差距项 | kimi 锚点（语义） | 本仓落点 | 状态 |
|---|---|---|---|---|
| B | 后台通知回流（jobs 完成 → 主线注入） | `kimisoul.py:1135-1164` deliver_pending(limit=4)+Notification hook | `agent.ts` noticeQueue 回流 | ✅ 已合入（f88e3b10）；**通知 hook 事件仍未对齐**（见下） |
| C | 输出 token 钳制 | `kimisoul.py:1348-1387` max_completion_tokens=窗口−输入估算−余量 | `agent.ts:1285-1294` / `providers.ts:274-278` | ✅ 已合入 |
| D | 历史归一化（相邻 user 合并） | `dynamic_injection.py:58-84`（仅 user 合并+跳过通知消息） | `historyNormalize.ts`（user+user 与 system+system 合并——**本仓更宽**，不合并 tool 与带 tool_calls 的 assistant） | ✅ 已合入 |
| E | 工具去重 | `toolset.py:184-202,365-423` canonical 参数+同批合并 | `agent.ts` cacheable 声明式+回合缓存+批内 inflight | ✅ 已合入 + **C3 canonical 化补全（2026-08-27）** |
| — | 流式中途派发（on_tool_call） | 未取证（kimi soul 层为收集完整后执行模型） | `llmStream.ts` index-advanced + `agent.ts` earlyRuns（仅 cacheable 只读先行，fail-closed） | 🔶 批次2 未提交；**C2 标注传播已修（2026-08-27）** |
| — | 通知 hook 事件（Notification） | kimi hooks 引擎 Notification 事件 | **接线补齐（2026-08-27）**：hooks.ts 契约早已存在（HookRunner.notification）但 agent 从未调用（死接线同类）——noticeQueue 注入前触发 `hooks.notification('jobs', text)`，hook 异常不阻断注入 | ✅ 2026-08-27 |
| — | 旁路问答（/btw） | kimi `soul/btw.py:1-13`（保缓存/不入主上下文） | **已有实现（核对更正 2026-08-27）**：`handlersExt.ts:2111`——只读子代理隔离问答（隔离上下文不打断主对话）；机制形态与 kimi 不同（子代理隔离 vs 同提示单调用），用户价值等价——原差距评估「无等价」有误，已更正 | ✅ 已存在 |
| — | 参数 canonical 化（已并入 E） | `toolset.py:184-202` | `agent.ts` `canonicalToolArgs`（递归键序排序，数组顺序保持语义；环引用诚实回退） | ✅ 2026-08-27 |
| T1 | **TUI 思考折叠动画** | `visualize/_blocks.py:_ContentBlock`（`_compose_thinking`/`_bullet_frame_for`/`_estimate_tokens`）——Thinking 斜体 + 0.13s×6 点帧 + 耗时 + token 估算 + tok/s 心跳；收口落灰斜体 "Thought for Xs · N tokens" | `tui/theme.ts`（thinkBulletFrameAt/estimateTokens/formatElapsed/formatTokenCount）+ `ansiRenderer.renderThinkingLive/renderThoughtFinal` + `interactiveLoop.ts` 80ms 动画驱动 | ✅ 2026-08-28 |
| T2 | **TUI 生成流 Markdown 增量提交** | `_blocks.py:_ContentBlock._flush_committed`/`_find_committed_boundary`（markdown-it 顶层块边界：已确认块立即落盘、未确认尾部暂存） | `tui/markdownStreamer.ts`（行状态机：围栏闭合才提交/标题分隔线自闭合/段落空行收口/列表表格块结束收口——**不用 markdown-it，语义对齐**）+ `interactiveLoop.ts` Composing spinner 行（`renderComposingLive`） | ✅ 2026-08-28 |
| T3 | **工具行 "Using/Used + 关键参数"** | `_blocks.py:_ToolCallBlock._build_headline_text`（Used 蓝工具名 + extract_key_argument 单参数灰括号；结果 bullet 绿/dark_red） | `tui/keyArg.ts`（wxnodus 工具表自建 + 首个字符串值回退）+ `ansiRenderer.renderToolHeadline/renderToolOutcomeLine/renderCollapsedToolLine` | ✅ 2026-08-28 |
| T4 | **通知 severity 着色** | `_blocks.py:_NotificationBlock`（info 青/success 绿/warning 黄/error 红，标题加粗 + 灰正文 2 行预览） | `ansiRenderer.renderNotification`（severity 来自事件 level，无 level 默认 info——渲染器零猜测） | ✅ 2026-08-28 |
| T5 | **底栏（分隔线 + 模式(model ●/○) + cwd 分支徽标 + 轮换提示）** | `prompt.py:_render_bottom_toolbar`（30s 轮换 tip、窄终端 full→mid→bare 降级、`_get_git_branch` 分支徽标） | `ansiRenderer.renderToolbar`（CJK 宽度降级链同语义）+ `tui/gitStatus.ts`（**不 spawn git**：纯读 .git/HEAD→refs→packed-refs）+ `interactiveLoop.ts` 30s tip 轮换 | ✅ 2026-08-28 |
| T6 | **暗/亮主题集中令牌** | `ui/theme.py`（ThemeName 集中色板 + get_*_style 按主题解析） | `tui/theme.ts`（themeTokens(dark/light) 纯函数令牌——无全局可变状态；RenderOpts.theme 线程贯穿） | ✅ 2026-08-28 |
| T7 | **Ctrl+C 中断当前回合** | kimi prompt_toolkit 键盘事件（Esc/Ctrl+C 语义） | `interactiveLoop.ts` SIGINT → `handle.cancel()`（与 --wire 同链路）+ warn 通知行；非 TTY 不挂 handler | ✅ 2026-08-28 |
| — | reasoning 事件死接线 | kimi wire 思考流事件语义 | **修复（2026-08-28）**：agent 发 `reasoning.delta` 而 TUI 订阅 `agent.reasoning.delta`——折叠思考行静默永不触发（死接线同类，C1 模式再现）；已改正确订阅 + 测试锁定 | ✅ 2026-08-28 |

| T8 | **工具编辑 diff 红绿渲染** | `_blocks.py:_EditBlock`（编辑回显 +/- 着色） | `ansiRenderer.renderDiffPreview/hasUnifiedDiff` + `interactiveLoop` complete 分支消费 + **内核 complete 事件新增有界 preview（600 字）**——事件原无输出文本，TUI 无从取数（2026-08-28 ZCode 补缺） | ✅ 2026-08-28 |
| T9 | **底栏会话 token 段** | `prompt.py` 用量展示（`format_token_count` 语义） | `renderToolbar` sessionTokens dim 段（参与降级链：tip 先让位、token 随后、bare 档让净）+ `interactiveLoop` 每回合收口累计 | ✅ 2026-08-28 |

| T10 | **词级 diff 高亮** | aider/opencode 行内词差（editblock perfect_or_whitespace / detectLineEnding 语义家族） | `ansiRenderer.splitCommon/styleInlinePair`——字符级公共前后缀剥离、配对中段加粗（连续删行/增行按位配对、孤立行保持整行着色；实现原创无分词依赖） | ✅ 2026-08-28 |
| T11 | **Tab 斜杠命令补全** | kimi 命令补全（prompt_toolkit completer 语义） | `interactiveLoop.slashCompleter`（readline completer 契约：唯一命中补全附空格、多命中列显；候选源 = registry SLASH 单一事实源） | ✅ 2026-08-28 |
| T12 | **反斜杠续行多行输入** | kimi 多行输入（尾部续行符语义） | `interactiveLoop` isContinuation（尾部单反斜杠入缓冲、… 提示符、偶数反斜杠字面量豁免、无续行符收口合并提交） | ✅ 2026-08-28 |

## 已修复缺陷链（同日）

- **C1**（kernel-eval 3-1）：`agent.ts:676` 与 `permissions.ts:302` 双层 `require()` 死接线——sandboxFastPath 静默永不生效；且 vitest 注入 require 垫片使绿测试掩盖生产死接线（已取证：Node ESM `typeof require === undefined`）。修复：惰性 `await import` + 静态导入；agent 级接线测试（manual 模式判别器）。
- **C2**（kernel-eval 3-2）：提前执行标注随缓存传播——修复：缓存入库裸结果，标注仅本轮回填。
- **C3**（kernel-eval 3-5）：缓存 key 键序敏感——修复：三消费点共用 canonical 形态。
- **P1-4 附带**：`applyRules` 判定裁决精化——原注释宣称「deny>allow>ask」但排序只比 priority（同 priority 下 deny 被 allow 抢跑）；精化为 **priority → 具体度（有 pattern 先）→ decision（deny>ask>allow）**，B-06「收编兜底 deny 不遮蔽具体 allow」语义保持（kernel-exec-policy 回归锁定）；跨层 deny 不可放宽改由合并层信任序加权实现（global +2000 / user +1000 / project +0）。
- **TUI-1**（2026-08-28）：`reasoning.delta` 死接线——修复 + 回归测试（见 T 表末行）。

## TUI 风格化实现差异（2026-08-28，诚实记录）

> 用户指定「kimi code UI 风格」——机制与语义对齐、实现原创；差异如实列出：
> 1. **行式投影 vs Live 重绘引擎**：wxnodus 薄层 TUI 无替代屏/rich Live 引擎（V4 决策「绝不引 Ink/巨件」）——动画载体为单行 `\r\x1b[2K` 重绘（80ms 驱动），思考/生成行二选一占位，内容块落盘后不再回改；
> 2. **Markdown 增量提交**：kimi 用 markdown-it 顶层块标记映射定边界；本仓用行状态机（零新依赖）——语义对齐（只提交完整块），边界判定略粗（列表/表格以块结束收口，不做行内结构）；
> 3. **CJK 列宽**：kimi 依赖 rich/wcwidth；本仓自实现宽字符表（Wide/Fullwidth/emoji/组合标记）——覆盖主用区间，极生僻平面外字符按 1 列（文档标注）；
> 4. **git 分支徽标**：kimi 用 pygit spawn 子进程；本仓纯读 `.git` 文件（HEAD→refs→packed-refs 回退），无子进程、无网络——分支脏/领先落后状态不做（无 git 进程时不可得，诚实省略）；
> 5. **成本/真实 token 数**：kimi 状态行含真实 usage；本仓事件面暂无每回合 usage 字段——摘要行 token 为估算（estimateTokens）并沿用 `◦ N 轮 · X tokens` 格式（不虚报真实计费数）；
> 6. **非 TTY 诚实降级**：管道/测试环境零动画、零底栏、Markdown 原样直出（零 ANSI 乱码——渲染器 colors=false 全链路）。

## 更新纪律

对齐项合入必须：①更新本表状态列 ②注明 kimi 锚点复核状态（✅ 亲验 / ⚠️ 未复核）③本仓落点 file:line。本台账随仓库提交，禁止仅存在于提交信息与注释中。

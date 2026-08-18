# 多维升级方案（2026-08-19）

> 制定依据：四路专案代理对六家竞品**本地源码克隆**（`Desktop\cli-compare\{codex,gemini-cli,opencode,kimi-cli,crush,aider}`）的逐文件取证，全部结论附 file:line 锚点。
> 评分纪律：每档仅在**实现 + 测试 + 真实证据**齐备后复算（同 supremacy 计划口径，绝不预支分数）。
> 当前基线：843（第 2/7，距 codex 869 差 26）；①④⑥⑦=10 已满格。

## 0. 目标与路径

| 波 | 维度档位 | 增量 | 总分 | 里程碑 |
|---|---|---|---|---|
| 波 1 小步快跑 | ③5→6 ②6→7 ⑩9→10 ⑤9→10 | +8+9+7+11=**+35** | **878** | **反超 codex（869）——不依赖公开决策** |
| 波 2 核心体验 | ②7→8 ③6→7 ⑪8→9 | +9+8+5=**+22** | **900** | 编辑器/diff 追平头部体验 |
| 波 3 专家档 | ②8→9 ③7→8 ⑪9→10 | +9+8+5=**+22** | **922** | 独占点成型（per-hunk 应用/本地语义检索） |
| 阻塞项 | ⑧ 5→9 | +36 | — | 卡公开决策（用户暂缓：第三方接收已落地） |

## 1. 波 1「小步快跑」→ 878（四任务，约 2-3 天，全部小-中工作量）

### 1.1 ③ 5→6：diff 回显组件 + 图片模型输入（+8）
- **对标取证**：六家全有工具调用 diff 语法高亮回显；六家全有「图片作为模型输入」。wxnodus 两缺。
- **抄谁**：gemini-cli `packages/cli/src/ui/components/messages/DiffRenderer.tsx:224-399`（行号 gutter + +/- 色块 + 逐行语高 + gap 双线分隔——与 wxnodus 同 ink+TS 栈，移植成本最低）；kimi-cli `src/kimi_cli/tools/file/read_media.py`（data URL 图片输入，最简）；codex `core/src/tools/handlers/view_image.rs`（转录 "Viewed Image" 条目，`history_cell/patches.rs:60-73`）。
- **改动**：① 新增 `src/wxnodus-ui/components/diffRenderer.tsx`（fs_edit/apply_patch 结果内联渲染）并接入 messageLine；新文件全量语高、超大 diff 截断（codex `diff_render.rs:591-598` 保护）。② 新增图片输入工具（`view_image`：data URL + 尺寸，模型输入通道）——注意 400 防御与 toolTrim 已具备，接白名单。
- **验收**：6 单测（解析/渲染/超大截断/图片工具）；本机真实调用一次图片工具（视觉模型回显）。
- **工作量**：小。

### 1.2 ② 6→7：外部编辑器 + Ctrl-R 反向搜索 + 输入区 token 高亮（+9）
- **对标取证**：外部编辑器集成 **6/6 全有**（wxnodus 唯一缺失的「全票基础题」）；Ctrl-R 反向搜索 codex/gemini 有；输入内 token 高亮 gemini/aider/opencode 有。
- **抄谁**：crush `internal/ui/model/ui.go:3688-3725`（外部编辑器最简——temp 文件 + 光标行列传递）；kimi `src/kimi_cli/utils/editor.py:18-50`（$VISUAL→$EDITOR→code --wait 自动探测链）；codex `tui/src/bottom_pane/chat_composer/history_search.rs:55-134`（草稿快照 + 实时匹配高亮 + Esc 还原）；gemini `packages/cli/src/ui/utils/highlight.ts:29-57`（@/斜杠/占位符三类 token 正则 + LRU——同栈直译）。
- **改动**：① textInput 加 Ctrl+O 外部编辑器（挂起→$EDITOR 临时 .md→回读替换，Esc 保留草稿）；② historySearch 加 Ctrl-R 反向模式（会话态 + footer 提示）；③ textInput 渲染层 token 着色。
- **验收**：8 单测（编辑器往返/探测链/搜索还原/高亮 token）；TUI 手动冒烟。
- **工作量**：小。

### 1.3 ⑩ 9→10：cache 断点放置 + 缓存费率归集 + 摘要独立请求（+7）
- **对标取证**：crush `internal/agent/agent.go:839-855,1480-1497`（system + 末尾 2 条消息打 ephemeral cache 断点、三 provider 同构）；aider `aider/coders/base_coder.py:2077-2096`（cache_write×1.25 / cache_hit×0.10 计入费用）；gemini `chatCompressionService.ts:361-379` 与 kimi `compaction.py:126-131`（**摘要走独立 utility 请求，不污染主对话前缀**——最值钱一项）。
- **改动**：① buildChatRequest：DeepSeek 系自动前缀缓存靠字节稳定（规范排序已有）——补「system 首消息 + 尾部断点」标注（若 provider 支持 cache_control）与消息字段固定序；② `cost.ts`：cacheHit 按 cacheRead 价、cacheWrite 按 1.25× 输入价归集，usage_stats 展示「缓存省了多少」；③ `memory.ts` summarize 改为独立单轮请求（只把结果写回主对话）——保住主前缀缓存。
- **验收**：4 单测（断点位置/费率公式/独立请求不污染主历史）；成本面板缓存行实测。
- **工作量**：低-中。

### 1.4 ⑤ 9→10：压缩快照结构化 + 反注入段 + 失败护栏（+11）
- **对标取证**：gemini `prompts/snippets.ts:899-963`（7 块 `<state_snapshot>`：overall_goal/active_constraints/key_knowledge/artifact_trail/file_system_state/recent_actions/task_state + **CRITICAL SECURITY RULE 反注入段**）；kimi `prompts/compact.md:15-22`（错误全留、<20 行代码全留、优先级排序）；gemini `chatCompressionService.ts:287-321`（**摘要失败一次→纯截断，不再烧 LLM**）。
- **改动**：① `memory.ts` summarize 换结构化 XML prompt（7 块 + 反注入 + kimi 保留规则）；② 快照合并锚定指令（gemini :353-359）；③ per-session 摘要失败标记 → 后续压缩直接截断降级。
- **验收**：6 单测（模板块完整性/反注入段存在/合并指令/失败护栏/保留规则）；压缩产物快照人工抽查。
- **工作量**：低-中。

## 2. 波 2「核心体验」→ 900（三任务，约 1-2 周，中工作量）

### 2.1 ② 7→8：@文件补全弹窗 + slash 输入内补全（+9）
- **对标取证**：**6/6 全有** @补全（wxnodus 只有提交前展开，无 UI 补全）。
- **抄谁**：gemini `packages/cli/src/ui/hooks/useAtCompletion.ts:19-206`（同栈骨架）+ crush `internal/ui/completions/completions.go:205-260`（basename 精确>前缀>路径段 分层排序）+ opencode `autocomplete.tsx:29-58`（`#L1-L5` 行区间）+ `prompt/frecency.tsx:10-42`（frecency 排序）；kimi `prompt.py:1276-1290`（enter 双语义：slash 接受即提交）。
- **改动**：textInput token 前缀检测 + 弹窗（@文件/agent 双源、模糊排序、行区间）；与 `kernel/mentions.ts` 展开链路打通；slash 补全复用 commandPalette 数据。
- **验收**：10 单测（排序分层/行区间/enter 双语义/frecency 权重）。
- **工作量**：中。

### 2.2 ③ 6→7：词级 inline diff + hunk 跳转（+8）
- **对标取证**：词级 diff 为 **kimi 六家独有**（`diff_render.py:184-218` SequenceMatcher 配对 + ratio<0.5 跳过 + tab 偏移映射）；hunk 跳转为 opencode 独有（`diff-viewer.tsx:282-315`）。
- **抄谁**：kimi 算法直译 TS；opencode 跳转（结构化 diff 解析的扩展，复用 1.1 组件）。
- **改动**：diffRenderer 升级词级红绿；pager 键位加 `[`/`]` hunk 跳转 + 底部快捷键提示。
- **验收**：6 单测（词级配对/阈值跳过/跳转边界）。
- **工作量**：中。

### 2.3 ⑪ 8→9：离线「缺模型即拉取」+ 记忆审阅撤销层（+5）
- **对标取证**：codex `codex-rs/ollama/src/lib.rs:22-34`（ensure_oss_ready→缺则 pull_with_reporter 进度）；gemini `memoryService.ts` + `memoryPatchUtils.ts:984-1013`（.inbox 人工批准 / .patch / apply-discard）。
- **改动**：① `offlineModel.ts` downloadOfflineModel 加进度事件/自动就绪（零门槛离线）；② 黑洞记忆加「inbox 审阅 + apply/discard + 按记录撤销」命令面（可审可退，堵「不可控记忆」评审攻击）。
- **验收**：6 单测（拉取进度状态机/inbox 批准流/撤销）；文档补「记忆可审可退」宣称。
- **工作量**：小-中。

## 3. 波 3「专家档」→ 922（三任务，大工作量，按需启动）

### 3.1 ② 8→9：vim 模态编辑
- **抄谁**：gemini `packages/cli/src/ui/hooks/vim.ts`（1536 行：计数前缀、d/c/y+移动、f/F/t/T、r、~、`.`、dd/cc）+ `components/shared/vim-buffer-actions.ts`（1849 行）——**与 wxnodus 同 ink+TS 栈，对照移植**；codex `textarea/vim.rs:229-298`（括号栈最内层文本对象算法）。
- **验收**：20+ 单测（操作符/文本对象/计数/寄存器）+ 手动冒烟。
- **诚实口径**：只宣称「真 vim 模态（非伪 vim）」，与 codex 同档。

### 3.2 ③ 7→8：完整 diff viewer（或 per-hunk 应用）
- **抄谁**：opencode `diff-viewer.tsx`（文件树 + split/unified 切换 + 三源（工作区/主分支/上一轮）+ 单 patch 模式 + reviewed 标记）。
- **差异化候选（六家皆无）**：per-hunk 接受/拒绝——按 hunk 拆解应用 + 基于 undoShadows/checkpoint 逐 hunk 回滚；风险高于纯渲染层（动文件写入路径）。

### 3.3 ⑪ 9→10：ACP/插件 SDK 接收面 + 本地跨会话语义检索
- **抄谁**：kimi `src/kimi_cli/acp/server.py`（ACP 服务端——「被 IDE 接收」）+ opencode `packages/opencode/src/plugin/install.ts`（jsonc 配置注入零摩擦）+ codex `sdk/`（语言 SDK）。
- **独占点**：**本地跨会话语义检索——六家无一在本地做向量语义召回**（gemini 只产出 patch 文件；codex 记忆在服务端）。wxnodus 已有 embedding + memory search 基建，做成跨会话语义召回即六家独有。

## 4. 诚实口径与规则

1. **⑪ 论据修正（取证强制）**：旧口径「黑洞记忆六家唯一」❌（gemini Auto Memory 同赛道）；「Windows 沙盒六家唯一」❌（codex windows-sandbox-rs 更深）。**新论据 = UIA 桌面自动化（六家唯一）+ 离线四模态组合（六家唯一）**。score/register 同步改口。
2. **复算纪律**：每档任务完成 = 代码 + 测试 + 真实运行证据（截图/实测输出）三件齐备，才在 score §0.1/§9.x 复算；失败留档 register。
3. **不破坏红线**：离线四模态、合规链路、提权沙盒是护城河——任何改动不得退化；波 1 的 1.3/1.4 动压缩与成本路径，回归锚点 = 现有 14 成本用例 + 压缩相关用例全绿。
4. **阻塞项**：⑧ 5→9（+36）仍卡「公开决策」（用户已暂缓）——本方案不依赖它即可反超 codex。

## 5. 验证总门禁（每任务同款）

`npx tsc --noEmit` → 任务单测 → 全量 `npx vitest run`（含 known-failures gate）→ `npm run ci`（本地九命令）→ 远程 CI 绿 → 复算入档（score/register/audit/CHANGELOG）。

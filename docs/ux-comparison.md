# wxnodus CLI 与同类 CLI Agent 全方位 UX 对比报告

> 生成：2026-08-17 · 对比对象：Claude Code v2.1.x、OpenAI Codex CLI v0.147（Rust alpha 并行）、aider、Gemini CLI（已停更，被闭源 Antigravity 取代，仅作冻结参照）、OpenCode/Crush。
> 证据口径：竞品侧 = 2026-08 联网调研（官方文档/GitHub releases/HN 用户实证，未能直连的标 (R)）；wxnodus 侧 = 本仓库代码审计 + 验收电池脚本内的**实测陷阱注释**（这些注释是真实 UX 缺陷的记录）+ 本轮实测数据（启动/电池/闭环电池）。
> 方法：不列营销话术，只列「用户坐在终端前能感受到的东西」；wxnodus 自身问题不粉饰。

---

## 1. 竞品 UX 基准事实（2026-08 调研提炼）

### 1.1 交互语言已收敛为行业标配
- **斜杠命令 + 模糊补全**：Claude Code `/` 菜单模糊补全；Codex 命令/路径补全；Gemini `/commands list|reload`；aider 是唯一坚持行 REPL 的特例。
- **文件提及语法**：Claude Code `#` 文件引用 / `@` 目录引用；Gemini `@file.md`；OpenCode `@` 模糊搜文件。Tab 路径补全是各家共同兜底。
- **历史与多行**：aider Ctrl-R 搜历史；Claude Code `\`+Enter 多行；各家 Up/Down 历史为标配。

### 1.2 审批与模式是 2025-2026 的分水岭
- **Shift+Tab 循环审批模式**：Claude Code（default→acceptEdits→plan→bypass）与 Gemini（Default→Auto-Edit→Plan）双家同键位——已成为事实标准。
- **Plan 模式**：五家全有（aider 是 /architect+ask 模式）。Gemini 的 plan-mode.md 是最完整规格：只读工具集 + 写 .md 计划 + 停等确认 + Ctrl+X 打开编辑 + Esc 取消。
- **审批提示三选**：once/always/reject 各家一致（Codex 另有「写回规则文件」）。

### 1.3 回滚/时间旅行人人都有
- Claude Code **Esc-Esc → 回退到上一检查点**（检查点在每次改动前自动保存，代码回滚与上下文回退联动）+ `/rewind` 列检查点。
- Gemini `/rewind`（跨压缩点）；Codex rollouts/checkpoint；aider `/undo`（git 原生，每次改动自动 commit）；OpenCode `/undo /redo`。

### 1.4 上下文可见性
- Gemini：**页脚显示已加载上下文文件数** + GEMINI.md 层级按目录 JIT 加载 + Auto Memory（≥10 条消息后挖掘记忆补丁，需人工批准）。
- Claude Code：`/context` 列已加载文件、`/memory` 编辑记忆；HN 用户持续抱怨其「会话间无记忆」。
- aider：repo map 自动构建 + `/map` 可视化 + `/tokens`。

### 1.5 错误与恢复
- Claude Code：限流/过载错误内联显示 + 重试建议；上下文溢出靠自动压缩 + `/compact`；**无自动降级模型**（HN 抱怨）。
- Gemini：HN 报告「无限循环」「跑圈耗尽 5h 额度」——循环失控是行业通病。

### 1.6 用户抱怨清单（HN，标注日期）
- Claude Code：「会话间无记忆」(2025-12)、上下文窗口很快满 (2025-08)、Pro 套餐会话限额焦虑 (2026-04)、权限提示疲劳、交互式脚手架（npm create vite）卡死。
- Gemini：启动极慢（vs Claude 秒开）、强制迁移 Antigravity 引发不满（2026-05/07）。
- Codex：审批摩擦「每次改动都要批准等于毁了这工具」、订阅额度重置引发愤怒。
- aider：自动 commit 噪音、无原生检查点 UI、Windows 安装摩擦。

### 1.7 Windows 生态空位
四家主流 **无一 Windows 原生**（Claude Code 在 release notes 里修 Windows 审批 bug v2.1.233；aider 靠 Git Bash）。跨平台 TUI 里 Crush（Go/Bubble Tea）是最接近者。**Windows 原生 TUI 是明确空位**。

---

## 2. wxnodus 实测 UX 盘点（证据：本仓库代码 + 电池陷阱注释 + 实测）

### 2.1 客观性能（本轮实测）
| 指标 | wxnodus 实测 | 参照 |
|---|---|---|
| UI 首帧 | **0.04s** | Claude「秒开」（HN） |
| 会话就绪（锻造完成） | **1.8-2.1s** | Gemini「极慢」（HN） |
| 启动后到可打字 | ≈2s | aider 纯 REPL 近似 |
| 时钟自驱重绘（活性） | winpty 1/s · ConPTY 1/s | — |

### 2.2 输入与建议
- `/` 建议面板：前缀精确 + 子序列模糊（`lib/suggest.ts`）、窗口 16 行 + PgUp/PgDn 翻页、命令描述 meta、32 条上限。
- Tab 路径补全：`complete.path` RPC（目录扫描）。
- Up/Down 历史循环 + 队列循环；多行输入（inputBuf）；Ctrl+L 重绘；Ctrl+G 打开编辑器；Ctrl+D 退出；复制快捷键（选区/消息/输入框三级）。
- ⚠️ **已知缺陷（电池陷阱实测）**：
  1. 补全 RPC 往返窗口内击键被吞（cmd-verify 以 200ms/字符慢速输入规避——真实打字速度下偶发丢字）。
  2. 补全面板打开时 Enter = 接受补全项（电池用「命令末尾加空格关面板」规避——用户想提交原文时会误提交模糊匹配项）。
  3. Esc 关闭 overlay 后约 1.5s 输入恢复窗口，首批击键失效。
  4. CJK 高速键入在 winpty/ConPTY 均有丢字竞态（IME 真机通道已验证无此问题；pty 直输路径仍存在）。

### 2.3 流式与渲染
- 逐 token 流式（agent.token→message.delta）；思考分片 reasoning.delta 实时面板；工具执行实时清单（turnTodos）+ 状态行动词（busy 态 spinner + elapsed）。
- Markdown + 代码块渲染、行级差分、DECSTBM 滚动。
- ⚠️ 无 diff 语法高亮（红绿 +/-）——文件编辑回显为文本块（对比 Claude Code/aider 的 diff 高亮）。

### 2.4 反馈与控制
- 中断：busy 态 **双 Esc 确认中断**（1.5s 窗口 + 「再按 Esc 确认」提示）。
- **本轮已修**：空闲态 Ctrl+C 此前直接 `die()` 杀掉整个会话（pty 下曾出现渲染永久停摆）——已改为无操作 + 一行提示（Ctrl+D / /quit 退出）。
- 回滚：`/rewind` 快照回滚 + **每回合自动 checkpoint**（保留 10 个）。
- 审批：面板三选（allow/session/deny）+ 会话缓存 + **审批回显凭据脱敏**（redactSecrets + 通知提示）。
- ⚠️ 语义分歧：Claude/Gemini 的 Esc-Esc = 回滚到检查点；wxnodus 的 Esc-Esc = 中断确认——老用户跨工具迁移会触发错误预期。

### 2.5 错误与恢复（本轮修复后）
- 早退路径统一发 agent.message + agent.end——错误文本真正可见（此前静默）。
- 轮次耗尽 → 无工具强制总结收敛；总结失败 → 显式失败文案（绝不静默空输出）。
- 模型 429/5xx 自动降级链；4xx 不重试立即反馈。
- 上下文 75% 水位预警 + 85% 自动压缩（通知 + 压缩摘要归档）。

### 2.6 引导与发现性
- 首启：语言选择（stdio 纯文本二选一，WXNODUS_LANG 可跳过）；无 key → 规则脑即时回复 + `/key set` 引导。
- /help 分页面板（108 命令全量 + 分类 + 描述）；/status、/doctor。
- ⚠️ 无 `#`/`@` 文件提及语法（Tab 路径补全兜底——但「先 @ 文件再提问」的会话前注入习惯不可用）。
- ⚠️ 无 Shift+Tab 模式循环（模式切换需 /perm 命令）。
- ⚠️ 无 Ctrl+R 历史搜索（仅 Up/Down 线性循环）。

### 2.7 上下文可见性
- 状态栏：模型名 / 上下文百分比 ⚡ + 渐变条 / 会话数 / elapsed。
- `/context` token 分布；仓库地图（repo_map）首轮自动注入 + /map。
- AGENTS.md 32KiB 注入（/init 生成）；黑洞引擎三层记忆 + curator 策展（**会话间记忆——Claude Code 的 HN 头号抱怨点，wxnodus 是结构性解决**）。

---

## 3. 逐维度 UX 对比矩阵

| UX 维度 | Claude Code | Codex | aider | Gemini(停更) | **wxnodus** |
|---|---|---|---|---|---|
| 启动 | 秒开 | 中 | 快（REPL） | 慢（HN） | **0.04s 首帧/1.8s 就绪 ✅** |
| 斜杠补全 | ✅ 模糊 | ✅ | ✅ 行内 | ✅ | ✅ 模糊+翻页+描述 |
| 路径/文件提及 | #@ 语法 | ✅ | /add | @file | ⚠️ 仅 Tab 补全 |
| 历史 | Up/Down+Ctrl-R | ✅ | **Ctrl-R 搜索** | ✅ | ⚠️ 仅 Up/Down |
| 多行输入 | \ 换行 | ✅ | {} / Meta-Enter | ✅ | ✅ inputBuf |
| 模式循环键 | **Shift+Tab** | 配置 | 模式命令 | **Shift+Tab** | ⚠️ /perm 命令 |
| Plan 模式 | ✅ | review | architect | ✅ 最完整 | ✅ plan 模式 |
| 中断 | Esc | ✅ | Ctrl-C | Esc | 双 Esc 确认 |
| 空闲 Ctrl+C | 无害 | 无害 | 退出 | — | **已修（无害+提示）✅** |
| 回滚 | Esc-Esc /rewind | ✅ | /undo(git) | /rewind | /rewind+自动快照 ✅ |
| 工具步骤可视化 | 缩进块+spinner | ✅ | 文本 | ✅ | Todo 面板+动词 ✅ |
| diff 高亮 | ✅ | ✅ | ✅ | ✅ | ⚠️ 无 |
| 错误可见性 | 内联+建议 | ✅ | 文本 | 内联 | **本轮修复后可见 ✅** |
| 循环失控防护 | max-turns | ✅ | — | ❌（HN 循环抱怨） | 循环检测+缓存+强制收敛 ✅ |
| 会话间记忆 | ❌（HN 头号抱怨） | memories | ❌ | AutoMemory(实验) | **黑洞引擎+curator ✅** |
| 上下文可见性 | /context | get_context | /tokens | **页脚文件数** | ⚡% + /context |
| 审批三选 | ✅ | ✅+写回规则 | git 兜底 | ✅ | ✅+脱敏+缓存 |
| 成本显示 | /cost | 订阅 | /tokens | 5h 额度 | ⚠️ /usage（无 /cost 累计） |
| Windows 原生 | ❌ 修 bug 中 | ❌ | ❌ | ❌ | **✅ 独有** |
| 本地/离线 | ❌ | ollama | ❌ | ❌ | **✅ 数据不出机** |

---

## 4. wxnodus UX 缺陷清单（按用户可感严重度排序）

| # | 缺陷 | 证据 | 状态 |
|---|---|---|---|
| 1 | 回合静默空输出（35 工具调用后无结果） | 用户真机复现 | ✅ 已修（finishEarly + 轮次耗尽强制收敛 + 闭环电池） |
| 2 | 空闲 Ctrl+C 误杀整个会话/pty 渲染停摆 | 电池陷阱 + 代码审计 | ✅ 已修（无操作 + 提示） |
| 2b | **演示插件工具对模型可见**：/plugin new 脚手架 example_greet 被廉价模型在「hello」时选中 → 审批面板阻塞会话（真实 cmd 实测 13.9） | 真实 cmd 取证 | ✅ 已修（demo 标记/example_ 前缀过滤 + 逃生门） |
| 3 | 补全 RPC 往返窗口内击键被吞（快打丢字） | cmd-verify 陷阱（200ms/字符规避） | ⏳ 未修（需专门复现定位竞态） |
| 4 | Esc 关闭 overlay 后 1.5s 输入恢复窗口失效 | full-scene 陷阱 5 | ⏳ 未修 |
| 5 | CJK 高速键入丢字竞态（pty 直输） | full-scene 陷阱 4 | ⏳ 未修（IME 真机通道已验证无损） |
| 6 | 补全面板 Enter 误提交模糊匹配项 | full-scene 陷阱 2 | ⏳ 未修（可改为「未手动选择则提交原文」） |
| 7 | 无 diff 语法高亮 | 代码审计 | ✅ 已修（diff 段逐行着色：add 绿/del 红/hunk 青/meta 灰；超长降级合并） |
| 8 | 无 #/@ 文件提及语法 | 竞品标配对照 | ✅ 已修（@path 提及：Tab 补全 + 提交时展开文件内容；缺失/二进制诚实通知；散文 @词零触发） |
| 9 | 无 Shift+Tab 模式循环 / Ctrl+R 历史搜索 | 竞品对照 | ⏳ 差距 |
| 10 | Esc-Esc 语义与 Claude/Gemini 相反（中断确认 vs 回滚） | 竞品对照 | ⏳ 差距（迁移用户预期冲突） |
| 11 | 无 /cost 会话成本累计 | 竞品对照 | ✅ 部分覆盖（状态栏 📊 token 区间 today/7d/30d + 💰 余额实时监控；会话级 $ 成本仍缺） |
| 12 | 首启语言选择阻塞 TUI（纯 stdio 文本） | 代码审计 | ⚠️ 可接受（有 WXNODUS_LANG 逃生门） |

---

## 5. 结论

- **结构性优势（同代无替代）**：Windows 原生零依赖渲染器（0.04s 首帧）、数据不出机 + 本地向量记忆（Claude Code 的 HN 头号抱怨点在此是已解决状态）、回合闭环可靠性（本轮修复后：循环检测 + 读缓存 + 强制收敛 + 错误必达 UI——Gemini 的「无限循环」通病在此有系统级防护）。
- **追平项**：启动性能、斜杠建议、流式渲染、审批 UX（含脱敏）、回滚、plan 模式——均达同类水平或更优。
- **必须追的 UX 债（按序）**：#3 丢字竞态（输入手感是 CLI 的命根）→ #7 diff 高亮（写代码类任务的可信感）→ #8/@ 提及（会话前注入习惯）→ #9 键位（Shift+Tab/Ctrl-R 零成本对齐）→ #10 Esc-Esc 语义（可加「检查点回滚」双 Esc 绑定或改名）。
- **诚实边界**：答案质量受模型档位约束（glm-4-flash 免费档 vs Claude Sonnet/Opus 不在一个量级）——这是供给问题，不是 UX 代码问题。

---

## 6. 本轮已实施修复

1. **空闲 Ctrl+C**：`useKeyBindings.ts`——busy 中断 / 有文本清行 / 空输入 → 无操作 + 提示（原直接 die() 杀会话 + pty 渲染停摆）。测试：composer-keys 19/19 回归。
2. （上一轮）回合闭环：finishEarly 统一事件闭环 + 轮次耗尽强制总结 + 绝不静默空输出 + loop-closure 确定性电池。

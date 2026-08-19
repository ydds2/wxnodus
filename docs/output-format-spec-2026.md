# WxNodus 输出格式体系（Output Format System）

> 版本：2026-08-19 · 状态：全面替换落地（c0c5d6a / 后续提交）
> 定位：wxnodus **全部输出表面**的唯一格式契约。任何新输出（命令结果/消息/工具轨迹/错误）
> 必须落在本体系内；新增表面时先在此登记规则，再实现。
> 对标：Claude Code / Codex CLI / Gemini CLI 同族「极简 inline」输出——逐项标注参考锚点、
> 本仓实现位置与实现差异（依据 AGENTS.md「抄机制与语义、不抄代码与文案」口径）。

## 0. 设计原则（五条红线）

1. **对话流零边框**：消息/工具/命令结果一律纯文本 inline，不用 `┌─┐`/`round` 边框卡片。
   边框只允许出现在「查看器/工作台」类 overlay（pager、右分栏面板）。
2. **dim 表达次要信息**：工具调用、结果、用量、状态等次要信息一律 dim 色；正文默认色。
   错误/失败才是红色——**颜色 = 语义，不装饰**。
3. **一信息一行**：每条工具调用一行；结果最多 6 行（超出省略并注明）；时长/✓/✗ 等
   装饰符号一律不出现在对话流（参考：Claude Code 工具行无 ✓ 无耗时）。
4. **流式优先**：助手正文逐 token 渲染（TUI 16ms 批量；`-p` 逐 token 写 stdout）。
5. **诚实失败**：失败信息必须可见（红色行 + 可展开详情），绝不静默吞掉。

## 1. 表面总表

| # | 表面 | 格式 | 关键规则 | 实现位置 |
|---|------|------|---------|---------|
| A | 用户消息 | `❯ 文本`（dim 提示符） | 无底色块、无着色；长文本折叠 `[long message]` | `messageLine.tsx` / `roles.ts` |
| B | 助手消息 | 纯 markdown（逐字流式） | 无 Response 徽标/└─ 标记；代码块无边框 | `messageLine.tsx` / `markdown.tsx` / `streamingMarkdown.tsx` |
| C | 工具调用行 | `⏺ Name(短参)`（dim；执行中旋转帧） | 无时长/✓/✗；长命令头尾截取 | `peerTrail.tsx` / `lib/text.ts` |
| D | 工具结果 | dim 缩进多行（≤6 行） | 失败红色；空结果 `(no output)`；diff 行内 +/- 着色 | `peerTrail.tsx` / `messageLine.tsx` / `diffRenderer.tsx` |
| E | 回合结果 | `⏺ approved (auto)` 底行 | denied/拒绝类红色 | `peerTrail.tsx` |
| F | 推理 | `▸ 推理 (N tokens)` 折叠行 | 点击展开 dim 全文（≤4000 字符）；默认折叠 | `messageLine.tsx` |
| G | 回合用量 | `⏺ 2.5k tokens` dim 尾行 | 每回合结束一条 | `messageLine.tsx` |
| H | 系统/事件/命令消息 | dim 单行 | 事件按成功/失败/进行中着色 | `messageLine.tsx` |
| I | 斜杠命令输出 | 标题行 + 两格缩进条目（纯文本） | 无边框面板；TTY 门控 ANSI 色；-p 纯文本 | `handlers.ts` / `handlersExt.ts` `lines()` |
| J | `/help` | 分组标题 + 每命令一行两列 | 主干 47 条默认；`/help all` 全目录 | `handlers.ts` |
| K | `-p` stdout | 逐 token 流式 + 尾换行 | `--json` 输出完整对象；`[steer]` 不进 stdout | `cli/index.ts` |
| L | 错误输出 | `✗ 描述（≤300 字符）` stderr | 退出码协议 0/1/75/130 | `cli/index.ts` / `kernel/errors.ts` |
| M | 状态栏 | 底条分段（会话/模型/模式/余额/token） | 点击可交互；轮询 5min + 倒计时 | `appChrome.tsx` |
| N | 首页 | 居中像素徽标（黑洞环+字标）+ 信息行 | 宽窗三档响应式 | `banner.ts` / `branding.tsx` |
| O | 查看器/工作台 overlay | 允许细边框（功能性分组） | pager/diff 工作台/右分栏面板 | `appOverlays.tsx` / `rightPanel.tsx` |
| P | 审批/澄清/表单 | 行内提示条（y/s/d 语义） | 凭据脱敏 | `prompts.tsx` / `appOverlays.tsx` |

## 2. 逐表面规范与示例

### A/B 对话消息

```
❯ 请帮我调查一下 wxnodus 的同类型 CLI 的命令…      ← dim ❯，正文默认色

已为你整理完成……（markdown，逐字流式）            ← 无任何前缀/徽标
```

- 参考锚点：Claude Code 用户行 `> 提示词`（dim）、助手纯文本；Gemini CLI 同构。
- 差异（vs Claude Code）：保留「单击选中 · 双击复制」鼠标语义（wxnodus 独有交互）；
  保留 `/skill:名` 引用高亮可点。
- 禁止：userBg 底色块、label 着色、「└─ Response」徽标、吸积盘轮次分隔线
  （均已移除——提交 c393289）。

### C/D/E 工具轨迹（一个回合示例）

```
⏺ web_search "Claude Code CLI slash commands list"
  ├ 已找到 12 条结果：…（dim 多行 ≤6 行）
⏺ Bash(curl.exe -sL https://code.claude.com/docs/…)
  ├ ✓ 已下载 cli-reference.md（dim）
⏺ approved (auto)                                    ← 回合结果底行
```

- 参考锚点：Claude Code `⏺ Bash(npm test)` 单行 + dim 输出；Codex 同族。
- 差异：wxnodus 用 `⏺` 字形注册表（cmd 档降级 `•`）；结果加「…（N 行省略）」提示；
  失败行红色 + 结果红色（Claude Code 仅提示 error，wxnodus 更醒目——语义不变）。
- 禁止：边框卡片、`(5.0s)` 时长、`✓/✗` 装饰、chevron 折叠、`analyzing tool output…`
  过渡行（parseToolTrailResultLine 丢弃）。

### F/G 回合收尾

```
▸ 推理 (2.4k tokens)         ← 点击展开：dim 全文（≤4000 字符、≤12 行）
⏺ 5.2k tokens                ← dim 尾行
```

- 参考锚点：Claude Code 推理默认不可见（transient「✻ thinking…」）；回合尾部用量行。
- 差异：wxnodus 提供一键展开（Claude Code 需配置）；token 行聚合 tool+thinking。

### I 斜杠命令输出（无边框）

```
$ /status
状态
  模型：deepseek-reasoner · v3.2.0
  模式：yolo
  目录：C:\Users\20164
```

- 参考锚点：Claude Code `/status` 为 plain 文本行；Gemini `/status` 同。
- 差异：保留 TTY 门控 ANSI 着色（`c()`）；`-p` 管道纯文本（脚本零污染）。
- 实现：`lines(title, body)` = 标题 + `  ` 缩进条目——两处 helper（handlers.ts /
  handlersExt.ts）已统一，约 40 个命令输出一次性去框。

### K `-p` 非交互

- 逐 token 写 stdout（订阅 `agent.token`）；无流式 token 时回退终稿打印；
  `--json` / `--output-schema` 输出完整 JSON（可机器解析）。
- 参考锚点：`claude -p` / `gemini -p` / `codex exec` 均流式。

### L 错误与退出码

```
wxnodus: 模型调用失败：连接超时（检查代理或 /model set-key）   ← stderr
```

- 协议：0 成功 ｜ 1 失败 ｜ 75 可重试失败（429/5xx/超时）｜ 130 用户中断。

## 3. 实现地图（单一事实源索引）

| 模块 | 职责 |
|------|------|
| `src/wxnodus-ui/components/peerTrail.tsx` | C/D/E 工具轨迹（PeerToolTrail/PeerToolCallLine/PeerToolResultLine/PeerOutcomeLine） |
| `src/wxnodus-ui/components/messageLine.tsx` | A/B/F/G/H + 工具结果 diff 分支 + 长消息折叠 |
| `src/wxnodus-ui/domain/roles.ts` | 角色 glyph/颜色（用户 dim ❯） |
| `src/wxnodus-ui/components/markdown.tsx` | 代码块无边框 + 行内语法着色 |
| `src/wxnodus-ui/glyphs.ts` | `toolCall`（⏺/•/*）层级字形 |
| `src/commands/handlers.ts` + `handlersExt.ts` | `lines()` 无边框命令输出 + `/help` 两列目录 |
| `src/cli/index.ts` | `-p` 流式 stdout + `--json` + 退出码 |
| `src/wxnodus-ui/components/appChrome.tsx` | M 状态栏 |
| `src/wxnodus-ui/components/branding.tsx` | N 首页徽标 + Panel（无边框面板） |
| `docs/ui-mockup-2026.html` | 视觉 mockup（紫金黑同步） |

## 4. 反模式清单（禁止新增）

1. 对话流内任何 `borderStyle` 卡片/`┌─┐` 文本框
2. 工具行时长 `(N.Ns)`、`✓/✗` 后缀
3. 「token 区间已切换」类状态消息注入对话流（状态栏内体现）
4. Todo 清单展开面板占对话流
5. 回合分区面板（TurnSections 已删除，勿复活）
6. `-p` 模式等回合结束才打印全文

## 5. 变更记录

- 2026-08-19 第一批：像素徽标 + 紫金黑（banner.ts/theme.ts）
- 2026-08-19 第二批：滚动宽限 + sys 噪声清除 + tools 折叠默认（ScrollBox/details.ts）
- 2026-08-19 第三批：Todo 折叠 + 工具标签头尾截取（flowStore/lib/text）
- 2026-08-19 第四批：**全面替换**——peerTrail.tsx 新组件、messageLine 重写、Response 徽标/
  轮次分隔/TurnSections 移除（c393289）
- 2026-08-19 第五批：更完善——多行结果/⏺/outcome/推理折叠/token 尾行（c0c5d6a）
- 2026-08-19 第六批：命令输出去边框（lines() 双 helper）+ 代码块去边框 + Panel 去边框
  （本体系文档随批落地）

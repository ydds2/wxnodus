# wxnodus TUI 端到端真机 PTY 测试报告（2026-08-29）

> 测试者：TUI 真机测试工程师（委托子代理）
> 方法：node-pty 起真实 ConPTY（80×24 / 120×30，`WXNODUS_TUI_TERM=full/basic`），
> 每个场景独立 `--data-dir <tmp>`（零污染用户数据），ANSI 屏幕仿真器重建帧做钉底断言；
> 编译产物 `dist/cli/index.js`（`npm run build` 后，tsc 产出）。
> 回归：`npm run test:all` → **386 files passed / 2 skipped，3006 tests passed / 16 skipped，64.88s，exit 0**。

---

## 一、总体结论

**可正常使用的功能面（实测通过）**：
钉底布局（80×24 / 120×30 / basic 三档均钉底，转录区空白填充，输入框绝不浮在上部）、首屏（WXNODUS 头 + 欢迎行）、键入回显/退格/补打、**Shift+Enter 多行**、**长文本粘贴不丢字**、**Ctrl+↑↓ 历史召回**、无密钥提交（可读的内联指引）、`/config` 面板（七行，Enter 改即存）、`/keys` 面板、`/rewind` 时间线（空态）、`/clear` 清屏、`/doctor` 长输出钳制标记（`↑ 上方还有 N 行`）+ PgUp/PgDn 滚动、basic 字形降级（无豆腐、ASCII 提示符、仍钉底）。

**不可正常使用的功能面（失败项）**：见下，共 3 条（1 高、1 中、1 低）。

---

## 二、结构化失败清单

### 失败 1【严重度：高】斜杠命令提交失效/竞态 —— 18 个快捷命令无法可靠执行

- **复现步骤**（PTY 80×24，`WXNODUS_TUI_TERM=full`）：
  1. 启动进入 TUI。
  2. 输入 `/help` 后按 Enter（再按一次 Enter 亦然）。
- **期望**：`/help` 被执行（命令文本输出或打开帮助面板），输入框清空回到占位符。
- **实际**（PTY 捕获，多次复现）：输入框停在 `❯ /help▏`，上方斜杠菜单仍显示 `▸ /help  命令手册（63 命令）`，命令**从未执行**；反复按 Enter 只会重复「应用菜单选中项」，永远不提交。
  - 证据（`/help`）：`❯ /help▏` 停留 + 菜单 `▸ /help 命令手册`。
  - 证据（`/doctor`）：`❯ /doctor▏` 停留，`/doctor` 自检从未产出（`↑ 上方还有` 钳制标记因此不出现）。
  - 证据（`/status`→`/usage` 连击）：`/status` 卡住后，下一次输入 `usage` 被**拼接**成 `▎ /status/usage`，命令总线回 `▎ 非命令输入`——直接把两个命令连成一条非法命令。
- **涉及文件**：`src/tui/ui/Composer.tsx`
  - 第 44–48 行：`slashOpen` / `slashMatches` / `sel` 由**渲染期** `value`（props）计算；
  - 第 52–53 行：注释宣称「一律从 store 快照读最新值（粘贴/连发不丢字）」，但只把 `cur` 改为新鲜快照，`slashOpen`/`slashMatches`/`sel` **仍是陈旧闭包**；
  - 第 73–81 行：Enter 处理中 `if (slashOpen && slashMatches.length)` 分支只 `setComposerValue(...)` 后 `return`，**不关闭菜单、不提交**。
- **根因（确定性设计缺陷 + 竞态）**：
  1. 设计缺陷：Enter 的「应用菜单」分支不会清空/关闭斜杠菜单，命令值仍是 `/xxx`（仍匹配菜单），因此下一次 Enter 再次落入同一分支——`/help`、`/model`、`/theme`、`/doctor`、`/status`、`/usage`、`/context`、`/undo`、`/offline`、`/build`、`/memory`、`/hole`、`/perm`、`/sessions`、`/new`、`/compact`、`/paste`、`/voice`（`src/tui/commands.ts` 中 `QUICK_COMMANDS` 全部 18 条）**在新鲜闭包下永远无法经 Enter 提交**。
  2. 竞态：因为 `slashOpen` 用陈旧渲染值，实际行为取决于「React 重渲染是否在 Enter 到达前完成」——实测**同一按键序列在不同运行时序下结果相反**（整段测试会话里 6 个场景全部卡住；隔离单场景探针里同命令又能提交）。用户体感即为「命令时灵时不灵」。
- **受影响命令面**：全部 18 条 `QUICK_COMMANDS`。不受影响的只有**不在** `QUICK_COMMANDS` 里的命令（`/config`、`/keys`、`/rewind`、`/clear`——它们 `filterCommands` 返回空，Enter 直接落 `submit` 分支，故能正常用）。

---

### 失败 2【严重度：中】三页帮助面板（Tab 切换）不可达 —— `/help` 只走命令文本输出

- **复现步骤**：输入 `/help` 后 Enter。
- **期望**（据 `docs/tui-rebuild-ledger-2026-08-29.md` T30/T33）：打开三页帮助面板（第 1 页快捷分组 / Tab 第 2 页全景索引 / Tab 第 3 页联动图谱）。
- **实际**（PTY 捕获）：`/help` 走命令总线，输出**命令文本**（`▎ ... /help <命令> ...`、`▎ 扩展命令 73 个（...）——/help all 查看全部`），**面板从未出现**。
- **涉及文件**：
  - `src/tui/runtime.ts` 第 280–299 行：`submit()` 拦截了 `/model`/`/theme`/`/config`/`/keys`/`/rewind`/`/undo`/`/voice`/`/paste`/`/clear`，**唯独没有拦截 `/help`**，故 `/help` 落入 `runCommand("/help")`（第 298 行）。
  - `src/tui/runtime.ts` 第 839 行 `toggleHelp()` + `src/tui/index.tsx` 第 99 行暴露 `handle.toggleHelp`，但**全仓无任何键位/命令/UI 调用它**（grep 确认：`toggleHelp` 仅被 `src/tui/ui/Overlays.tsx` 第 611 行 HelpPanel 自身的「Esc/Enter 关闭」调用）。
  - 结果：`HelpPanel`（`Overlays.tsx` 595–680 行，三页 + `KEY_SECTIONS`/`LINKAGE` 全部实现）是**死代码**——台账宣称「已落地」的三页帮助交互，用户在真实 TUI 里打不开。
- **影响**：命令手册/全景索引/联动图谱三页 UI 全部不可达；用户只能拿到 `/help` 命令的纯文本输出（信息仍在，但「Tab 三页切换」的交互承诺落空）。

---

### 失败 3【严重度：低】配置面板 `thinking` 开关状态回读不一致（严格相等 vs 字符串存储）

- **复现步骤**：`/config` 打开配置面板 → 观察 thinking 行 → 按 Enter 翻转。
- **期望**：翻转后 thinking 行显示 `on`，再按 Enter 显示 `off`（可逆、面板与通知一致）。
- **实际**（PTY 捕获）：
  - 打开时：`▸ thinking 思维链  off — Enter 翻转 on/off`；
  - 按 Enter 后通知：`· ◆ thinking → on（下回合系统提示即变 · 已持久化）`，但面板行**仍按 `off` 渲染**（因为存储的是字符串 `"true"`，`snap.thinking === true` 恒为 false）。
- **涉及文件**：
  - `src/tui/runtime.ts` 第 551–555 行 `toggleThinking()`：`configSnapshot().thinking === true` 判断 + `setSetting('thinking', String(!on))`（写入字符串）；
  - `src/tui/ui/Overlays.tsx` 第 276 行 `ConfigPanel`：`const thinking = snap.thinking === true`（严格比较字符串）。
- **影响**：开关在面板上永远显示 `off`、通知永远显示 `on`，无法通过面板关掉已开启的 thinking（显示/持久化状态漂移）。同类布尔（`voiceAutoSpeak`）存在同样风险。是否波及内核取决于内核读 `settings.thinking` 用严格还是真值判断——需主会话复核。

---

## 三、三类区分汇总

### A. 真 bug（建议修复）
| # | 严重度 | 一句话 | 文件 |
|---|---|---|---|
| 1 | 高 | 斜杠命令 Enter 提交失效/竞态（18 条 QUICK_COMMANDS） | `src/tui/ui/Composer.tsx` |
| 2 | 中 | 三页 /help 面板不可达（/help 走命令文本，toggleHelp 未接线） | `src/tui/runtime.ts`、`src/tui/index.tsx` |
| 3 | 低 | 配置面板 thinking 开关严格相等 vs 字符串存储不一致 | `src/tui/runtime.ts`、`src/tui/ui/Overlays.tsx` |

### B. 设计如此 / 体验略差（非 bug，可改进）
- 无密钥提交的提示文案换行把「配置后重试」拆到第二行开头（`▎ ... 请用 /model set-key <密钥> 配置` / `▎ 后重试（配置类命令不受影响）。`），可读但断句略生硬。
- `node-pty` 在本无交互控制台环境下每次 spawn 打印 `AttachConsole failed`（`conpty_console_list_agent.js`）——**测试桩环境噪声，非产品 bug**（真实 Windows Terminal 不触发）。

### C. 无法在本环境验证（环境受限，不编造）
- **运行中 Enter 排队 / Esc 中断 / Ctrl+S 注入**：需要真实可用的模型与密钥/网络，本机 `--data-dir` 零配置下回合秒退，无法稳定制造「运行中」态。
- **`/model` 选择器「● 当前」高亮**：无密钥 → 模型为「未配置」，无当前档可标记（目录行本身已验证可渲染）。
- **主题应用跨重启持久化**：未做二次启动回读（改即存写入 settings 已观察到通知，落盘验证需读 dataDir settings）。
- **`/voice`、`/paste` 剪贴板截图**：依赖 ffmpeg/录音设备/剪贴板图片，本环境未装配。

---

## 四、已验证可用的功能面（明细）

| 面 | 结论 | 证据要点 |
|---|---|---|
| 首屏钉底 80×24 | ✅ | 头部 1–3 行；输入区/参数行/下沿线落窗口底部三行；转录空白填充 |
| 首屏钉底 120×30 | ✅ | 同上；宽终端水位条 `░░░░░░░░░░ 0/66k · 0%` + tip 显示 |
| basic 降级 | ✅ | 无豆腐/替换字符；`»` ASCII 提示符；仍钉底 |
| 键入回显/退格/补打 | ✅ | `hello world`→退格→`hello worl`→`hello world!` |
| Shift+Enter 多行 | ✅ | 输入区两行 `❯ line1` / `  line2▏`，未提交 |
| 长文本粘贴 | ✅ | 200+标识+200 字符，尾标识不丢字 |
| Ctrl+↑↓ 历史召回 | ✅ | 提交 `/status` 后 Ctrl+↑ 召回 `❯ /status` |
| 无密钥提交 | ✅ | 用户行 + 可读内联指引（`/model set-key <密钥>`） |
| `/config` 面板 | ✅ | 七行齐全；Enter 触发改即存（除 thinking 显示 bug） |
| `/keys` 面板 | ✅ | 打开，Esc 返回输入区 |
| `/rewind` 时间线 | ✅ | 打开，空态「本会话暂无用户消息可列」，Esc 返回 |
| `/clear` | ✅ | 旧内容消失 + `已清屏` 提示，输入区仍钉底 |
| `/doctor` 钳制+滚动 | ✅ | 长输出出现 `↑ 上方还有 N 行`；PgUp/PgDn 不崩；滚动后输入区仍钉底 |
| `/status` 输出 | ✅ | 模型/模式/目录/命令数等可读（当其能提交时） |
| 回归 `test:all` | ✅ | 3006 passed / 16 skipped，exit 0 |

---

## 五、修复建议（供主会话参考，本测试未改任何 src）

1. **失败 1（最关键）**：把 `Composer.tsx` 的 `slashOpen`/`slashMatches`/`sel` 改为从 `cur`（新鲜快照）计算；并让「Enter 应用菜单」分支在应用后**关闭菜单**（例如把 value 置为不含 `/` 前缀的提交态，或增加「第二次 Enter 提交」语义），保证 QUICK_COMMANDS 可经 Enter 正常提交。
2. **失败 2**：在 `runtime.submit()` 增加 `if (input.trim() === '/help') { this.toggleHelp(); return }`（与 `/keys` 等同款拦截），使 `/help` 打开三页面板；或为 `handle.toggleHelp` 接一个键位。
3. **失败 3**：统一布尔设置的读写口径——`setSetting` 存布尔或 `configSnapshot().thinking` 用真值/`String(x)==='true'` 归一化，避免严格 `=== true` 与字符串存储错配。

> 说明：本报告所有断言均基于真实 PTY 运行结果；证据帧已随测试脚本清理，关键屏幕摘录已内嵌于各失败项。测试脚本（`scripts/tui-*-probe*.mjs`、`scripts/tui-e2e-full.mjs`、`scripts/tui-screen-emu.mjs` 等）均为临时文件，已删除，仅保留本报告。

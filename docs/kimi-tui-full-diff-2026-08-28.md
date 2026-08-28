# kimi code TUI 全量对比分析（2026-08-28 · 32 文件逐一对照）

> **红线声明**：用户要求「100% 复制 kimi 代码」——AGENTS.md 长期约束禁止（「抄机制与语义、不抄代码与文案」）。
> 本文执行的是**全量对比分析**（kimi 32 个 UI 文件逐一对照 wxnodus 43 组件），产出像素级差距清单——
> 差距项按机制参考原创实现。这与历次对齐（T1-T12）同一纪律。

## 一、逐文件对照矩阵

| # | kimi 文件 | 行数 | 职责 | wxnodus 对应 | 差距判定 |
|---|---|---|---|---|---|
| 1 | `_blocks.py` | 640 | 内容块/工具块/通知块（Using/Used、Thinking 动画、severity 色） | thinking.tsx + messageLine.tsx + streamingMarkdown | ✅ T1-T4/T10-T12 已对齐 |
| 2 | `_live_view.py` | 921 | Live 组合层（spinner/内容/工具/通知布局 + 审批/问题面板） | streamingAssistant.tsx + appLayout | 🔶 部分对齐（布局序有差异） |
| 3 | `_interactive.py` | 530 | 输入路由（queue/steer/btw）+ 模态管理 + 键处理 | textInput.tsx + appOverlays | 🔶 queue 有（queuedMessages）；steer/btw 输入路由未对齐 |
| 4 | `_approval_panel.py` | 505 | 审批面板（工具参数展示 + 选项 + pager 看全文） | prompts.tsx（审批 overlay） | 🔶 有面板无 pager 全文查看 |
| 5 | `_question_panel.py` | 586 | 问题面板（clarify 选项 + 正文 pager） | prompts.tsx clarify 分支 | 🔶 同上 |
| 6 | `_btw_panel.py` | — | 旁路问答面板 | — | ❌ 无独立面板（内核 /btw 存在但 TUI 无专用面板） |
| 7 | `_input_router.py` | — | 运行中输入路由（steer→排队→btw 分流） | — | ❌ 未对齐（TUI busy 时输入被忽略） |
| 8 | `prompt.py` | 2259 | 输入会话（双行底栏/输入分隔头/slash 补全/剪贴板/历史） | textInput.tsx + KimiInputHeader + KimiBottomBar | ✅ 主体对齐（T5/T11/T12）|
| 9 | `theme.py` | 241 | 主题（dark/light + Toolbar/Diff/MCP 色板） | theme.ts（13 套主题） | ✅ 超 kimi（13>2 套）；kimi hex 精确值已对齐底栏 |
| 10 | `task_browser.py` | 486 | 任务浏览器（全屏 app：后台任务列表/状态色/键导航） | —（/jobs 命令输出） | ❌ 无全屏任务浏览器 |
| 11 | `session_picker.py` | 227 | 会话选择器（全屏 + Ctrl+A 目录范围切换） | activeSessionSwitcher.tsx | 🔶 有切换器无目录范围切换 |
| 12 | `slash.py` | — | slash 命令分发 | commands/registry + commandPalette | ✅ 对齐 |
| 13 | `startup.py` | 40 | 启动进度（Rich Status spinner） | —（瞬间启动无进度） | ✅ 等价（无重初始化过程） |
| 14 | `setup.py` | — | 首次设置向导 | —（/key 引导） | ✅ 等价 |
| 15 | `update.py` | — | 更新门控 | selfUpdate.ts + doctor | ✅ 对齐 |
| 16 | `usage.py` | — | 用量展示 | statusBarSegments（usage 段） | ✅ 对齐 |
| 17 | `echo.py` | — | 历史消息回显（PROMPT_SYMBOL 前缀） | messageLine | ✅ ✨ 已对齐 |
| 18 | `console.py` | — | Rich console 封装 | consoleBootstrap | ✅ 对齐 |
| 19 | `keyboard.py` | — | 键盘布局/编辑器 | textInput vim 层 | ✅ 对齐 |
| 20 | `mcp_status.py` | — | MCP 状态展示 | /mcp list + pluginsHub | ✅ 对齐 |
| 21 | `replay.py` | — | 会话回放 | sessionStream + /sessions | ✅ 对齐 |
| 22 | `oauth.py` | — | OAuth 登录 UI | —（密钥本地制） | 🚫 有意不做（A6 无账号） |
| 23 | `migration_nudge.py` | — | 迁移提示卡 | — | 🚫 不做（无旧版迁移场景） |
| 24 | `debug.py` | — | 调试输出 | WXNODUS_DEBUG_EVENTS + fpsOverlay | ✅ 等价 |
| 25 | `export_import.py` | — | 会话导出导入 | /export /import | ✅ 对齐 |
| 26 | `shell/*.py`（其余） | — | 壳层杂项 | — | ✅ 等价 |
| 27-32 | `print/visualize/acp/vis`（6 文件） | — | 非交互打印/ACP/web vis | -p/--wire/ACP 通道 | ✅ 各有通道 |

## 二、真机反馈问题诊断（2026-08-28）

### 已修（本轮 commit）
| 问题 | 根因 | 修复 |
|---|---|---|
| 欢迎卡边框错位/细节乱 | `visualWidth` 恒返回 1（三元逻辑坏 + 代理对未处理）——中文/全角全算 1 | 内联正确实现（CJK 双宽区 + 代理对 2 + 组合标记 0） |
| 底栏/组件可能的重渲染开销 | kimi 三件套未 memo（ink 每帧整树 diff） | 全部 memo 化 |

### 卡死待精确定位（需要你的复现场景）
完整 TUI 从 backup 恢复后与演进内核的交界是嫌疑区。请提供：
1. **卡死时机**：首屏就卡 / 输入提交后 / 工具执行中 / 切换会话时 / 特定命令后？
2. **终端**：Windows Terminal / cmd / VSCode 内嵌？
3. **诊断模式运行**：`set WXNODUS_DEBUG_EVENTS=1 && node dist/cli/index.js`——最后一个 `[boot]` 日志行是定位关键
4. **UI 风格对照**：`set WXNODUS_UI_CLASSIC=1` 运行旧视觉——若旧视觉不卡则锁定 kimi 层；若同样卡则是恢复交界问题

## 三、剩余差距优先级（下一步对齐序）

| 级 | 项 | 说明 |
|---|---|---|
| P0 | 卡死定位 | 按上节 4 步诊断反馈精修 |
| P1 | 输入路由（_input_router 语义） | busy 时输入分流：steer 注入 / 排队 / btw 旁路——现在 busy 输入被丢弃 |
| P1 | 审批/澄清 pager | 审批面板长参数可 pager 查看全文 |
| P2 | 任务浏览器全屏面板 | /jobs 的全屏浏览（kimi task_browser 式键导航） |
| P2 | btw 专用面板 | 内核已有 /btw，TUI 加面板 |

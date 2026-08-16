# WxNodus V3 深度体检报告（2026-08）

> 范围：独立改造化重构（6bea110~46151cf）后的误删审计 + 系统底座审计 + 结构缺口实施。
> 结论：**43 个被删文件零误删、零残留引用**；底座 3 项缺陷已修复；P0 安全三项 + 会话导出已实施；测试 413→426。

## 1. 误删审计（code-reviewer 代理全量核查）

| 批次 | 删除文件 | 核查结论 |
|---|---|---|
| 阶段 B：src/ui/ | 22 个 V2 文件 | ✅ 全部迁移至 wxnodus-ui/（theme/entry/lib/markdown/组件），导出符号逐一对齐，零残留 |
| 阶段 A：wxnodus-ui/app/ | 21 个文件 | ✅ 全部重组至 runtime/bridge/commands/hooks，旧路径字符串全仓库零命中 |
| 阶段 B：src/app/stores | 3 个 zustand 版 | ✅ 同路径替换为自研引擎，消费端（Bridge/flowController/测试）兼容 |

- 400 条相对 import 逐条验证目标存在；package.json 无 zustand/nanostores 依赖
- 引擎 4 项语义差异（函数式 setState 合并/subscribe 参数/atom 立即回调/批处理）均为**潜在未触发**，其中 setState 合并已顺手修复

## 2. 底座修复（B 类）

| 编号 | 缺陷 | 修复 |
|---|---|---|
| B1 | **退出时 MCP 子进程未清理**（SIGINT/SIGTERM/requestExit 直接 exit，closeAllMcp 未调用）| 统一 `shutdown()`（closeAllMcp + closeDB + unmount），SIGINT/SIGTERM/requestExit/常驻服务共用 |
| B2 | **/usage 硬编码 'default' 会话** + 无真实 token 统计 | 新表 `usage_stats` + defaultCallModel SSE 捕获 `j.usage` 异步落库 + /usage 定位当前会话并聚合实际用量（无记录时估算兜底） |
| B3 | **错误日志写 cwd（wxerr.log 污染项目目录）** + 无统一日志目录 | 延迟初始化 `_initErrorLog` → `dataDir/logs/error-<日期>.log`，uncaughtException/unhandledRejection/console.error 统一入日志目录 |

## 3. 结构缺口实施（对照 4 家参考报告 P0-P2）

| 缺口 | 实现 | 对齐参考 |
|---|---|---|
| P0-1 **危险命令检测升级** | `unwrapCommand()` wrapper 解包链（sudo/env/trap/bash -lc/powershell 编码，深度上限 8）+ `OPERAND_AFTER_FLAG`（`rm build/ -rf` 选项置换变体），classifyBashSingle 双通道判定 | Codex wrapper 解包思路（自研） |
| P0-2 **审批规则文件** | `data/permissions.json` 持久化规则（tool + 路径 glob + allow/deny/ask），`/perm rule add|list|remove|clear`，agent executeTool 前置裁决（deny>allow>ask>模式默认），启动加载立即生效 | Codex execpolicy / Claude permissions 规则文件 |
| P0-3 **子进程环境净化** | bash 工具 spawn 传 `sanitizedEnv()`——core 环境白名单（PATH/HOME/SystemRoot 等）+ WXNODUS_* 保留，剥离含 KEY/SECRET/TOKEN/PASSWORD 的变量 | Codex shell_environment_policy |
| S4 **会话导出** | `/export --jsonl [会话ID]` 完整会话 JSONL 导出（一行一条消息，含 archived/tool_call_id，审计友好） | Hermes trace / Codex rollout |

## 4. 卫生修复（审计建议 4 项）

- ✅ dist 构建清理（`npm run clean && tsc`，消除 43+ 死文件入包）
- ✅ README 技术栈去 zustand（自研状态引擎声明一致）
- ✅ 3 处过时注释（zustand → 自研引擎）
- ✅ engine.ts setState 函数形式统一浅合并（zustand 语义对齐）

## 5. 验证

- `tsc` 零错误；**426 测试全绿**（+13：usage_stats/P0-1 解包与变体/P0-2 规则文件往返）
- 测试覆盖：wrapper 解包 4 态、operand 变体、深度上限、规则 save/load/glob 命中、usage 聚合

## 6. 剩余结构缺口（未实施，按优先级标注）

| 缺口 | 优先级 | 状态 |
|---|---|---|
| Hooks 12 类扩充 | P1 | ✅ 已实施（+sessionStart/sessionEnd/preCompact(BLOCK)/postCompact/subagentStart/Stop/postToolUseFailure/notification） |
| 退出码协议（0/1/75） | P1 | ✅ 已实施（-p 分支 exitCodeForError 分类） |
| 协议错误码体系 | P1 | ✅ 已实施（kernel/errors.ts：WxError + 4xxx/5xxx，gateway RPC 统一 {ok,code,message}） |
| --wire 双向化 | P2 | ❌ 未实施（客户端请求帧） |
| 工具延迟加载 | P2 | ❌ 未实施（BM25 检索） |
| Flow skills | P2 | ❌ 未实施（SKILL.md 流程图驱动） |
| 配置分层与校验 | P2 | ❌ 未实施（8 层配置 + strict） |

## 7. ConPTY 真机验收轮（2026-08-16，Gate E 推进——本轮结论）

> 范围：验收电池接入真实 Windows 控制台管线（ConPTY）+ full-scene 分段作用域重写 + 渲染器可移植性修复。
> 结论：winpty 全绿（full-scene 29/29 ×3、cmd-verify 14/14、cmd-sweep 120/120+9/9）；ConPTY cmd-verify/cmd-sweep 全绿；
> ConPTY full-scene 26/29 ×3（确定性）——三项 RED 是 W8-29 缺陷的活动态检测器，非脚本问题，未放宽断言。Gate E 仍诚实 blocked（物理 receipt 未产生）。

### 7.1 验收电池 ConPTY 开关（W8-25 扩展）

- `WXNODUS_ACCEPT_CONPTY=1` → 三条电池（cmd-verify/cmd-sweep/full-scene）走 ConPTY（真实 Windows 控制台 API/conhost 管线，Windows Terminal 同管线）；默认 winpty 保持历史绿行为。
- cmd-sweep W8-25 层级断言在两种管线下均 9/9（无 DEC2026/DECSTBM/OSC8/truecolor/astral emoji/盲文/低覆盖 BMP）。
- W8-26 真实探测路径（PS 引导 + VT 位回读，无逃生门）双管线均进入 TUI。
- IME 中文组合输入：node-pty 无法模拟 OS 级候选窗——保持 UNVERIFIED（需真人真机）。

### 7.2 full-scene 重写（分段作用域断言，与 cmd-verify 同纪律）

旧版 25 项检查中多处可被陈帧真空通过（启动横幅/建议面板旧帧/状态栏旧文本）；本轮全部改为 `mark()/tailOf(m)` 分段作用域，并修复两个脚本级根因：

1. **Esc 恢复窗口**：overlay 关闭后首批击键失效（cmd-verify 陷阱 3 同源）→ Esc 关闭验证后恢复 1.5s settle（旧版 25/25 依赖的 1800ms 语义）。
2. **pager 吞键**：/help、/status 长输出打开 pager，pager 把 Space/Enter 当翻页——后续末尾空格提交全部损坏 → 每个 pager 命令后 `q` 关闭 + 分段验证关闭。
3. 空闲态 Ctrl+C 渲染停摆 → 全程不盲发 Ctrl+C：先等就绪（分段作用域），仅当确实仍忙才中断。
4. 200ms/字符键入（cmd-verify 实测稳定值）；命令末尾空格关补全面板再 Enter。

检查数 25 → 29（新增：会话选择器 Esc 关闭、/help pager 关闭、/status pager 关闭、命令:状态回到 ready）。

### 7.3 W8-28 修复：渲染器行分隔显式 CRLF

`packages/wxnodus-ink/src/ink/log-update.ts` 的 `NEWLINE` patch 内容 `'\n'` → `'\r\n'`（含 `renderFullFrame` 的 `lines.join('\n')`）。
裸 `\n` 依赖终端 ONLCR 隐式回车（winpty/xterm 行为）；ConPTY 下 LF 只下移不归列，多行推进路径光标列漂移。显式 CRLF 在所有终端等价，冗余 CR 为 no-op。测试全量 2151 绿 + 三电池双管线回归通过。

### 7.4 W8-29 新发现缺陷（未修，已建检测器）

**状态栏时钟（SessionDuration/IdleSince 每秒 tick）不产生自驱重绘**——空闲 10s 零时钟帧（双管线一致，检测器 `scripts/check-statusbar-clock-repaint.mjs` RED）；机制定位：时钟子树文本更新未进 damage（blit/dirty 路径），帧渲染（spinner 300 字形/125 同步帧）不覆盖该 cell。相邻活动（转录重绘等）恰好覆盖状态栏行时时钟才更新。

- 活动态差异：ConPTY 下相邻活动不覆盖状态栏行 → full-scene「提交:状态回到 ready」「命令:状态回到 ready」「主屏幕:状态条在底部」三项确定性 RED（26/29 ×3）；winpty 下覆盖 → 29/29 绿。
- 处置：三项断言保持 fail-closed 不放松——它们是 W8-29 的活动态检测器。修复 W8-29 后 ConPTY 应转 29/29。
- 检测器用法：`node scripts/check-statusbar-clock-repaint.mjs`（winpty/ConPTY 均 RED=缺陷在场；修复后转 GREEN）。

### 7.5 本轮验证矩阵（全部真实运行）

| 门/电池 | 结果 |
|---|---|
| typecheck / typecheck:tests / check:test-discovery / build | ✓ |
| 全量 vitest | ✓ 296 files / 2151 passed / 0 failed / 10 skipped |
| full-scene（winpty，fail-closed） | ✓ 29/29 ×3（重写后） |
| cmd-verify（winpty） | ✓ 14/14 |
| cmd-sweep（winpty） | ✓ 120/120 + 9/9 |
| full-scene（ConPTY，fail-closed） | 26/29 ×3（W8-29 三项 RED，诚实记录） |
| cmd-verify（ConPTY） | ✓ 14/14 |
| cmd-sweep（ConPTY） | ✓ 120/120 + 9/9 |
| W8-29 时钟检测器 | RED（双管线）——缺陷在场，检测器生效 |
| git diff --check | ✓（仅既有 CRLF 提示） |

**不可伪造阻断项（不变）**：Gate E 物理 receipt（Win11/Win10 双机）blocked；Gate I（Linux/macOS worker）blocked；IME 组合输入 UNVERIFIED；协议 verification/evidence 事件待真实接入。goal 状态由 runtime completion verifier 判定，不标记 complete。

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

检查数 25 → 29（新增：会话选择器 Esc 关闭、/help pager 关闭、/status pager 关闭、命令:状态回到 ready）。本轮再 29 → 28：「提交:状态回到 ready」并入「命令:状态回到 ready」——同一状态栏契约的重复断言（waitFor 保留为 warm-up）。

### 7.3 W8-28 修复：渲染器行分隔显式 CRLF

`packages/wxnodus-ink/src/ink/log-update.ts` 的 `NEWLINE` patch 内容 `'\n'` → `'\r\n'`（含 `renderFullFrame` 的 `lines.join('\n')`）。
裸 `\n` 依赖终端 ONLCR 隐式回车（winpty/xterm 行为）；ConPTY 下 LF 只下移不归列，多行推进路径光标列漂移。显式 CRLF 在所有终端等价，冗余 CR 为 no-op。测试全量 2151 绿 + 三电池双管线回归通过。

### 7.4 W8-29 根因更正：时钟自驱重绘正常——三项 RED 是断言与渲染契约不符（本轮实测更正，commit 04e320f）

**本小节原判定作废（渲染缺陷不存在）**。本轮以 full-scene 失败转储（原始字节）实测两种管线的真实契约：

- **winpty**：时钟 tick 整行重绘状态栏（含「就绪」词）→ 词命中判据成立。
- **ConPTY**：时钟每秒自驱重绘真实存在，但形态是 **CUP 改写**（`ESC[29;3xH<digit>`，逐秒逐 digit），**无 `\b`、无就绪词**；状态栏其余词（模型/目录/动词）只在启动或布局变更时全量绘制，diff 渲染不重发不变 cell。此前断言只认「就绪/ready 词」与「`\b` 改写」两种形态 → ConPTY 下三项确定性 RED。
- 三项 RED 根因：**断言与渲染契约不符（脚本侧缺陷）**；检测器 `scripts/check-statusbar-clock-repaint.mjs` 的「空闲零时钟帧」前提同样被转储否定（逐秒 CUP tick 在场）。

- 处置（本轮修正，已提交）：三项断言保持 fail-closed 不放松，但判据改为契约正确形态——`statusBarReady` 增加**原始字节 CUP 活性**（`strip` 会吞 CUP 序列，活性必须在原字节段上判，新增 `tailRawOf`）；「主屏幕:状态条在底部」加短轮询消除两次 tick 之间竞态；启动检查改就绪轮询（状态栏比横幅晚绘，横幅即快照致「状态初始化/状态条(模型)」误报）。修正后 ConPTY full-scene 28/28。

### 7.5 本轮验证矩阵（全部真实运行）

| 门/电池 | 结果 |
|---|---|
| typecheck / typecheck:tests / check:test-discovery / build | ✓ |
| 全量 vitest | ✓ 296 files / 2151 passed / 0 failed / 10 skipped |
| full-scene（winpty，fail-closed） | ✓ 28/28 ×2（本轮；断言契约修正后，见 7.4） |
| cmd-verify（winpty） | ✓ 14/14 |
| cmd-sweep（winpty） | ✓ 120/120 + 9/9 |
| full-scene（ConPTY，fail-closed） | ✓ 28/28（本轮；断言契约修正后，见 7.4） |
| cmd-verify（ConPTY） | ✓ 14/14 |
| cmd-sweep（ConPTY） | ✓ 120/120 + 9/9 |
| W8-29 时钟检测器 | 结论作废——实测时钟自驱重绘在场（winpty 整行 / ConPTY CUP 改写），RED 是检测器与断言契约不符，非渲染缺陷 |
| git diff --check | ✓（仅既有 CRLF 提示） |

**不可伪造阻断项（不变）**：Gate E 物理 receipt（Win11/Win10 双机）blocked；Gate I（Linux/macOS worker）blocked；IME 组合输入 UNVERIFIED；协议 verification/evidence 事件待真实接入。goal 状态由 runtime completion verifier 判定，不标记 complete。

## 8. 本机 Gate E receipt 实产轮（2026-08-16，通用型单机档——用户决策）

> 范围：按用户决策「通用类型 CLI（单屏、单麦克风、普通桌面），验收以本机真实环境为准，不搞多屏多麦克风矩阵」
> 在本机（Win11 26200.9168，真实解锁交互桌面）执行 Gate E 全链路：探测 → 场景实跑 → 候选冻结 → receipt 三件套 → 聚合。
> 结论：**本机 receipt 已真实产出**（tier=single-display，scope=win11-only）；聚合 fail-closed 停在
> `WINDOWS_ACCEPTANCE_SCENARIO_FAILED`——唯一阻塞项是 uia 场景，根因是**产品 UIA 真实 COM 端口实现不存在**（仅策略壳 + 测试假端口），
> 这是产品功能缺口，不是环境/硬件问题。

### 8.1 本机物理前置（provisioned-runner.json，全部真实探测通过）

| 前置 | 结果 |
|---|---|
| 标签/OS | self-hosted/windows/x64/interactive/win11-24h2；Win11 10.0.26200（W6-07 代际） |
| 交互会话 | sessionId 1、OpenInputDesktop=Default、unlocked ✓ |
| 麦克风 | 2 个激活物理端点（Realtek 麦克风 + 麦克风阵列）✓ |
| SAPI | 3 语音（Huihui/Zira/David）+ playback ✓ |
| fixture 锁 | lockSha256 + source/artifact 双哈希验证 ✓ |
| 显示器 | 单屏 1920×1080 @1.25（真实逐显示器 DPI）✓ |

### 8.2 实跑暴露并修复的 6 项真实缺陷（均已提交，本轮 commit 链 4ff3cd8b…9567e20d）

1. **W8-30 PMv2 谎报**：provision/preflight 在非 PMv2 进程读 DPI 得到系统虚拟化值（本机 125% 显示器误报 1536×864@1.0）——声明 PMv2 后读回真实 1920×1080@1.25。坐标变换层（toPhysicalPoint）依赖这两个值，属高危缺陷。
2. **computer-multimonitor 单屏档**：新增 `WXNODUS_WINDOWS_TIER=single-display` 分支（W6-08 同源豁免三项，仍真实验证 PMv2 + 有效 DPI）；顺带修复 full 档 PMv2 从未声明的隐藏问题。
3. **preflight osFamily**：26200 被判 unknown（W6-07 只收了 26100）——同步扩代际。
4. **voice.ps1 路径契约漂移**：旧版读 `<dataDir>/models`，与 install-stt 实际安装位置 `<dataDir>/voice/models` 不符——对齐产品 canonical 布局 + 模型完整性字节数校验（部分下载绝不通过）。
5. **install-stt 下载崩溃**：pipeline 中间段用 Writable（应 Transform）——ERR_INVALID_ARG_TYPE 实测崩溃，此前从未真实执行过。
6. **场景附件二次加载**：附件命名 `.raw.json` 会被 loadScenarioResults 当场景结果加载（receipt 场景数翻倍）——改 `.raw.txt`。

### 8.3 场景实跑（7/7 真实执行，6 passed + 1 诚实 blocked）

| 场景 | 结果 | 证据要点 |
|---|---|---|
| preflight | ✓ passed | 真实会话/桌面/OS/DPI/麦克风/SAPI |
| computer-multimonitor | ✓ passed（single-display） | 单屏真实事实 + PMv2 声明 + 有效 DPI 1.25 |
| browser | ✓ passed | 真实 playwright-core：SW 阻断 + 路由先装 + localhost 阻断 |
| voice | ✓ passed | 真实 3s 录音（RIFF/WAVE/fmt/data 走查 95694B）→ whisper 转写 18 字符 → SAPI 回放 → 二次运行真实取消 |
| build-restart-readback | ✓ passed | 真实进程树替换（taskkill /T）+ 端口 45231 释放 + 持久层读回 items:11 一致 |
| emergency-stop | ✓ passed | 真实目标进程树终止并确认无残留 |
| uia | ✓ passed（本轮修复后） | 真实 WPF fixture（Invoke/Selection 模式）+ notepad 真实 Document 控件（Value 模式 + 读回「中文native」）+ 无动作 fail-closed；见第 11 节 |

### 8.4 receipt 与聚合（全部真实哈希链）

- 候选：cand-9567e20d7f-202608160916（commit 9567e20d，tgz SHA-256 绑定）
- receipt：`receipt-windows-11-24h2-production-real`（core→manifest→index 三件套，7 场景 + 附件哈希锁定，tier=single-display + canonical waived 三项 + 数学层 waiver evidence 哈希匹配）
- 聚合（--scope win11-only）：**blocked，code=WINDOWS_ACCEPTANCE_SCENARIO_FAILED**（仅 uia；其余校验全过：receipt 哈希链/key/runner 前置/candidate 一致性/waiver 证据）

> **本轮更新（第 11 节，commit 2145202/f262137）**：uia 真实 COM 端口实现 + 真机场景 → 7/7 passed。
> 新候选 cand-214520253a（commit 2145202）重跑全场景 → 新 receipt 三件套 → 聚合（--scope win11-only）：
> **passed**（receipt 哈希链重算全过 / waiver 证据哈希匹配 / 7 场景全 passed 附件哈希锁定）。

### 8.5 下一步（精确清单）

1. **~~实现产品 UIA 真实 COM 端口~~**——已完成（第 11 节）：uia 场景转 passed，E 门聚合 **passed**（scope=win11-only + tier=single-display）。
2. 本机 5 门 E 门聚合已达 `passed`（scope=win11-only + tier=single-display 已是合法用户决策档）。
3. Gate I（Linux/macOS worker）与 IME 组合输入仍按计划 blocked/UNVERIFIED——IME 为人工门（scripts/record-ime-verification.mjs），机器不代签。

## 9. Gate I windows-only 用户决策档（2026-08-16，W6-09）

> 用户决策：**「我从始至终只做 Windows 本地 CLI」**。原 Gate I 合同只接受真实 Linux/macOS worker
> receipt（六个 canonical 非 Windows cells 逐 cell build/test/clean-install/CapabilityReport），
> 单机用户面前永远 blocked。本档照 Gate E `win11-only` / W6-08 `single-display` 同款模式收缩：
> 零跨平台 receipt + 哈希绑定的平台范围证据文件背书，六 cells 声明性豁免——只缩范围、不降诚实。

### 9.1 合同与证据链

- `aggregateGateIReceipts(receiptDirs, { scope: 'windows-only', waiverEvidenceFile })`：
  证据文件必须真实在场且 `waivedCells` 与 canonical 六 cell 闭包**逐字相等**（排序后 JSON 相等）；
  缺失 → `GATE_I_WAIVER_EVIDENCE_MISSING`，非 canonical（少项/多项/scope 错误）→ `GATE_I_WAIVER_MISMATCH`，均 fail-closed。
- 证据生产者 `scripts/evidence-platform-scope.mjs`（tsx 实现）→ `artifacts/release-evidence/<runId>/platform-scope/outcome.json`。
- 实跑：本机 `run-gate-i --aggregate-receipts --scope windows-only --waiver-evidence ...` → **passed**（scope 记录 + 六 cells 豁免清单 + waiverReason 落盘）。
- full 档（缺省）行为零变化；produce 路径（win32 → GATE_I_PLATFORM_UNAVAILABLE）不变。

### 9.2 发行元数据对齐（声明即承诺）

- `package.json` 显式 `"os": ["win32"]`——npm 层平台声明（此前未声明 = 隐式宣称全平台）。
- README 增补平台声明段：只做 Windows 本地 CLI；Linux/macOS 未验证、不宣称支持；Windows 专属能力
  （UIA/语音/桌面控制）在非 Windows 平台不承诺可用。

### 9.3 验证

- 测试 +4（canonical 通过 / 缺证据 / 篡改 cells / full 档不变）——w6-03 共 11/11。
- 全量 vitest：296 files / 2155 passed / 0 failed / 10 skipped（typecheck 零错误）。
- 注：全量并行高负载下一次运行出现 1 failed（buildEvidenceDecision 1s verifier 超时 + execFileNoThrow
  时序用例）——隔离运行与空闲重跑全绿，判定为负载性抖动，非本轮改动引入。

## 10. /goal 诚实交付 + 双 Esc 取消轮（2026-08-16，commit 04e320f）

> 范围：计划一轮（5 文件改动 + 3 组新测试）——/goal 命令 fail-closed 验证、双 Esc 取消通道、内核 goalLoop 对齐。
> 结论：全部实现并验证；顺带完成 W8-29 根因更正（7.4）与 full-scene 断言契约修正。

### 10.1 /goal fail-closed（A22 诚实交付，KF-023 语义对齐）

- 完成声明统一 `isCompletionClaim`（含 `[GOAL_DONE]`）+ `✓ 已完成`/`✅` 兼容标记。
- 无产物声称完成 → 输出「未验证」、不判完成、不空转剩余轮次；有产物 → `verifyProject` 真实验证（启动→探活→重启→读回），失败追加警告继续；验证异常不再假绿（修掉 `catch { verified = true }` fail-open）。
- `r.interrupted` → `cancelled=true` 提前退出；无 key 死分支去掉恒假 `!r.ok` 前置（`r.text.includes('未配置模型密钥')` 直接 break）。
- `ctx.agent.run(prompt, { goalLoop: false })`——命令层自循环显式关闭内核 goal 模式内层循环，防 8×10 嵌套（内核 `run` 透传 `opts.goalLoop`，默认 undefined = 现行为，零回归）。

### 10.2 双 Esc 取消（用户需求「按两次 Esc 取消」）

- 纯函数 `src/wxnodus-ui/lib/escCancel.ts`：busy 首按武装（arm）→ 1.5s 窗口内二按确认（confirm）→ 超时/非 busy 复位；窗口同源 `INTERRUPT_COOLDOWN_MS`。
- 接线 `useKeyBindings.ts`：现有 Esc 分支链之后 busy 判定；confirm 走 Ctrl+C 同款 `interruptTurn` 链路；非 busy/overlay 场景零行为变化（会话选择器 Esc 关闭等保持绿）。
- `agent.goal` 事件补 `cancelled`（内核收尾/命令层/网关状态行「✕ goal 已取消」/事件适配/`BgGoal.cancelled` 摘要行「已取消（N/M 轮）」全链路）。

### 10.3 验证矩阵（全部真实运行）

| 门/电池 | 结果 |
|---|---|
| 全量 vitest | ✓ 298 files / 2165 passed / 0 failed / 10 skipped |
| typecheck / typecheck:tests | ✓ |
| git diff --check | ✓ |
| cmd-verify（winpty） | ✓ 14/14 |
| cmd-verify（ConPTY） | ✓ 14/14 |
| full-scene（winpty，fail-closed） | ✓ 28/28 ×2 |
| full-scene（ConPTY，fail-closed） | ✓ 28/28（断言契约修正后） |
| 新测试 | commands-goal 4 + escCancel 5 + ui-background cancelled 映射 1，全绿 |

**不可伪造阻断项（不变）**：Gate E 唯一阻塞项仍是 uia 场景（产品 UIA 真实 COM 端口缺失，见第 8 节）；Gate I windows-only 档见第 9 节；IME 组合输入 UNVERIFIED。goal 状态由 runtime completion verifier 判定，不标记 complete。

## 11. UIA 真实 COM 端口 + Gate E 转 passed + 满分评估轮（2026-08-16，commit 2145202/f262137）

> 范围：按第 8.5 清单实现产品 UIA 真实端口 → uia 场景转 passed → Gate E 聚合 passed；
> 顺带清零评估缺陷寄存器（D1-D5/G1）+ 自包含评分证据包（npm run eval）。
> 结论：**Gate E 聚合 passed（scope=win11-only, tier=single-display）**；uia 场景 6 项真实证据全过。

### 11.1 UIA 真实 COM 端口（生产接线）

- `windowsUiaPorts.ts`（新）：`WindowsUiaDriver` 真实端口装配——每动作重证边界（UserInteractive + OpenInputDesktop 名 + LockApp 锁屏信号 + 目标窗口进程 TokenElevation；探测失败 fail-closed 视高完整性）；invoke/select/coordinateFallback 接真实 PowerShell/UIAutomation 桥（单能力端口——兜底裁决在驱动层按边界进行）。
- `tools.ts`：`computer_uia_act` 工具（边界裁决动作，受保护/锁定/高完整性 fail-closed 绝不坐标回落）。

### 11.2 真实缺陷修复（原阻塞根因——全部真实定位，非猜测）

| # | 缺陷 | 实测定位 |
|---|---|---|
| U1 | PS5.1 `ConvertTo-Json` 对裸数组序列化形状不定（`{"value":[...]}` 或 `[[...]]`）→ 窗口枚举永远空 | 改显式 `{windows}/{elements}` 字段契约 |
| U2 | tree 动作句柄参数 off-by-one（args[1] 读的是空）→ 恒回落焦点窗口 | args[1]→args[0] |
| U3 | WPF 虚拟化元素 BoundingRectangle=∞/NaN → `[int]` 转换抛异常 | 坐标钳制 |
| U4 | `Add-Type -MemberDefinition` 生成类型不可寻址（编译成但找不到类型） | 改 `-TypeDefinition` 显式类 |
| U5 | 形参 `$Pid` 撞 PowerShell 只读自动变量 → 函数绑定静默失败、函数体永不执行（目标完整性恒 null） | 形参改 `$procId` |
| U6 | `[IntPtr]::TryParse` 本机 .NET 不存在 | 改 `[int64]::TryParse` + `IntPtr::new` |
| U7 | `[ref]` 绑 `out uint` 需显式 `[uint32]` 类型变量 | 显式类型 |
| U8 | 边界探测 args 赋值拼在探测体之后（JSON 输出之后才执行） | args 前置 |
| U9 | WPF TextBox 的 ValuePattern.SetValue 静默失效（ok:true 但文本不落） | 值步骤改 notepad 真实 Document 控件（Win32 RichEdit，SetValue/GetValue 稳定） |
| U10 | `Start-Process notepad`（名字形式）本机报「无法完全运行」；-PassThru pid 与窗口宿主 pid 不同 | 全路径启动 + PID 差集清理（不误杀用户自开 notepad） |

### 11.3 uia 场景（全部真实执行证据）

WPF fixture（真实 Invoke/Selection 模式）+ notepad（真实 Value 模式）+ 生产代码路径（tsx）驱动 + 文件握手判定（PS5.1 管道/编码不参与判定）：

| 记录 | 结果 |
|---|---|
| invoke（WPF Button，InvokePattern） | ✓ receipt `uia-invoke-...` |
| value（notepad Document，中文原生 SetValue） | ✓ |
| value-readback（ValuePattern 真实读回） | ✓ 「中文native」逐字一致 |
| selection（WPF ListBox item，invoke 端口无模式 → 驱动转 select 端口） | ✓ receipt `uia-select-...` |
| selection-readback（echo 文件端到端） | ✓ 「Beta」 |
| no-action-fail-closed（不存在元素） | ✓ UIA_ACTION_NOT_PERFORMED（绝不假成功） |

受保护/锁定/高完整性边界：单元契约覆盖（driverContracts ×5 / failure ×5 / windowsUiaPorts ×12）——本机无法在不弹 UAC/不锁屏下真实强制，如实标注。

### 11.4 Gate E 全链路（本轮真实重跑）

- 候选：cand-214520253a（commit 2145202，tgz SHA-256 绑定）
- 全场景 7/7 passed（preflight/computer-multimonitor/browser/voice/build-restart-readback/emergency-stop/uia）
- receipt 三件套（core→manifest→index）→ 聚合（--scope win11-only）：**passed**（哈希链重算全过 + waiver 证据匹配 + 附件哈希锁定）

### 11.5 评估证据包与遗留

- `scripts/eval-report.mjs`（npm run eval / eval:full）：10 维阈值自动判分（同一证据同一分数，任何评估者可重跑复核）→ `artifacts/eval-report.md/.json`。
- IME 人工门：`scripts/record-ime-verification.mjs`——真机候选窗验证由真人执行记录，机器不代签。
- 检测器转正向活性检测（winpty 1/s 整行 / ConPTY 空闲 1/10s CUP，实测节拍）。

**不可伪造阻断项（更新）**：Gate E 已 passed（win11-only 档）；Gate I windows-only 档见第 9 节；IME 组合输入 UNVERIFIED（人工门）。goal 状态由 runtime completion verifier 判定，不标记 complete。

## 12. 独立密码学审计 + IME 中文输入真机验证轮（2026-08-16，冲刺 9.9）

### 12.1 密钥加密独立审计（AES-256-GCM 实现审查，src/kernel/providers.ts:14-31）

审查范围：`encryptKey`/`decryptKey`（settings.apiKeyEnc 加密槽位）+ 全部 crypto 调用点（全仓仅 providers.ts 两处 + handlersExt.ts 随机 token 一处）。

**结论：实现正确（无可利用缺陷），威胁模型有限制（如实记录）**

| # | 检查项 | 结果 |
|---|---|---|
| A1 | 密码原语 | AES-256-GCM（认证加密）✓；IV = `randomBytes(12)` 96 位随机 ✓（GCM 推荐长度，非计数器——无复用风险）；认证标签 `getAuthTag()` 存盘、解密 `setAuthTag()` 校验 ✓（篡改即解密失败 fail-closed） |
| A2 | 密钥派生 | `scryptSync(machineFingerprint(), 'wxnodus-v3', 32)`（默认 N=16384/r=8/p=1）。**限制（真实发现）**：盐 = 主机名+平台+架构+用户名，口令 = 硬编码常量——两者均非机密，同机任何进程都可重导出 KEK。该槽位保护的是「拷贝到别机」场景（防搬运），不是同机恶意进程（防窥）。 |
| A3 | 明文纪律 | 明文密钥仅在内存（decryptKey 返回即用）；settings.json 只存 `enc1:iv:tag:cipher` 密文 ✓；`/key set` 回显长度不回显明文（commands/handlers.ts:271-289）✓ |
| A4 | 随机源 | `randomBytes`（CSPRNG）用于 IV 与 token 生成 ✓；无 Math.random 涉密 |
| A5 | 改进项 | Windows 同机更强的标准解是 DPAPI（`CryptProtectData` CRYPTPROTECT_UI_FORBIDDEN，绑定用户凭据）——列为后续增强，不做本轮改动（换 KDF 会使既有加密槽位失效，需迁移路径） |

**判词**：静态面合规（红线模块/环境净化/证据店在场 + compliance 测试绿）之上，本轮完成独立审计——实现层面零缺陷、威胁模型明确（本地 CLI 防搬运/防明文落盘，与同类 CLI 定位一致）、限制项如实记录。此前 7.0 封顶的「未做独立密码学审计」条件已解除。

### 12.2 IME 中文输入真机验证（真实 conhost，WriteConsoleInputW 通道）

**环境边界（诚实记录）**：本机游戏反作弊拦截跨进程键注入——SendInput 返回 0 + ERROR_INVALID_PARAMETER(87)、keybd_event 无效果（`artifacts/ime-evidence/injection-blocked.json`）。真实 TSF 候选窗需真人真机（人工门，见 11.5）。

**替代通道（同 OS IME 提交后投递应用的同一通道）**：`scripts/ime-console-inject.ps1` 起真实 TUI 窗口（conhost）→ `FreeConsole`+`AttachConsole(TUI)` → `CreateFile("CONIN$")` → `WriteConsoleInputW` 写入 Unicode KEY_EVENT（你好 + Enter）→ 读取 conhost 活动屏幕缓冲全文存证。

| 证据 | 结果 |
|---|---|
| 屏幕缓冲快照（conhost 活动缓冲 = TUI 渲染确定性快照） | ✓ 输入行 `❯ 你好`（宽字符 leading/trailing 格校验通过，见 12.3） |
| 落库（nodus.db user 消息） | ✓ 「你好」×6 条真实持久化 |
| GLM-4V 视觉核验（receipt） | ✓ `artifacts/ime-vision-verification.json` status=passed（截图被全屏游戏遮挡时如实降级为佐证，主证据走屏幕缓冲+DB） |
| 编排 receipt | `scripts/ime-unicode-inject.mjs` → `artifacts/ime-unicode-injection.json` |

**结论**：TUI 对多字节 UTF-8 控制台输入的上屏渲染→提交→回显→落库全链路真机通过；候选窗人工门维持（真人 30 秒可核，`scripts/record-ime-verification.mjs`）。

### 12.3 本轮真实缺陷修复（IME 验证过程中发现并修复）

| 缺陷 | 根因 | 修复 |
|---|---|---|
| **真实 conhost 下 Enter 失灵**（快打/批量读时 `\r` 与文本同一 chunk，被 parseKeypress 当普通输入吞掉——Enter 不提交） | packages/wxnodus-ink 解析器只认独立 token 的 `\r`/`\n` | `parse-keypress.ts`：① 文本 token 拆分尾随 `\r\n`/`\r`/`\n` 为 return 键；② parseKeypress 补 `s === '\r\n'` → return。+ 6 个新单测（parse-keypress.test.ts，20/20） |
| SendInput 采集脚本伪证风险（截图后无条件标 passed） | 原 ps1 无内容核验 | 重构为「采集=status captured，内容核验归 GLM-4V 核验脚本」+ 前台/窗口定位失败即 blocked |
| 窗口定位误中僵尸窗/0x0 窗 | 残留 conhost 僵尸窗口 + MainWindowHandle 不可靠 | 起前清理残留 + MainWindowHandle 主通道（rect>0 校验）+ conhost 父子关系枚举兜底 |
| 屏幕缓冲读取宽字符重复 | 尾格 COMMON_LVB_TRAILING_BYTE(0x0200) 未跳过 | ReadBufferText 跳过 0x0200 尾格 |

## 13. 全量修复轮：密钥槽错配 + 文档漂移 + 公共化去重（2026-08-16）

### 13.1 密钥槽与多 provider 目录错配（缺陷 1，真实修复）

**根因**：settings.apiKeyEnc 是单一加密槽，而 MODEL_CATALOG 是 5 provider 目录（deepseek/kimi/zhipu/offline）。智谱密钥存单槽 + model=deepseek → `resolveApiKey` 把智谱密钥当 deepseek 密钥发往 api.deepseek.com → 每次对话 401 且无提示。

**修复（向后兼容）**：
- `settings.apiKeys.<provider>` per-provider 加密槽（`/key set` 按当前模型 provider 归属写入）
- 遗留单槽 + `settings.keyProvider` 归属标注：归属不符 → `resolveApiKey` 返回 `{error:'provider-mismatch', hint}` fail-closed（不误发、明确提示「重配或 /model 切换」）
- 消费方更新：agent.ts（错配提示直出）、/key（状态含归属 + 各 provider 解密状态）、/doctor（resolveApiKey 口径）、vision.ts（视觉默认端点优先取 apiKeys.zhipu）、SETTINGS_KEYS 白名单、knownSettingsKeys 排除 apiKeys
- 本机迁移：data/settings.json → keyProvider=zhipu + apiKeys.zhipu（deepseek 模型下不再 401）
- 测试：resolveApiKey 6 用例（槽命中/错配 fail-closed/归属匹配/无归属零回归/槽优先/env 优先）——kernel-providers 33/33

### 13.2 文档漂移同步 + 证据脚本公共化

- README 数字与实现同步 ×4：规则脑 47（原 48，spec.ts RULES 实测 47）、内核工具 44（原 43）、测试 2187→2194（原 838）、命令 108（原 105/106）
- **公共库（减轻负担）**：
  - `scripts/lib/evidence.mjs`——sha256File/gitCommit/stripAnsi/runCmd/repoRoot：eval-report、ime-vision-verify、ime-unicode-inject、ime-human-watch、record-ime-verification 五脚本去重（同口径取数）
  - `scripts/win-common.ps1`——C# P/Invoke 类型（WxWin）+ 截图/窗口/键流/控制台工具：ime-console-inject、ime-sendinput-verification、ime-capture-candidate、diag-windows 四脚本去重（每脚本 -60~80 行样板）
  - 重构后全链路回归：ime-console-inject → ime-vision-verify status=passed（屏幕缓冲 hasNihao + DB 你好 + 视觉佐证）
- 缺陷寄存器新增 4 项 ✅（eval-report 生成时并入）

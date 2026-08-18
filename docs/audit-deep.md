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

### 13.3 功能上限提升轮（不做离线方向；代码优化 + 域覆盖扩充）

- **启动就绪真优化（去串行化）**：main() 装配链（taskRunner/term/plugins/handlers/sessionStart/download/ssrf 共 12 个动态 import）由串行 await 改为一次 Promise.all 分组——就绪实测 **3.0-4.3s → 1.7s**（×3 中位，eval perf 探针同口径复测 1.7s）
- **规则脑域覆盖 47 → 60**：+13 域（宠物/租车/招聘/捐赠/票务/家教/维修/志愿者/讲座/外卖/预约/租借/家政），零新增模具成本；`RULE_PATTERNS` 导出契约锁定（≥60）+ 13 命中用例（tests/build-spec.test.ts 21/21）
- **IME TSF 候选窗人工门闭环**：真人真机输入落库（nodus.db id=3809「你好？」，全角问号为微软拼音转换特征）——`artifacts/ime-verification.json` 人工 receipt 生成（sha256 绑定 + DB/守望/屏幕缓冲证据标注）；候选窗为真人现场见证、守望 250ms 轮询未截到弹窗帧（如实标注）

### 13.4 联网搜索+内容能力轮（对标现代 coding 工具）

用户反馈：/search 只能拿标题+摘要，无法下载/获取网页内容——与现代 coding 工具的「搜索即读」差距明显。

- **extractMainText（readability 式正文提取，src/kernel/html.ts）**：噪音块剥离（script/style/nav/footer/header/aside/form/iframe）→ 块级换行 → 行评分（长度+标点密度+CJK）→ 预算内取高分块按原文序输出——导航/页脚/广告噪声不入结果（+4 单测，kernel-html 17/17）
- **searchWebWithContent（src/kernel/search.ts）**：搜索后对前 N 条结果并发抓正文（6s 超时/条，失败降级保留摘要）——`/search <q> --content [N]` 搜索即读
- **/claw JS 渲染兜底**：静态抓取 <200 字符 → Playwright 无头渲染拿正文（复用既有 browserNavigate）；正文提取同样走 extractMainText
- **http_get 工具**同步升级：正文干净度优先（extractMainText → htmlToText 兜底）
- 真实网络冒烟：`/search 今天新闻 --content 1` → bing 引擎 8 条真实新闻 + 正文抓取成功（cctv/tophub 正文实测可读；toutiao 等 SPA 页如实返回可提取部分）

### 13.5 「工具跑完无输出」缺陷修复（模型对齐）

用户复现：评估请求完成 35 个工具调用全部成功，但最终回合「没有输出结果」。

- **根因**：本地会话处于 provider 错配循环——智谱密钥（zhipu 槽位）配 deepseek 系模型 → `provider-mismatch` 提示互相循环，模型消费提示文本后未产出实质回复（会话历史 DB 消息 3835-3846 循环印证）
- **修复**：
  - `MODEL_CATALOG` 补入 `GLM-4 Flash`（zhipu 系，`glm-4-flash`）——zhipu 密钥下有可用目录项可选（glm-4.5 实测 HTTP 429 余额不足，glm-4-flash HTTP 200）
  - 本地配置对齐：`model=glm-4-flash` + zhipu baseURL，错配提示链条解除
- **验证**：无头复现 `-p "评估 wxnodus CLI 并列出与同类型 CLI 的差距…"`（工具搜索对比资料）→ exit 0 + 实质最终文本（特性/差距结构化输出，非空）；错配路径的 hint 已指向「/key set 重配 或 /model 切换 provider 系模型」双出口

### 13.6 电池环境耦合 + 通告持久化缺陷（eval 掉 6.93 的根因链）

对齐修复后复跑 eval:full 掉至 6.93（tests/battery/render 三维 0.0）——追出四条根因链，全部修复后 9.90 复归：

- **目录契约断言漂移**：`MODEL_CATALOG` 补 GLM-4 Flash（12→13），`tests/kernel-providers.test.ts` 计数断言未同步——12→13（两处）。
- **电池与评估者环境耦合**（主根因）：full-scene 断言硬编码「无 key/deepseek」基线——本机真实智谱密钥+glm-4-flash 后 TUI 走线上模型，7 项断言（状态条模型词/规则脑 /key 提示等）与环境绑定。修复：三个电池脚本统一**洁净间数据目录**（`WXNODUS_DATA_DIR=artifacts/battery-cleanroom` + `WXNODUS_LANG` 跳过首启语言 onboarding）——电池验证的是终端管线机械性，必须与密钥/模型解耦；线上模型路径由无头 -p 复现与真人使用覆盖。任何评估者重跑同证据同分数。
- **时钟改写形态随布局漂移**：状态栏时钟改写列随模型名宽度漂移（glm-4-flash 下 CUP 列=18，检测器锁死 32-39）且形态三变（`\b<digit>`/`\x1b[29;<col>H<digit>`/winpty 整行）——两个脚本的正则扩展为不锁列号 + 三形态全收（fail-closed 保留：未知形态仍判异常）。
- **通告永久占据动词槽**（产品级缺陷，W8-29 契约破坏）：curator/定时任务等一次性通告缺省 sticky 且无清除方——动词槽被「自动审查完成」永久顶替、空闲时钟消失（首跑必现）。修复：`eventAdapter` 缺省 kind 改 `ttl`、`flowController.applyNotice` 缺省 8s 自过期（显式 `sticky` 仍可常驻）——动词槽自动归还就绪+空闲时钟（+2 单测：缺省 ttl 自过期 / sticky 常驻）。
- **证据行取 stdout 末行**：eval-report lastLine 曾取 stderr（node-pty 控制台清单 agent AttachConsole 非致命噪音）——证据展示失真，改为 stdout 末行（判分本就走 exit code，不受影响）。
- 修复后 eval:full（洁净间首跑，即新评估者首跑路径）：vitest 2202 绿 · cmd-verify 双管线 14/14 · full-scene 双管线 28/28 · 时钟检测器双管线 GREEN · 首帧 0.04s/就绪 2.1s——**9.90/10 全维 9.9**。

### 13.7 回合闭环缺陷（「35 工具调用后无输出」真根因——贬低视角复盘）

用户真实 cmd 环境复现：评估请求 35 个工具调用全部成功（Todo 35/35），但最终「没有输出结果」——逻辑不闭环。逐层追出两条系统性缺陷（非环境、非偶发）：

- **提前 return 不发 agent.message/agent.end**：4xx/重试耗尽/未知工具/连续失败/循环检测五条早退路径 `return { ok:false, text }`——但网关只在 `agent.end` 时发布最终消息（message.complete），`agent.message` 才是文本投递通道。结果：所有错误文本从未到达 UI（C8 注释声称「错误路径也发 agent.end」，实现只覆盖尾部路径，早退全部漏发）。
- **轮次耗尽静默空文本**：`while (turns < MAX_TURNS)` 退出后 `finalText=''` → 静默 `return { ok:false, text:'' }` → UI 无任何渲染。用户 35 次工具调用 = 批量 tool_calls 跨 ≤16 轮，恰好顶满轮次上限。
- **修复**：
  - `finishEarly` 统一闭环 helper——所有早退路径必发 `agent.message`（文本）+ `agent.end`（回合终结事件），错误文本真正可见
  - 轮次耗尽兜底：未中断且无最终文本 → **无工具强制总结调用**（tools:[]，模型把已执行工具结果收敛为答案）；总结失败 → 显式失败文案（「轮次上限…建议 /rewind 拆分子任务」）——**绝不静默空输出**；`ok` 对兜底文案强制 false（不冒充成功）
  - MAX_TURNS 16→32（批量调用下探索类任务有余量自然收敛）
- **确定性回归（客观契约，非主观评分）**：`scripts/loop-closure-test.mjs`——本地 mock OpenAI SSE 服务前 32 轮只回 tool_call（真实 ls 调用、参数轮换避开循环检测），逼内核轮次耗尽 → 断言真实 TUI 渲染出第 33 次强制总结的最终答案且状态回归就绪。已接入 eval battery 维度（fail-closed：静默空输出 = 电池红）。
- **工具调用浪费止血（同轮贬低复盘）**：用户 35 次调用中 7× Ls、5× Web Search、4× Command Search 大量同参重复——新增**回合内读工具结果缓存**（ls/grep/find_files/fs_read/web_search/http_get/repo_map/memory_search/command_search/tool_search）：同参重复读调用合并返回缓存 + 「已缓存」标记（提示模型无需重跑）；任何写/执行类工具（bash/fs_write/fs_edit…）执行后整体清空——缓存绝不跨写失效（+2 单测：缓存命中标记达模型上下文 / bash 清空后真实重执行）。与循环检测（同参 ≥3 终止）协同：先合并止血，再终止空转。
- **验证**：+3 单测（耗尽收敛/总结失败显式文案/4xx 早退事件可见）kernel-agent 56/56；回合闭环电池 exit 0（mock 33 次调用，最终答案渲染 true）；真实 zhipu 端点 -p 复现用户同款 prompt → 完整最终答案。

### 13.8 全方位 UX 对比轮（贬低视角 + 联网竞品调研）

用户要求：与同类型 CLI 全方位对比（代码/逻辑/功能），着重用户体验问题，循环修复。

- **竞品调研**（联网 agent，2026-08 事实）：Claude Code v2.1.x / Codex v0.147 / aider / Gemini CLI（已停更）——交互语言已收敛（斜杠补全/提及/Shift+Tab 模式循环/Esc 语义）；回滚人人都有（Claude Esc-Esc 回检查点）；上下文可见性各家分层；**四家无一 Windows 原生**。
- **产出**：`docs/ux-comparison.md`——竞品 UX 基准 + wxnodus 实测盘点（电池陷阱注释 = 真实缺陷记录）+ 逐维度矩阵 + 12 项缺陷清单（严重度排序）。
- **修复**：
  - **空闲 Ctrl+C 误杀会话**（缺陷 2）：`useKeyBindings.ts`——原直接 die()（pty 下曾渲染永久停摆），改为无操作 + 一行提示（Ctrl+D//quit 退出）——对齐 Claude Code 无害语义；busy 中断/有文本清行不变。
  - **丢字竞态复测**（缺陷 3/4）：ASCII 与 CJK 在 5ms/字符（超人类速度）双管线均零丢字——parse-keypress 批次读取修复（§12.3）已根治；电池 200ms 慢速保留为 CI 确定性余量（陷阱注释更新口径）。
- **遗留清单**（ux-comparison.md §4）：diff 语法高亮、#/@ 提及、Shift+Tab 模式循环、Ctrl+R 历史搜索、Esc-Esc 语义与 Claude/Gemini 相反（wxnodus 为中断确认）、/cost 累计——按序追债。

### 13.9 真实 cmd 环境 UX 审计（用户「体验真的很差」的实证根因）

用户反馈「使用体验真的很差」——电池全绿但真实 cmd.exe（conhost，cmd 档）体验差。停用自评，改为**真实环境取证**：`scripts/cmd-audit.ps1`（真实窗口 + WriteConsoleInputW 驱动 + 屏幕缓冲/截图四帧），截图经 GLM-4V 识别（ZCode 会话不嵌图——deepseek-v4-pro 拒收 image_url，识别走 wxnodus 自身 glm-4v-flash）。

- **取证结果**：启动/品牌面板/状态栏/CJK 输入/回复渲染全部正常（屏幕缓冲 + GLM 双重确认）；**但真实提交「hello」时 glm-4-flash 选中了演示插件工具 `example_greet`（/plugin new 脚手架产物）→ 弹出审批面板阻塞会话**——这正是「体验差」的实证根因：示例工具暴露给模型 + 廉价模型优先选低成本闲聊工具 + 写类工具审批阻塞 = 用户第一句话就卡住。
- **修复（演示工具对模型隐藏）**：
  - `ToolDef.demo` 标记 + `plugins.ts` 从 plugin.json `demo:true` 透传 + `/plugin new` 脚手架工具标 demo
  - `agent.ts` 过滤：demo 标记 或 遗留 `example_` 前缀 → 不进模型 toolList（不注入 schema、不可调用）；`WXNODUS_INCLUDE_DEMO_TOOLS=1` 逃生门（plugin-smoke 等演示脚本）
  - 用户现有 `data/plugins/example/plugin.json` 的 example_greet/example_echo 补标 demo:true（数据目录实时修复）
  - plugin-smoke 两处陈旧断言修复（命令输出文本/审批面板中文文案——先于本轮已坏）+ 显式 process.exit 防挂起
- **+2 单测**（demo 标记与 example_ 前缀不进 toolList / 逃生门恢复）kernel-agent 60/60。
- **复测（真实 cmd）**：hello → 直接文本回复「你好！我是 WxNodus…」+ 状态回归就绪 + GLM 确认无视觉缺陷——审批阻塞路径消除。

### 13.10 接入层开放收官轮（余额耗尽前持续完善 2026-08-17）

用户目标：持续完善直至余额耗尽——本轮按「ZCode 真实事故 + ux-comparison 债单 + 接入层 UI 闭环」三条线推进，每轮全量回归（2293 通过 / tsc 零错误）+ 逐项提交。

- **image_url 400 防御纵深（ZCode deepseek-v4-pro 真实事故根除）**：
  - 事故：messages[678] unknown variant `image_url`——纯文本模型收到多模态内容块 400（TraceID 0577747b 留证）。
  - `providers.ts`：`imageStrategy` 三态纯函数（无图→none 零视觉调用 / 视觉模型→inject / 文本模型→describe 视觉通道先识别）；`hasImageIn` 名称启发式（档案自定义视觉模型 gpt-4o/qwen-vl/gemini/claude/llava/moondream…识别，未知默认文本——安全方向）。
  - `agent.ts`：图片注入能力门收敛到 agent 环（视觉模型注入 parts；文本模型 describeImage 识别为文本注入 prompt；无 key 诚实丢弃 + system.notice + 审计 agent.image.described/dropped）；历史装载 contentToText 清洗（dataUrl 绝不进 API 消息）；识别文本同步入历史（与视觉模型异步摘要两条路径对等）。
  - `vision.ts`：自动降级路径 `visionOcr:false`（聊天回合内不 spawn PowerShell OCR；显式 /vision 保留 OCR 兜底）。
  - `wxGateway`：图片门移除（策略收敛 agent 环，全部 caller 一致防御）。
  - +12 测试（策略矩阵/启发式/历史文本化/网关透传契约/agent inject-describe 端到端）。
- **ux-comparison 12 项债单清仓**：#3/#5 复测口径修正（2026-08 证据 5ms/字符双管线零丢字）；#4 TextInput 常驻挂载根除 overlay 恢复窗口（卸载重挂监听注册窗口是陷阱 5 真根因）；#6 代码复核（Enter 恒提交原文即建议行为）；#7 diff 语法高亮（diffHighlight 行分类 + messageLine 着色，超长降级不丢内容）；#8 @文件提及（kernel/mentions 展开 + complete.path @补全 + CLI 同链路）；#9 Shift+Tab 六模式循环 + Ctrl+R 反向历史搜索 overlay；#10 Esc-Esc 中断指路 /undo 回滚（Claude 肌肉记忆等价出口）；#11 /cost 会话/区间成本估算 + 状态栏 $ 成本段真实化。
- **接入层 UI 闭环**：`/model` 直达档案模型（命中切 activeProvider+baseURL）+ modelOptions 档案 provider 分组（选择器可见可选）；`/doctor` profileHealth 档案一致性检查（悬空 active/重复 id/非法 baseURL）；`/status` 一览档案/余额监控/本会话成本。
- **SETTINGS_KEYS 白名单补齐（自伤误报根除）**：providers/activeProvider/usageRange/balanceMonitor/show_cost/autoGitCommit/vision*/proxy 等系统写入键此前不在白名单——`/config` 面板把系统自己的键报为「未知键（不生效）」；补入 + 回归测试锁死。
- **验证**：全量 2293 通过（+28 测试）；cmd-sweep 122/122（/cost 两形态入列）；tsc 零错误。

### 13.11 余额耗尽终局护栏轮（2026-08-17 持续完善）

用户目标「持续完善直至余额耗尽」的自我保护闭环——把「烧到没钱」从事故变成显式可停的状态：

- **低余额预警**：`numericBalance` 宽容解析（¥/$/千分位）+ `lowBalanceDecision` 状态机（低于阈值且未通知 → sticky warn；回升重新武装——防刷屏且可重复提醒）；阈值可配 `/balance threshold <数值>`（默认 5）。
- **余额耗尽自动停**：`/balance auto-stop on` 后网关每次余额抓取把「实测 ≤0」写入运行时态 `settings.balanceEmpty`（不落盘）→ agent 环同步门控（与 budgetStop 同款 finishEarly 显式失败闭环：agent.message/end 事件可见、零模型调用）→ 充值后余额回升自动恢复；耗尽发 sticky error 通知。
- **会话预算硬停**：settings.budgetStop=true 时超 budgetTokens 硬停（此前仅告警）——同步门控置于首个模型调用前（首调也不放过），finishEarly 显式失败。
- **成本护栏配套**：costPrices 自定义价目（中转站/私有定价档，adapter 与 /cost 同源）；/usage --waterfall [today|7d|30d] 区间瀑布；usage_stats 会话/时间索引（聚合查询不再全表扫描）。
- **说人话直达**：NL 触发「成本多少/花了多少钱 → /cost」「余额还有多少 → /balance status」；token 用量双向匹配（用了多少 token）。
- **验证**：全量 2314 通过；cmd-sweep 124/124（+threshold/auto-stop 两形态）；full-scene 28/28 + cmd-verify 14/14 真机电池复测（TextInput 常驻挂载等 UI 改动在真实 pty 上无回归）；tsc 零错误。

### 13.12 工具诚实性与观测补强轮（2026-08-17 持续完善）

- **静默截断清剿**：fs_read（20000）/grep/http_get×2（8000）/wx_cmd（2000）超长输出此前静默切片——模型误以为「内容到此为止」，改统一显式标注（共 N 字/剩余 M 字 + 续看指引：bash tail / 收窄搜索 / /claw / 重定向分片）。+2 测试（fs_read 长短双路径）。
- **视觉同屏去重**：describeImageStatus LRU(1) + 10s TTL（computer_observe 静止画面循环观测同图秒回，零重复视觉 API；prompt 不同/超时自然失效）；cached 标记透传 /computer observe 与 computer_observe 工具输出（诚实告知「10s 内相同画面未重新识别」）。+2 测试。
- **截图即问**：Ctrl+Shift+P 一键全屏截图 → 附件落盘 + pending 登记（下次提问经能力门：视觉模型注入 parts / 文本模型 GLM 先识别）——/capture→/img→提问三步合一；无图形环境诚实失败。+1 测试（真实图形环境成功路径实测通过）。
- **回合结算即时成本**：agent.end 的 message.complete 携带会话实时 usage（含 cost_usd）——状态栏 $ 不再等下次 session.info 才刷新。
- **验证**：全量 2319 通过；tsc 零错误。

### 13.13 余额目标观测面收官轮（2026-08-17 持续完善）

「持续完善直至余额耗尽」的观测面全部落地——钱的状态在命令面/面板/状态栏三处同源可见：

- **/sessions 非交互列表成本列**：每会话成本估算（全部模型有定价才显示；costPrices 覆盖同源）。
- **会话切换面板成本列**：adapter sessions.list 每会话聚合（N+1 有界 ≤50 行防查询爆炸）→ active_list/session.list 透传 → ActiveSessionSwitcher $ 列（accent 色，未知省略）。
- **状态栏 💰 低余额红色警示**：balance.status 响应带 low 标记（低于阈值）→ 段着色优先级 低余额红 > stale 黄 > 正常青——一眼可见钱快没了。
- **/capture --attach**：命令层与热键（Ctrl+Shift+P）共享 pending 契约（提取 kernel/imagePending.ts 单一事实源，防 UI/命令层契约漂移）；截图即附加提问，区域切片同样适用。+2 测试（含幽灵路径诚实 null）。
- **验证**：全量 2322 通过；cmd-sweep 125/125（+/capture --attach）；full-scene 28/28 + cmd-verify 14/14 双电池复测（会话面板/状态栏改动真机无回归）；tsc 零错误。

### 13.14 工具诚实截断三件套 + 余额观测面闭环轮（2026-08-17 持续完善）

- **工具结果诚实截断三件套**（截断→收窄→续查的完整闭环，模型不再误判「内容到此为止」）：
  - `fs_read`：offset/limit 按行分页 + 尾部行号标注（offset=N 续读）；超长文件显式标注共 N 字/剩余 M 字
  - `grep`：head 参数（缺省 200 行），超限标注匹配总数 + 收窄指引
  - `ls`：head 参数（缺省 200 条），大目录标注条目总数 + 分段指引
  - web_search 已有 max_results（盘点确认，无需改）
- **余额观测面闭环**：状态栏 💰 低余额红色警示（low 标记 → 着色优先级 低红 > stale 黄 > 正常青）；会话切换面板 $ 成本列（adapter N+1 有界 ≤50 行）；/sessions 非交互成本列；/goal 启动护栏明示（auto-stop/budget 状态，无护栏提示开启命令）；📊 区间轮换点击反馈；/capture --attach（命令层与热键共享 kernel/imagePending 契约）。
- **说人话**：README 表 + NL 触发「成本多少→/cost」「余额还有多少→/balance status」（契约测试锁定）。
- **验证**：全量 2326 通过；tsc 零错误。

### 13.15 模型调用健壮性与成本选型轮（2026-08-17 持续完善）

- **429 同模型退避重试（一次）**：瞬时限流尊重 Retry-After（上限 10s）自动重试，连续 429 才走降级链/报错——档案/自定义端点（无备选模型）也能扛瞬时限流；每调用只重试一次（防重试风暴）。降级链测试更新为新契约（先退避后降级）。
- **反限流节流**：web_search 1.5s / http_get 800ms 最小间隔（minIntervalSince 纯函数）——模型连发搜索/抓取不触发引擎 429/封禁。
- **成本敏感选型**：模型选择器与 /model 目录列表显示参考价目（USD/1M，免费/未收录三态诚实）；/cost 面板补 token 用量汇总行；/digest 摘要带本会话成本。
- **验证**：全量 2330 通过；full-scene 28/28（选择器改动真机无回归）；tsc 零错误。

### 13.16 costQuery 单一事实源收官轮（2026-08-17 持续完善）

- **成本 SQL 去重三处**：/context、/digest、/arena 原来各内联一份 `usage_stats GROUP BY model` SQL + costSummary 拼装，语义漂移风险（且 /context 一处 import 缺失 costText 已属编译隐患）。全部改为共享助手 `sessionCost`/`rangeCost`/`costText`——与 /cost、状态栏、/sessions 同一 SQL 事实源；costText 统一「$x.xxxx / $x.xxxx 起（N 个模型未收录定价）」口径，绝不显示被低估的数字。arena 保持原诚实口径（有未收录定价模型时整体省略 $）。
- **修复 import 缺口**：handlersExt.ts 补 `costText` 导入（此前 /usage range 已用而未导，tsc 悬空风险）；移除 costSummary 残留导入。
- **验证**：全量 2331 通过；tsc 零错误。

### 13.17 截断四件套补全轮（2026-08-17 持续完善）

- **labelTruncate 单一事实源**（新 kernel/truncate.ts）：统一标注口径 `…[已截断（共 N 字，剩余 M 字未读）——续查提示]`——任何面向模型的截断都显式告知有剩余，绝不静默（§13.14 三件套同源口径收口）。
- **补全三处静默截断**（审计扫出）：
  - `delegate` 子代理输出：原 `slice(0, 4000)` 静默——模型会误判「子代理只说了这些」而漏掉关键结论。现标注 + 指引（goal 要求精简/拆分子任务）。
  - `browser_snapshot`/`browser_click` 正文快照：原 `slice(0, 2500)` 静默；click 原对外层整体 `slice(0,1500)` 连标题/URL/交互元素清单一起切。现 `cleanBodyText` 只截正文并标注，click 用 1200 限正文、标题/URL/交互清单完整保留（比旧行为信息量更大且诚实）。
  - `memory_search` 命中条目：原每条 `slice(0, 300)` 静默。现逐条标注共 N 字。
- **验证**：+8 测试（labelTruncate 纯函数 ×3、delegate 长短 ×2、browser cleanBodyText ×2、memory_search 超长条目 ×1）；全量 2339 通过；tsc 零错误。

### 13.18 Computer Use 输出诚实性轮（2026-08-17 持续完善）

- **computer_observe**：视觉描述原 `slice(0, 1500)` 静默——模型以为屏幕描述到此为止。现 labelTruncate 标注 + 指引（computer_uia_tree 读精确元素结构）。
- **computer_uia_windows**：原静默截前 30 个窗口（总数不明）。现标注 `共 N 个窗口，已截断（前 30 个）` + 直达目标窗口指引。
- **computer_uia_tree**：原**无上限**全量输出——密集窗口（资源管理器/设置页）数百元素直接上下文爆破。现有界 60 项 + 总数标注 + `computer_uia_find <名称>|<AutomationId>` 定位指引。
- **验证**：+4 测试（uia_windows 超限/不超限 ×2、uia_tree 超限/不超限 ×2，vi.mock uia 桥）；全量 2343 通过；tsc 零错误。

### 13.19 用量缺失诚实统计轮（2026-08-17 持续完善）

- **根因**：端点未返回 usage 的调用此前完全不落 usage_stats——调用计数漏记、成本静默低估（无任何提示）。
- **修复（诚实口径：调用数真、token 数不虚高、成本不误标）**：
  - agent 每次模型调用都记账：无 usage 时记 0 token 行（预算检查仍只在有 usage 时触发）。
  - `usageSummary.unmeasured` 新口径：0 token 行单独计数——/usage 与 /usage range 显示「N 次端点未上报用量（不计入 token）」。
  - `sessionCost`/`rangeCost` SQL 排除 0 token 行——未上报用量的模型绝不出现「$0（免费/离线）」误标。
  - `renderWaterfall` 0 token 行 NaN 防护（原 `0/0` 产生 NaN bar）+ 显式「（端点未上报用量）」行——绝不伪装成 ≈$0。
- **验证**：+4 测试（usageSummary unmeasured、sessionCost 排除 0 行、rangeCost 全 0→null、waterfall 0 token 行）；全量 2347 通过；tsc 零错误。

### 13.20 usage 数据源收敛 + 状态栏未上报标记轮（2026-08-17 持续完善）

- **单一事实源收敛**：tuiPresentationAdapter.usageRange 原来内联一段自己的 SQL + 区间算法（与 kernel/usage 漂移风险）。改为直接调用 `usageSummary`（/usage 同 SQL 口径）——`usage.ts` 参数改为结构化最小端口 `UsageDb`（窄端口可调用，真实 Db 自然满足，tsc 严格过）。
- **状态栏 ⚠N 标记**：unmeasured 全链路透传（adapter → gateway RPC → UsageRangeUi → toUsageRangeUi → usageSegmentLabel）——📊 段在「N 次端点未上报用量」时显示 `⚠N`（token 数被低估不静默；/usage 看明细）。gateway 异常回退形状补齐 unmeasured:0。
- **验证**：+3 测试（adapter unmeasured 透传/非法区间回退 ×2、usageSegmentLabel ⚠N ×1）；全量 2350 通过；tsc 零错误。

### 13.21 costQuery 单一事实源扫尾轮（2026-08-17 持续完善）

- **扫尾三处残留内联 SQL**：`/sessions`（非 TTY 成本列）、`/status`（成本行）、tuiPresentationAdapter `sessions.list`（会话面板 $ 列）——全部改为 `sessionCost` + `costText`（与 /cost 同一 SQL 事实源，且自动获得 §13.19 的 0 token 行排除口径）。
- **costQuery 参数收窄为结构化最小端口** `CostDb`（`{ prepare(): { all() } }`）：presentation 窄端口可直接调用，真实 Db 自然满足——与 usage.ts 的 `UsageDb` 同模式（tsc 严格过，无 `as any` 逃逸）。
- **验证**：全量 2350 通过（行为等价重构，输出格式不变）；tsc 零错误。

### 13.22 labelTruncate 口径收官轮（2026-08-17 持续完善）

- **wx_cmd 命令输出截断并入统一口径**：原标注只有「前 2000 字」（无总数/剩余数）——模型仍不知后面还有多少。现 labelTruncate 统一「已截断（共 N 字，剩余 M 字未读）——分段执行或重定向到文件续看」。
- **验证**：+2 测试（wx_cmd 超长/短输出 ×2）；全量 2352 通过；tsc 零错误。
- **备注（诚实记录）**：本轮全量回归 4 次中 1 次出现单测试 flake（未复现于随后 3 次连续全绿运行——疑似真实 npm 子进程门测试的时序抖动，与本次改动无关；未获稳定复现，暂记录待观察）。

### 13.23 bash/HTTP/HTML 截断口径收官轮（2026-08-17 持续完善）

- **bash 8000–20000 静默截断缺陷（真根因修复）**：原实现输出 9000 字时 `out.slice(0, 8000)` 不触发任何标注（truncated 只在 20000 触发）——模型看到无标注的 8000 字误判「输出到此为止」。修复后标注「共 N 字/剩余 M 字」；且发现 `wrapDanger` 自身 8000 硬截会把内嵌标注切掉——标注改附在包裹之外（自有文本，无注入风险；调试取证 LEN=8049 纯 x 无标注 → 修复后标注可见）。
- **http_get/http_request**：8000 截断并入 labelTruncate 统一口径。
- **htmlToText/extractMainText**：maxLen 截断显式标注（共 N 字/剩余 M 字）；extractMainText 另补「另有 K 行低分块未选取」标注 + 首行超预算仍纳入（labelTruncate 兜底，绝不静默空输出）。
- **验证**：+4 测试（bash 9000/短 ×2、htmlToText 标注、extractMainText 标注）；全量 2354 通过；tsc 零错误。

### 13.24 capNote 列表封顶标注轮（2026-08-17 持续完善）

- **capNote 单一事实源**（truncate.ts）：枚举类工具列表封顶统一标注 `…[共 N 个，已截断（前 M 个）——指引]`——超限才追加，未超限空串。
- **修复 browser 交互元素 40 封顶静默**：原 `out.length >= 40 → break` 静默截断（且 total 不可知）。现全量遍历计数唯一元素（uniq），前 40 个展示 + 总数标注——模型知道还有未列出的可交互元素。
- **uia_windows/uia_tree 内联封顶统一**：去内联 `more` 拼串，改用 capNote（文案等价，测试锁定）。
- **验证**：+1 测试（capNote ×4 断言）；全量 2355 通过；tsc 零错误。

### 13.25 /claw 抓取截断口径轮（2026-08-17 持续完善）

- **/claw 4000 字静默截断修复**：正文原 `body.slice(0, 4000)` 无标注——模型误判「页面只提取到这些」（网页正文通常远超）。现 labelTruncate 统一口径 + 指引（http_get 或分段抓取续看）。上一轮 extractMainText 内置的省略/截断标注现不会再被外层 slice 拦腰切断。
- **验证**：全量 2355 通过（labelTruncate 已有纯函数覆盖，此处一行接线）；tsc 零错误。

### 13.26 skill_load 技能注入截断标注轮（2026-08-17 持续完善）

- **skillContentForModel 8000 字静默截断修复**：SKILL.md 超长时原 `slice(0, 8000)` 无标注——模型误以为技能步骤到此为止（可能漏掉关键后置步骤）。现 labelTruncate 统一口径 + 指引（fs_read 完整 SKILL.md）。
- **扫描结论（video 帧采样无缺陷）**：video 工具 `frames.slice(0, 2)` 为采样设计（取前 2 帧视觉探测），非截断；无标注需求。
- **验证**：skills 测试更新为标注断言（+1 断言强化）；全量 2355 通过；tsc 零错误。

### 13.27 /fs 面板封顶诚实标注轮（2026-08-17 持续完善）

- **/fs ls /fs read 封顶标注**：原 ls 静默截前 30 个、read 静默截前 60 行（模型经 wx_cmd 调用时误判「到此为止」）。提取纯函数 `fsLsRows`/`fsReadRows`（超限追加总数标注行 + 续看指引：/fs tree 分段、bash tail/sed），handler 接线。
- **验证**：+2 测试（fsLsRows/fsReadRows 超限与未超限 ×4 断言）；全量 2357 通过；tsc 零错误。

### 13.28 UX 缺陷清单口径同步轮（2026-08-17 持续完善）

- **docs/ux-comparison.md 陈旧口径修正**：缺陷 #11 原标「部分覆盖（会话级 $ 成本仍缺）」、结论段还留「会话级 /cost 待补」——与 §13.14/§13.16–§13.21 已交付的会话级 /cost + 会话面板 $ 列 + 未上报用量标注冲突（文档与实机不一致即说谎）。现表行与结论段同步为「✅ 已修」，剩余边界仅 #12 首启语言。
- **验证**：docs-only（无代码路径变更，全量测试不受影响）。

### 13.29 /sql 面板封顶诚实标注轮（2026-08-17 持续完善）

- **/sql 前 20 行静默截断修复**：数据查询行数影响结论——原 `rows.slice(0, 20)` 无总数标注，模型（经 wx_cmd）会误以为「查出来就 20 行」。提取纯函数 `sqlTableRows`（超限追加 `…（共 N 行，前 20 行——WHERE/LIMIT 收窄续查）`）并接线。
- **验证**：+1 测试（sqlTableRows 超限/未超限 ×4 断言）；全量 2358 通过；tsc 零错误。

### 13.30 工具空输出归一轮（2026-08-17 持续完善）

- **agent 层空工具结果归一**：工具返回 `''`（如 fs_read 空文件）时，原样回填会让模型误判「结果丢失/被吞」进而幻觉或重试。现归一为「（工具无输出——操作可能已成功或无需返回内容）」——语义明确、失败计数不受影响（不含「失败/异常」字样）。
- **验证**：+1 测试（extraTools 空输出工具 → 回填含「工具无输出」）；全量 2359 通过；tsc 零错误。

### 13.31 fs_edit 行号换算性能轮（2026-08-17 持续完善）

- **fs_edit 多处出现反馈 O(k×n) → O(n + k·log n)**：原 `positions.map(i => content.slice(0, i).split('\n').length)` 对每个出现位置都复制前缀再 split——大文件多处出现时明显卡顿。提取纯函数 `lineNumbersOf`（预建换行索引 + 二分定位行号）并接线。
- **验证**：+1 测试（lineNumbersOf 边界：首行/末行/空输入）；全量 2360 通过；tsc 零错误。

### 13.32 面板摘要片段省略号轮（2026-08-17 持续完善）

- **snippet 显示级截断补 …**：/hole 与 /memory search（70 字）、/memory list（60 字）、置顶记忆（40 字）四处的摘要片段原静默截断——超限条目补 `…`（完整数据在对应检索工具/详情）。纯函数 `snippet`（truncate.ts 单一事实源）并接线。
- **验证**：+1 测试（snippet 超限/未超/空 ×3 断言）；全量 2361 通过；tsc 零错误。

### 13.33 召回注入截断标注轮（2026-08-17 持续完善）

- **agent 召回注入 300 字静默截断修复**：`recallHybrid` 命中条目注入用户提示时原 `slice(0, 300)` 无标注——模型误以为记忆到此为止。现 labelTruncate 统一口径（无 hint——紧凑，模型可 memory_search 查全文）。
- **验证**：全量 2360 通过 + tsc 零错误（一轮全量回归出现单测试 flake——已另起 6 次循环复测定位中，未见与本次改动相关性）。

### 13.34 版本单一事实源 + 3.1.0 发布轮（2026-08-17 用户请求）

- **根因**：版本号散落 8+ 处硬编码 `'3.0.0'`（banner//version/serve/MCP/ACP/wxGateway/打包）——package.json 单独改不动 cmd 里显示的版本。
- **修复**：`kernel/version.ts` 运行时读 package.json 单一事实源（src/dist 同深度，失败回退 '0.0.0'）；8 处接线；package.json → **3.1.0**；`npm run build` 刷新 dist（`node dist/cli/index.js --version` → `wxnodus 3.1.0` 实测）。
- **测试**：+2（version 单一事实源一致性 + 已升级断言）；w2 进程级 smoke 改读 package.json（bump 自动同步，不再硬编码）。
- **flake 根治**：本会话 2 次出现的 `kernel-taskRunner 双线独立日志` flake 定位为**测试竞态**（并行双线只等 children[0] 落定就读 children[1] 日志——读空文件）——测试改为等双线均 success；另附产品级修复（taskRunner finish 改挂 writer 'finish'/'error' 事件：日志刷盘后才置终态，/jobs 面板读日志绝不见残缺）。
- **验证**：全量 2363 通过；tsc 零错误。

### 13.35 /model 开放兼容 + /key 并入 /model 轮（2026-08-17 用户请求）

- **开放兼容（任意 OpenAI 端点）**：`/model add <模型ID[,ID2]> --base <URL> [--name 名称] [--key 密钥]` 创建档案并激活（id 净化+去重，密钥 AES-256-GCM 落盘）；模型选择器 provider 列表新增「＋ 添加自定义接口（^a）」四字段顺序表单（名称 → 地址 → 模型ID → 密钥可空，就地校验 http(s)/非空）——提交走新 `model.add` RPC（与命令同一写入路径 modelRegistry.addCustomModel），成功后刷新列表 + 一次性 ✓ 提示。`parseModelAddArgs`/`sanitizeProfileId` 纯函数单测。
- **/key 彻底移除、并入 /model**：`/model set-key <密钥> [--provider <档案id>]`（档案槽/目录厂商槽/遗留单槽三分支——modelRegistry.applyModelKey 单一写入路径）+ `/model key` 状态；registry/分级/secretDetect/agent 引导文案/中文别名（/密钥 → /model set-key，子命令别名拆解路由）全链迁移；`/profile` 补进 SLASH（此前对 /help 不可见）。分级：`/model set-key` redline（含裸传密钥变体）、`/model add` confirm。
- **Gateway 修复与扩展**：model.options 补 `is_current`（选择器打开即落当前模型所在提供商——此前恒第 0 项）；save_key/disconnect 档案分支（写/清档案 key 槽，不再误写全局单槽）；新增 model.add RPC；审计经组合根注入回调（gateway 不直连 db）。
- **TUI 路由**：`/model add|set-key|key` 走 command.dispatch；^k 直达当前 provider 密钥段（已认证可改钥）。
- **验证**：+15 测试（modelRegistry 8、gateway is_current/save_key/disconnect/model.add 5、分级/秘密检测/别名路由/命令面 迁移更新）；全量 2384 通过；tsc 零错误；npm run build 通过（dist 实测 3.1.0）。

### 13.36 介绍大幅瘦身轮（2026-08-17 用户请求：删除夸大字样，文档后续自建）

- **去掉「概念编译器/概念进·证据出」夸大字样**（11 处）：`--help`/i18n cli.usage 头部 → 「Windows 本地 AI agent CLI」；/version 去标语；终端标题去「概念编译器」；TUI 品牌 welcome → 「Windows 本地 AI agent CLI」；品牌 TAG 与宠物欢迎帧去 slogan；i18n system.role/p7 与 llmSpec 提示词去「概念编译器/编译学派」措辞（方法论保留）；forge 生成标注、scaffold_build/wx_cmd 工具描述、registry /build 描述同步；providers 兜底欢迎语顺带修复残留 `/key` 指引 → `/model set-key`。
- **README 大幅瘦身**：~157 行 → ~75 行（去平台声明/三个限定词/离线分层/编译学派/能力地图五段副线/技术栈长篇/验收证据/目录结构——仅留快速开始、常用命令、模型接入、NL 契约表、键位、终端三档、License）；保留诚实背书行「记忆容量 ≠ 模型上下文窗口 64k」（w8-04 契约测试同步锚点更新）。AGENTS.md README 摘要同步瘦身（ZCode 工作流注记保留）。
- **验证**：w4 进程契约（--help 中文头）、w8-04 背书锚点更新；全量 2384 通过；tsc 零错误；npm run build 通过。

### 13.37 规则脑删除轮（2026-08-18 用户请求：仅删除规则脑，离线能力全部保留）

- **删除对话规则脑 `ruleBrain()`**（providers.ts，打招呼/四则运算/状态三能力的无 key 确定性兜底——此前已被 agent.ts 无 key 引导路径架空，实为死代码）；`cli/index.ts` 会话工件 model 占位 `'rule-brain'` → `'unconfigured'`（sessionStart 非空 schema 契约保持）。
- **删除编译规则脑**（/build 确定性规格引擎）：spec.ts 关键词表 RULES（60+ 域）+ RULE_PATTERNS + makeSpec；plan.ts makePlan 规则分解（topoSort/类型保留）；scaffold.ts `plan ?? makePlan` 兜底删除（plan 参数改为必传）。
- **/build 单通道化**：无 key → 立即报错「AI 规格化是唯一编译通道，需要模型密钥」；有 key → aiMakeSpec 唯一入口；AI 失败 → 明确报错不假装编译；计划由调用方固定构造（单模块 app）；scaffold_build 工具同语义（非法模具/空验收 fail-closed 报错，不再回退规则脑）。
- **文案面**：README/AGENTS 标语「无 key 也有离线能力（规则脑 + …）」→「（本地离线模型 + …）」；/build 描述、useConversationLifecycle 无 key 提示、wxGateway/llmStream/handlersExt 注释共 8 处同步；knownFailures KF-022 resolvedBy 更新。
- **测试面**：删 ruleBrain 4 用例、RULE_PATTERNS 域覆盖契约、makeSpec/makePlan 用例、kf-022「未传 plan 兜底」用例（源码级断言改为 plan 必传）；instantiate 调用点全部显式传固定 plan；kf-018 改字面 Spec；kernel-tools 回退用例改 fail-closed 断言；kf-004/kf-029 夹具 `'unconfigured'`。
- **口径失效记录**：competitive-analysis.md 的「免 key 可用：规则脑兜底」对外对比口径随本删除失效（离线模型路径仍在，该口径应按「本地离线模型」重述）。
- **保留不动**：离线四模态模型、语音、本地嵌入/向量、黑洞记忆、/offline、/voice、Windows OCR、云端视觉、/build 的脚手架执行/验证/证据/质量门全链路。

### 13.38 image_url 终极闸门 + /key 残留清零轮（2026-08-18 用户报 ZCode deepseek-v4-pro hydrate 400）

- **背景**：用户报告 ZCode（deepseek-v4-pro 纯文本模型）会话 hydrate 时报 `messages[678]: unknown variant image_url`（TraceID: hydrate-trace）。本会话自查：上下文 100% 文本、零待识别图片——按规则不触发 GLM 调用（零冗余）。
- **wxnodus 侧纵深审计**：上游三层防御已就位（agent.ts 能力门注入 :744-782 / 历史 contentToText :861-864 / 描述通道），且截图类工具返回文件路径不产 image 内容、MCP 客户端不映射图像块——但工具结果消息（agent.ts:1124 `msgs.push({role:'tool', content:e.out})`）与任何未来路径（MCP 图像、DB 残留）在最终装配处**无兜底闸门**。
- **修复（第四层防御）**：providers.ts 新增 `textifyForModel(content, modelId)` 纯函数——视觉模型（hasImageIn）原样放行；其余模型把 parts 数组中的 `image_url` 段替换为 `[图片]` 文本段（未知段 → `[附件]`，保持数组合法性）；`buildChatRequest`（llmStream 与 llmOnce 的唯一装配点）序列化前对全部消息执行。dataUrl 从此物理上不可能进入纯文本模型请求体。
- **契约测试**：kernel-image-guard.test.ts 新增「装配终极闸门」3 例——纯文本模型 tool/user parts 全文本化且请求体不含 image_url/base64/data:image；视觉模型 parts 原样放行；纯函数边界（字符串/null 原样、未知段 [附件]）。
- **/key 残留清零**（§13.35 迁移漏网收尾）：providers.ts 401 映射、handlers.ts 状态/doctor 3 处、handlersExt.ts 8 处（/profile 下一步、/learn、/assimilate、/fdr、/encrypt）共 12 处 `/key set` → `/model set-key`；marketServer.ts `/keys` 端点为 forge 公钥服务，与模型密钥无关，保留。

### 13.39 本地门禁聚合 + vim 死代码清理轮（2026-08-18 /goal 自主完善）

- **`npm run ci` 一键门禁**：仓库无 git remote（GitHub Actions 无意义）——诚实等价物为本地全量门禁聚合脚本：typecheck → typecheck:tests → test:all → test:known-failures → check:test-discovery → check:requirement-coverage → build。首次全链路实跑暴露 typecheck:tests 项目（tsconfig.tests.json，主 tsc 不覆盖）**3 处既有测试类型错误**（kernel-tools-computer-truncate UiaElement 缺 offscreen、ui-phase0-contract PromptZone props 缺 onHistoryAccept/onHistoryCancel、kernel-llmStream 未窄化失败变体 r.error）——本轮回合一并修复，typecheck:tests 归零后七步全绿复跑确认（此前「自始全绿」口径作废，如实记录）。README 快速开始补一行。
- **vim 死代码清理**（深评 UI S0 之二选一执行「从宣传移除」分支）：`src/wxnodus-ui/lib/vimKeys.ts` 41 行薄层全仓库零调用（仅 gaps 测试锁定）、无 hotkeys/helpHint/README 任何宣称——删除文件 + gaps.test.ts vim 段（差距 #1 以「无宣称不保留」关闭）；真 vim 模式如需复活应按 codex keymap 层重新设计（薄层连操作符/文本对象都没有，无保留价值）。

### 13.40 stdin 管道模式轮（2026-08-18 /goal 自主完善——场景矩阵「stdin 管道 ✗」关闭）

- **实现**：新增 `src/cli/stdinPipe.ts`——`readStdinAll()`（首字节 300ms 宽限期：无数据即放弃，execFile 等保持 stdin 打开的调用方零阻塞；有数据读到 EOF，1MB 封顶）+ `composePipePrompt()`（纯函数：无 -p 时 stdin 即提问；有 -p 时指令 + `<stdin>` 素材块；50k 字超限走 labelTruncate 诚实标注）。
- **接入**（cli/index.ts）：命令注册后、预热前——仅 `!wire && !serve && !mcpServer && !isTTY` 时探测；--wire 的 stdin 是 RPC 帧通道、--serve 不消费 stdin、--mcp-server 的 stdin 是 MCP stdio 传输，三者绝不混用（护栏显式化）。
- **契约测试**（tests/cli-stdin-pipe.test.ts 5 例）：纯函数 3 例（无 -p 提问/有 -p 组合/51k 超限标注）；真实进程 2 例（piped stdin → 一次性执行，session-streams/default.jsonl 用户事件留证；-p+stdin → 组合提问含 `<stdin>`）——dist 未构建诚实 skip。
- **文案**：--help 用法表 + README 快速开始各补一行 `cat 文件 | wxnodus -p "指令"`。
- **实测**：`printf '…' | node dist/cli/index.js --json` 退出 0 且一次性执行（JSON 响应正常）；管道证据落 session-streams（此前误判为 sessions/ 目录，测试已按真实路径修正）。

### 13.41 wire/stream-json 协议面 + ACP 接入文档轮（2026-08-18 /goal 自主完善——深评「无 schema 文档/示例」「ACP 无配置文档」关闭）

- **`--stream-json` 别名**：args.ts 新增 flag（gemini/kimi 命名对齐），解析后并入 `out.wire`（单一事实源，wire 分支/stdin 护栏零改动）；--help 补行。
- **`docs/wire-protocol.md`**：机器可读 schema 文档——8 类事件行（agent.start/token/message/tool/error/end/system.notice + agent.result 终态恒末行）+ 4 种 stdin 请求帧（approval/clarify/sudo/secret.respond）+ WIRE_GATEWAY_NOT_READY 规则 + 退出码共享表（0/1/2/3/4/130）+ 已知边界诚实声明（载荷非版本化 JSON Schema、wire 下 stdin 为帧通道非管道素材）。
- **可运行示例**：`examples/wire-events.mjs`（最小消费者：逐行解析/事件统计/终态退出码透传）+ `examples/wire-approval-responder.mjs`（双向帧通道演示：危险工具检测 → approval.respond 帧 → wire.response 消费）——仅 Node 内置依赖，dist 或 npm link 双入口。
- **`docs/acp-zed-jetbrains.md`**：零代码接入指南——启动命令唯一事实（`wxnodus -p "/acp server"`）+ 协议面方法表（initialize/session new/load/load_history/prompt，逐条对应 acp.ts switch）+ Zed/JetBrains 配置样例（明确标注「以 IDE 官方文档为准」，不编造字段）+ 不依赖 IDE 的 printf 自测命令 + 维护锚点。Zed 官方 ACP 文档页 404，样例字段据此诚实降级标注。
- **顺带**：acp.ts:62 无 key 文案 `/key set` → `/model set-key`（§13.38 清零漏网第 13 处，本轮复扫确认 src 零残留）。
- **契约测试**：`tests/cli-wire-alias.test.ts` 2 例（真实进程）——stdout 全程 JSONL 零非 JSON 行、agent.start 起 agent.result 终、退出码 0；`--wire` 与 `--stream-json` 事件类型集合同构。
- **README**：新增「协议与集成」小节（3 入口 × 文档链接）。
- **向导双注册隐患（本轮回合一并修复）**：新 flag 需在 args.ts（主解析）与 preBootstrapOnboarding.ts（向导白名单，先于主解析执行）两处注册——`--stream-json` 首跑被向导 CONFIG_UNKNOWN_FLAG 拒绝（exit 2、零输出），契约测试立即捕获；两处均已注册并在白名单处留「新 flag 双注册」注释防再犯。

### 13.42 CHANGELOG + 分发闭环 S0 轮（2026-08-18 /goal 自主完善——深评「无 CHANGELOG/无更新机制/无卸载路径」部分关闭）

- **CHANGELOG.md（3.1.0）**：Keep-a-Changelog 格式——Added/Changed/Fixed/Removed 四节完整记录本会话全部用户可见变更（/model 开放兼容、stdin 管道、--stream-json+wire 协议、ACP 文档、npm run ci、/update、版本单一事实源；/build 单通道化、README 瘦身；image_url 终极闸门、/key 13 处清零、typecheck:tests 归零、向导双注册；规则脑/vim 死代码删除）+ 3.0.0 基线节。
- **`/update` 更新检查**：`src/commands/updateCheck.ts` 纯函数组——detectInstallChannel（npm-global vs git/npm link 路径判定）/findRepoRoot（package.json name 上探）/probeGit（真实 git 探测，失败降级 isRepo=false 绝不抛）/channelGuidance（五渠道人话命令）/buildUpdateReport；handlers.ts 注册 `/update`（报告 + git 渠道 remote+干净树时 `--yes` 执行 pull+build，审计 update.git-pull）；registry SLASH/icon/desc 注册；commandLevels 白名单制默认 confirm 自动覆盖（未列命令保守确认，无需显式条目）。
- **诚实性实测**：本机 `MSYS_NO_PATHCONV=1 node dist/cli/index.js -p "/update"` → 正确报告 git 渠道/HEAD 25d4566/脏树/未配置 origin 且给确切指引；`--yes` 在无 remote 时明确拒绝（「仅 git 渠道 + 已配置 remote + 工作树干净时可执行」）。Git Bash 下 `/update` 被 MSYS 改写——args.ts 既有防护提示正确触发（诚实降级路径实测）。
- **winget/scoop manifest 生成器**：`packaging/{winget,scoop}` 模板 + `scripts/generate-package-manifests.mjs`（npm run gen:manifests）——renderWingetManifest/renderScoopManifest/zipSha256 纯函数；**诚实门禁**：--zip/--url 缺失时输出 `__RELEASE_URL_REQUIRED__`/`__SHA256_REQUIRED__` 占位并警告「不可提交发布」，绝不生成假装可发布的 manifest（本仓库无 git remote，发布 URL 尚不存在——生成器为发布日零改动就绪）。
- **测试**：update-check 9 例（渠道/根定位/指引五渠道/报告降级/probeGit 不抛）+ package-manifest-gen 6 例（占位门禁/JSON 合法性/sha256 64hex）——15/15 绿。
- **边界声明**：winget/scoop manifest 未提交 winget-pkgs/scoop bucket（无发布 URL）；卸载命令（opencode uninstall 模式）留待有真实安装面后补。

### 13.43 deepseek 前缀缓存稳定化 + usage 缓存可观测 + handlersExt 拆分第 1 块轮（2026-08-18 /goal 自主完善——深评 §8 序 5「prompt caching 降费」落地）

- **根因定位（缓存永久 miss 的主犯）**：systemPrompt.ts 环境段 `new Date()` 每回合变化——系统提示是第 0 段消息，时间戳一变整个历史前缀缓存从第一段起永久 miss（DeepSeek 上下文缓存为自动前缀精确匹配，官方 docs 核验：无启用字段、命中回 prompt_cache_hit/miss_tokens）。
- **前缀稳定化**：buildSystemPrompt 新增 `now?: Date`（缺省保持旧行为）；agent 闭包新增 `sessionClocks: Map<sessionId, Date>`——按会话冻结首次时间传入（跨天后时间不刷新，换取缓存命中；压缩/规范文件等静态段本就先于历史，顺序已最优，未动）。
- **usage 缓存可观测**：llmStream 提取 `prompt_cache_hit_tokens/prompt_cache_miss_tokens`（离线通道归零）；usage_stats 新增 cache_hit_tokens/cache_miss_tokens 双列——迁移 v7/v8（makeColumnMigration 工厂表参数化 table 字段，validate/reconcile 泛化；SCHEMA_VERSION 6→8）；agent INSERT 7 列；usageSummary 聚合 cacheHit/cacheMiss；/usage range 展示「前缀缓存命中 X token（命中率 Y%）」（0 时诚实不显示）。
- **契约测试**：systemPrompt now 逐字一致+差异证明 1 例；llmStream 缓存字段提取 1 例+既有 usage 断言同步；usage 缓存聚合 1 例；db-migrations 版本链 6→8。
- **handlersExt 巨文件拆分第 1 块**：确定性工具类 11 命令（/calc /hash /base64 /uuid /rand /json /timer /sql /fs /units /csv，174 行）+ safeEval + fsLsRows/fsReadRows/sqlTableRows 纯函数迁入 `src/commands/ext/deterministicTools.ts`（registerDeterministicTools(bus, ctx)）；handlersExt 以 re-export 保持 tests/commands.test.ts 导入兼容——**3912 → 3718 行（−194）**，零行为变化（迁移纯搬移，commands 契约测试全绿）。过程自伤修复：ext 模块注释含 `+-*/()` 使 `*/` 提前终结块注释（TS 解析错误）→ 注释改「四则运算符」。

### 13.44 /key set 漏网清零 + 余额护栏轮（2026-08-18 /goal 预算约束轮）

- **/key set 漏网第 14-19 处清零**：早前清剿被 grep 模式截断——本轮全量扫出 a2a.ts:65、balance.ts:94、handlersExt.ts:94/717/758/1524 共 6 处用户可见 `/key set` 残留（「彻底移除 /key」要求的最后一公里），sed 批量改 `/model set-key`；复扫 src 零残留（registry 注释/密钥归属文案为说明性引用，非指引）。
- **余额护栏 `scripts/balance-guard.mjs`**：读 settings（apiKeys.deepseek 槽 → 内存解密，明文绝不回显）→ GET deepseek /user/balance → 打印余额 + 退出码协议（0≥min / 1<min 打断 / 2 无密钥或失败）。实测基线：**本机 wxnodus 仅配置 zhipu/GLM 密钥，DeepSeek 密钥缺失** → DEEPSEEK_KEY_MISSING（exit 2）——自动监控待用户 `/model set-key` 后生效。
- **`docs/t0-budget-plan-2026.md`**：300 元预算→T0 计划——成本模型假设 + 已完成 10 轮清单 + 剩余 7 项按性价比排序（含轮数估算与止损判定 <¥20 收敛）+ 监控协议 + T0 达标判据（npm run ci 全绿 + 评分 ≥8.0）。
- **handlersExt 拆分 2/3 块尝试与回退**：锚点切片成功（块 2/3 = 583+894 行 → ext/sessionCommands.ts、ext/profileMemoryBuildCommands.ts），但导入自动修剪脚本陷入「同行列漂移→误删在用导入→护栏死锁」循环（根因：tsc 在文件存在其它错误时对在用导入误报 unused）——按预算止损回退（保留第 1 块成果，handlersExt 3718 行），拆分重做方式已写入预算计划序 5（静态导入清单手写）。

### 13.45 分层泄漏修复轮（2026-08-18 /goal 自主完善——深评 P1「分层泄漏 4+ 处」关闭）

- **方向规则**：kernel/domain 不得 import store（infra→kernel 合法，kernel→store 跨层违规）。
- **appendAudit**：迁 `src/kernel/audit.ts`（AuditDb 结构端口 + auditHash + SQL 由 kernel 拥有）；store/db.ts 仅 re-export（全仓 import 面零改动）。
- **saveCheckpoint**：迁 `src/kernel/checkpoint.ts`（DbPort 端口）；agent.ts:1185 动态 import 改 `./checkpoint.js`。
- **searchMessages**：迁 `src/kernel/memory.ts`（kernel 拥有检索语义）；store re-export；handlers 导入面不变。
- **Db 类型**：agent/memory/imageHistory 的 `import type { Db } from '../store/db.js'` → 本地 `InstanceType<typeof Database>`（better-sqlite3 库类型，类型保真零跨层）；新增 `src/kernel/dbPort.ts`（run 返回类型化）。
- **completionGate**：domain 不再直 import infrastructure 的 FileEvidenceStore——新增 `src/domain/quality/evidenceStorePort.ts`（`EVIDENCE_STORE_BRAND` unique Symbol 品牌 + isGenuineEvidenceStore + owns 端口）；FileEvidenceStore 实现该 Symbol 字段（防伪强度不降）；gate 的 isGenuine/owns 全部走端口。
- **复扫**：src/kernel 与 src/domain 中 `from '../store` 零残留（grep 空）。
- **搬移事故如实记录**：node -e 转义链把 `/\s+/` 吃成 `/s+/`（FTS 词切分失效 → 中文召回空）——定向测试立即捕获，单字符修复（教训：跨 bash 的代码注入不用于正则字面量；本次为事后发现，正文经文件对照确认其余转义完好）。
- **验证**：tsc 零错误；定向 115/115（含 completionGate 闭包证据/权威冲突/安全控制面/记忆召回）；全量回归见下。

### 13.46 handlersExt 拆分第 2/3 块重做 + 序 3 核验轮（2026-08-18 /goal 自主完善）

- **序 3 核验（fixture node_modules 出 git）**：实测该卫生问题**早已解决**——`.gitignore` 已含 `tests/fixtures/windows/uia/electron/node_modules/`、`git ls-files` 该路径追踪 0 文件（deep-dive 的 2550 计数系工作树文件而非入库文件）；`build-fixtures.ps1` electron 构建 = `npm ci && npm run build`（package-lock 锁定）+ `fixtures.lock.json` artifactSha256 + `verify:windows-fixtures -VerifyLock` 哈希核验——「脚本化下载 + 哈希锁定」全链路已在位，本项判定为已满足（补证，不重做）。
- **序 5 拆分第 2/3 块重做（新方案成功）**：上轮失败根因是 tsc 迭代修剪的死循环（同行列漂移 + 误报）。本轮改用 `scripts/split-commands.mjs` **按块内标识符实际用法确定性生成导入清单**（word-boundary 过滤 + 动态 import 路径升档 + ctx 类型恒纳入 + handlersExt 自身导入按剩余文本重算）——一次生成即 tsc 零错误，无修剪循环。
  - `src/commands/ext/sessionCommands.ts`：/resume /new /title /offline /undo /versions /snapshot /script /fork /checkpoint /reload-skills /map /init /usage /cost + scriptRecording 状态 + renderWaterfall。
  - `src/commands/ext/profileMemoryBuildCommands.ts`：/profile /balance /config /warp /fortune /context /compact /digest /curator /deploy /forge /skill /learn /assimilate /gate /fdr /evidence /sandbox /compliance /consent /audit /encrypt /lang /logs /bench + parseProfileAddArgs/parseBalanceSetArgs。
  - handlersExt **3718 → 2180 行**；renderWaterfall/parse* 保持 re-export 兼容；registerExtHandlers 依次调用四个 ext 模块。
- **过程自伤修复**：脚本 4 处 bug（块模板用错变量致动态 import 未升档、headBlock off-by-one 致导入重复、ctx 类型未恒纳入致 TS7006、调用点漏插入致 register 导入未用）——全部由 tsc 即时捕获，逐一定点修复。
- **验证**：tsc 零错误；命令契约定向 98 绿（commands/profile-balance/w1-04/intent）；全量回归见下。

### 13.47 测试布局收口决策轮（2026-08-18 /goal 自主完善——序 4 按成本/收益重新界定）

- **决策**：深评 P1「测试布局收口（123 根目录文件归位）」经实测评估后**以约定文档化替代机械搬移**——批量移动会连锁破坏 package.json 数十条 `test:w*-xx` 路径锚点脚本 + 123 处 import 深度 + vitest 发现顺序，纯外观收益、高回归风险（成本远超收益，违背预算约束）。
- **交付**：`tests/README.md` 布局约定（分区表 + 4 条规则：命名前缀、路径锚点同步义务、fixture 不入库、npm run ci 唯一权威）——捕获深评「发现性/维护性」本意。
- **本轮回退/止损汇总（如实）**：拆分 2/3 自动修剪失败（§13.44 回退）→ 用法过滤新方案成功（§13.46）；fixture 卫生为既有状态补证（§13.46）；测试批量移动明确延后（本条）。

### 13.48 补齐轮（2026-08-18 /goal：cli-comparison 差距清单逐条落地——OS 沙盒/apply_patch/并行调度/输出蒸馏掩码/LSP/硬编码清零）

- **范围**：docs/cli-comparison-2026.md §4 P0 四件 + P2 LSP + cli-implementation-gap-2026.md 硬编码清单；docs/t0-budget-plan-2026.md 已按要求删除（目标明确条目）。
- **新增模块**：
  - `src/kernel/toolOutput.ts`——offload（50KB/2000 行落盘 truncations/ + 头尾预览 + 续读路径）、旧轮掩码（50k 保护窗/30k 触发，幂等）、promoteOffloadFile/readHeadTail（有界读，绝不整文件入内存）；全部阈值 settings 可覆盖 + 夹取防误配（resolveWrapLimit/OffloadThreshold/MaskWindow/DistillThreshold）。
  - `src/kernel/applyPatch.ts`——codex 语法子集（Add/Update/Delete/Move + @@），三级匹配容错（精确→行尾空白→重缩进）+ 全量校验后落盘（失败绝不写一半，逐块报错 + did_you_mean）+ undoShadows 快照 + CRLF 保留 + 工作区守卫 + 生产护栏（500KB/50 文件/200 块/500 行）。
  - `src/kernel/winSandbox.ts`——OS 沙盒（详见下「实测校准」）。
  - `src/kernel/lspClient.ts`——stdio JSON-RPC（Content-Length 帧）LSP 客户端：initialize/didOpen/3.17 pull 诊断（-32601 回退 publishDiagnostics 宽限期）/hover/definition；settings.lsp.servers 可配任意服务器 + 内置 typescript-language-server 探测；会话 LRU 缓存（上限 4）；请求全带超时；ENOENT 诚实报错带安装指引。
- **agent.ts 集成**：并行工具调度（纯只读批次 Promise.all、含写批次整批串行、manual 恒串行、槽位保序——gemini scheduler 语义；并发计数实测 2/1）；蒸馏开关（settings.toolDistill，默认关，子代理不蒸馏防递归计费）；掩码（回填后按保护窗处理）；压缩阈值 64k 写死 → maxContextFor − 输出预留（settings.ctxOutputReserve 可覆盖）；MAX_TURNS 32 写死 → settings.maxTurns（1..200 夹取）；executeTool 侧 offload + wrapLimit 统一装配（已自包裹输出透传防双重标注）。
- **tools.ts**：wrapDanger limit 参数化（settings.untrustedWrapLimit）；bash 流式落盘（sink 保留完整输出→promoteOffloadFile 接管）+ 沙盒接入（trySandboxLaunch，探测失败诚实提示后普通执行）+ 8000–20000 静默区间补标（回归修复）；apply_patch/lsp_diagnostics/lsp_hover/lsp_definition 注册（内置 44→48 工具，agent 测试计数同步）。
- **命令/配置**：/sandbox 升级双层语义（策略层 L0-L3 模式映射 + 执行层 os L0-L3|off|status|probe 真实 OS 沙盒，settings.sandbox.profile 持久化）；store/config.ts 白名单 +12 键（sandbox/maxTurns/ctxOutputReserve/toolOutputOffload*（3）/toolOutputMask*（2）/toolDistill*（2）/untrustedWrapLimit/lsp）。
- **OS 沙盒实测校准（本机标准用户，重要口径）**：
  1. `CreateRestrictedToken(DISABLE_MAX_PRIVILEGE)+CreateProcessAsUser` → **1314 ERROR_PRIVILEGE_NOT_HELD 实测证伪**（标准用户无 SeTcbPrivilege，受限令牌不可用于进程创建；flags=0 同样失败——与 codex 方案在非提权环境的差异）。
  2. `SetTokenInformation(Low IL S-1-16-4096)+CreateProcessAsUser` → **实测可用**；Low IL 子进程写 Medium-IL 文件「拒绝访问」= L0 只读语义实证。
  3. Job Object（KILL_ON_JOB_CLOSE + DIE_ON_UNHANDLED_EXCEPTION）+ JobObjectNetRateControlInformation（1B/s=断网级 / 10KB/s）经普通 CreateProcess 施加——实测可用。
  4. 最终 profile：L0=Low IL 只读+断网｜L1=Job+断网｜L2=Job+限速 10KB/s｜L3=Job 遏制；探测失败诚实降级 + 提示（绝不假装沙盒）；默认 off（兼容性优先 opt-in）。
  5. 修复链：C# 编译期 4 错（Split char/string、OpenProcessToken 缺 out、CreateFile 句柄不可继承致输出全丢、CreateProcessAsUser 裸名 error 2→全路径）；**Add-Type -TypeDefinition 非 ASCII 损坏实测**（中文注释致解析错位——runner 内嵌 C# 纯 ASCII 红线 + 版本戳 v2）；受限令牌 1314 探测链三轮 diag 定位。
- **过程回退/教训**：apply_patch parse 初版 `\S.+?` 单字符路径漏配 + sawBegin 校验误用 inPatch 终态 + **flushFile 漏 push doc.files**（三连修）；lspClient 块注释内 `"**/*.ts"` 的 `*/` 提前终结（本仓既知陷阱复发——已换无歧义写法）；测试口径修正（mask 数据量、offload 阈值夹取下限 10k、ctx==minus 退化容错使多数旧用例语义自愈、LSP mock 服务器 EPIPE 防护 + close 等待真实退出防 EBUSY）。
- **验证**：新 5 套件 50 用例全绿（apply-patch 15/tool-output 10/win-sandbox 6/lsp-client 10/agent-gap 6 + truncate-label 契约修复）；全量 2447 通过 / 10 跳过 / 0 失败；tsc 零错误；评分复算 6.14→7.25（第 4/7 名，逐维理由入 cli-deep-analysis-score-2026.md §0.1，⑥ 安全 9 不升 10 的依据=沙盒仅 Windows 单平台）。

### 13.49 深化轮（2026-08-18「继续深化」：循环检测分级 P1-2 + 硬编码二次清零）

- **P1-2 循环检测分级（agent.ts）**：签名并入输出短哈希（shortHash FNV-1a 36 进制 7 位——crush「签名含工具输出」对齐，同参不同输出的空转漏检修复）；分级响应——重复 ≥loopRemindAt(2) 注入一次「【循环提醒】」system 消息（给合法轮询恢复机会，原 3 次直停误杀）、≥loopHardStopAt(5) 硬停；goal 模式轮间相同结论 chanting 检测（≥chantRemindAt 提醒语并入续轮 prompt、≥chantStopAt 终止并显式 ok=false + 空转文案）。
- **硬编码二次清零（EFF 块 + 工具侧）**：连续失败 5/未知工具轮 3/重试间隔 800ms/子代理深度 3/goal 轮数 10/读缓存 32/签名窗口 8/循环阈值——全部 settings 化（clampInt 单一事实源从 toolOutput 导出，agent 复用）；fs_read 20000→settings.fsReadLimit、bash 内存封顶 20000→settings.bashOutputCap；白名单 +13 键。默认值=既有行为（零行为漂移；settings.loopHardStopAt=3 恢复旧行为的回归锚已入测）。
- **既有测试更新**：goal「模型始终不宣告完成」用例原为恒同文本——正是 chanting 检测目标场景，改每轮不同文本（轮次上限路径）+ 新 chanting 用例（kernel-agent-gap-2026：提醒注入不直停/硬停阈值/短哈希确定性/空转终止 4 例）。
- **教训**：python 批量替换误入 `${}` 模板字面量进单引号字符串（已即时修复——继续坚持「批量改动用 Edit 精确匹配优先」）。
- **验证**：tsc 零错误；定向 10+65 绿；全量 2450 通过 / 10 跳过 / 0 失败；npm run ci 七步全绿（CI_EXIT=0）。

### 13.50 生态/桌面端准备轮（2026-08-18：会话血缘 + approve_for_session 真实授权）

- **范围**：用户需求「基于 6 家源码参考继续补充生态、提高上限（后续制作桌面端）」——选 P1-4（授权 UX）+ P2-1 血缘半件（会话数据结构化，桌面端历史树/会话浏览器的数据面）。
- **会话血缘（sessionLineage.ts）**：sessions 表加 `forked_from_id`（SCHEMA v9，registry `db-v9-add-session-lineage`；kf-030 与 db-migrations 测试 8→9 同步）；`forkSession` 记血缘复制消息、`sessionLineage` 祖先链（环形防护 seen 集）、`listSessionsStructured`（首问摘要清洗空白截断 80 字/消息数/分支数/血缘——gemini sessionUtils 思想）；/fork 走 kernel 函数 + `/fork lineage`；/sessions 增 `--json` 结构化出口（与桌面网关共用单一事实源）。
- **approve_for_session（sessionGrants.ts + agent 接线）**：session_grants 表（UNIQUE(session_id,tool,grant_key) upsert）；grantKey 诚实粒度——bash 精确命令、fs 精确 path、其余规范化 JSON（刻意不前缀化，理由入注释：批准 git 前缀连带放行 push --force）；优先级红线 > 规则 deny > 会话 deny > 会话 allow > 模式判定（agent 内插入点已注释）；cmdForceManual（wx_cmd danger）不受 allow 影响；授权表异常 fail-closed 走确认链；批准即自动记录（settings.approveForSession=true，默认关 opt-in）；`/perm session-allow|deny|revoke|list` 四子命令（handlers.ts /perm 扩展）；白名单 +approveForSession。
- **测试**：新套件 7 用例（血缘链/首问摘要/授权 upsert deny 优先撤销/agent 批准一次→同键免弹窗真实执行/deny 直拒不弹窗/红线不可被授权绕过）；kf-030、db-migrations 双版本断言 8→9。
- **教训**：① agent 测试共享 sessionId 导致 DB 行跨用例串扰——断言改「最新 N 行」而非全量；② 收尾文本 'done' 触发 isCompletionClaim 零副作用判 incomplete（KF-023/024 契约）——测试收尾用中性文本。
- **验证**：tsc 零错误；定向全绿；全量 2458 通过 / 10 跳过 / 0 失败；npm run ci 七步全绿（CI_EXIT=0）。

### 13.51 分享/路线图轮（2026-08-18：/share 离线加密打包 + 缺陷寄存器 + IDE/远程路线图）

- **需求**：「IDE 插件、远程执行、share 分享实现原理和难易程度，完善缺陷清单，提高上限」。
- **/share 离线打包（kernel/share.ts）**：openecode/kimi 云端分享依赖中心服务器（S-05 阻塞 + 数据不出机红线）→ 实现离线变体——明文包 `{format,version,exportedAt,source,messages,sha256}`（sha256 覆盖规范化 JSON 防篡改/截断）；`--encrypt` AES-256-GCM + scrypt(N=16384,r=8,p=1) 口令派生（盐/iv 随机、tag 校验、口令绝不入包）；导入先校验再入库、血缘 `share:<源id>`；命令层 argv 口令可见性风险如实提示（推荐 WXNODUS_SHARE_PASS 环境变量）。
- **缺陷寄存器（docs/defect-register-2026.md）**：S/A/B/C 四级 21 项——与评分维度、提分预估、阻塞项（无 remote/无服务器）一一联动；A-08 ✅、B-07/B-08 ✅（前轮）、其余状态如实。
- **路线图（docs/ide-remote-share-roadmap-2026.md）**：三块空白原理对照（gemini ide-companion ACP stdio / codex app-server SSE / opencode Tauri+token / codex exec-server / opencode share POST）→ wxnodus 落地方案：IDE 插件走现成 `--wire`（零协议新增，~600-900 行，本地 vsix 不受 S-01 阻塞）；远程执行 ssh 通道先行（标注「远端未沙盒」诚实口径）+ 完整版 exec-server 安全面对齐 codex；桌面端与 IDE 插件共用协议层（serve SSE + /sessions --json）。
- **验证**：tsc 零错误；share 4 用例全绿（篡改拒绝/错误口令拒绝/加密往返保真/血缘标记）；全量 + npm run ci 见下。

### 13.52 超越计划定稿轮（2026-08-18：用户要求「真正实现超越」）

- **交付**：`docs/supremacy-plan-2026.md`——上下文总结（3 轮评审 + 5 个落地轮全链路）、超越的可验收定义（总分 ≥870 超 codex + ≥3 维度第一 + 生态有真实消费者）、11 维逐维超越路径（理论上限 ≈9.4，全部带对标锚点）、三阶段执行计划（阶段 1 内核登顶 7 项零外部依赖 → 阶段 2 生态上车 5 项需 remote/桌面端决策 → 阶段 3 超越收官 6 项）、阻塞项（git remote/桌面端接入方式/密钥/mac-linux 环境）与每轮执行协议。
- **口径**：超越不是口号——每阶段收尾跑评分复算 + audit 实录，分数证据先行；score 文档 §8 已挂接本计划入口。

### 13.53 沙盒三平台化轮（2026-08-18：POSIX 沙盒实现 + 三平台门面，实机校准诚实留白）

- **需求**：「沙盒 macOS/Linux 化怎么办」——supremacy 阶段 3.2（⑥ 冲 10 前提）。
- **实现（参考机制、原创代码）**：`posixSandbox.ts`——bwrap 参数构建器（L0=--ro-bind 工作区+--unshare-net；L1=--bind+断网；L2=可写+联网；L3=--die-with-parent 遏制；dataDir 恒 ro-bind）+ Seatbelt profile 文本（L0 deny file-write/network、L1 allow write+deny network、L2 allow network）+ 探测（bwrap --version / sandbox-exec 内联试跑，15s 超时，ENOENT 给安装指引）+ 启动（输出流式落盘 outPath/errPath，与 winSandbox 同构供 bash offload 接管）；`osSandbox.ts` 门面（platform 分派，bash 与 /sandbox os status 唯一入口）。
- **诚实口径（核心）**：① L2 限速在 Linux 需 root（tc）/ Seatbelt 无原语——本平台 L2 降级为「可写+联网」，常量 POSIX_L2_RATE_LIMIT_NOTE 如实标注；② **本模块 Linux/macOS 实机验证未完成（本机 Windows）**——测试仅覆盖构建器纯函数 + 非本平台诚实不适用 + 门面 off 路径；**⑥ 评分在实机校准前不升 10**（审计与寄存器同步注明）。
- **测试**：新套件 7 用例（bwrap 四层映射/seatbelt 三档文本/降级口径断言/Windows 探测诚实/门面 off）。
- **验证**：tsc 零错误；posix+win 沙盒套件全绿；全量 + npm run ci 见下。

### 13.54 Windows-only 决策轮（2026-08-18：范围收敛 + 计划修订）

- **用户决策**：「我只想做 windows」——超越计划修订为 Windows-only 版（supremacy-plan-2026.md 顶部修订注记）。
- **处置**：POSIX 沙盒实现（591cebf）**保留休眠态**（零维护：纯函数测试仍跑、探测在非 POSIX 平台诚实返回不适用、bash 门面分派不受影响）；从路线图优先级移除；寄存器 S-06 标记 ❌ 已移除并新增 S-07（Windows 双态沙盒：提权→受限令牌 / 标准用户→Low IL，⑥ 冲 10 的 Windows 深度论据，提权分支待实现+实测）。
- **口径**：⑥ 评分表维持 9（跨平台客观口径不变）；Windows-only 产品的 10 分论据 = 「目标平台深度第一」（双态沙盒+纵深防御清单），评分时注明口径——诚实原则：提权分支未经实测前不宣称。
- **差异化升级**：超越叙事定为「Windows 最强 agent CLI」（渲染/ConPTY/UIA/沙盒双态唯一深度组合），而非跨平台跟随者。

### 13.55 计划重写轮（2026-08-18：supremacy-plan Windows-only 完整重写）

- 用户「请你重写计划」——将打补丁式修订（13.54）升级为**干净完整版**：`docs/supremacy-plan-2026.md` 整体重写为 Windows-only 定稿（定位「Windows 最强 agent CLI」、六轮落地表、Windows-only 天花板 ≈940、⑥ Windows 深度口径、三阶段 18 项任务表、休眠资产声明、四前置项、执行协议）。
- 无代码改动；文档一致性核验：register S-07 与 plan 3.2 对齐、score §8 挂接不变。

### 13.56 超越计划阶段 1 首批轮（2026-08-18：supremacy 1.1 分族提示词 / 1.2 小模型任务档 / 1.4 成本五维+整数分）

- **需求**：执行 supremacy-plan-2026.md 阶段 1（内核登顶，0 外部依赖）。本批交付 1.1/1.2/1.4 三项（其余 1.3/1.5/1.6/1.7 留后续轮）。

- **1.1 分族提示词（A-02，对标 gemini 分族）**：新模块 `kernel/providerPrompts.ts` 承载 DeepSeek/Kimi/GLM 三族中文专属段（内容口径=真实 API 行为：reasoning_content 必须原样回传否则 400、前缀缓存提示、窗口档位、中文优先——零营销文案）；`systemPrompt.ts` 保持零 CJK（kf-029 红线）——`SysPromptOpts.providerPrompt` 参数注入（persona 之后）；`agent.ts` 按 `model 目录 modelId 优先 → baseURL 探测回退` 解析 provider（`resolveProviderForPrompt`）。关键决策：provider 段注入位置在 external system.md 覆盖**之前短路**——外部 prompt 整体替换时不含 provider 段（用户全权控制语义，诚实不叠加）。
- **1.2 小模型任务档（A-03，对标 crush large/small）**：`kernel/taskModels.ts` 纯函数（resolveTaskModel 槽位隔离 / generateTitle 剥引号截 20 字 / generateSummary 截 200 字，异常一律 null）；settings 白名单 +`titleModel`/`summaryModel`；CLI 装配 `titleGenerator`（独立单轮 callModelOnce、10s 超时、无密钥零调用）；agent 回合末标题块：小模型 → 回退首行切片，**已有标题不触发调用**（sessions 查库门，避免每回合浪费小模型请求），注入器抛出不崩溃（内层 catch，诚实降级不劣于原版）。
- **1.4 成本五维 + 整数分计价（A-06，对标 opencode）**：`usage_stats` **v10** 新增 `reasoning_tokens`（registry v10 列迁移 + db.ts CREATE TABLE + SCHEMA_VERSION=10 + kf-030/db-migrations 断言同步 10）；llmStream 解析 `completion_tokens_details.reasoning_tokens`（端点未上报 0）；`cost.ts` 重写——五维计价（input×in、output×out、reasoning×out、cacheMiss×in、cacheHit×cacheRead——cacheRead 仅收录 DeepSeek 官方公布价 0.07/0.14，未收录保守按输入价**高估不低估**），全部金额**整数 µUSD BigInt 定点**（microFor 四舍五入，杜绝浮点累加漂移；仅展示层 /1e6 换算 USD）；costQuery/usageSummary 全链路聚合五维（/cost /usage /status 状态栏同源）。
- **测试**：新套件 kernel-provider-prompts（7）+ kernel-task-models（9）；kernel-cost 扩到 14（含定点精度断言：3 token×280000µ=1µ）；llmStream/usage/gateway 快照同步 reasoning/cacheRead 字段；kf-029 中文注释事故（systemPrompt.ts 注入注释改英文 ASCII）当场修复。
- **文档**：register A-02/A-03/A-06 → ✅；plan 阶段 1 表加状态列；score §9.4；本审计条目。
- **口径**：三项预计提分（⑤+11/⑤+1/⑩）**计入阶段 1 收尾复算**（执行协议：阶段完成一次复算，不逐项碎片化加分）——当前分数 725 不变。
- **验证**：tsc 零错误；定向套件全绿；全量 + npm run ci 见下。

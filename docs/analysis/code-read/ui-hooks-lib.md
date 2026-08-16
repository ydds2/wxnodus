# 代码精读 digest：src/wxnodus-ui/hooks + lib（agent 交付，2026-08-17）

> 覆盖：hooks 14 文件（4487 行）+ lib 顶层 65 文件 + markdown/ 3 文件（7909 行）= 82 文件 / 12,396 行，逐文件精读零跳过。
> 注：本 digest 由 Explore agent 以消息交付（无写文件权限），由父会话落盘存证。

## hooks/（14 文件）

- **useBackgroundPoll.ts（57）**：后台活动轮询（A24）。`useBackgroundPoll(gw)` 每 5s 读 `background.status` RPC → `patchBgState`（截断 12 条）；goal 进度由 background.goal 事件即时更新。L10 BACKGROUND_POLL_MS=5000。
- **useBatteryMonitor.ts（65）**：电池轮询（A7）。每 30s `system.battery` RPC（L40）→ `patchUiState({battery})`；失败置 null 状态栏自动隐藏。
- **useCompletion.ts（112）**：补全核心。`completionRequestForInput`（L11）：TAB_PATH_RE→complete.path / looksLikeSlashCommand→complete.slash / /model 排除（L26-28）；`useCompletion`（L41）：60ms 防抖（L74/L106）+ `ref.current !== input` 陈旧守卫（L75/L81/L92），blocked 清空，失败显示 "completion unavailable"。
- **useComposer.ts（406）**：输入框状态中枢（L101）。粘贴管线 handleResolvedPaste（L138）→ 拖放启发式（L66）→ image.attach（L159）/input.detect_drop（L179）→ 大粘贴折叠 paste.collapse（L211，32 条/4MB）；SSH 远端 OSC52 优先（L228-237）；外部编辑器 openEditor（L271）；acceptCompletion（L315）；editQueued（L328）。
- **useConfigWatcher.ts（288）**：配置同步。hydrateFullConfig（L174）RPC config.get full → applyDisplay（L185）→ patchUiState（L205-220）；5s mtime 轮询（MTIME_POLL_MS L125）变化→ reload.mcp（L271）+重拉。纯函数 normalizeStatusBar（L35）/normalizeBusyInputMode（L49，TUI 默认 'queue' vs CLI 'interrupt'）。
- **useConversationLifecycle.ts（374）**：会话生命周期。startNewSession（L154，setup.status→session.close→session.create，W3 闸门 fail-closed L171-176）→resetSession（L123）→writeActiveSessionFile（L42）；activateLiveSession（L250）；resumeById（L292，session.resume + hydrateStreamingText）；guardBusySessionSwitch（L350）；trimTail（L70）供 /retry。
- **useGitBranch.ts（72）**：git 分支探测，15s TTL 缓存+inflight 去重（L10-35），500ms 超时。
- **useInputHistory.ts（11）**：输入历史薄封装（historyRef/historyIdx/historyDraftRef/pushHistory）。
- **useKeyBindings.ts（667）**：全局输入处理器。完整键位表：Ctrl+K 命令面板（L279-282）；Ctrl+O 模型选择器（L384-387）；补全面板 ↑/↓/PgUp/PgDn 独占（L389-403）；滚轮加速 computeWheelStep（L405-432）+ 修饰键精确模式（L415-426）；Shift+↑↓ 逐行滚动（L434-440）；Ctrl/Alt/Super+Esc 语音（L455-457）；**双 Esc 中断**：busy 首按 arm+提示、1.5s 窗口二按 confirm→interruptTurn（L478-500）；↑↓ 队列/历史循环（L502-526）；复制键三级优先级 ink 选区>选中消息>输入框（L528-563）；Ctrl+X 队列编辑删除/会话切换（L565-573）；**Ctrl+C：busy 中断/有文本清行/空闲空输入仅提示不再 die()**（L575-592）；Ctrl+D 退出（L594-596）；Ctrl+B 语音 toggle（L605-607）；Ctrl+G 外部编辑器（L612-616）；**Shift+Tab 无补全时 yolo 翻转**（L619-639）；Tab 接受补全（L641-654）；Ctrl+K 有排队时出队（L656-663）。
- **useLongTaskHints.ts（69）**：长任务暖心语——工具超 8s 后每 10s 最多 2 次随机提示（L19/L58-60）。
- **usePromptDispatch.ts（430）**：提交/分发管线。send（L87）→input.detect_drop（L136）→prompt.submit（L110），busy 报错自动入队；shellExec（L155，! 前缀）；interpolate（L184 反引号插值并行）；handleBusyInput（L233）三模式 queue/steer(session.steer L257)/interrupt（入队+interruptTurn keepBusy L274）；submit（L357）：补全态 Enter 先接受补全（A4 修复 L366-369）、空输入双击 Enter=中断/出队（DOUBLE_ENTER_MS=450 L22）、`\` 续行（L403-407）；typing idle 定时器控制流式节流（L58-85）。
- **useQueue.ts（76）**：排队消息（queueRef 权威 + queuedDisplay 镜像 + queueEdit）。
- **useSessionShell.ts（1274）**：总装钩子 useMainApp（L166）。resize 合并 80ms（L173-210）；**事件订阅核心（L794-885）**：createGatewayEventHandler + gw.on('event')/gw.on('exit') + gw.drain()，exit 时 planGatewayRecovery 恢复会话（L842-874）；slash handler（L889-941）；answerApproval/Sudo/Secret/Form（L948-1004）；virtualRows（L360-363，key=id:c{cols} 换列必重测）；heightCache 12 桶 LRU（L379-392）；die（L516）/dieWithCode（L528）。
- **useVirtualHistory.ts（586）**：滚动虚拟化。OVERSCAN=20（L20）、MAX_MOUNTED=120（L26）、QUANTUM=10 分桶（L38）、FREEZE_RENDERS=2（L43）、SLIDE_STEP=12（L51）；快照键按 (scrollTop+pendingDelta)/QUANTUM 分桶短路 React 提交（L55-65/L198-202）；区间算法 sticky 贴尾回退 vp+overscan（L288-324）；**速度门限滑动**防 PageUp 一次挂 190 行（L359-382）；**useDeferredValue 时间分片**（L399-418）；卸载时测量抢在 WASM 释放前（L436-469）；列宽变化按比例缩放缓存（L171-183/L506-508）。

## lib/（65+3 文件）

- **atRefs.ts（23）**：@路径 文件引用解析（resolveAtRefs 同步读前 4000 字符）。
- **brandRule.ts（85）**：品牌差异化布局纯函数（accretionRule L22 / brandBarLayout L62，<24 列返回 null）。
- **circularBuffer.ts（48）**：CircularBuffer。
- **clipboard.ts（230）**：剪贴板读写多平台回退；PS 输出走 base64 规避 CP936 损坏（L8-10）；readClipboardImage（L165，Win System.Drawing 存 PNG）。
- **composerKeys.ts（111）**：Composer 键位纯逻辑 handleComposerKey（L52）。
- **consoleBootstrap.ts（176）**：Windows conhost 引导（W8-21/26/27）。PS_ENABLE/PS_RESTORE（L15/L27，P/Invoke SetConsoleMode）；runConsoleModeScript（L51，结果经临时文件回读 + vtEnabled 终态核验 L72）；bootstrapConsoleForTui（L112）；**OS≥1903 且 PS 失败 → 按默认 VT 假设降级 cmd 档直接进 TUI**（L148-158）；noVtGuidance（L165）。
- **diffSummary.ts（113）**：diff 投影（per-file ±计数，changesLabel L107）。
- **editor.ts（47）**：resolveEditor（L29）：$VISUAL/$EDITOR→POSIX 链→win32 notepad.exe。
- **emoji.ts（54）**：ensureEmojiPresentation（VS16 注入）。
- **escCancel.ts（22）**：**双 Esc 判定纯函数** escCancelNext（L13），ESC_CANCEL_WINDOW_MS=1500（L5）。
- **externalCli.ts（16）**：launchWxnodusCommand。
- **externalLink.ts（434）**：外链标题抓取（96KB 预算/5s 超时/私网不抓 L156-234）。
- **fpsStore.ts（51）**：FPS 追踪（SHOW_FPS 未设零开销）。
- **fuzzy.ts（177）**：自研模糊评分 fuzzyScore（L49）/fuzzyScoreMulti（L118）/fuzzyRank（L157）。
- **gracefulExit.ts（47）**：SIGINT/SIGTERM/SIGHUP → 129/130/143，cleanups 先行 + 4s 兜底。
- **history.ts（82）**：输入历史持久化（~/.wxnodus/.wxnodus_history，MAX=1000，尾条去重）。
- **inputMetrics.ts（203）**：光标几何（wrap-ansi 源保证与 Ink 一致，cursorLayout L122）。
- **layoutProfile.ts（60）**：布局条件纯函数（statusSegmentsFor 72/76/80/84/96 渐进披露 L36）。
- **lines.ts（84）**：行数估算（strWidth >0xff 按 2 列 L4）。
- **liveProgress.ts（79）**：工具架合并 appendToolShelfMessage（L43）/mergeToolShelfInto（L15）。
- **markdown/blocks.ts（11）**：MdBlock 块模型。
- **markdown/parse.ts（67）**：parseMd（L14）micromark+GFM+math；流式容错未闭合围栏自动补全（L17-18）。
- **markdown/streaming.ts（45）**：splitStablePrefix（L4）+ throttleStreaming(16ms)（L24）。
- **mathUnicode.ts（770）**：LaTeX→Unicode 纯正则管线 texToUnicode（L672）。
- **memory.ts（246）**：内存诊断/堆转储（auto 触发器需 opt-in L163-175；2GB 上限 L190）。
- **memoryMonitor.ts（184）**：startMemoryMonitor（L89）；critical~88%/high~70%；**异常增长预警**（≥150MB/10s L102-134）；触发前动态 import evictInkCaches（L67-87）。
- **messages.ts（8）**：appendTranscriptMessage=appendToolShelfMessage。
- **modelPicker.ts（44）**：handlePickerKey（L18）/groupByProvider（L31）。
- **openExternalUrl.ts（158）**：parseSafeUrl（L6 仅 http/https）；openCommand（L28，win32 用 explorer.exe 防元字符重解析）；spawn 必须挂 error 监听（L40）。
- **osc52.ts（73）**：OSC52 剪贴板（tmux DCS 包装 L14-24）。
- **parentLog.ts（57）**：recordParentLifecycle → ~/.wxnodus/logs/tui_gateway_crash.log。
- **perfPane.tsx（107）**：PerfPane（WXNODUS_DEV_PERF=1 才生效）。
- **platform.ts（409）**：平台键位助手 isMac/isAction/isCopyShortcut（含 VSCode CSI-u super+ctrl L48-51）；parseVoiceRecordKey（L228，保留键黑名单 c/d/l）；isVoiceToggleKey（L347，默认 ctrl+b 接受 mac Cmd+B）。
- **precisionWheel.ts（48）**：修饰键精确滚轮（16ms/帧限 1 行 L1）。
- **prompt.ts（35）**：composerPromptText（shellMode $、termux 单格 >）。
- **reasoning.ts（55）**：splitReasoning 抽取/剥离 <think>/<reasoning> 标签（L8）。
- **rpc.ts（49）**：asRpcResult/asCommandDispatch/rpcErrorMessage。
- **subagentTree.ts（355）**：子代理树纯函数 buildSubagentTree（L17）/aggregate（L58）/sparkline（L210）。
- **suggest.ts（22）**：filterCommands（L6 前缀精确+fuzzy 模糊各 6 条）/isSuggesting（L20）。
- **syntax.ts（117）**：highlightLine（L75）8 语言关键词表（TS/PY/SH/GO/RUST/SQL/JSON/YAML）。
- **terminalModes.ts（51）**：TERMINAL_MODE_RESET（L3 全部鼠标/kitty/modifyOtherKeys/备用屏复位）。
- **terminalParity.ts（89）**：detectMacTerminalContext（L22）；terminalParityHints（L33）VSCode/tmux/SSH/**cmd 档提示**（L79-86）。
- **terminalSetup.ts（444）**：IDE 终端键位配置 configureTerminalKeybindings（L275，冲突检测 when 子句 L193-268，写前备份 L370-372）。
- **terminalTier.ts（128）**：**终端三级画像** detectTerminalTier（L95）：WXNODUS_TUI_TIER 逃生门（L99-102）→非 TTY/TERM=dumb→no-vt（L104-106）→非 win32→modern（L109）→Windows 现代信号（WT_SESSION/TERM_PROGRAM/MSYSTEM/ConEmu/ANSICON，L112-119）→否则注入探测（CPR/PS）→cmd 或 no-vt；setTuiTerminalTier/rendererCapabilitiesFor（L49）。
- **termux.ts（29）**：isTermuxEnv/isTermuxTuiMode。
- **text.ts（368）**：文本处理全家桶 stripAnsi（L23）/boundedLiveRenderText（L129）/buildVerboseToolTrailLine（VERBOSE_TRAIL 上限 L226-231）/formatAbandonedClarify（L352）/estimateRows（L299 含代码围栏/表格分隔行）。
- **todo.ts（9）**：todoGlyph（[x]/[>]/[ ]/[-] 定宽 ASCII）。
- **turnTodos.ts（50）**：**实时任务清单合成**（A22）。seedTurnTodos（L12，>80 字符或任务动词→三行骨架）；syncToolTodo（L27，骨架在首个真实工具落地时整体让位 L35-37）。
- **uiCopy.ts（45）**：产品固定文案单一事实源（SECTION_TITLES/EVIDENCE_STATUS_LABELS）。
- **viewportStore.ts（124）**：useViewportSnapshot（L87），量化 key 按 8px 分桶（L64/L84）。
- **vimKeys.ts（41）**：vim 模式薄层 vimHandleKey（L9）。
- **virtualHeights.ts（158）**：高度估计 messageHeightKey（L16）/estimatedMsgHeight（L69，assistant 段落间隙≤6，16k 字符扫描上限 L115）。
- **voiceIntent.ts（35）**：voiceConfirmChoice（L12，≤12 字符才判定；拒绝词先查 L21-27）。
- **wheelAccel.ts（190）**：滚轮加速状态机（claude-code 移植）computeWheelStep（L82）：native 路径（40ms 窗口+0.3 至 6）/xterm.js 路径（150ms 半衰期）；5 连发<5ms→触控板 flick 解除（L127-133）。

## 重点结论（带行号）

1. **双 Esc + Ctrl+C 解耦**：busy 首 Esc 只 arm+提示「再按 Esc 确认取消（1.5s）」（useKeyBindings.ts:478-500，判定器 lib/escCancel.ts:13）；空闲空输入 Ctrl+C 仅提示（useKeyBindings.ts:589-591，历史 die() 误杀已修）。
2. **补全管线三段吞键风险与防御**：60ms 防抖+ref 陈旧守卫（useCompletion.ts:74-106）；面板开启时 ↑/↓/PgUp/PgDn 与 Tab 被面板独占（useKeyBindings.ts:389-403/641-654）；Enter 补全态先接受补全（A4 修复 usePromptDispatch.ts:357-371）。
3. **流式渲染订阅链**：agent.token→wxGateway message.delta（wxGateway.ts:150-152）→eventAdapter→turnController.recordMessageDelta→$turnState（flowStore）；节流 boostStreamingForTyping(80ms)/boostStreamingForScroll(96ms)/relaxStreaming(16ms)；Markdown 流式 splitStablePrefix+throttleStreaming(16ms)。
4. **审批/澄清弹窗不锁死滚动**：滚轮/PgUp/PgDn/Shift+↑↓ 显式穿透（shouldFallThroughForScroll useKeyBindings.ts:41-63）。

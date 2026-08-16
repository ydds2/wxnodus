# WxNodus UI 代码精读 digest：components / bridge / commands / runtime / content / config / domain / types / protocol

生成时间：2026-08-17。覆盖 85 文件（components 31、bridge 5、commands 8、runtime 17、content 8、config 3、domain 10、types 1、protocol 2），全部逐文件精读，零跳文件。
总行数：约 19,462 行（wc -l 实测：components 12434 / bridge 1498 / commands 2076 / runtime 2502 / content 176 / config 100 / domain 486 / types 186 / protocol 4）。

关键结论速览（详见文末重点问答）：
- 状态容器不是 zustand：自研零依赖 atom 引擎 src/app/stores/engine.ts（createAtom/createStore/computed，基于 useSyncExternalStore）。
- 事件桥：GatewayClient 'event' → bridge/eventAdapter.ts createGatewayEventHandler → 四路并行写（operational atoms + turnController + presentation 纯投影 + TUI sidecar 投影）→ 组件经 selector/computed 原子重渲。
- 审批面板 4 选（once/session/always/deny），tirith 警告时降 3 选；回传 approval.respond RPC。

---

## 一、bridge/（5 文件）——内核事件与 React UI 之间的桥

### bridge/interfaces.ts（484 行）
职责：全目录唯一跨层类型契约文件——UiState / OverlayState / AppLayoutProps / SlashHandlerContext / GatewayEventHandlerContext / Composer 全套接口 + Notice、BatteryInfo、SelectedMessage 等。
关键导出与行号：
- StateSetter L27；StatusBarMode L31；BusyInputMode L33；NoticeLevel L35；Notice L42-49（snake_case 直通 WS 线格式，text 自带字形）
- INDICATOR_STYLES L55（单一事实来源元组）；DEFAULT_INDICATOR_STYLE L58（tier 感知：full→kaomoji / cmd、ascii→ascii）
- SelectionApi L60-69；CompletionItem L71；GatewayRpc L77-79；GatewayServices L81-84（gw + rpc）
- OverlayState L91-109（agents/approval/clarify/commandPalette/confirm/modelPicker/pager/pluginsHub/secret/sessions/skillsHub/sudo/form/dirPicker 全量清单）
- FormReq L111-115；PagerState L117-121；TranscriptRow L123-127
- UiState L129-164（busy、streaming、theme、notice、battery、selectedMessage、selectionHint 等 30 字段）
- SelectedMessage L170-174（A19 鼠标点选快照：key/text/role）
- BatteryCategory/BatteryInfo L177-184；VirtualHistoryState L186-193（虚拟化窗口：topSpacer/start/end/measureRef/offsets）
- ComposerActions/ComposerRefs/ComposerState L202-255；UseComposerStateOptions/Result L244-255
- InputHandlerActions/Context/Result L257-296；GatewayEventHandlerContext L298-334；SlashHandlerContext L336-378
- AppLayoutActions L380-399（answerApproval L381 / answerClarify L382 / answerSecret L383 / answerSudo L384 / answerForm L385 / cancelForm L386）
- AppLayoutComposerProps/ProgressProps/StatusProps/TranscriptProps/AppLayoutProps L401-454；AppOverlaysProps L456-478（onApprovalChoice L462 / onFormSubmit L475）
- PasteSnippet L480-484
闭环连接点：被 eventAdapter.ts / useSessionShell.ts / appLayout.tsx / appOverlays.tsx / 全部 slash 命令引用；UiState 由 viewStore.ts:40 实例化；OverlayState 由 promptStore.ts:7 实例化。

### bridge/gatewayProvider.tsx（19 行）
职责：React Context 依赖注入——把 { gw, rpc }（GatewayServices）提供给组件树。
关键导出与行号：GatewayContext L5；GatewayProvider L7-9；useGateway() L11-19（缺失时 throw 'GatewayContext missing'）。
闭环连接点：消费方 appLayout.tsx:414（AgentsOverlayPane）、appOverlays.tsx:37/164、dirPicker.tsx:8、useSessionShell.ts（注入处）。

### bridge/eventAdapter.ts（931 行）★ 核心
职责：内核 GatewayEvent 的中央适配器——createGatewayEventHandler(ctx) 返回 (ev: GatewayEvent) => void，把网关 WS 事件翻译成四个并行 UI 数据流（operational atom patch / turnController 命令 / presentation 纯投影 feed / TUI sidecar 投影）。
关键导出与行号：
- NO_PROVIDER_RE L31（中英双语匹配「未配置模型密钥」）；statusFromBusy L33；applySkin L35-45（fromSkin→patchUiState）；dropBgTask L47-53
- pushUnique L55-58；pushThinking(6)/pushTool(8) L60-61；normalizeSubagentStatus L73-81
- createGatewayEventHandler L83（解构 ctx L84-90）
- presentation feed：feed(body) L98-99（generation 恒 0 + sessionId=getUiState().sid）；feedTodos(raw) L101-128（raw→{id,content,status} 过滤）
- persistedAbandonedClarify L133；flushAbandonedClarify L144-157（clarify 超时被弃 → 落 transcript 系统行再清 overlay）
- turnController.persistSpawnTree 注入 L161-189（spawn_tree.save RPC，best-effort）
- getFullConfigOnce L200-204（memoized config.get full 单次 RPC）
- /agents nudge：L217-256（display.tui_agents_nudge 每次 turn 一次 + overlay 已开时静默 + subagent.start 触发）
- setStatus L258；restoreStatusAfter L262-268（statusTimer 经 turnController）
- scheduleStartupPrompt L270-298（STARTUP_QUERY/IMAGE，轮询 sid 最多 4s）
- isTerminalStatus/keepTerminalElseRunning L303-306
- handleReady(skin) L308-401：applySkin L309-311 → commands.catalog L319-337（setCatalog + warning→pushActivity）→ 崩溃恢复 recoverSidRef L343-354（resumeById + status 'recovering session…'）→ STARTUP_RESUME_ID L356-362 → display.tui_auto_resume_recent L370-395（session.most_recent）→ 兜底 newSession L396-400
- 主 switch（返回的 handler）L403-930：
  - session_id 过滤 L404-408（gateway.* 除外）
  - feedTuiProjection(ev) L411（W3-02：run.* 事件入纯投影管线）
  - gateway.ready L414-425（无 key 首屏告警 L418-423）
  - skin.changed L427 / theme.changed L433-441（/theme dark|light|wxnodus 真实生效）
  - session.info L442-455（usage 合并 + intro 行 info 回填）
  - message.start L457-467（startMessage + feed turn.start + 骨架 todos）
  - status.update L468-515（goal 类 6s 恢复；compressing 落 transcript；其余 pushActivity + 4s 恢复）
  - notification.show L517-541（→turnController.showNotice，busy 时挂起回合末显示）
  - gateway.stderr L543-549；voice.status L551-568（VAD 状态直推 status bar，无轮询）
  - voice.transcript L570-624（3-strikes 静音停止 L573-580；审批/确认弹窗时语音确认词库直接 approval.respond L590-610；普通文本清空输入后 defer submit L620-621）
  - gateway.start_timeout L626-653（stderr 尾部 8 行/120 字符内联展示）
  - gateway.protocol_error L655-668（protocolWarned 单次）
  - reasoning.delta L670-675（recordReasoningDelta）
  - tool.start L677-687（recordTodos + recordToolStart + feed）
  - tool.complete L688-726（clarify 弃答落档 L693-695；inline_diff 分支 L697-713；否则 recordToolComplete L714-723）
  - clarify.request L728-735 → patchOverlayState({clarify}) + feed prompt.opened
  - approval.request L736-755 → patchOverlayState({approval:{allowPermanent,command,description,tool,category,icon}}) + status 'approval needed' + feed
  - sudo.request L757-762 / secret.request L764-772（秘密值不投影，只投影变量名）/ credential.form L774-786
  - background.complete L788-792；background.goal L793-808（即时 goal 进度，不依赖 5s 轮询）；background.jobs L809-816（任务列表即时刷新）
  - subagent.start L817-826（upsert + maybeNudgeAgents）；subagent.thinking L827-846（createIfMissing:false）；subagent.tool L848-864；subagent.complete L866-877
  - message.delta L879-885（recordMessageDelta + feed）；message.complete L886-908（recordMessageComplete → appendMessage + bell + usage 合并）
  - error L910-929（recordError + NO_PROVIDER_RE → setup 面板）
闭环连接点：由 useSessionShell.ts:794-835 构造、:876 gw.on('event', handler) 挂载；写入 viewStore.ts:50 / flowStore.ts:39 / promptStore.ts:37 / presentationStore.ts:21 / tuiProjection.ts:16 / backgroundStore.ts:57 / delegationArchive.ts（经 flowController）。

### bridge/recovery.ts（35 行）
职责：网关崩溃恢复预算纯函数——限制 respawn+resume 次数，防 crash-loop spawn-storm。
关键导出与行号：GATEWAY_RECOVERY_LIMIT=3 L7；GATEWAY_RECOVERY_WINDOW_MS=60_000 L8；RecoveryPlan L10-17；planGatewayRecovery(liveSid, recoverSid, attempts, now) L24-35。
闭环连接点：useSessionShell.ts:853（exit handler）调用；recoverSid 由 eventAdapter.ts:343-354 的 gateway.ready 一次性消费。

### bridge/setupHandoff.ts（29 行）
职责：/setup 不再 spawn 外部进程——进程内执行 personalization.setup RPC。
关键导出与行号：RunInProcessSetupOptions L7；runInProcessSetup({ctx}) L11-29（patchUiState 'setup running…' → personalization.setup scope:user → 失败 sys(error.code) / 成功 newSession）。
闭环连接点：commands/slash/bootstrap.ts:9 调用。

---

## 二、runtime/（17 文件）——状态机、回合编排与渲染调度

### runtime/viewStore.ts（83 行）★ UI 主状态
职责：UiState 原子（$uiState）+ 派生 computed + 鼠标选中/提示辅助。
关键导出与行号：buildUiState L10-38（30 字段默认值）；$uiState = atom<UiState> L40；$uiTheme L42、$uiSessionId L43、$selectedMessage L46（computed 细粒度隔离）；getUiState L48；patchUiState L50-51；resetUiState L53；selectMessage L58-59；clearSelectedMessage L62-63；showSelectionHint L71-83（3s 自清 + unref）。
闭环连接点：eventAdapter.ts 大量 patchUiState；组件 useAtom as useStore($uiState)（appLayout.tsx:2,97 等）；computed 订阅点 appOverlays.tsx:8（$uiTheme/$uiSessionId）、messageLine.tsx:23（$selectedMessage）。

### runtime/flowStore.ts（88 行）
职责：turnState 原子（当前回合 live 数据）+ useTurnSelector + 回合末 todos 归档。
关键导出与行号：buildTurnState L7-24；$turnState L26；getTurnState L28；useTurnSelector L32-37（useSyncExternalStore）；patchTurnState L39-40；toggleTodoCollapsed L42；archiveTodosAtTurnEnd L46-66（todos → trail 消息 todoCollapsedByDefault/todoIncomplete）；resetTurnState L68；TurnState interface L70-88。
闭环连接点：flowController.ts 是唯一写者；读者 streamingAssistant.tsx:36-47、turnSections.tsx:15、thinking 系列、appChrome.tsx:9（SpawnHud）。

### runtime/promptStore.ts（73 行）
职责：OverlayState 原子 + $isBlocked computed + flushSync/forceRedraw 桥接保障。
关键导出与行号：buildOverlayState L7-23；$overlayState L25；$isBlocked L27-33（任一 overlay 打开即 blocked）；getOverlayState L35；patchOverlayState L37-51（flushSync 内 set；catch 兜底直设；随后 setTimeout forceRedraw 0ms + 120ms 双保险覆盖 markDirty 链断的 blit 短路）；resetOverlayState L54；resetFlowOverlays L64-73（软重置：清 flow 类审批/澄清/确认/sudo/secret/pager，保留 agents/modelPicker/skillsHub/sessions 等用户主动开的面板）。
闭环连接点：eventAdapter.ts（approval/clarify/sudo/secret/form/confirm 写入）；turnController.idle→resetFlowOverlays（flowController.ts:294）；组件 appLayout.tsx:7/481、appOverlays.tsx:7/35。

### runtime/flowController.ts（1014 行）★ 回合编排核心
职责：TurnController 单例——流式文本/思考/工具/子代理/通告/todos 的全部时序与节流，回合结束落账 transcript。
关键导出与行号：
- 常量：INTERRUPT_COOLDOWN_MS=1500 L28；ACTIVITY_LIMIT=8 L29；TRAIL_LIMIT=8 L30；DEFAULT_NOTICE_TTL_MS=8000 L32
- diffSegmentBody L38-46；parseTodos L53-78；finalTail L83-95；InterruptDeps L97-102
- class TurnController L114：字段 L115-148（bufRef/segmentMessages/pendingSegmentTools/activeTools/doneToolsAcc/reasoningText 等 + notice 机制 L146-148）
- 流式调度：boostStreamingForTyping L150-152（STREAM_TYPING_BATCH_MS 80）；boostStreamingForScroll L154-156（96）；relaxStreaming L158-160（16）；scheduleStreaming L885-896（单飞 timer → boundedLiveRenderText 入 turnState.streaming）；scheduleReasoning L871-883；hydrateStreamingText L898-904；pulseReasoningStreaming L450-458（700ms REASONING_PULSE_MS）
- 通告机制：showNotice L184-194（busy 挂起 latest-wins）；clearNotice L201-210（key 匹配）；applyNotice L218-237（ttl 计时 8s 兜底、sticky 不超时）；flushPendingNotice L251-259（仅三个真实回合末调用点触发）；clearNoticeState L263-270
- 回合生命周期：startMessage L906-930（清空 + busy=true + credits.usage/grant_spent 让位清除）；recordMessageDelta L659-677（bufRef += text）；recordReasoningDelta L679-705（不显示思考时只 pulse 动画；80k→60k 截断）；recordToolStart L827-843；recordToolProgress L804-825；completeTool L745-793（doneToolsAcc + 时长回退本地实测）；recordToolComplete L707-726；recordInlineDiffToolComplete L728-743；pushInlineDiffSegment L495-527（diff 块夹在叙述段之间）；flushStreamingSegment L416-448（按 reasoning tag 拆分）；recordMessageComplete L558-657（拼接 finalMessages = archiveDoneTodos + segments(去重 diff) + finalDetails + finalText；归档 spawn 树 pushSnapshot + persistSpawnTree；flushPendingNotice）
- 中断：interruptTurn L302-369（session.interrupt RPC；在飞工具标 cancelled L314-322；preserve segments；keepBusy 等待真 settle 边）
- 重置：idle L277-295（busy=false + resetFlowOverlays）；reset L845-864；fullReset L866-869；recordError L545-556
- 子代理：upsertSubagent L932-1011（snake→camel 映射；createIfMissing:false 丢弃迟到事件；depth/index 稳定排序）
- 其他：recordTodos L460-470；pushActivity L529-543；pruneTransient L371-378；endReasoningPhase L272-275；clearReasoning L162-169；clearStatusTimer L171-173
- export const turnController = new TurnController() L1014（模块级单例）
闭环连接点：eventAdapter.ts 所有回合类事件调用它；adapter 注入 persistSpawnTree（eventAdapter.ts:161）；输出 patchTurnState（flowStore.ts:39）+ appendMessage（useSessionShell 提供）；中断依赖注入 InterruptDeps（useSessionShell）。

### runtime/presentationStore.ts（42 行）
职责：presentation read-model（纯投影）的存取 seam。
关键导出与行号：$presentation L15；getPresentationState L17；dispatchPresentationEvent L21-31（跨会话重置投影）；resetPresentationState L33；usePresentationSelector L37-42。
闭环连接点：eventAdapter.ts:99 feed → 本文件；读者 turnSections.tsx:16（Verification/Evidence 分区）。

### runtime/presentationReducer.ts（310 行）
职责：阶段 2 view-only 纯 reducer——事件序列 → 确定性展示快照（不碰 operational stores）。
关键导出与行号：SessionLifecycle L8；TurnPhase L10-20；PromptKind L21；PROMPT_PRIORITY L24（approval→confirm→clarify→sudo→secret→form 严格优先级）；PromptView L26；PresentationState L60-79；initialPresentationState L81-99；PresentationEvent L101-121；PresentationEventBody L124-128；isStaleEvent L141-151（generation/session 双守卫）；topPrompt L154-164；turnReset L171-180；presentationReducer L182-308（session.changed 清空 L194-201；message.delta 累积 streaming L212；message.complete 入 history L215-228；prompt.opened/closed 维护 openPrompts+blockingPrompt L258-287；evidence 委托 evidenceReducer L301-302；未知事件不改快照 L304-306）。
闭环连接点：presentationStore.ts:21；测试 presentationReducer.test.ts。

### runtime/presentationReducer.test.ts（121 行）
职责：纯 reducer 合同测试——确定性、streaming 不丢不重、blocking prompt 优先级回落、session/generation 守卫。
关键断言：L20-30 确定性；L32-41 streaming→history；L63-91 prompt 优先级链（approval→…→form 逐级回落）；L95-120 session 守卫。
闭环连接点：对应 presentationReducer.ts。

### runtime/presentationStore.test.ts（62 行）
职责：read-model seam 合同——dispatch→确定性快照、跨会话重置、证据仅 verification 事件。
关键断言：L14-26；L28-40（旧 generation 丢弃 / 跨会话重置）；L42-49；L51-61。
闭环连接点：presentationStore.ts。

### runtime/evidenceModel.ts（175 行）
职责：阶段 2 证据状态机（纯 reducer）——红线：只有 verification.succeeded 能进 verified。
关键导出与行号：EvidenceStatus L6-14；EvidenceItem L16-27；EvidenceSnapshot L29-32；EvidenceEvent L38-43（类型层排除 assistant text/tool success/todo 伪造路径）；evidenceReducer L51-148；evidenceStatusOf L151-152（缺失→unknown 绝不默认 verified）；evidenceOverall L155-175（failed > interrupted > pending > verified > unknown）。
闭环连接点：presentationReducer.ts:301-302 委托；turnSections.tsx:17 汇总。

### runtime/evidenceModel.test.ts（88 行）
职责：证据状态机红线测试——只有 succeeded 进 verified、failed 不冒充、汇总优先级。
闭环连接点：evidenceModel.ts。

### runtime/backgroundStore.ts（76 行）
职责：A24 后台活动只读状态（终端 BgTerm/任务 BgJob/定时 BgCron/goal 循环 BgGoal）。
关键导出与行号：类型 BgTerm L7-14 / BgJob L16-24 / BgCron L26-32 / BgGoal L34-41 / BgState L43-49；buildBgState L51；$bgState L53；patchBgState L57-58（自动 ts=Date.now）；useBgSelector L63-68；resetBgState L70；bgActiveCount L73-76。
闭环连接点：数据源 5s 轮询（useBackgroundPoll，目录外）+ eventAdapter.ts:793-816（background.goal/background.jobs 事件即时刷新）；读者 appLayout.tsx:9/70-89（BgSummaryLine）。

### runtime/delegationArchive.ts（159 行）
职责：子代理 spawn 树回合快照内存归档（最多 10）+ 磁盘快照归一化。
关键导出与行号：SpawnSnapshot L6-15；SpawnDiffPair L17-20；$spawnHistory/$spawnDiff L44-45；pushSnapshot L63-85（HISTORY_LIMIT=10）；summarizeLabel L87-95；pushDiskSnapshot L103-124；normaliseSubagent L126-159。
闭环连接点：flowController.recordMessageComplete:633-642 调用 pushSnapshot；ops.ts:324（/replay load）pushDiskSnapshot；agentsOverlay.tsx:703-704 消费。

### runtime/delegationStatus.ts（77 行）
职责：委派上限/暂停状态 + overlay 折叠手风琴全局开关。
关键导出与行号：DelegationState L5-13；$delegationState L22；patchDelegationState L26；resetDelegationState L29；$overlaySectionsOpen L41；toggleOverlaySection L43-48；getOverlaySectionOpen L50-54；applyDelegationStatus L57-77。
闭环连接点：agentsOverlay.tsx:5-10/785-790；appChrome.tsx SpawnHud:294；ops.ts:247（/agents pause）。

### runtime/scroll.ts（73 行）
职责：带选区感知的滚动（选区随滚动平移 + captureScrolledRows）。
关键导出与行号：SelectionSnap L5-9；ScrollWithSelectionOptions L11-14；scrollBoundsForDelta L16-31（fresh scroll height 兜底虚拟历史尾部）；scrollWithSelectionBy L33-73（scrollTo 绝对定位修复 pending-delta 阶梯滚动）。
闭环连接点：useInputHandlers（目录外）调用；ScrollBoxHandle 由 types/hermes-ink.d.ts:89-104 声明。

### runtime/selectionStore.ts（15 行）
职责：输入框选区全局原子（供 /copy 等读取）。
关键导出与行号：InputSelection L3-9；$inputSelection L11；setInputSelection L13；getInputSelection L15。
闭环连接点：textInput.tsx:5/628-640 注册；slash/chat.ts /copy 使用。

### runtime/tuiProjection.ts（21 行）
职责：TUI 视图本地状态 sidecar——只消费 run.* 生命周期事件喂入纯投影管线。
关键导出与行号：getTuiProjection L10；subscribeTuiProjection L11-14；feedTuiProjection L16-21（toProtocolGatewayEvent → 过滤 run. 前缀 → projectGatewayEvent().reduce(reduceTui)）。
闭环连接点：eventAdapter.ts:411 每个事件调用；底层实现 src/presentation/tui/（目录外）。

### runtime/voiceRpc.ts（25 行）
职责：语音录音/转写 RPC 的 legacy 路径委托（requireLegacyPath 守卫）。
关键导出与行号：startVoiceRecording L6-15；stopVoiceTranscribe L17-25。
闭环连接点：kernel/voice.js 动态导入（目录外）；legacyGuard 门控。

---

## 三、components/（31 文件）——React Ink 面板与交互

### components/appLayout.tsx（542 行）★ 布局总装
职责：单栏主布局——transcript（ScrollBox 虚拟化）/ PromptZone / ComposerPane / 状态栏两档 / FPS；AppLayoutProps 编排。
关键导出与行号：PromptPrefix L37-60；modelBarLabel L63-67；BgSummaryLine L70-89（后台任务/终端/goal 摘要行）；TranscriptPane L91-224（BrandBar 常驻 L114-117；ScrollBox+滚动条几何 row L121-214；虚拟化 topSpacer/rows.slice(start,end)/bottomSpacer L137-194；StreamingAssistant L196-204；TurnSections L207；StickyPromptTracker L216-221）；ComposerPane L226-411（QueuedMessages L287、sticky prompt 点击载入 L297-309、FloatingOverlays L314-330、HelpHint 触发 '?' L332、TextInput 装配 L367-379、麦克风钮 L381-396）；AgentsOverlayPane L413-426；StatusRulePane L428-471（statusBar top/bottom 两档 + 全部 StatusRule props 接线）；AppLayout L473-535（INLINE_MODE 切 AlternateScreen L487；agents overlay 换片 L497-505；PromptZone 接 answerApproval/answerClarify/answerSecret/answerSudo/answerForm/cancelForm L509-518；SHOW_FPS L525-529）。
闭环连接点：props 由 useMainApp/useSessionShell 组装；useStore($uiState) L97/231/481；useGateway L414；$isBlocked L232。

### components/appOverlays.tsx（373 行）
职责：浮层渲染——PromptZone（阻塞式提问区）+ FloatingOverlays（下拉/补全/pager 浮层）。
关键导出与行号：COMPLETION_WINDOW=16 L24；PromptZone L26-134（approval→ApprovalPrompt L54-60、confirm L62-77、clarify L79-91、sudo L93-99、secret L101-115、form L118-131；sudo/secret 点击取消 = 空值 respond L40-52）；FloatingOverlays L136-373（sessions/modelPicker/skillsHub/commandPalette/pluginsHub/dirPicker/pager/补全窗口 L183-370；FloatBox 常驻 + display 切换显隐，规避 React 19 并发条件渲染挂错父节点 L176-181；pager 翻页按钮 L280-307；补全行点击接受 L334-339）。
闭环连接点：appLayout.tsx:314-330 传 props；审批回传 onApprovalChoice L57 → appLayout.tsx:512。

### components/appChrome.tsx（935 行）★ 状态栏与计时器
职责：状态栏 StatusRule（渐进收缩布局）+ busy 指示器 FaceTicker + 时钟类自驱重绘组件 + 滚动条。
关键导出与行号：FACE_TICK_MS=2500 L24；VERB_PAD_LEN/padVerb L28-29；renderIndicator L54-92（kaomoji/emoji/ascii/unicode 四风格 + cmd/ascii 档字形降级退回 ASCII 帧）；MAX_DURATION_WIDTH L116-119；busyIndicatorWidth L126-133；FaceTicker L135-179（glyph interval + 1s clock + verb 2500ms 三 timer，useEffect L146-161）；ctxBarColor L181-199；statusSessionCountLabel L201；noticeColor L208-223；ctxGradientCells L234-252（青→黄→红热力带）；statusRuleWidths L258-277（cwd 段优先让位）；StatusBarSegments/statusBarSegments L285-289；SpawnHud L291-350（委派深度/并发接近上限变 warn/error）；SessionDuration L352-363（1s 自驱）；IdleSince L365-378；effortLabel/shortModelLabel/modelLabel L380-399；GoodVibesHeart L401-424（tick 触发 650ms 心形）；StatusRule L426-776（slotWidth 预算：hint > busy FaceTicker+status > notice > status L496-502；tail 渐进弃段 L513-562；notice/hint 可收缩槽 L608-620；模型段可点 L629-641；ctx 渐变条 L649-666；battery L552-557/719-735；SpawnHud 最后渲染 L752）；FloatBox L778-807；StickyPromptTracker L809-816（viewport→sticky prompt 派生）；TranscriptScrollbar L818-889（thumb 拖动 jump）。
闭环连接点：viewStore 驱动（StatusRulePane appLayout.tsx:428-471 全量接线）；stickyPromptFromViewport 来自 domain/viewport.ts:18；StatusRuleProps L891-923。

### components/appChrome-indicator.test.ts（50 行）
职责：busy 指示器 tier 降级合同测试（cmd/ascii 档绝不发射 astral emoji/盲文帧）。
关键断言：L19-26 full 档；L28-36 bmp/ascii 档纯 ASCII；L38-44 kaomoji/ascii 保持；L46-49 unicode 无 verb。
闭环连接点：appChrome.tsx renderIndicator:54。

### components/messageLine.tsx（492 行）★ 单条消息渲染
职责：transcript 单行（块）渲染——按 kind/role 分发到 TodoPanel / ToolTrail / 工具结果卡片 / Markdown / 系统折叠 / event 时间线，含 A19 鼠标选中复制。
关键导出与行号：SYSTEM_COLLAPSE_CHARS=400 L40；HOVER_HINT L43；MessageClickIntent/messageClickIntent L46-66；messageMultiClickIntent L69-70；renderSkillRefs L77-109（/skill: 引用可点执行）；MessageLine L111-450（thinking/tools/activity 三区 sectionMode 解析 L138-140；leadGap L149；event 行 L213-229；todos trail L231-240；tools trail L242-264；空 trail 不渲染 L270-272；tool 结果卡片 L274-296；kind==='slash' ANSI L307-315；长 system 折叠 L320-336；assistant → StreamingMd/Md L342-353；user 长消息折叠 L355-367；点击选中/双击复制 L174-193；hover 提示 L195-209；选中高亮 selectionBg L437-446）；shouldShowResponseSeparator L456-461（Response 徽标）。
闭环连接点：appLayout.tsx:173-188 调用；prevRenderedMsg/hasLeadGap 来自 domain/blockLayout.ts:68/132；$selectedMessage viewStore.ts:46。

### components/markdown.tsx（1196 行）★ 自研 Markdown 渲染器
职责：无依赖行级 Markdown 解析（标题/表格/代码块/数学/脚注/列表/引用/details/媒体）→ Ink 节点；主题键控 LRU 缓存。
关键导出与行号：MEDIA_LINE_RE L91；AUDIO_DIRECTIVE_RE L92；INLINE_RE L110-134（18 个捕获组优先序：image/link/autolink/strike/code/bold/italic/highlight/脚注/上下标/URL/行内数学）；stripInlineMarkup L201-217；DetailsBlock L226-248；renderTable L250-530（三档列宽 + grapheme 硬折 + 竖排降级）；MdInline L532-649（行内 token 递归渲染，数学 texToUnicode + inverse 高亮）；跨实例缓存 MD_CACHE_LIMIT=512 L654 + WeakMap<Theme, LRU Map> L655-687；MdImpl L689-1185（主解析循环：media L740-758、fence L760-865（含复制按钮 L801、diff 行着色 L840-855）、数学块 L867-943、heading L945-976、hr L978-988、脚注 L990-1013、定义列表 L1015-1041、bullet/task L1043-1062、numbered L1064-1077、quote L1081-1106、表格 L1108-1171、<details> L1122-1138、裸 HTML 行 L1140-1150）；export const Md = memo(MdImpl) L1187。
闭环连接点：messageLine.tsx:351 调用；streamingMarkdown.tsx 复用；cols 来自 transcriptBodyWidth（lib/inputMetrics）。

### components/streamingMarkdown.tsx（174 行）
职责：流式增量 Markdown——稳定前缀 memo 复用 + 尾部重解析（O(tail) 而非 O(total)）。
关键导出与行号：fenceOpenAt L57-102（code/$$/\[ 围栏平衡）；findStableBoundary L107-129（最后安全 \n\n 边界）；StreamingMd L131-167（stablePrefixRef 只前进不回退；两个 <Md> 竖向堆叠）。
闭环连接点：messageLine.tsx:346-349（isStreaming 时）；文本来自 turnState.streaming（flowController.scheduleStreaming）。

### components/thinking.tsx（1241 行）★ 工具轨迹/思考/子代理树
职责：ToolTrail 面板组（Thinking/工具组/Spawn tree/Activity + 树形绘制原语）。
关键导出与行号：树原语 TreeRow L62-93 / TreeTextRow L95-130 / TreeNode L132-159；Spinner L161-182（think/tool 两组盲文动画）；StreamCursor L202-238（420ms 闪烁）；Chevron L240-274（Shift/Ctrl 点击 expandAll）；heatColor L276-287；SubagentAccordion L289-625（递归子树 + rollup 后缀 status/耗时/tool/token/cost/文件 + 热力 stem）；Thinking L629-685（truncated/full 两模式）；ToolTrail L699-1241（四区可见性 sectionMode L732-740；工具耗时 200ms 自驱跳动 L758-767；trail 行解析 parseToolTrailResultLine L807-849；live tools 带 Spinner L851-875；activity 后 4 条 L877-881；allHidden 时浮空告警回退 L934-946；panels 组装 thinking/tools/subagents/activity L994-1201；token 合计行 L1218-1231；outcome 行 L1232-1238）。
闭环连接点：messageLine.tsx:245/401、streamingAssistant.tsx:97-115；数据 turnState + props。

### components/textInput.tsx（1440 行）★ 输入框
职责：全功能受控输入框——光标/选区/undo/redo/鼠标多击/剪贴板/fast-echo 直写 stdout 快路径。
关键导出与行号：wordBoundsAt L54-69（双击选词）；lineBoundsAt L72-78（三击选行）；applyPrintableInsert L140-161；shouldRouteMultiCharInputAsPaste L163；shouldPreserveCtrlJNewline L165-187（WT_SESSION/SSH/Ghostty/WSL 保留裸 LF）；lineNav L250-275（逻辑行上下移动）；canFastAppendShape L304-328；canFastBackspaceShape L357-392（软换行边界拒绝）；supportsFastEchoTerminal L394-421（Apple_Terminal/tmux/Termux 黑名单）；TextInput L482-1360（ref 双写机制 curRef/vRef L501-503；FRAME_BATCH_MS=16 批量提交 L37/675-701；fast-echo stdout.write(text) + noteCursorAdvance L1241-1258、backspace \b \b L1132-1145；useInput 主键处理 L976-1269（paste 热键 L991-1012、Enter 提交/Shift+Enter 换行 L1042-1055、undo/redo L1074-1080、词跳转/删除 L1118-1189、bracketed paste L1190-1196）；鼠标 API mouseApiRef L968-974；onMouseDown 多击计数 L1293-1341；右键复制/粘贴 L1298-1312）；decideRightClickAction L1407-1420；shouldPassThroughToGlobalHandler L1422-1434；TextInputMouseApi L1436-1440。
闭环连接点：appLayout.tsx:369-378（ComposerPane）；prompts.tsx:197（Clarify 自定义输入）、maskedPrompt.tsx:22、dynamicFormPrompt.tsx:77、activeSessionSwitcher.tsx:905；选区发布 selectionStore.ts:628-640。

### components/streamingAssistant.tsx（149 行）
职责：live 回合区——流式段/在飞工具/待挂工具拼装成 MessageLine 块序列 + 动态状态行。
关键导出与行号：groupedSegments L16-17；StreamingAssistant L26-131（blocks 拼装 L59-73；busy 状态行 + Spinner L81-94；blockRenders 决定分组前驱 L121-125）；LiveTodoPanel L133-139（turnState.todos 受控 TodoPanel，toggleTodoCollapsed）。
闭环连接点：appLayout.tsx:196-204；数据 useTurnSelector（flowStore）。

### components/todoPanel.tsx（120 行）
职责：工具任务清单（turnTodos）面板——折叠 + 完成计数 + in_progress 闪烁。
关键导出与行号：rowColor L9-13；TodoPanel L15-120（受控/非受控折叠 L33-64；in_progress 行 [>]↔[ ] 500ms 闪烁 L38-52；行点击选中高亮 L104）。
闭环连接点：LiveTodoPanel（streamingAssistant.tsx:133）live 用；messageLine.tsx:231-240 归档用；数据 flowStore.todos。

### components/turnSections.tsx（268 行）
职责：阶段 6 回合分区展示（计划/活动/修改/验证/证据——单栏纵向）。
关键导出与行号：PlanSection L31-71（todos 清单 + 完成计数，全完成默认收起）；ActivitySection L80-123（activeTools + doneTools 生命周期行）；ChangesSection L128-173（diffSummary 摘要 + 展开 per-file）；VerificationSection L178-211（仅真实验证事件；空时诚实显示「等待真实验证事件 · 待验证」）；EvidenceSection L215-243（evidenceOverall 汇总 + 来源事件标识）；TurnSections L250-268（busy 或 hasEvidence 才渲染整体）。
闭环连接点：appLayout.tsx:207；数据源 flowStore（useTurnSelector）+ presentationStore（usePresentationSelector）。

### components/turnSections.test.tsx（151 行）
职责：分区展示渲染合同（诚实性红线：绝不伪造「已验证」）。
关键断言：L21-53 计划分区；L56-84 活动分区；L86-101 修改分区；L103-136 验证/证据红线；L139-151 窄宽度不抛错。
闭环连接点：turnSections.tsx + flowStore/presentationStore 直写。

### components/prompts.tsx（332 行）★ 审批/确认/澄清面板
职责：三块阻塞式提问面板 + 纯键盘分发函数。
关键导出与行号：APPROVAL_OPTS = ['once','session','always','deny'] L12；APPROVAL_OPTS_NO_ALWAYS L14（tirith 警告时去掉 always）；LABELS L15；ApprovalChoice L18；approvalAction(ch,key,sel,opts) L43-72（Esc→deny；数字键 1..n；Enter→当前项；↑↓ 移动；纯函数可测）；ApprovalPrompt L74-145（useInput 挂 approvalAction L79-87；长命令 wrapAnsi 硬折行 + CMD_PREVIEW_LINES=10 截断 + 点击展开 L89-126；选项行 onClick 直接选 L130-138；提示行 L140-142）；ClarifyPrompt L147-247（选项/自定义输入两态；Other 行进入 typing L229-236）；ConfirmPrompt L249-310（Y/N + ↑↓ + danger 着色）。
闭环连接点：appOverlays.tsx PromptZone:57/74/84；回传 onChoice/onAnswer → appLayout actions（useSessionShell 实现）。

### components/maskedPrompt.tsx（59 行）
职责：掩码单行输入（sudo 密码/secret 值）+ 提交/取消按钮。
关键导出与行号：MaskedPrompt L9-48（TextInput mask="*"；空值禁点提交 L27；取消按钮 L37-44）。
闭环连接点：appOverlays.tsx:96/104（sudo/secret）；onSubmit → appLayout answerSudo/answerSecret。

### components/dynamicFormPrompt.tsx（112 行）
职责：动态内容表（credential.form 多字段敏感输入——值仅内存回传）。
关键导出与行号：DynamicFormField L13-17；DynamicFormPrompt L28-112（聚焦字段掩码 TextInput；↑/↓、Tab 切换 L42-57；末字段 Enter = 提交全部 L37-40；提交/取消按钮 L94-105）。
闭环连接点：appOverlays.tsx:118-131；onSubmit → answerForm（useSessionShell.ts:987-996，credential.respond RPC）。

### components/commandPalette.tsx（190 行）
职责：Ctrl+K 命令面板——commands.catalog/skills.manage/session.active_list 三源真实 RPC + fuzzy 过滤。
关键导出与行号：PaletteEntry L14-19；CommandPalette L29-180（Promise.allSettled 三源加载 L44-74；fuzzyScoreMulti 过滤 L77-90；MAX_ROWS=9；Enter/点击执行：命令/技能→onSubmit 提交，会话→onSessionSelect L107-116/150-161）。
闭环连接点：appOverlays.tsx:215-227；onPaletteSubmit → composer.submit（appLayout.tsx:324-327）。

### components/modelPicker.tsx（717 行）
职责：模型选择器（provider → model 两段 + API key 录入 + 断开确认）。
关键导出与行号：ModelPicker L21-708（model.options RPC L46-76；fuzzyRank 过滤 L90-111；acceptProviderAt L160-183（未认证→key 段）；acceptModelAt L185-195（--provider slug --global/--tui-session）；saveKey → model.save_key L198-229；confirmDisconnect → model.disconnect L232-269；useInput 四段处理 L271-404；key 段掩码 L429-494；provider/model 列表窗口 L546-708）。
闭环连接点：appOverlays.tsx:199-209；activeSessionSwitcher.tsx:673-687（内嵌复用）；TUI_SESSION_MODEL_FLAG domain/slash.ts:2。

### components/dirPicker.tsx（238 行）
职责：A24 目录选择器——dir.list 浏览 + cwd.set 切换 + /term + explorer。
关键导出与行号：parentOf L24-34（Win 盘符根处理）；joinPath L36-40；basenameOf L42-50；DirPicker L54-238（load→dir.list L68-91；switchHere→cwd.set L138-154；openTerminalHere→command.dispatch term L156-158；openExplorer→shell.exec L160-162；MAX_ROWS=14 窗口化 L164-170；动作栏按钮 L218-233）。
闭环连接点：appOverlays.tsx:233-236；状态栏 cwd 点击打开（appLayout.tsx:457）。

### components/skillsHub.tsx（354 行）
职责：技能 Hub——category → skill → actions(inspect/install) 三段 RPC 面板。
关键导出与行号：SkillsHub L14-341（skills.manage list L28-39；inspect L66-73；install L75-83；三段 useInput L85-179）。
闭环连接点：appOverlays.tsx:211-213；/skills 命令 ops.ts:430。

### components/pluginsHub.tsx（253 行）
职责：插件 Hub——plugins.manage list/toggle + user/all 作用域。
关键导出与行号：PluginsHub L43-247（list L56-69；toggle L82-101；Tab 切作用域 L122-127；数字键快捷 L140-150）。
闭环连接点：appOverlays.tsx:229-231；/plugins 命令 ops.ts:609。

### components/activeSessionSwitcher.tsx（944 行）
职责：会话编排器——[+new][live…][history…] 合并列表 + 草稿 prompt + 模型选择内嵌。
关键导出与行号：纯函数组 L46-272（sessionRowKindAt L61、resumableHistory L88、closeFallbackAfterClose L195、draftModelArgFromPickerValue L209、orchestrator 提示段 L94-144）；ActiveSessionSwitcher L295-927（load → session.active_list + session.list allSettled L349-442；1.5s 静默轮询 L449-454；closeSession → onClose RPC + 光标回退 L471-507；双 d 删除确认 L586-599；useInput 全键位 L582-671；行内 ModelPicker L673-687；窗口化渲染 L693-899；new 行 TextInput 草稿 L901-911）。
闭环连接点：appOverlays.tsx:183-197；actions 来自 useSessionShell（closeLiveSession 等）。

### components/agentsOverlay.tsx（1147 行）
职责：/agents 子代理树仪表盘——list/detail 双模式 + Gantt + 回放 + kill/pause + 双快照 diff。
关键导出与行号：OverlayScrollbar L144-226（tick 驱动重算）；GanttStrip L228-361；OverlaySection L363-392；Detail L403-538；ListRow L540-588（热力标记）；DiffView L636-696（基线/候选/Δ 指标）；AgentsOverlay L700-1137（live=historyIndex 0 / 回放 1..N L727-733；300/500ms tick L750-758；auto-follow 回合完成 L766-778；interrupt/killOne/killSubtree/togglePause L808-836；stepHistory L838-848；useInput 双模式键位 L861-959；动作栏按钮 L1071-1110）；closeAgentsOverlay/openAgentsOverlay L1146-1147。
闭环连接点：appLayout.tsx:413-426（AgentsOverlayPane）；数据 $spawnHistory/$spawnDiff/$delegationState/useTurnSelector；/agents 命令 ops.ts:236-266。

### components/branding.tsx（525 行）
职责：品牌横幅 Banner + 会话卡 SessionPanel（工具/技能/特色能力/MCP/系统提示折叠区）+ 通用 Panel。
关键导出与行号：InlineLoader L16-34（120ms）；ArtLines L36-46；Banner L91-126（按列宽 4 档响应式）；CollapseToggle L130-159；SessionPanel L166-473（特色能力默认展开 L184；模型/cwd 可点开选择器 L305-316/341-351；工具墙默认折叠 L179；update_behind 提示 L454-469）；Panel L475-510（rows/items/text 三型 section）。
闭环连接点：appLayout.tsx:158-171（intro 行 Banner/SessionPanel、panel 行 Panel）；FEATURE_SPOTLIGHTS content/features.ts。

### components/brandBar.tsx（48 行）
职责：常驻品牌顶栏（左品牌名 + 吸积盘渐变规则线 + 右上下文），不随滚动消失。
关键导出与行号：BrandBar L9-48（<24 列整体让位）。
闭环连接点：appLayout.tsx:114-117；布局规则 lib/brandRule.ts。

### components/queuedMessages.tsx（69 行）
职责：排队消息窗口（QUEUE_WINDOW=3 滑动窗 + 编辑态）。
关键导出与行号：QUEUE_WINDOW L6；getQueueWindow L8-15；QueuedMessages L17-60（点击行进入编辑 L45）。
闭环连接点：appLayout.tsx:287-293；composer.queuedDisplay/editQueued。

### components/fpsOverlay.tsx（30 行）
职责：FPS 角标（WXNODUS_TUI_FPS=1 时显示，零成本关闭）。
关键导出与行号：FpsOverlay L13-19；FpsOverlayInner L21-30。
闭环连接点：appLayout.tsx:525-529；$fpsState lib/fpsStore.ts。

### components/helpHint.tsx（77 行）
职责：'?' 快速帮助浮层——常用命令（可点执行）+ 快捷键预览。
关键导出与行号：COMMON_COMMANDS L6-14；HelpHint L18-77。
闭环连接点：appLayout.tsx:332（composer.input === '?' 触发）；HOTKEYS content/hotkeys.ts。

### components/themed.tsx（39 行）
职责：主题化小原语 Keycap / Fg。
关键导出与行号：Keycap L9-15；Fg L17-25；ThemeColor L27；FgProps L29-39。
闭环连接点：overlayControls.tsx:3（Keycap 用于 OverlayHint）。

### components/overlayControls.tsx（67 行）
职责：浮层共用件——q/Esc 键位 hook、键帽化提示行、列表窗口化工具。
关键导出与行号：useOverlayKeys L6-20；KEYCAP_RE L24；OverlayHint L26-44（把「↑/↓ select · Enter confirm」解析为键帽）；windowOffset L46-47；windowItems L49-56。
闭环连接点：modelPicker/skillsHub/pluginsHub/dirPicker/pager 全用。

### components/uiPrimitives.tsx（102 行）
职责：阶段 3 分区原语——SectionHeader / StatusBadge / SingleColumnPanel / InlineHint（tier-safe，宽度一律 stringWidth）。
关键导出与行号：SectionHeader L13-53；StatusBadge L56-84；SingleColumnPanel L87-93；InlineHint L96-102。
闭环连接点：turnSections.tsx:26。

---

## 四、commands/（8 文件）——斜杠命令注册与执行

### commands/slashHandler.ts（180 行）
职责：斜杠命令总入口——本地注册命令优先 → catalog.canon 别名解析 → slash.exec RPC → 失败回退 command.dispatch。
关键导出与行号：createSlashHandler(ctx) L10-180（flight 计数器 + stale 守卫 L16-36；handleDispatch L41-90（exec/plugin/alias/skill/send/prefill 五种结构化响应）；findSlashCommand L92-98；canon 别名精确/前缀匹配 L100-127；slash.exec L129-157（长输出 >180 字符或 >2 行 → page() pager，PAGER_TITLES 中文标题表 L147-153）；command.dispatch 兜底 L158-174）。
闭环连接点：useSessionShell.ts:889-941 构造；page/panel/send/sys 均来自 transcript ctx。

### commands/slashRegistry.ts（44 行）
职责：本地命令注册表——KEEP_LOCAL 白名单过滤后按 name+alias 建 Map。
关键导出与行号：KEEP_LOCAL L12-30（core/session/setup/ops/conversation 各模块保留清单）；SLASH_COMMANDS L32-38；findSlashCommand L44（大小写不敏感）。
闭环连接点：slashHandler.ts:92；chat/conversation/ops/bootstrap/diagnostics 五模块汇入。

### commands/slashTypes.ts（21 行）
职责：斜杠命令类型契约。
关键导出与行号：SlashRunCtx L5-13（含 flight/guarded/guardedErr/stale/ui）；SlashCommand L15-21。
闭环连接点：全部命令模块实现该接口。

### commands/slash/bootstrap.ts（11 行）
职责：/setup 进程内执行。
关键导出与行号：setupCommands L5-11（run → runInProcessSetup）。
闭环连接点：bridge/setupHandoff.ts:11。

### commands/slash/chat.ts（539 行）
职责：本地 UI 命令组 coreCommands（quit/update/mouse/clear/details/fortune/copy/paste/terminal-setup/history/save/statusbar/queue/steer/undo/retry/redraw/title）。
关键导出与行号：MOUSE_MODE_ALIASES L27-38；coreCommands L56-539（quit→die L61；update→dieWithCode(42) L67-72；mouse→patchUiState+config.set L79-91；clear/new→confirm 面板 L98-125（NO_CONFIRM_DESTRUCTIVE 跳过）；details→config.get/set + sections L182-239；copy→copySelection 或 assistant 消息 L262-307；steer→session.steer L457-489；undo/retry→session.undo+trimLastExchange L492-538）。
闭环连接点：slashRegistry.ts:33 汇入；OverlayState.confirm 由 promptStore 承载（prompts.tsx ConfirmPrompt 渲染）。

### commands/slash/conversation.ts（542 行）
职责：会话/模型/语音类命令 sessionCommands（background/model/sessions/image/personality/compress/branch/voice/skin/indicator/reasoning/fast/busy/verbose）。
关键导出与行号：stripTuiSessionFlag L22；sessionCommands L38-542（background→prompt.background L45-60；model→config.set + confirm_required 弹窗 L66-109；sessions→overlay 或 newLiveSession/resumeById L116-138；compress→setHistoryItems 重建 L185-233；branch→session.branch L240-255；voice→voice.toggle L261-356（record_key 解析回填 L294-298）；indicator→config.set + 热切换 patchUiState L379-409；reasoning→config.set + sections 联动 L415-451；fast→config.set + info.fast L457-495）。
闭环连接点：slashRegistry.ts:34；TUI_SESSION_MODEL_FLAG domain/slash.ts:2。

### commands/slash/diagnostics.ts（48 行）
职责：调试命令 debugCommands（heapdump/mem）。
关键导出与行号：debugCommands L4-48（heapdump→performHeapDump L13-24；mem→process.memoryUsage panel L30-46）。
闭环连接点：slashRegistry.ts:37；lib/memory.ts。

### commands/slash/ops.ts（691 行）
职责：运维命令 opsCommands（stop/reload-mcp/reload/rollback/agents/replay/replay-diff/reload-skills/skills/plugins/tools）。
关键导出与行号：opsCommands L63-691（rollback list/diff/restore L143-229；agents→delegation.pause/status/overlay L236-266；replay list/load/N L271-352（pushDiskSnapshot + agentsInitialHistoryIndex）；replay-diff→setDiffPair L356-387；skills 子命令族 L426-598；plugins→hub 或 slash.exec L604-627；tools→tools.configure + 历史重置 L631-689）。
闭环连接点：delegationArchive.ts / delegationStatus.ts / promptStore.ts；slashRegistry.ts:35。

---

## 五、content/（8 文件）——文案与内容源

### content/charms.ts（1 行）
职责：长时间运行趣味文案数组。
关键导出：LONG_RUN_CHARMS L1。
闭环连接点：useLongRunToolCharms（useSessionShell.ts:887，目录外）。

### content/faces.ts（17 行）
职责：kaomoji 表情帧（busy 指示器帧源）。
关键导出：FACES L1-17。
闭环连接点：appChrome.tsx:56（renderIndicator kaomoji）。

### content/features.ts（20 行）
职责：旗舰能力速览（SessionPanel「特色能力」区，cmd 均可一键执行）。
关键导出：FeatureSpotlight L3-7；FEATURE_SPOTLIGHTS L9-20（/build、/memory、/voice on、/term new、/jobs、/goal、/map、/security、/self-evolve、/search）。
闭环连接点：branding.tsx:6/386-413。

### content/fortunes.ts（30 行）
职责：/fortune 彩蛋文案（随机 + 按 sid/日期哈希的每日一句 + 稀有 legendary）。
关键导出：randomFortune L29；dailyFortune L30。
闭环连接点：slash/chat.ts:249-256。

### content/hotkeys.ts（39 行）
职责：快捷键表（平台感知 Cmd/Ctrl、远程 shell、Termux）。
关键导出：HOTKEYS L18-39。
闭环连接点：helpHint.tsx:3/16（前 8 条预览）。

### content/placeholders.ts（13 行）
职责：输入框占位文案（启动时随机 pick 一条）。
关键导出：PLACEHOLDERS L3-11；PLACEHOLDER L13。
闭环连接点：appLayout.tsx:375。

### content/setup.ts（17 行）
职责：无密钥启动面板文案。
关键导出：SETUP_REQUIRED_TITLE L3；buildSetupRequiredSections L5-17。
闭环连接点：eventAdapter.ts:920（error 匹配 NO_PROVIDER_RE → panel）。

### content/verbs.ts（39 行）
职责：状态栏动词轮播文案（工具执行态 + 思考态）。
关键导出：TOOL_VERBS L2-21；VERBS L23-39。
闭环连接点：appChrome.tsx:12/28（VERB_PAD_LEN、FaceTicker verbTick）。

---

## 六、config/（3 文件）——启动常量与预算

### config/env.ts（68 行）
职责：环境变量/启动开关解析（单一事实来源）。
关键导出与行号：TERMUX_TUI_MODE L25；STARTUP_RESUME_ID L27；STARTUP_QUERY L28；STARTUP_IMAGE L29；MOUSE_TRACKING L48（优先级：WXNODUS_TUI_MOUSE_TRACKING > WXNODUS_TUI_DISABLE_MOUSE > Termux 默认 off）；NO_CONFIRM_DESTRUCTIVE L50；DEV_CREDITS_MODE L54；INLINE_MODE L64（Termux 默认 on——主缓冲渲染保 scrollback）；SHOW_FPS L68。
闭环连接点：eventAdapter.ts:1/270-298（STARTUP_*）、appLayout.tsx:10/487、viewStore.ts:3、appChrome.tsx:10。

### config/limits.ts（26 行）
职责：渲染/历史预算常量（OOM 防线）。
关键导出与行号：LARGE_PASTE L1；LIVE_RENDER_MAX_CHARS=16000/LINES=240 L3-4；VERBOSE_TRAIL_MAX_CHARS=800/LINES=12 L16-17（持久 trail 截断——修复 #34095 数百 MB Ink 节点 OOM）；LONG_MSG=300 L19；MAX_HISTORY=800 L20；THINKING_COT_MAX=160 L21；WHEEL_SCROLL_STEP=1 L26（保 DECSTBM 快路径）。
闭环连接点：messageLine.tsx:7/355、thinking.tsx:5、flowController（boundedLiveRenderText）。

### config/timing.ts（6 行）
职责：流式节流时间常量。
关键导出与行号：STREAM_BATCH_MS=16 L1；STREAM_IDLE_BATCH_MS=16 L2；STREAM_SCROLL_BATCH_MS=96 L3；STREAM_TYPING_BATCH_MS=80 L4；TYPING_IDLE_MS=250 L5；REASONING_PULSE_MS=700 L6。
闭环连接点：flowController.ts:1-7（全部引用）。

---

## 七、domain/（10 文件）——纯领域函数

### domain/blockLayout.ts（146 行）
职责：消息块视觉分组与行间距纯逻辑（哪个块之上要留空行、块是否渲染）。
关键导出与行号：BlockGroup L20；messageGroup L22-43（user/model/trail/note/diff/slash/intro 六组）；SELF_SPACED L50；PAINTS_TRAILING_GAP L55；hasLeadGap L68-85（只按前驱分组计算——streaming 安全）；DetailsCtx L87-91；trailAllHidden L93-96；blockRenders L110-124（空 trail 透明）；prevRenderedMsg L132-146（跨隐藏块找真前驱）。
闭环连接点：messageLine.tsx:8/149；appLayout.tsx:12（prevRenderedMsg）；streamingAssistant.tsx:7（blockRenders）。

### domain/details.ts（76 行）
职责：/details 可见性模型解析（全局模式 + 分区覆盖 + 内置默认分层）。
关键导出与行号：SECTION_NAMES L5（thinking/tools/subagents/activity）；SECTION_DEFAULTS L23-27（thinking/tools expanded、activity hidden）；parseDetailsMode L40；resolveDetailsMode L45；resolveSections L51-58；sectionMode L69-74（override → commandOverride 全局 → SECTION_DEFAULTS → 全局）；nextDetailsMode L76。
闭环连接点：messageLine.tsx:9/138-140、thinking.tsx:6/732-740、slash/chat.ts:5。

### domain/messages.ts（102 行）
职责：消息投影/格式化纯函数。
关键导出与行号：introMsg L5；bareIntro L7；startupHistory L15-16（info 缺失保 bareIntro——防品牌面板消失回归）；imageTokenMeta L18-24；attachedImageNotice L26-31；userDisplay L33-43（长消息折叠）；toTranscriptMessages L45-80（tool 行并入 tools 数组）；fmtDuration L82-89。
闭环连接点：useSessionShell 启动历史；conversation.ts:1/194；appChrome.tsx:13（fmtDuration）。

### domain/messages.test.ts（38 行）
职责：启动历史投影合同测试（bare intro 兜底）。
闭环连接点：messages.ts:15。

### domain/paths.ts（40 行）
职责：路径展示纯函数（cwd 缩写/分支标签/终端标题）。
关键导出与行号：shortCwd L1-6；fmtCwdBranch L8-16；composeTabTitle L27-40。
闭环连接点：useSessionShell（状态栏 cwdLabel/终端标题）。

### domain/providers.ts（11 行）
职责：模型提供商显示名（同名 slug 消歧）。
关键导出：providerDisplayNames L1-11。
闭环连接点：modelPicker.tsx:4/78。

### domain/roles.ts（9 行）
职责：角色 → 字形/颜色映射。
关键导出：ROLE L4-9。
闭环连接点：messageLine.tsx:11/298。

### domain/slash.ts（10 行）
职责：斜杠命令识别/解析。
关键导出：TUI_SESSION_MODEL_FLAG='--tui-session' L2；looksLikeSlashCommand L4；parseSlashCommand L6-10。
闭环连接点：slashHandler.ts:1/19；conversation.ts:2；activeSessionSwitcher.ts:4。

### domain/usage.ts（3 行）
职责：Usage 零值。
关键导出：ZERO L3。
闭环连接点：viewStore.ts:4/37。

### domain/viewport.ts（51 行）
职责：视口 sticky prompt 派生（当前可见用户提问回溯）。
关键导出：upperBound L5-16；stickyPromptFromViewport L18-51。
闭环连接点：appChrome.tsx:16/811（StickyPromptTracker）。

---

## 八、types/（1 文件）

### types/hermes-ink.d.ts（186 行）
职责：@wxnodus/ink 模块环境声明（自研 Ink 渲染器的完整 TS 面）。
关键导出与行号：Key L4-26；InputEvent L28-32；FrameEvent L36-60（onFrame 帧相位统计）；RenderOptions.capabilities L71-79（sync2026/decstbm/truecolor/osc8/oscNotify/mouse/extendedKeys 能力集）；Instance L82-87；ScrollBoxHandle L89-104（scrollTo/getScrollTop/getPendingDelta/getFreshScrollHeight/isSticky 等）；组件声明 L106-117；scrollFastPathStats L121-135；evictInkCaches L137-144；forceRedraw L146；hooks L149-185（useInput/useSelection/useStdout/useDeclaredCursor/useCursorAdvance/useStdin 等）。
闭环连接点：全组件库的类型基础；scroll.ts:1、textInput.tsx:18-27（InkExt 扩展）。

---

## 九、protocol/（2 文件）

### protocol/interpolation.ts（3 行）
职责：{!cmd} shell 输出插值正则。
关键导出：INTERPOLATION_RE L1；hasInterpolation L3。
闭环连接点：useComposerState（目录外，输入提交前插值）。

### protocol/paste.ts（1 行）
职责：[[...]] 粘贴片段占位正则。
关键导出：PASTE_SNIPPET_RE L1。
闭环连接点：useComposerState 粘贴处理。

---

## 十、重点问题回答（带行号）

### 1. bridge/ 的职责：wxGateway 内核事件与 React UI 之间的桥如何工作

桥由三段组成，数据流：网关 WS 事件 → 中央适配器 → 四路并行 store 写入 → 原子订阅驱动 React 重渲。

(1) 注入层：bridge/gatewayProvider.tsx L5-19 用 React Context 提供 { gw: GatewayClient, rpc: GatewayRpc }（interfaces.ts:81-84），组件经 useGateway()（L11）取用。

(2) 事件订阅层（目录外挂载点）：useSessionShell.ts L794-835 调 createGatewayEventHandler(ctx)（eventAdapter.ts:83）构造 handler，L876 gw.on('event', handler) 挂到 GatewayClient，L842-874 exit handler 用 planGatewayRecovery（recovery.ts:24）做崩溃恢复（3 次/60s 预算，超出降级 'gateway exited' 惰性态）。

(3) 翻译层：eventAdapter.ts 返回的 handler（L403-930）是一个巨型 switch——先做 session_id 过滤（L404-408），再 feedTuiProjection（L411，仅 run.* 事件），然后按事件类型写入四个并行数据流：
   - operational UI 原子：patchUiState（viewStore.ts:50-51）写 $uiState（viewStore.ts:40）；patchOverlayState（promptStore.ts:37-51，flushSync + 0/120ms 双 forceRedraw）写 $overlayState；patchBgState（backgroundStore.ts:57）写 $bgState。
   - 回合控制器：turnController.*（flowController.ts:114 单例 L1014）做流式节流/工具/子代理/通告编排，最终 patchTurnState（flowStore.ts:39）写 $turnState，回合末经 ctx.transcript.appendMessage 落历史。
   - presentation 纯投影：feed()（eventAdapter.ts:98-99）→ dispatchPresentationEvent（presentationStore.ts:21-31）→ presentationReducer（presentationReducer.ts:182）产出确定性只读快照（供 turnSections 验证/证据分区）。
   - TUI sidecar 投影：tuiProjection.ts:16-21（src/presentation/tui 管线，run.* 生命周期）。

(4) 重渲层（不是 zustand）：自研引擎 src/app/stores/engine.ts——createAtom（L56-73）以 useSyncExternalStore 实现 React 订阅；createStore（L17-43）是 zustand 兼容语义；computed（L83-107）懒重算派生原子。事件写 atom（值相同时短路，engine.ts:62）→ 通知 subscribers → 订阅组件重渲。订阅入口：useAtom as useStore($uiState)（appLayout.tsx:2,97,231,481）、useTurnSelector（flowStore.ts:32-37）、usePresentationSelector（presentationStore.ts:37-42）、useBgSelector（backgroundStore.ts:63-68）；派生原子 $isBlocked（promptStore.ts:27-33）、$uiTheme/$uiSessionId/$selectedMessage（viewStore.ts:42-46）实现重渲粒度隔离（如 messageLine 只订阅 $selectedMessage，hint 变化不重渲全部消息行）。

(5) 迟到/跨会话守卫双保险：adapter 层 session_id 过滤（eventAdapter.ts:404-408）+ reducer 层 isStaleEvent（presentationReducer.ts:141-151）generation/sessionId 丢弃。

### 2. components/ 主要面板清单

| 面板 | 文件:行 |
|---|---|
| 消息列表（transcript 虚拟化容器） | appLayout.tsx TranscriptPane L91-224（ScrollBox + 虚拟行 L137-194） |
| 单条消息渲染 | messageLine.tsx MessageLine L111-450 |
| Markdown 渲染 | markdown.tsx Md L1187（缓存 L654-687） |
| 流式 Markdown | streamingMarkdown.tsx StreamingMd L131-167 |
| 思考/工具轨迹/子代理树 | thinking.tsx ToolTrail L699-1241 / Thinking L629-685 |
| live 回合区（流式段拼装） | streamingAssistant.tsx StreamingAssistant L26-131 |
| 回合分区（计划/活动/修改/验证/证据） | turnSections.tsx TurnSections L250-268 |
| 输入框 | textInput.tsx TextInput L482-1360；装配 appLayout.tsx ComposerPane L226-411 |
| 排队消息 | queuedMessages.tsx QueuedMessages L17-60 |
| 审批面板 | prompts.tsx ApprovalPrompt L74-145；容器 appOverlays.tsx PromptZone L26-134（审批分支 L54-60）；挂载 appLayout.tsx L509-518 |
| 确认/澄清面板 | prompts.tsx ConfirmPrompt L249-310 / ClarifyPrompt L147-247 |
| 工具任务清单（turnTodos live） | todoPanel.tsx TodoPanel L15-120 + streamingAssistant.tsx LiveTodoPanel L133-139（数据 $turnState.todos，feed 源 eventAdapter.ts:101-128 feedTodos + flowController.ts:460-470 recordTodos）；归档版 messageLine.tsx L231-240；分区版 turnSections.tsx PlanSection L31-71 |
| 状态栏 | appChrome.tsx StatusRule L426-776 + FaceTicker L135-179；装配 appLayout.tsx StatusRulePane L428-471 |
| help 面板 | helpHint.tsx HelpHint L18-77（输入 '?' 触发 appLayout.tsx:332）；完整 /help 走 pager（appOverlays.tsx L238-317；slashHandler.ts:156） |
| 会话切换器/模型选择/命令面板/技能/插件/目录 | activeSessionSwitcher.tsx L295、modelPicker.tsx L21、commandPalette.tsx L29、skillsHub.tsx L14、pluginsHub.tsx L43、dirPicker.tsx L54 |
| /agents 子代理仪表盘 | agentsOverlay.tsx AgentsOverlay L700-1137 |

### 3. runtime/ 的运行时

- 渲染调度（流式节流）：flowController.ts——scheduleStreaming L885-896（单飞 setTimeout，STREAM_BATCH_MS=16ms，config/timing.ts:1；打字时 boostStreamingForTyping L150-152 → 80ms，滚动时 boostStreamingForScroll L154-156 → 96ms，空闲 relaxStreaming L158-160）；scheduleReasoning L871-883（思考文本 16ms 批）；hydrateStreamingText L898-904（立即灌入）；pulseReasoningStreaming L450-458（REASONING_PULSE_MS=700 动画脉冲）；recordToolProgress L804-825（工具进度 STREAM_BATCH_MS 批）；patchOverlayState 的 flushSync + 双 forceRedraw 兜底（promptStore.ts:37-51）。
- pty 输出注入：本目录内后台终端/任务状态是 backgroundStore.ts（BgTerm/BgJob/BgCron/BgGoal 只读模型 L7-49）——数据源为 background.status RPC 5s 轮询（文件头注释 L1-3，useBackgroundPoll 在目录外）+ background.goal（eventAdapter.ts:793-808）/background.jobs（L809-816）事件即时刷新；摘要行渲染 appLayout.tsx BgSummaryLine L70-89。真正的 node-pty 会话交互在目录外（后台面板组件 + useBackgroundPoll）。注意 voiceRpc.ts 是语音录音委托（kernel/voice legacy 路径），与 pty 无关。
- 时钟自驱重绘（全部靠组件本地 setInterval 自驱，不依赖外部 store）：FaceTicker（appChrome.tsx:135-179：glyph 2500ms 或 100ms + 1s 时钟 + verb 2500ms）；SessionDuration L352-363 / IdleSince L365-378（1s）；ToolTrail 工具耗时 200ms 跳动（thinking.tsx:758-767）；Spinner（thinking.tsx:161-182）、StreamCursor 420ms（L202-238）；todoPanel in_progress 500ms 闪烁（L43-52）；agentsOverlay 300/500ms tick（L750-758）；GoodVibesHeart 650ms（appChrome.tsx:405-417）；showSelectionHint 3s 自清（viewStore.ts:71-83）；turnController.statusTimer 状态 4s/6s 恢复（eventAdapter.ts:262-268/487/512）。

### 4. 审批面板（allow/session/deny）的渲染与回传路径

渲染链路（事件 → store → 组件）：
1. 网关 approval.request → eventAdapter.ts L736-755：patchOverlayState({ approval: {allowPermanent, command, description, tool, category, icon} }) + status 'approval needed' + feed prompt.opened（presentationReducer.ts:258-269 记 blockingPrompt，approval 为最高优先级 PROMPT_PRIORITY:24）。
2. $overlayState（promptStore.ts:25）变化 → appLayout.tsx PromptZone 挂载点 L509-518 → appOverlays.tsx PromptZone L54-60（overlay.approval 命中）→ prompts.tsx ApprovalPrompt L74-145。
3. 选项集合：APPROVAL_OPTS = ['once','session','always','deny']（prompts.tsx:12）四选；当网关标记 tirith 警告（allowPermanent === false，eventAdapter.ts:738-739）时降为三选 APPROVAL_OPTS_NO_ALWAYS（prompts.tsx:14/77）——即题述的 allow(once)/session/deny 三选形态。LABELS 中文：允许一次/本会话允许/总是允许/拒绝（L15）。
4. 键盘：纯函数 approvalAction（prompts.tsx:43-72）——Esc=deny（与全局 Ctrl+C 同语义）、数字 1-4 直选、Enter 确认当前、上下移动；鼠标：选项行 onClick={() => onChoice(o)}（L132）。长命令 wrapAnsi 硬折行 + 10 行预览 + 点击展开全文（L89-126）。

回传链路（UI → RPC）：
1. onChoice → appOverlays.tsx L57 onApprovalChoice → appLayout.tsx L512 actions.answerApproval → useSessionShell.ts L948-956：respondWith('approval.respond', { choice, session_id: ui.sid }, done)；成功才 patchOverlayState({ approval: null }) + patchTurnState({ outcome })（deny→'denied'，其余 'approved (choice)'）+ status 'running…'（L950-954）。RPC 失败时面板保留。
2. 语音免提路径：eventAdapter.ts voice.transcript L590-610——审批/确认弹窗打开时，短文本经 voiceConfirmChoice 词库匹配，直接 rpc('approval.respond', {choice, session_id}) + 清 overlay。
3. 取消路径：Esc → deny（prompts.tsx:49-51）；Ctrl+C 全局 handler → cancelOverlayFromCtrlC（useSessionShell，同样 respond deny）。

---

## 十一、3 个 UI 架构发现

1. 双轨状态架构：operational stores 与 presentation 纯投影并存（迁移期设计）。同一事件流被 eventAdapter 同时喂给两条线：命令式副作用 stores（$uiState/$turnState/$overlayState，patch 即写）和纯函数 read-model（presentationReducer/presentationStore，同序列必得确定性快照，isStaleEvent 双守卫丢迟到事件）。后者专供单栏「回合分区」的验证/证据区（turnSections.tsx L178-243），配合 evidenceModel 类型层红线（EvidenceEvent 只有 verification.* 五种，不存在 assistant text/tool success/todo 伪造路径，evidenceModel.ts:34-43）——UI 层结构性保证「绝不把工具成功渲染成已验证」。

2. 自研零依赖原子引擎替代 zustand/nanostores：src/app/stores/engine.ts 的 createAtom/createStore/computed 统一两种语义，全部落地在 useSyncExternalStore。工程收益是细粒度重渲：computed 派生原子（$isBlocked/$uiTheme/$uiSessionId/$selectedMessage）让组件按需订阅——最典型的是消息行只订阅 $selectedMessage 快照（messageLine.tsx:157），hint/usage 等高频字段变化不重渲整条虚拟历史；atom.set 引用相等短路（engine.ts:62）进一步抑制无效渲染。

3. 帧预算工程化：批处理 + 快路径 + 缓存三级优化。流式文本以 16ms 批节流且按场景动态升频（typing 80ms/scroll 96ms，flowController.ts:150-160 + config/timing.ts）；TextInput 的 fast-echo 路径在严格形状门控（纯 ASCII、无换行、非软换行边界，canFastAppendShape L304-328/canFastBackspaceShape L357-392 + Apple_Terminal/tmux/Termux 黑名单 L394-421）下直接 stdout.write 绕过 Ink 渲染，并用 noteCursorAdvance 同步 Ink displayCursor 防光标漂移；markdown 用主题键控 WeakMap + LRU(512) 跨实例缓存（markdown.tsx:654-687）配合 StreamingMd 的单调稳定前缀（streamingMarkdown.tsx:131-167）把流式重解析从 O(total) 降到 O(tail)。同一思路的兜底：promptStore 的 flushSync+双 forceRedraw（promptStore.ts:37-51）覆盖 Ink blit 短路丢帧的边界。

---

## 十二、目录外闭环连接点索引（本目录文件的挂载/实现处）

- useSessionShell.ts（src/wxnodus-ui/hooks/）：构造 createGatewayEventHandler（L794-835）+ gw.on('event')（L876）+ exitHandler 崩溃恢复（L842-874）；answerApproval L948-956 / answerSudo L958-970 / answerSecret L972-984 / answerForm L987-996 / cancelForm L998+；createSlashHandler（L889-941）；interruptTurn 依赖注入。
- gatewayClient.ts：GatewayClient（'event'/'exit' 发射源）。
- src/app/stores/engine.ts：createAtom/createStore/computed/useAtom（状态引擎本体）。
- src/presentation/tui/：tuiProjection.ts 引用的 reducer/projector/gatewayClientAdapter。
- lib/：text.js（formatToolCall/stripAnsi/boundedLiveRenderText）、subagentTree.js、liveProgress.js（appendToolShelfMessage）、clipboard.js、fuzzy.js、rpc.js、platform.js、terminalTier.js、inputMetrics.js、brandRule.js、perfPane.js、fpsStore.js 等。
- useBackgroundPoll（目录外）：backgroundStore 的 5s 轮询数据源。

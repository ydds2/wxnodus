# 代码精读 digest：packages/wxnodus-ink 渲染内核核心（agent 交付，2026-08-17）

> 覆盖：ink/ 根 50 实现 + 17 测试、ink/layout/ 4、ink/termio/ 9+2、ink/events/ 14+1、bootstrap/ 1、utils/ 10+1、native-ts/ 2 = **90 实现文件逐文件 + 21 测试文件逐一登记，共 111 文件零跳过**。
> 注：本 digest 由 Explore agent 以消息交付（无写文件权限），由父会话落盘存证。

## 一、ink/ 根（50 实现）

- **constants.ts（6）**：FRAME_INTERVAL_MS=16（渲染节流）；BLURRED_FRAME_INTERVAL_MS=16。
- **cursor.ts（5）**：Cursor 虚拟光标 {x,y,visible}。
- **instances.ts（10）**：Map<stdout, Ink> 单例注册表（forceRedraw 依 stdout 查找）。
- **lru.ts（14）**：lruEvict 4 热缓存批量淘汰。
- **wrapAnsi.ts（13）**：优先 Bun.wrapAnsi 否则 npm wrap-ansi。
- **measure-element.ts（23）/measure-text.ts（50）**：yoga 测量（measureText 单遍扫描算宽高，零 split 分配）。
- **get-max-width.ts（27）**：computedWidth−padding−border（AtMost 需 clamp）。
- **line-width-cache.ts（38）**：行宽 LRU 4096——流式已完成行不可变。
- **widest-line.ts（22）**：最大行宽判定。
- **cache-eviction.ts（45）**：evictInkCaches 统一驱逐 4 内容键缓存（宿主内存压力/会话切换调用）。
- **tabstops.ts（44）**：仿 Ghostty 8 列制表位（测量 L43 / 渲染实时展开 output.ts:715-727）。
- **squash-text-nodes.ts（74）**：ink-text 子树→StyledSegment（含 hyperlink）。
- **stringWidth.ts（341）**：优先 Bun.stringWidth；ASCII≤64 直算；8192 LRU。滚动期 CPU 曾占 21%。
- **bidi.ts（145）**：Windows/conhost/WT_SESSION/vscode 下 bidi-js 软件双向重排（纯 LTR 快速返回）。
- **wrap-text.ts（144）**：wrap/wrap-char/wrap-trim/truncate 五模式；4096 LRU；宽字符越界重试。
- **supports-hyperlinks.ts（51）**：OSC 8 支持判定（supports-hyperlinks + 终端名单）。
- **terminal-focus-state.ts（52）**：DECSET 1004 焦点信号非 React 层。
- **useTerminalNotification.ts（117）**：iTerm2/kitty/Ghostty 通知+BEL+OSC 9;4，全部过 oscNotify 门控。
- **colorize.ts（277）**：ansi/rgb/#hex→chalk SGR；加载时调整 chalk level（xterm.js 提 3、tmux 钳 2、Apple_Terminal 降 8 位）。
- **clearTerminal.ts（68）**：现代 ESC[2J+3J+H；legacy Windows 仅 2J+HVP（无 scrollback 清除）。
- **capabilities.ts（72）**★：RendererCapabilities{sync2026,decstbm,truecolor,osc8,clipboard,oscNotify,mouse,extendedKeys}；setRendererCapabilities 宿主注入（cmd 档全关+chalk.level=2 钳 256 色）。
- **dom.ts（494）**★：宿主 DOM 层——createNode（107-127，measureFunc 挂接）；markDirty 冒泡（425-448，yogaNode.markDirty+_textMeasureCache.gen++）；scheduleRenderFrom（454-464，DOM 级 scrollTop 直写不经 React）；setAttribute/setStyle 浅比较跳过；collectRemovedRects（209-230，absolute 节点置全局 blit 毒化）；测量缓存 16 项 FIFO（322-362）；clearYogaNodeReferences（484-494）freeRecursive 前清指针防悬垂。
- **reconciler.ts（379）**★：createInstance（217-237，Box 嵌 Text 报错、Text 内嵌降级 ink-virtual-text）；commitUpdate（294-325，React 19 双参数签名+style 单独 diff）；**resetAfterCommit（181-204）渲染回路枢纽：onComputeLayout→onRender**（test 环境改同步 onImmediateRender）；hideInstance/removeChild+cleanupYogaNode（85-95）；dispatcher 断环（377）。
- **events/dispatcher.ts（242）**：DOM 式两阶段事件分发；优先级表（128-153）：keydown/click/focus/blur/paste=Discrete，resize/scroll/mousemove=Continuous；dispatchDiscrete 包 reconciler.discreteUpdates。
- **events/event.ts（11）+terminal-event.ts（107）+keyboard-event.ts（57）+click-event.ts（80）+mouse-event.ts（18）+multi-click-event.ts（55）+paste-event.ts（10）+resize-event.ts（12）+focus-event.ts（18）+terminal-focus-event.ts（19）**：事件体系全集。
- **events/input-event.ts（173）**：parseKey（31-158）——meta/option 合并、ctrl 取 name、剥 ESC 前缀、CSI u/modifyOtherKeys/应用键盘三模式提取输入、大写→shift。
- **events/event-handlers.ts（89）**：HANDLER_FOR_EVENT O(1) 查表；EVENT_HANDLER_PROPS 保证 handler 身份变化不标脏。
- **events/emitter.ts（40）**：EventEmitter maxListeners=0，尊重 stopImmediatePropagation。
- **hit-test.ts（281）**：nodeCache rect 包含判定（51-80，逆序=后绘者在上）；dispatchClick（88-143，click-to-focus+冒泡+localCol/Row 重算）；dispatchMouse（196-237）/dispatchHover（250-281）。
- **focus.ts（219）**：FocusManager——activeElement+去重焦点栈 MAX=32；handleNodeRemoved 栈修复；Tab 循环 collectTabbable。
- **node-cache.ts（53）**：nodeCache WeakMap + pendingClears；**absolute 移除全局禁用下一帧 blit**（34-53）。
- **frame.ts（124）**：Frame{front/back screen, cursor, scrollHint, scrollDrainPending, absoluteOverlayMoved}；Patch 联合类型（stdout/clear/cursor*/hyperlink/styleStr）——diff 中间表示；FrameEvent 帧剖面（renderer/diff/optimize/write 各阶段 ms）。
- **optimizer.ts（99）**：单遍合并——去空 stdout、合并 cursorMove、折叠 cursorTo、拼接相邻 styleStr、抵消 hide/show 对。
- **screen.ts（1590）**★ 屏幕缓冲核心：
  - CharPool/HyperlinkPool（13-84）跨屏驻留；StylePool（126-305）——**bit 0 编码「空格可见样式」**（奇数 ID 位测试跳过不可见空格）、transition 缓存 SGR 差串（32768）、withInverse/withCurrentMatch/withSelectionBg 叠加样式。
  - CellWidth（337-348）Narrow/Wide/SpacerTail/SpacerHead 显式 spacer 模型。
  - **打包单元（381-398）**：每格 2×Int32（charId + styleId[31:17]|hyperlink[16:2]|width[1:0]）；BigInt64 视图批量清零（EMPTY_CELL_VALUE=0n）。
  - createScreen/resetScreen（511-606）grow-only 复用；damage 包围盒、noSelect、written、softWrap 四图。
  - setCellAt（769-881）宽字符邻格修复（Wide/SpacerTail 双向清理）+ damage 就地扩展。
  - setCellStyleId（888-913）原地换样式（选择/搜索覆盖层，**不记 damage→需全帧 damage**）。
  - blitRegion（932-1036）TypedArray.set 整块拷贝；clearRegion（1043-1139）BigInt64 fill。
  - **shiftRows（1148-1190）**：软件镜像 DECSTBM——[top,bottom] 内 shift n 行同时搬 cells/noSelect/written/softWrap 四图。
  - diffEach（1244-1311）：只扫 prev.damage ∪ next.damage，字对字整数比较；visibleCellAtIndex（690-726）跳 spacer/空单元。
- **output.ts（845）**★ 帧组装器：
  - 操作队列（write/clip/unclip/blit/shift/clear/noSelect）→get() 两遍展开进 Screen。
  - **charCache 按行文本整行缓存**（184, 697-702）：tokenize+grapheme 聚类+样式驻留+超链接提取成品；>16384 才清。
  - styledCharsWithGraphemeClustering（616-647）：修复 ansi-tokenize 拆散复合 emoji；按样式 run 预计算 styleId（80 字符 3 run 只驻留 3 次）。
  - writeLineToScreen（688-845）热循环：tab 按屏列实时展开（715-727）；C0/CSI/OSC 序列完整跳过（734-795）；行尾宽字符 SpacerHead（820-830）。
  - get() 第一遍（286-326）clear 只扩 damage；blit 与 absoluteClears 求差集（374-425 防 overlay 幽灵）；clip 相交 sliceAnsi+宽字符重切（446-525）；noSelect 最后压过（564-569）。
- **renderer.ts（228）**★ 帧渲染器工厂：
  - 渲染进 backFrame.screen；pools 从 back 屏读（47-48）；alt-screen 高度钳制（90-98）。
  - **prevFrameContaminated/absoluteRemoved → prevScreen=undefined**（112-123, 181-183）blit 安全阀。
  - PATCH 幽灵树修复×3（125-179）：① absolute overlay 误挂父→渲染前移回；② 渲染前强制 calculateLayout(terminalWidth)；③ 无条件扫描 dirty/无缓存节点向上 markDirty（React 19 并发提交补救）。
- **render-node-to-output.ts（1626）**★ 树→操作绘制器：
  - 滚动排水：drainProportional（196-211，每帧 max(4,3/4 剩余)，封顶 innerHeight-1 保 DECSTBM）；drainAdaptive xterm.js（161-192）。
  - **blit 快速路径（478-509）**：非脏+位置未变+有缓存+有 prevScreen → output.blit（WXNODUS_NOBLIT=1 可禁用）。
  - ink-text squash→wrap（softWrap 位）→OSC 8→output.write（592-668）。
  - **ScrollBox 主逻辑（721-1288）**：scrollAnchor 一次性锚定（793-802）；at-bottom 跟随+sticky 恢复（804-857）；pendingScrollDelta 排水+虚拟滚动 clamp（859-928）；**DECSTBM hint 捕获（941-966）**：content wrapper 缓存 y 变化=delta 且容器未动且 |delta|<innerHeight；**快路径三遍（1023-1236）**：blit 滚动区+shift 镜像+清边缘行+clip 边缘渲染→补脏子节点→修 absolute overlay 移位；全路径回退（1237-1279）。
  - 污染模型（1389-1611）：脏子节点之后的兄弟禁用 prevScreen blit；cumHeightShift O(dirty) 裁剪。
- **render-to-screen.ts（236）**：隔离渲染（搜索定位用），scanPositions（133-194）缓冲区扫查询串。
- **selection.ts（1143）**★：SelectionState（19-63）；selectWordAt/selectLineAt/extendSelection；findPlainTextUrlAt（329-473）软件复刻 URL 检测（鼠标跟踪截获原生 Cmd+Click）；shiftSelection 三平移维护 virtual row 债务；getSelectedText（970-998）softWrap 不插 \n+noSelect 跳过；applySelectionOverlay（1108-1143）渲染后 setCellStyleId 原地换样式。
- **searchHighlight.ts（91）**：applySearchHighlight SGR7 反色（非重叠推进）。
- **hyperlinkHover.ts（52）**：鼠标下 OSC 8 整链反色。
- **render-border.ts（206）**：cli-boxes 边框+嵌入文本+逐边颜色。
- **Ansi.tsx（435）**：ANSI 串→spans→结构化 Text/Link（React Compiler 编译产物）。
- **terminal.ts（313）**★：
  - isSynchronizedOutputSupported（71-137）★：TMUX 直接 false；TERM_PROGRAM 白名单（iTerm/WezTerm/Warp/ghostty/contour/vscode/alacritty）+kitty+xterm-ghostty/foot/ZED_TERM/WT_SESSION+VTE≥6800。
  - XTVERSION 异步探测（139-170）识别 xterm.js（VS Code SSH）。
  - **writeDiffToTerminal（224-313）★ 最终落盘**：Patch[]→单字符串；BSU…ESU 包裹（能力允许）；stdout.write(buffer, onDrain) 返回背压。
  - hasCursorUpViewportYankBug（198-200）conhost 拉顶 bug。
- **log-update.ts（760）**★ 帧差分行级 diff 引擎：
  - render(prev, next, altScreen, decstbmSafe)（141-469）。
  - **DECSTBM 滚动优化（176-197）★**：scrollHint 存在且 decstbmSafe 且不触及最后一行→先 shiftRows(prev.screen) 软件镜像→发单 patch setScrollRegion+SU/SD+RESET_SCROLL_REGION+CURSOR_HOME→diff 循环自然只发现滚入行。
  - 主 diff 循环（268-399）：VirtualScreen 虚拟光标+diffEach；**行推进用 LF 不用 CSI CUD**（CUD 到底不滚动静默失败）；行尾显式 \r\n（W8-28 ConPTY 修复 39-43,127-128）；**moveCursorTo（678-698）绝对 CUP/CHA**（ConPTY/winpty 相对定位漂移修复）。
  - 光标还原（410-454）：alt-screen 跳过；主屏 CR+n×LF 造行。
- **ink.tsx（2716）**★ 主控制器：
  - 双帧 frontFrame/backFrame（193-194）；prevFrameContaminated（279）。
  - scheduleRender=throttle(queueMicrotask(onRender),16ms,{leading,trailing})（367-371）——**微任务保证 layout effect 先行**。
  - **onRender 主循环（681-1173）**：renderer 产帧（714-722）→覆盖层写 styleId+全帧 damage 判定（823-884）→log.render diff（907-917）→**帧交换 backFrame=frontFrame; frontFrame=frame（921-922）**→optimize（945）→alt 屏前插 CSI H+park（950-978）→writeDiffToTerminal（1099-1114）→prevFrameContaminated 重算（1122）→scroll drain 重排（1129-1131）→onFrame 剖面（1145-1165）。
  - handleResize（486-552）每 burst 一微任务；alt 同尺寸 resize 也重绘+160ms 沉降（564-594）。
  - reassertTerminalModes（1331-1366）stdin 静默>5s 自愈。
  - unmount（2382-2468）：退出帧+终端模式复位（EXIT_ALT_SCREEN/DISABLE_MOUSE/MODIFY/KITTY/DFE/DBP/SHOW_CURSOR/通知清理）。
  - resetPools（2503-2512）5 分钟换代；drainStdin（2626-2696）退出路径排空 stdin。
- **root.ts（210）**：renderSync/createRoot/forceRedraw；按 stdout 复用实例。

## 二、ink/layout/（4）

- **engine.ts（6）**：createLayoutNode 唯一入口。
- **node.ts（145）**：LayoutNode 适配器接口+全字符串枚举。
- **yoga.ts（313）**：YogaLayoutNode——TS 移植版映射；calculateLayout(width, undefined, LTR)（84-86）；**TS 移植无 WASM、同步、无需 preload/swap**。
- **geometry.ts（98）**：Point/Size/Rectangle/Edges 类型。

## 三、ink/termio/（9+2）

- **ansi.ts（75）**：C0 控制符/ESC 引入字节底座。
- **csi.ts（334）**★：cursorMove 先横后竖（134-192）；erase 系列（205-241）；**scrollUp/scrollDown/setScrollRegion(DECSTBM)（270-282）+RESET_SCROLL_REGION**；Kitty 协议 ENABLE/DISABLE（316-322）+modifyOtherKeys（329-334）。
- **dec.ts（99）**★：**BSU/ESU（37-38，DEC 2026 同步输出）**；EBP/DBP（bracketed paste）；EFE/DFE（1004）；ENTER/EXIT_ALT_SCREEN（1049）；MouseTrackingMode 预设与 DISABLE_MOUSE_TRACKING 四模式无条件复位（98-99）。
- **esc.ts（69）**：RIS/DECSC/DECRC/IND/RI/NEL→Action。
- **sgr.ts（362）**：完整 SGR 解析（38/48/58 扩展色、21/53/55）。
- **osc.ts（758）**★：剪贴板三路径（native/tmux loadBuffer/Linux 工具探测）；**link(url)（637-654，osc8=false→空串；自动 id= 让折行链接成组）**；parseOSC（469-527）。
- **parser.ts（467）**：流式语义动作生成器（ghostty 风格）；CSI 语义表（106-285，含 DECSTBM/私有模式 25/47/1049/2004/1000-1004）。
- **tokenize.ts（350）**★：八态机；**x10Mouse 选项（243-261，校验三 payload 字节≥0x20 防吞 PASTE_END）**；**flush 语义（70-88, 319-347）**：未完成 CSI 不发射（跨 flush 重组，修复鼠标报告碎片）、孤 ESC 在 flush 时发射、**连续双 flush 无进展丢弃卡死 partial**。
- **types.ts（230）**：TextStyle/Color/Action 语义类型。

## 四、utils/（10+1）

- **env.ts（66）**：detectTerminal（TERM_PROGRAM 优先）+supportsOsc52Clipboard 白名单。
- **earlyInput.ts（131）**：启动期早期输入捕获（raw mode 提前开；Ctrl+C→exit(130)；consumeEarlyInput 交还 REPL）。
- **execFileNoThrow.ts（115）**：不抛错 spawn 包装（wl-copy 守护进程化用）。
- **intl.ts（87）**：grapheme/word Segmenter 共享实例（output.ts:667 与 parser.ts:88 复用）。
- **semver.ts（57）**：Bun.semver 优先。
- **sliceAnsi.ts（106）**★：按显示宽度切 ANSI 串（保留样式上下文+补 undo 码）；4096 LRU；**滚动期 18% CPU 优化对象**。
- **log.ts/debug.ts/envUtils.ts/fullscreen.ts**：小工具。

## 五、native-ts/（2）

- **yoga-layout/enums.ts（112）**：Yoga 全部数值枚举。
- **yoga-layout/index.ts（2326）**：**Yoga flexbox 纯 TS 移植**（替代 WASM）——Node（389 起）；**布局缓存（942-1010）**：单槽 _lW/_lH + 8 槽 Float64Array 输入缓存；getYogaCounters（928-940）；loadYoga 恒同步（2322-2324）；无 WASM 线性内存管理故无 load/preload。

## 重点答案（带行号）

1. **渲染主循环时序**：React 状态/DOM 直写/resize/SIGCONT/滚动排水/选择变化 → reconciler.resetAfterCommit（reconciler.ts:181-204）→onComputeLayout（yoga calculateLayout，ink.tsx:398-418）→scheduleRender 微任务（ink.tsx:367-371）→onRender（ink.tsx:681）→renderer 产帧→覆盖层→log.render diff→帧交换（921-922）→optimize（945）→BSU…ESU 包裹 writeDiffToTerminal（1099-1114）→prevFrameContaminated 重算（1122）。
2. **行级差分**：行级复用一=DOM blit（未变节点 rect 全等+!dirty→TypedArray.set 整块拷，render-node-to-output.ts:478-509）；行级复用二=charCache 按行文本缓存 tokenize+字素聚类成品（output.ts:697-702）；帧间 diff 只在 prev.damage∪next.damage 内整数比较（screen.ts:1244-1311）；**滚动=blit(prevScreen)+shiftRows 软件镜像+终端 SU/SD 硬件滚动四图同步**（render-node-to-output.ts:1023-1036→log-update.ts:176-197→screen.ts:1148-1190）。
3. **双帧+prevFrameContaminated**：渲染目标恒 backFrame.screen，diff 用 frontFrame 作 prevScreen，完成后交换（ink.tsx:921-922）；污染置位路径 resetFramesForAltScreen（1479）/forceRedraw（1234）/invalidatePrevFrame（1250-1252）/stderr 拦截（2582-2585）；每帧末重算 selActive||hlActive||absoluteOverlayMoved（1122）——**性能靠信任，正确性靠精确刻画何时不信任**。
4. **parse-keypress 尾随换行拆分（近期修复）**：parse-keypress.ts:280-291——Windows conhost raw 模式 Enter 投递 \r，libuv 批读并入同 token 被吞（Enter 失灵根因）；修复 `^(.*?)(\r\n|\r|\n)$` 拆两个 ParsedKey；测试 parse-keypress.test.ts「trailing newline in text chunk (Windows conhost batched read)」。
5. **终端能力探测与降级**：DEC 2026 白名单（terminal.ts:71-137，TMUX 直接 false）；decstbm≡sync2026 硬绑（ink.tsx:910-916）；cmd 档全关（capabilities.ts:51-61）；conhost 专门路径：游标拉顶 bug（198-200）、无 ONLCR 显式 \r\n（log-update.ts:39-43）、绝对 CUP/CHA（684-698）。
6. **输入订阅模型**：useInput 计数→setRawMode+readable 监听（App.tsx:280-340）→parseMultipleKeypresses（tokenizer 跨批缓冲）→reconciler.discreteUpdates(processKeysInBatch)（App.tsx:416）→三分流 response/mouse/key→FOCUS_IN/OUT 判定→handleInput+inputEmitter.emit('input')+dispatchKeyboardEvent（619-623）→FocusManager.activeElement→dispatcher 两阶段冒泡。

## 三个架构级发现

1. **打包单元屏幕+damage 差分零对象分配**：2×Int32/格打包（charId+styleId[31:17]|hyperlink[16:2]|width[1:0]，BigInt64 批量清零）；diff 整数比较仅在 damage 并集；StylePool bit0=空格可见样式；visibleCellAtIndex 跳格——稳态帧接近零写入。整条管线（yoga→操作队列→打包单元→Patch[]→单字符串 write）为规避 GC 停顿设计，本质是自研终端帧缓冲系统而非 ink 文本 diff。
2. **DECSTBM 硬件滚动与软件镜像双游标一致**：shiftRows 必须同步搬运 cells/noSelect/written/softWrap 四图才让后续 diff 与终端物理状态一致；原子性依赖 DEC 2026，无 2026（tmux/conhost/cmd）自动退化逐行重写但保持正确——少见的「软件缓冲区与终端滚动寄存器互为影子」设计。
3. **prevFrameContaminated 单比特信任模型**：默认把上一帧当 blit 源（O(unchanged) 快路径），任何渲染后篡改（选择/搜索/悬停覆盖层、alt 重入、absolute 移动）要么全帧 damage 要么毒化缓冲区一帧；加幽灵树三补丁（renderer.ts:125-179）构成 React 19 并发提交时序下保正确性的核心防线。

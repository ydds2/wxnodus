# wxnodus-ink 组件/hooks 层 + 闭环验证脚本 精读 digest

日期：2026-08-17。覆盖 47 个文件：`packages/wxnodus-ink/src/hooks/`（2）、`src/ink/components/`（20）、`src/ink/hooks/`（14）、`scripts/`（10）+ `scripts/lib/`（1）。
注意：任务指定的 `packages/wxnodus-ink/src/components/` 目录不存在（工作树与 git 历史均无）；该包的全部组件位于 `src/ink/components/`。本包内亦无 `Static` 组件（其职能由 `RawAnsi` 承担）。

## 0. 源码形态说明（影响全部行号）

`src/ink/components/*.tsx` 与部分 `.tsx` 为 React Compiler 编译产物：函数体内是 `_c(N)` memo-cache 重写（如 Text.tsx:157 `const $ = _c(29)`），文件末行内嵌 base64 sourcemap（内含原始源码，可还原）。行号按磁盘文件计；关键导出在编译态文件中位置不变。

---

# 任务 A：wxnodus-ink 源码

## A1. src/hooks/（包级 hooks，2 个文件）

### packages/wxnodus-ink/src/hooks/use-stdout.ts（15 行）
职责：以 `useMemo` 冻结 `process.stdout` 与其 `write` 绑定，暴露给需要直写标准输出（旁路 Ink 渲染）的调用方。
关键导出：`export default useStdout()`（行 7-15）；类型 `StdoutHandle`（行 2-5）。
连接点：`useMemo` 空依赖保证句柄稳定（行 8-13）；被包内 TextInput fast-echo / REPL 类直写路径消费（与 CursorAdvanceContext 的 out-of-band 游标推进协议配套，见 CursorAdvanceContext.ts:1-31）。

### packages/wxnodus-ink/src/hooks/use-stderr.ts（15 行）
职责：同构的 stderr 句柄。
关键导出：`export default useStderr()`（行 7-15）；类型 `StderrHandle`（行 2-5）。
连接点：结构镜像 use-stdout.ts。

## A2. src/ink/components/（Ink 组件层，20 个文件）

### packages/wxnodus-ink/src/ink/components/Text.tsx（335 行）
职责：文本叶子组件。颜色/斜体/下划线/删除线/反显/粗细由 props 组合为 `textStyles`；换行与截断由 `wrap` prop 查表映射到 Yoga 样式；`dim` 按终端能力（`shouldUseAnsiDim`）降级为灰色兜底。
关键导出：`export default function Text`（行 156）；`export type Props`（行 66，`BaseProps & WeightProps`，bold/dim 互斥见行 53-65）；`shouldUseAnsiDim(env)`（行 68-84，`WXNODUS_TUI_DIM` 覆盖 → Apple_Terminal false → 无 `VTE_VERSION` 才 true）；`dimColorFallback(env)`（行 86-94，Apple Terminal 兜底 `#6B7280`）；`memoizedStylesForWrap` 布局查表（行 96-151：每项 `flexGrow:0, flexShrink:1, flexDirection:'row', textWrap:<wrap>`）。
布局声明方式：不直接声明 flex，而是渲染 `<ink-text style={memoizedStylesForWrap[wrap]} textStyles={textStyles}>`（行 320-324）；wrap 默认 `'wrap'`（行 176）。
连接点：`ink-text` 宿主节点由 dom.ts/renderer 解释；Ansi.tsx 引用同表。

### packages/wxnodus-ink/src/ink/components/Text.test.ts（38 行）
职责：Text 的终端环境探测纯函数单测（vitest）。
关键导出：无（测试）。覆盖：VTE/Apple 默认禁 ANSI dim（行 6-12）、其他终端启用（行 14-16）、`WXNODUS_TUI_DIM` 显式覆盖（行 18-22）、Apple 灰兜底与显式配置互斥（行 26-37）。
连接点：import 自 `./Text.js`（行 3）。

### packages/wxnodus-ink/src/ink/components/Box.tsx（310 行）
职责：布局核心容器（等价 `<div style="display:flex">`）。Props = 全部 `Styles`（除 textWrap）+ 事件处理器 + tabIndex/autoFocus。
关键导出：`export default Box`（行 309）；`export type Props`（行 15-62）。
布局声明：flex 四元组默认值 `flexWrap:'nowrap'`、`flexDirection:'row'`、`flexGrow:0`、`flexShrink:1`（行 136-139）；`overflowX/Y` 回退 `style.overflow ?? 'visible'`（行 204-205、223-224）；margin/padding/gap 非整数告警 17 项（行 140-156）；最终渲染 `<ink-box style={{flexWrap,flexDirection,flexGrow,flexShrink,...style,overflowX,overflowY}}>`（行 261-281）。
事件面：onClick/onMultiClick/onMouseDown/Up/Drag/Enter/Leave/onFocus(+Capture)/onBlur(+Capture)/onKeyDown(+Capture)（行 35-61，注释说明仅 `<AlternateScreen>` 内鼠标跟踪生效）。
连接点：被 Button.tsx:10、Spacer.tsx:3、ScrollBox.tsx:12、NoSelect.tsx:3 复用；`ink-box` 由 reconciler/dom.ts 落地。

### packages/wxnodus-ink/src/ink/components/Spacer.tsx（22 行）
职责：弹性占位。
关键导出：`export default function Spacer()`（行 9-21）。
布局声明：`<Box flexGrow={1} />`（行 14）。
连接点：Box.tsx。

### packages/wxnodus-ink/src/ink/components/Newline.tsx（42 行）
职责：在文本流中插入 N 个换行。
关键导出：`export default function Newline`（行 14）；`Props.count` 默认 1（行 19）。
布局声明：`<ink-text>{'\n'.repeat(count)}</ink-text>`（行 33）。
连接点：必须嵌于 `<Text>` 内（注释行 12）。

### packages/wxnodus-ink/src/ink/components/Link.tsx（38 行）
职责：超链接（OSC 8）。无条件渲染 `<ink-link href>`（不再按 `supportsHyperlinks()` 门控——行 17-30 注释解释：点击分发器按 cell 的 hyperlink 字段打开 URL，门控曾让 Apple Terminal 点击失效）。
关键导出：`export default function Link`（行 17）；`Props` 含兼容性残留 `fallback`（行 8-14）。
连接点：渲染层能力门控在 render-node-to-output.ts 的 `wrapWithOsc8Link`/log-update.ts 的 `oscLink`（行 26-27 注释）。

### packages/wxnodus-ink/src/ink/components/NoSelect.tsx（72 行）
职责：标记内容不可被全屏文本选择（选中高亮与复制文本都跳过）。
关键导出：`export function NoSelect`（行 35）；`fromLeftEdge` 扩展排除区（行 5-15）。
布局声明：透传 Box props + `noSelect={fromLeftEdge ? 'from-left-edge' : true}`（行 53-61）。
连接点：Box.tsx；仅 alt-screen 选择生效（行 31-33 注释）。

### packages/wxnodus-ink/src/ink/components/RawAnsi.tsx（60 行）
职责：已终端就绪（ANSI+已换行）内容的直通叶子——单 Yoga 叶 + 常量测度（width × lines.length），绕过 `<Ansi>`→React 树→Yoga→重序列化往返（行 12-25 注释）。
关键导出：`export function RawAnsi`（行 27）；渲染 `<ink-raw-ansi rawText rawWidth rawHeight>`（行 49）。
连接点：output.write() 拆行/解析 ANSI（行 24-25 注释）；供 ColorDiff NAPI 类外部渲染器使用。

### packages/wxnodus-ink/src/ink/components/Button.tsx（108 行）
职责：无样式交互按钮（Enter/Space/点击触发 onAction），渲染属性暴露 focus/hover/active 三态。
关键导出：`export default Button`（行 107）、`export type { ButtonState }`（行 108）、`Props`（行 18-41，`children` 可为 `(state)=>node` 函数）。
关键行为：`handleKeyDown` return/space 触发 + 100ms active 定时复位（行 56-68）；内部由 `useState` 维护三态（行 44-46）；未用 React Compiler（普通函数组件）。
连接点：Box.tsx 事件面（行 90-100）。

### packages/wxnodus-ink/src/ink/components/AlternateScreen.tsx（134 行）
职责：备用屏（DEC 1049）。挂载进入 alt-screen + 清屏 + 回home + 按 `mouseTracking` 预置启用 SGR 鼠标跟踪；卸载禁用跟踪 + 退出 alt-screen；通知 Ink 实例 `setAltScreenActive`。
关键导出：`export function AlternateScreen`（行 49）；`mouseTracking` 默认 `'all'`（行 54）。
关键行为：useInsertionEffect 内 writeRaw(ENTER_ALT_SCREEN+ERASE_SCROLLBACK+ERASE_SCREEN+CURSOR_HOME+mousePreset)（行 78-84）；teardown `DISABLE_MOUSE_TRACKING + EXIT_ALT_SCREEN`（行 95-103）；能力门控注释 W8-22（行 68-69，cmd 档 mouse=false 不发射跟踪序列）。
布局声明：`<Box flexDirection="column" flexShrink={0} height={size.rows} width="100%">`（行 121-125）。
连接点：instances.ts `setAltScreenActive`（行 62、85、96）；capabilities.ts `mousePresetFor`（行 70）；TerminalWriteContext（行 56）；TerminalSizeContext（行 55）。

### packages/wxnodus-ink/src/ink/components/App.tsx（884 行）
职责：Ink 应用根组件（PureComponent）。提供 5 层 Context（TerminalSize→App→Stdin→TerminalFocus→Clock→CursorDeclaration→CursorAdvance，行 202-238）；管理 raw mode 引用计数、stdin readable 泵、转义序列解析、终端查询（XTVERSION）、鼠标/选择状态机、Ctrl+C 退出、超链接延迟打开、终端模式重断言。
关键导出：`export default class App extends PureComponent`（行 144）；`export function handleMouseEvent`（行 628，测试导出）。
关键机制（行号）：
- raw mode 进入：EBP+EFE 括号粘贴/焦点报告（行 292-294）、能力门控 Kitty/modifyOtherKeys（行 301-305）、setImmediate XTVERSION 探测（行 315-324）、setImmediate 重断言鼠标跟踪（行 337-339）、退出时 DISABLE_MOUSE_TRACKING 防 cooked 回显泄漏（行 348-367）。
- 输入泵：`handleReadable`（行 434-473，含 STDIN_RESUME_GAP_MS=5000 长间隙检测行 50-55/441、Bun 流卡死自愈 454-471）；`processInput`→`parseMultipleKeypresses`→`reconciler.discreteUpdates(processKeysInBatch)`（行 405-433，防 "Maximum update depth exceeded"）。
- 事件分发：`processKeysInBatch`（行 544-625）——response→querier（560-564）、mouse→handleMouseEvent（569-573）、FOCUS_IN/OUT（578-603）、Ctrl+Z suspend（612-616，SUPPORTS_SUSPEND=false 行 48）、`inputEmitter.emit('input')`（行 620）+ DOM `dispatchKeyboardEvent`（行 623）。
- 鼠标/选择：SGR 位解码、multi-click（500ms/1 cell，行 135-136、748-773）、lost-release 恢复（行 647-659、724-732、788-800）、右击复制（行 672-703）、OSC8 打开去抖 + xterm.js 双开防护（行 841-879）。
- 不完整序列冲洗：`flushIncomplete`（行 371-402，NORMAL_TIMEOUT 50 / PASTE_TIMEOUT 500，行 163-164）。
连接点：StdinContext/AppContext 等 6 个 Context（行 38-45）；ink.tsx 的 onCursorDeclaration/onCursorAdvance/onStdinResume 回调（行 110-127）；reconciler.ts（行 22、416）；terminal-querier.ts（行 168）。

### packages/wxnodus-ink/src/ink/components/AppContext.ts（20 行）
职责：暴露 `exit(error?)` 的应用级 Context。
关键导出：`export default AppContext`（行 20）；`Props`（行 3-8）。
连接点：App.tsx:210-214 Provider；use-app.ts:8。

### packages/wxnodus-ink/src/ink/components/StdinContext.ts（25 行）
职责：stdin 访问 Context。
关键导出：`export default StdinContext`（行 25）；`Props`（行 6-13：stdin、setRawMode、isRawModeSupported、exitOnCtrlC、inputEmitter、querier）。
连接点：App.tsx:215-224 Provider；use-stdin.ts:8、use-input.ts:45、use-search-highlight.ts:38、use-selection.ts:45/94。

### packages/wxnodus-ink/src/ink/components/TerminalSizeContext.tsx（7 行）
职责：终端尺寸 Context（columns/rows）。
关键导出：`export const TerminalSizeContext`（行 6）。
连接点：App.tsx:204-209 Provider（props 输入）；Altern
ateScreen.tsx:55、use-terminal-viewport.ts:31。

### packages/wxnodus-ink/src/ink/components/TerminalFocusContext.tsx（63 行）
职责：终端焦点 Context + Provider（useSyncExternalStore 订阅 terminal-focus-state，独立组件避免 App 重渲染）。
关键导出：`export function TerminalFocusProvider`（行 26）、`export default TerminalFocusContext`（行 62）。
连接点：terminal-focus-state.ts（行 4-9）；use-terminal-focus.ts:15；ClockProvider 用它调 tick 速度（ClockContext.tsx:96-115）。

### packages/wxnodus-ink/src/ink/components/ClockContext.tsx（133 行）
职责：共享时钟。`createClock` 是订阅式 tick 源（keepAlive 订阅者驱动 interval）；ClockProvider 按终端焦点切换 FRAME_INTERVAL_MS / BLURRED_FRAME_INTERVAL_MS。
关键导出：`export function createClock`（行 12-83）、`export const ClockContext`（行 85）、`export function ClockProvider`（行 90）、`Clock` 类型（行 6-10）。
关键行为：tick 快照同一 tick 时间保证动画同步（行 21-27）；`now()` 暂停时回退实时（行 59-73）。
连接点：use-animation-frame.ts:35、use-interval.ts:51；constants.ts（行 4）。

### packages/wxnodus-ink/src/ink/components/CursorAdvanceContext.ts（35 行）
职责：out-of-band 物理游标推进通知 Context（TextInput fast-echo 直写 stdout 后）。注释详述两段式更新：displayCursor（alt-screen 跳过）与 cursorDeclaration（双屏都更新）（行 3-29）。
关键导出：`export type CursorAdvanceNotifier`（行 31）、`export default CursorAdvanceContext`（行 35）。
连接点：App.tsx:116-127（onCursorAdvance 由 ink.tsx 实现）；use-cursor-advance.ts:32。

### packages/wxnodus-ink/src/ink/components/CursorDeclarationContext.ts（28 行）
职责：声明每帧结束后终端游标停靠位置（IME 预编辑/读屏跟踪输入框光标）。
关键导出：`export type CursorDeclarationSetter`（行 24，`clearIfNode` 条件清除防兄弟组件互踩）、`export default CursorDeclarationContext`（行 28）。
连接点：App.tsx:110-115/227；use-declared-cursor.ts:35。

### packages/wxnodus-ink/src/ink/components/ErrorOverview.tsx（129 行）
职责：渲染错误总览（ERROR 标题 + 出错行源码摘录 code-excerpt + 解析后的堆栈）。
关键导出：`export default function ErrorOverview`（行 28）。
连接点：App.tsx:229（error 时替代 children）；stack-utils + code-excerpt（行 3-4）。

### packages/wxnodus-ink/src/ink/components/ScrollBox.tsx（315 行）
职责：`overflow:scroll` 容器 + 命令式滚动 API（绕过 React：DOM 节点上直接改 scrollTop + markDirty + 微任务 scheduleRenderFrom）。
关键导出：`export default ScrollBox`（行 314）、`ScrollBoxHandle`（行 13-72）、`ScrollBoxProps`（行 73-80）。
关键行为：scrollTo/scrollBy 清 sticky、累积 pendingScrollDelta（行 136-180）；scrollToElement 用 scrollAnchor 在渲染期读 Yoga top（行 152-167）；adjustScrollTop 视口保持不解除 sticky（行 181-199）；scrollToBottom 强制 React 渲染（行 200-212）；scrollMutated 调 markScrollActivity 压制后台轮询（行 113-131，注释：1402ms 帧隙来源）；微任务合并同一批输入（行 126-130）。
布局声明：外层 `<ink-box style={{overflowX:'scroll',overflowY:'scroll',...}}>`（行 283-306）+ 内层 `<Box flexDirection="column" flexGrow={1} flexShrink={0} width="100%">`（行 307-309）。
连接点：dom.ts（markDirty/scheduleRenderFrom 行 8）、reconciler.ts（markCommitStart 行 9）、bootstrap/state.ts（markScrollActivity 行 6）、render-node-to-output.ts 读 scrollTop/scrollHeight（行 26-28、66-67 注释）。

## A3. src/ink/hooks/（Ink hooks 层，14 个文件）

### packages/wxnodus-ink/src/ink/hooks/use-stdin.ts（9 行）
职责：读取 StdinContext。
关键导出：`export default useStdin`（行 8-9）。
连接点：StdinContext.ts；use-input.ts:45。

### packages/wxnodus-ink/src/ink/hooks/use-input.ts（95 行）
职责：用户输入订阅主入口（每键回调；粘贴多字符整串一次回调）。
关键导出：`export default useInput`（行 95）、`Options.isActive`（行 17）。
输入订阅链路：`useStdin()`（行 45）→ useLayoutEffect 同步开 raw mode（行 52-62，注释：useEffect 会把 raw mode 推迟到下个 tick、击键回显）→ `useEventCallback` 包装 handleData（行 71-84，稳定监听槽位防 stopImmediatePropagation 乱序）→ `inputEmitter.on('input', handleData)`（行 86-92）；Ctrl+C 过滤（行 81）。
连接点：App.tsx:620 发射 'input'；StdinContext.ts:11。

### packages/wxnodus-ink/src/ink/hooks/use-app.ts（9 行）
职责：读取 AppContext 取 exit。
关键导出：`export default useApp`（行 8-9）。
连接点：AppContext.ts。

### packages/wxnodus-ink/src/ink/hooks/use-animation-frame.ts（62 行）
职责：同步动画帧（共享时钟，屏幕外自动暂停）。
关键导出：`export function useAnimationFrame(intervalMs=16)`（行 32-62），返回 `[ref, time]`。
连接点：ClockContext.ts:85；use-terminal-viewport.ts:36（isVisible 决定 active）。

### packages/wxnodus-ink/src/ink/hooks/use-interval.ts（71 行）
职责：共享时钟驱动的 interval/定时器（合并为单次唤醒）。
关键导出：`export function useAnimationTimer`（行 14）、`export function useInterval`（行 47）。
连接点：ClockContext.ts:85；subscribe keepAlive=false（行 34/69）。

### packages/wxnodus-ink/src/ink/hooks/use-cursor-advance.ts（33 行）
职责：取得 out-of-band 游标推进通知器（调用者负责 stdout 直写，本 hook 只报 delta）。
关键导出：`export function useCursorAdvance`（行 31-33）。
连接点：CursorAdvanceContext.ts。

### packages/wxnodus-ink/src/ink/hooks/use-declared-cursor.ts（75 行）
职责：声明输入框光标停靠位（ref 回调 + useLayoutEffect 双重发布；条件清除防 sibling handoff 互踩，注释 42-53）。
关键导出：`export function useDeclaredCursor`（行 26-75）。
关键行为：无依赖数组的 useLayoutEffect 每 commit 重声明（行 55-63）；空依赖卸载清除 effect（行 68-72）；调度时序注释（行 18-25）。
连接点：CursorDeclarationContext.ts；App.tsx onCursorDeclaration；ink.tsx 每帧后停靠游标。

### packages/wxnodus-ink/src/ink/hooks/use-external-process.ts（27 行）
职责：在 Ink 实例中运行外部进程（进入 alt-screen 隔离，结束后退出恢复）。
关键导出：`export async function withInkSuspended`（行 7-23）、`export function useExternalProcess`（行 25-27）。
连接点：instances.ts（行 3、8）。

### packages/wxnodus-ink/src/ink/hooks/use-search-highlight.ts（56 行）
职责：屏幕空间搜索高亮（SGR 7 反显覆盖所有可见匹配——匹配渲染文本而非源消息文本）。
关键导出：`export function useSearchHighlight`（行 19-56）：setQuery / scanElement / setPositions。
连接点：StdinContext.ts（行 38 锚定 App 子树）；instances.ts（行 39）；ink.setSearchHighlight / scanElementSubtree / setSearchPositions（行 51-53）。

### packages/wxnodus-ink/src/ink/hooks/use-selection.ts（101 行）
职责：全屏文本选择操作面（复制/清除/状态订阅/键盘扩展/滚动捕获/主题底色）。
关键导出：`export function useSelection`（行 11-83）、`export function useHasSelection`（行 93-101，useSyncExternalStore 响应式）。
关键行为：无 Ink 实例时返回全套 no-op（行 51-66）；ink 实例经 `instances.get(process.stdout)` 获取（行 46）。
连接点：selection.ts（shiftAnchor 行 5/75）；StdinContext.ts（行 45）。

### packages/wxnodus-ink/src/ink/hooks/use-tab-status.ts（71 行）
职责：声明式设置标签页状态指示（OSC 21337 彩点+状态词；不支持则静默丢弃；null 时清除）。
关键导出：`export function useTabStatus(kind)`（行 46-71）、`TabStatusKind`（行 7）、预置映射（行 17-33）。
连接点：termio/osc.ts（tabStatus/CLEAR_TAB_STATUS/wrapForMultiplexer/supportsTabStatus 行 3）；TerminalWriteContext（行 47）；ink.tsx 卸载路径清理（行 44 注释）。

### packages/wxnodus-ink/src/ink/hooks/use-terminal-focus.ts（18 行）
职责：查询终端是否聚焦（DECSET 1004 焦点报告自动处理，与 useInput 隔离）。
关键导出：`export function useTerminalFocus`（行 14-18）。
连接点：TerminalFocusContext.ts。

### packages/wxnodus-ink/src/ink/hooks/use-terminal-title.ts（34 行）
职责：声明式设置终端标签/窗口标题（strip-ansi 清洗；Windows 用 process.title，其余 OSC 0）。
关键导出：`export function useTerminalTitle(title)`（行 18-34）。
连接点：TerminalWriteContext（行 19）；termio/osc.ts（行 4）；行 28-32 是「真实 cmd/conhost 不支持 OSC」的平台分支——与 cmd-sweep W8-25 层级门控呼应。

### packages/wxnodus-ink/src/ink/hooks/use-terminal-viewport.ts（100 行）
职责：判断元素是否在终端视口内（动画开闭/懒渲染用）。
关键导出：`export function useTerminalViewport`（行 30-100）。
关键行为：useLayoutEffect 每渲染读 Yoga 链计算 absoluteTop（行 44-77），DOM 父链行走减 scrollTop（行 60-77）；cursor-restore 补偿 `scrollbackRows = viewportY + 1`（行 83-91，与 log-update.ts 对齐防边界闪烁）；仅改 ref 不 setState（防级联渲染，行 39-43）。
连接点：TerminalSizeContext.ts:31；ScrollBox scrollTop（行 72-74 注释）；log-update.ts（行 85 注释）。

---

# 任务 B：scripts/ 闭环验证脚本（11 个文件）

### scripts/loop-closure-test.mjs（123 行）
「回合闭环」确定性回归电池——「35 工具调用后无输出」缺陷的定点复现。本地 mock OpenAI 兼容 SSE 服务（行 22-59）：前 32 次请求只回 `tool_calls`（ls，路径按 LS_PATHS 逐次变化，行 21/33-35；注释 18-20 说明同签名重复 ≥3 会触发内核循环检测提前终止，无法逼出轮次耗尽路径），第 33 次回最终答案文本（分两块 delta 模拟真实流式，行 37-39）。真实 TUI 由 node-pty 驱动（行 76-88，WXNODUS_MODEL=glm-4-flash + BASE_URL/API_KEY 指向 mock）。断言序列见下方重点 2。失败时 exitCode=1（行 108-110），5 分钟看门狗 fail-closed（行 74），显式 `process.exit` 防 node-pty 句柄悬挂（行 119-120）。

### scripts/full-scene-test.mjs（324 行）
全场景自动化测试（pty 驱动真实终端）：启动/品牌、模型选择器（q 关闭）、会话选择器（Esc 关闭）、hello 提交与规则脑回复、/calc、/help pager、/uuid、/status、历史消息累积、输入框贴底、状态栏、/quit 干净退出（行 110-321）。核心方法论：分段作用域断言（mark/tailOf，行 55-59，W8-19/阶段 12 头注 5-6）+ 洁净间数据目录（行 115-118）+ 双管线诚实判据 `statusBarReady`（行 96-108，W8-32：winpty 整行重绘含「就绪」词 vs ConPTY 时钟 CUP 改写）。陷阱规避注释 8 条见重点 3。fail-closed：`process.exit(fails.length ? 1 : 0)`（行 321）。

### scripts/cmd-verify.mjs（176 行）
命令落地验证（W8-19/阶段 11，fail-closed）。五个独立 PTY 会话（withSession，行 31-77；会话隔离：fresh 输入态、无残留草稿、无 pager/overlay 污染，头注 4）：A `/help` 全量（首页 10 命令抽查 + /bench /memory /goal 展开，行 80-115）；B 过滤 mem→执行 /memory（行 118-133）；C vers→/version（行 136-151）；D cle→/clear 后清屏缺否检查（行 154-163）；E mod→/model 过滤 only（行 166-171）。规避陷阱头注 5-11（200ms/字符、末尾空格关面板、不用 Esc/Ctrl+C/退格）。CLEANROOM 环境（行 21）。任一断言失败非零退出（行 176）。

### scripts/cmd-audit.ps1（82 行）
真实 cmd.exe（conhost）环境 UX 审计。不经过 node-pty：`Start-TuiWindow` 起真实窗口进程，`WriteConsoleInputW` 注入真实控制台输入记录（行 22-26），`CreateFile('CONOUT$')`+`ReadBufferText` 读真实屏幕缓冲文本（行 11-20），每步 `Save-WindowZoom` 截图（行 9-10）。步骤：就绪帧 02-ready → /help 建议面板（03）→ Enter 执行 pager（04）→ q 关 pager → CJK 输入「你好」（05-cjk-input）→ 真实提交 hello（06-reply-busy / 07-reply-done，行 37-77）。产物 artifacts/cmd-audit/（截图由 GLM-4V 视觉识别，头注 1-2）。finally 强制 Stop-Process（行 80-82）。

### scripts/cmd-sweep.mjs（135 行）
全功能深度扫描：15 组约 120 条命令逐个执行 + `BROKEN` 正则（行 28：不支持/未实现/unknown rpc/内部错误/异常等）判「功能无法使用」（行 49-62，无 key 时对话类 `/key set` 引导不算坏，行 56）。启动崩溃检测行 20-25。层级断言三组：W8-25 cmd 档（WXNODUS_TUI_TIER=cmd 逃生门）序列门控——无 DEC 2026、无 DECSTBM、无 OSC 8、无 truecolor（行 85-89）+ 字形检查（无 astral emoji/盲文/低覆盖 BMP，行 91-94）；W8-26 真实探测路径（清空 MSYSTEM/TERM_PROGRAM/WT_SESSION 等 + TERM=msys，必须走 PS 引导+VT 位回读，行 102-123）；IME 诚实边界——node-pty 无法模拟 OS 级 IME，如实 UNVERIFIED（行 124-125）。fail-closed 汇总行 129-135。

### scripts/run-windows-acceptance-scenarios.mjs（95 行）
Gate E 场景编排驱动（本机通用档）：依次真实执行 tests/acceptance/windows/*.ps1（preflight、computer-multimonitor、browser、voice、build-restart-readback、emergency-stop、uia，行 41-92），结果 JSON `{id,status,attachmentIds}` + 原始输出附件落 artifacts/release-evidence/<runId>/scenarios/（行 24-37）。诚实语义：前置缺失/执行失败 → 该场景 blocked，绝不硬编码 passed（头注 7、行 60、92）。附件不得以 .json 结尾（行 28-29）；build 场景真实进程树 + taskkill 清理（行 56-80）；emergency-stop 用真实目标进程（行 82-89）。

### scripts/run-gate-h.mjs（14 行）
W6-03 Gate H（发行边界离线证据）运行入口：spawnSync node + node_modules/tsx/dist/cli.mjs 运行 scripts/run-gate-h.ts，stdio inherit，透传 exit status（行 10-14）。

### scripts/run-gate-i.mjs（14 行）
W6-03 Gate I（跨平台验收）运行入口：同构 thin wrapper，目标 scripts/run-gate-i.ts（行 10-14）。

### scripts/package-installer.ts（77 行）
DX-04 安装器打包入口。只消费冻结 candidate.json（绝不猜 dist/cli，头注 1-6）。确定性 zip 流程见重点 5。失败码：CANDIDATE_INVALID（行 50-53）、DEPENDENCY_CLOSURE_INCOMPLETE（行 56-59）、PACKAGE_FAILED（行 69-72）。

### scripts/memory-curator.ts（19 行）
记忆保留策略 CLI：默认 dry-run 只输出计划（JSON），`--apply` 才写库（行 9、17）；migrateMemory（384 维嵌入，行 15）→ createMemoryCurator(repository).run({mode:'apply'|'dry-run', now})（行 16-17）；`--now` 支持注入时间做确定性测试（行 10-12）；!ok 时 exitCode=1（行 18）。

### scripts/lib/evidence.mjs（33 行）
证据脚本公共库：repoRoot（行 10）、sha256File（行 12）、gitCommit（行 14-15）、stripAnsi（行 18-19）、runCmd spawnSync 包装 `{exit,out,lastLine}`（行 22-31，timeout 120s、maxBuffer 16MB）、nowIso（行 33）。头注：同一证据同一分数、公共取数公共口径（行 1-2）。

---

# 重点问题（带行号）

## 重点 1：ink 组件层布局声明与 hooks 输入订阅
- **布局声明**：组件把样式收敛到 `style` 对象后交给 Yoga 宿主节点，不另行声明。
  - Box.tsx:136-139 默认 `flexWrap:'nowrap' / flexDirection:'row' / flexGrow:0 / flexShrink:1`；Box.tsx:204-224 overflow 回退 'visible'；Box.tsx:261-281 渲染 `<ink-box style={...}>`。
  - Text.tsx:96-151 `memoizedStylesForWrap`（9 种 wrap 的 flex 预设，每项 flexGrow:0/flexShrink:1/flexDirection:'row'）；Text.tsx:320-324 `<ink-text style={...} textStyles={...}>`；wrap 默认 'wrap'（Text.tsx:176）。
  - AlternateScreen.tsx:121-125 以 `height={rows}` 约束全屏高度；ScrollBox.tsx:283-311 双层结构（overflow:scroll 外框 + 内 column Box flexGrow:1）。
  - 无 `Static` 组件（该包不存在，git 历史亦无）；预渲染直通由 RawAnsi.tsx:49 的 `<ink-raw-ansi>` 承担。
- **输入订阅**：`useInput`（use-input.ts:44-93）→ `useStdin()`（use-stdin.ts:8-9）取 StdinContext（StdinContext.ts:15-25，`inputEmitter` 来自 App.tsx:158/221）；订阅 = `inputEmitter.on('input', handleData)`（use-input.ts:86-92），事件由 App.tsx:620 `app.inputEmitter.emit('input', event)` 在 `reconciler.discreteUpdates` 批内（App.tsx:415-417）发出；raw mode 由 useInput 的 useLayoutEffect 同步开启（use-input.ts:52-62），App.handleSetRawMode（App.tsx:263-368）负责引用计数与终端序列（EBP/EFE/kitty/mouse）。

## 重点 2：loop-closure-test.mjs 的断言序列与故障注入
- **模拟的故障**：(1) 模型 32 轮只回 tool_call、从不回文本（行 31-35，`calls > toolTurns` 才回文本）——逼内核耗尽 `MAX_TURNS`（行 71 `startMock(32)`，注释「第 33 次 = 强制总结」）；(2) 工具参数逐次变化（LS_PATHS 行 21）以规避内核循环检测干扰（注释 18-20）；(3) 最终答案分两段 delta 流式（行 37-39）考验流式重组。
- **断言序列**：① 就绪：strip 后匹配 `/就绪|ready/`，30s（行 93-95）；② 键入 ASCII 提示词（行 98，注释 97：CJK 高速键入有丢字竞态、mock 不读内容）+ Enter（行 100）；③ 闭环主断言：180s 内 strip(out) 包含 `FINAL_MARK = 'LOOPCLOSURE-OK: 评估结论已收敛'`（行 14、101）——失败即 exitCode=1 并打印「静默空输出缺陷复现」+ 输出尾部（行 107-110）；④ 状态回归：尾部 3000 字符匹配 `/就绪|ready|curator|自动审查/`（行 103-104，curator 首跑通告占动词槽也算 settled）；⑤ 汇报 mock 调用数（行 105-106）。兜底：300s 看门狗 exit(2)（行 74）、finally 杀进程关 mock（行 114-118）、显式 process.exit（行 119-120）。
- 这是「闭环有测试背书」的直接证据：把真实 cmd 环境的「35 工具调用后无输出」场景，在可控 mock 端点上确定性复现并断言收敛。

## 重点 3：full-scene-test.mjs 的「陷阱注释」
头注 7-29 行编号清单（每条注明规避的缺陷）：
- 行 7-9：总述——2026-08 复测 CJK 与 ASCII 在 5ms/字符双管线零丢字（parse-keypress 批次读取修复已根治），**200ms/字符为 CI 确定性安全余量保留**。
- 行 10（陷阱 1）：补全 RPC 往返窗口内击键被吞 → **200ms/字符慢速输入**（实现于行 68 typeKeys）。
- 行 11（陷阱 2）：补全面板打开时 Enter=接受补全项 → 命令末尾加空格使过滤无匹配、面板关闭（实现于行 71 submitScoped）。
- 行 12-14（陷阱 3）：空闲态 Ctrl+C 使渲染停摆（永久停帧）→ 全程不盲发 Ctrl+C，仅当 agent 确实仍忙才中断（行 202-208、268-275）；2026-08 已修（空闲 Ctrl+C 改无操作+提示）但脚本仍保守。
- 行 15（陷阱 4）：消息用 ASCII——CJK 高速键入在 ConPTY/winpty 有丢字竞态，CJK 由真机专项验证。
- 行 16-17（陷阱 5）：Esc 关闭 overlay 后存在输入恢复窗口、首批击键失效 → Esc 关闭验证后恢复 1.5s settle（行 182-183）。
- 行 18-19（陷阱 6）：长输出命令（/help、/status）打开 pager 吞 Space/Enter → 每个 pager 命令检查后按 q 关闭并分段验证（行 237-243、261-266）。
- 行 20-23（陷阱 7）：W8-29/W8-32 更正——状态栏时钟有自驱重绘但双管线契约不同（winpty 整行重绘含「就绪」词；ConPTY 每帧只发时钟数字 CUP 改写、无就绪词）→ 以 statusBarReady 复合判据（词命中 或 时钟活性+最近状态词为就绪+无 busy 词）诚实判定（行 87-108）；启动检查改就绪轮询。
- 行 24-29（陷阱 8）：洁净间数据目录解耦评估者本机密钥/模型（行 115-118），WXNODUS_LANG 跳过 onboarding 首跑阻塞。
另：行 34 `WXNODUS_ACCEPT_CONPTY=1` → ConPTY（真实 conhost 管线），默认 winpty 保持历史绿行为。

## 重点 4：cmd-verify / cmd-audit 验证什么（真实 cmd 环境 vs conhost）
- **cmd-verify.mjs**：验证「命令落地」功能链路（/help 全量分页与展开、建议补全过滤→执行 4 条命令、清屏缺否），在 node-pty 合成键盘环境跑，管线用 `useConpty` 开关切换（行 15-17：默认 winpty 合成；WXNODUS_ACCEPT_CONPTY=1 → 真实 Windows 控制台 API/conhost 管线，验收 receipt 以 ConPTY 运行留存为准）。断言式（文本判据）验证。
- **cmd-audit.ps1**：验证「真实 cmd.exe（conhost）窗口里的 UX 真相」——不进 PTY，对真实控制台做输入注入与读出：`WriteConsoleInputW` 写控制台输入记录（行 22-26）、`ReadBufferText` 读 CONOUT$ 屏幕缓冲（行 11-20）、窗口截图（行 9-10），视觉层由 GLM-4V 识别截图（头注 1-2）。覆盖 /help pager、CJK 输入（你好）、真实提交回复 busy/done 帧。
- 差异回答：两者共同点是都受「合成键盘/终端渲染契约差异」困扰（cmd-verify 头注 5-11 的 200ms/字符、面板吞 Enter、pager 吞键、Esc/Ctrl+C/退格陷阱；full-scene 头注 7 双管线状态栏契约）。cmd-verify 是 PTY 模拟（可切 ConPTY）下的断言验证；cmd-audit 是真实 conhost 控制台 API 通道下的证据采集（截图+缓冲文本），不跑断言、交给视觉模型与人工核对。配套 cmd-sweep W8-25/W8-26 在序列层验证 cmd 档能力门控（无 DEC2026/DECSTBM/OSC8/truecolor、无豆腐块字形、无逃生门真实探测路径）——「真实 conhost 不支持现代序列」这一行为差异被显式编码为断言。

## 重点 5：package-installer.ts 的确定性 zip 流程
- 输入冻结：只读 candidate.json（行 31-32），含 `candidateId/commit/tgzSha256/cell/entrypoint/dynamicImportDeclarations`（头注 3）。
- 暂存树（staged Map，行 33-46）：递归 collect dist 树（行 34-40）+ `collectDependencyClosure`（行 45）+ `stageClosureEntries` 还原 node_modules/ 前缀（行 41-42 注释：否则依赖平铺安装根、运行时解析失败）。
- 校验两道（行 49-59）：`validateFrozenInstallerCandidate`（含 stagedTree，行 48-49）与 `verifyDependencyClosure(scanDistImportSpecifiers(dist), closure, dynamicImportDeclarations)`。
- 确定性 zip 在 `buildInstallerPackage`（行 61-68，src/application/release/installerPackager.js）：manifest 全量 sha256 + 确定性 zip + 读回自校验（头注 6）；输出 zipPath/zipSha256/entryCount（行 73-76）；入口 install.ps1（行 77）。

---

# 3 个验证体系发现

1. **三层证据体系（模拟→PTY→真实 conhost）**：最内层是确定性故障注入电池（loop-closure-test.mjs：mock 端点逼轮次耗尽，行 31-41/71/101）；中层是 PTY 驱动、分段作用域断言的全场景/命令电池（full-scene-test.mjs 行 55-59/96-108，cmd-verify.mjs 行 31-77，cmd-sweep.mjs 行 49-62）；外层是真实 conhost 控制台 API 的证据采集（cmd-audit.ps1 行 11-26 的 WriteConsoleInputW/ReadBufferText/截图 + acceptance-scenarios.mjs 行 41-92 的真机 .ps1 场景）。层间差异（winpty vs ConPTY 渲染契约）被显式编码为判据而非掩盖（full-scene 行 87-108；cmd-sweep 行 96-123 的 W8-25/W8-26 层级断言）。

2. **fail-closed + 诚实语义纪律**：所有电池任一断言失败即非零退出（loop-closure 行 107-110、cmd-verify 行 176、cmd-sweep 行 129-135、full-scene 行 321）；不可能的场景如实记录 blocked/UNVERIFIED 而非硬编码通过（acceptance-scenarios 头注 7、行 60/92；cmd-sweep 行 124-125 IME UNVERIFIED）；防悬挂工程（loop-closure 行 74 看门狗、行 119-120 显式 exit；mock closeAllConnections 行 51-53）；脚本内注释自带缺陷溯因与修复时间戳（W8-19/25/26/29/32 标签、2026-08 复测记录），测试即证据链。

3. **洁净间可复现基线**：全部电池跑在 `WXNODUS_DATA_DIR=artifacts/battery-cleanroom` + `WXNODUS_LANG=zh-CN`（full-scene 行 24-29/115-118，cmd-verify 行 19-21，loop-closure 行 75-86）——与评估者本机密钥/模型解耦，无 key 规则脑确定性回复；公共取数口径收敛于 scripts/lib/evidence.mjs（sha256/gitCommit/stripAnsi/runCmd，行 10-31）；证据统一流入 artifacts/release-evidence/<runId>/，由 run-gate-h.mjs/run-gate-i.mjs（tsx 运行 TS 实现）与 package-installer.ts（冻结 candidate → 确定性 zip → sha256 读回）组成可追溯的发行闭环。

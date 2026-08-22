// src/wxnodus-ui/components/appLayout.tsx — 四层布局装配（状态栏/转录流/输入区/浮层 + P2 面板右分栏）
import { AlternateScreen, Box, NoSelect, ScrollBox, Text } from '@wxnodus/ink'
import { buildStatusRows, type StatusBarUsage } from './statusBarSegments.js'
import type { Theme } from '../theme.js'
import { useAtom as useStore } from '../../app/stores/engine.js'
import { Fragment, memo, useRef } from 'react'

import { useGateway } from '../bridge/gatewayProvider.js'
import type { AppLayoutProps } from '../bridge/interfaces.js'
import { $isBlocked, $overlayState, closeOverlay, pushOverlay } from '../runtime/promptStore.js'
import { findEntry, findPanelKind } from '../runtime/overlayStack.js'
import { clearSelectedMessage, $uiState } from '../runtime/viewStore.js'
import { useTurnSelector } from '../runtime/flowStore.js'
import { bgActiveCount, useBgSelector } from '../runtime/backgroundStore.js'
import { INLINE_MODE, SHOW_FPS, TERMUX_TUI_MODE } from '../config/env.js'
import { PLACEHOLDER } from '../content/placeholders.js'
import { prevRenderedMsg } from '../domain/blockLayout.js'
import {
  COMPOSER_PROMPT_GAP_WIDTH,
  composerPromptWidth,
  inputVisualHeight,
  stableComposerColumns
} from '../lib/inputMetrics.js'
import { PerfPane } from '../lib/perfPane.js'
import { composerPromptText } from '../lib/prompt.js'
import { usageSegmentLabel } from '../lib/balanceStatus.js'

import { AgentsOverlay } from './agentsOverlay.js'
import { GoodVibesHeart, StatusRule, StickyPromptTracker, TranscriptScrollbar } from './appChrome.js'
import { BlackHolePet, WelcomeCard, modeBadgeSpec, type PetMood } from './blackHolePet.js'
import { FloatingOverlays, PromptZone } from './appOverlays.js'
import { RightPanelPane } from './rightPanel.js'
import { Banner, Panel, SessionPanel } from './branding.js'
import { BrandBar } from './brandBar.js'
import { FpsOverlay } from './fpsOverlay.js'
import { HelpHint } from './helpHint.js'
import { MessageLine } from './messageLine.js'
import { QueuedMessages } from './queuedMessages.js'
import { StreamingAssistant } from './streamingAssistant.js'
import { TextInput, type TextInputMouseApi } from './textInput.js'
import { getVimModeEnabled } from '../config/vimMode.js'
import { icon } from '../glyphs.js'

const PromptPrefix = memo(function PromptPrefix({
  bold = false,
  color,
  promptText,
  width
}: {
  bold?: boolean
  color: string
  promptText: string
  width: number
}) {
  const glyphWidth = Math.max(1, width - COMPOSER_PROMPT_GAP_WIDTH)

  return (
    <Box width={width}>
      <Box width={glyphWidth}>
        <Text bold={bold} color={color}>
          {promptText}
        </Text>
      </Box>
      <Box width={COMPOSER_PROMPT_GAP_WIDTH} />
    </Box>
  )
})

// 品牌顶栏右端上下文：模型短名 + 个性化档案（如有）
const modelBarLabel = (model: string, profile: string) => {
  const short = String(model).split('/').pop() ?? ''
  const parts = [short, profile && profile !== 'default' ? profile : ''].filter(Boolean)
  return parts.join(' · ')
}

// A24：后台活动摘要行——运行中任务/终端/goal 循环一览
const BgSummaryLine = memo(function BgSummaryLine() {
  const ui = useStore($uiState)
  const bg = useBgSelector(s => s)
  const terms = bg.terms.filter(x => x.status === 'running').length
  const jobs = bg.jobs.filter(j => j.status === 'running' || j.status === 'queued').length
  const parts: string[] = []
  if (jobs) parts.push(`${jobs} 任务`)
  if (terms) parts.push(`${terms} 终端`)
  if (bg.goal?.active) parts.push(bg.goal.cancelled ? `goal 已取消（${bg.goal.round}/${bg.goal.maxRounds} 轮）` : `goal ${bg.goal.round}/${bg.goal.maxRounds} 轮`)
  if (bgActiveCount(bg) === 0 || !parts.length) return null

  return (
    <Box>
      <Text color={ui.theme.color.muted}>
        <Text color={ui.theme.color.accent}>{icon('copy')} 后台：</Text>
        {parts.join(' · ')}
      </Text>
    </Box>
  )
})

const TranscriptPane = memo(function TranscriptPane({
  actions,
  composer,
  progress,
  transcript
}: Pick<AppLayoutProps, 'actions' | 'composer' | 'progress' | 'transcript'>) {
  const ui = useStore($uiState)

  // 单栏布局（双栏已取消）：消息渲染宽度恒等于终端宽度。
  const msgCols = composer.cols

  return (
    <>
      {/* 品牌差异化：常驻品牌顶栏——不随消息滚动消失（黑洞引擎视觉锚点） */}
      <BrandBar
        rightLabel={modelBarLabel(ui.info?.model ?? '', ui.info?.profile_name ?? '')}
        t={ui.theme}
      />
      {/* 滚动条几何 row：只包 ScrollBox 与其右侧滚动条——滚动条横向占 1 列、高度
          跟随整行拉伸（无纵向反馈回路，±1 行取整翻转抖动不回归）；ScrollBox 独占
          剩余全宽（BrandBar 不在本 row 内——否则 transcript 被挤成右缘窄条）。 */}
      <Box flexDirection="row" flexGrow={1} flexShrink={1}>
      <ScrollBox
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        onClick={(e: { cellIsBlank?: boolean }) => {
          if (e.cellIsBlank) {
            actions.clearSelection()
            // A19：点空白同时取消消息选中（与"点击空白清选区"约定一致）
            clearSelectedMessage()
          }
        }}
        ref={transcript.scrollRef}
        stickyScroll
      >
        <Box flexDirection="column" paddingX={1}>
          {transcript.virtualHistory.topSpacer > 0 ? <Box height={transcript.virtualHistory.topSpacer} /> : null}

          {transcript.virtualRows.slice(transcript.virtualHistory.start, transcript.virtualHistory.end).map(row => (
            <Box flexDirection="column" key={row.key} ref={transcript.virtualHistory.measureRef(row.key)}>
              {row.msg.kind === 'intro' ? (
                <Box flexDirection="column" paddingTop={1}>
                  <Banner maxWidth={Math.max(1, msgCols - 2)} t={ui.theme} />

                  {row.msg.info && (
                    <SessionPanel
                      info={row.msg.info}
                      maxWidth={Math.max(1, msgCols - 2)}
                      onCommand={text => composer.submit(text)}
                      sid={ui.sid}
                      t={ui.theme}
                    />
                  )}
                </Box>
              ) : row.msg.kind === 'panel' && row.msg.panelData ? (
                <Panel sections={row.msg.panelData.sections} t={ui.theme} title={row.msg.panelData.title} />
              ) : (
                <MessageLine
                  cols={msgCols}
                  compact={ui.compact}
                  detailsMode={ui.detailsMode}
                  detailsModeCommandOverride={ui.detailsModeCommandOverride}
                  msg={row.msg}
                  msgKey={row.key}
                  onCommand={text => composer.submit(text)}
                  prev={prevRenderedMsg(
                    i => transcript.virtualRows[i]?.msg,
                    row.index,
                    { commandOverride: ui.detailsModeCommandOverride, detailsMode: ui.detailsMode, sections: ui.sections }
                  )}
                  sections={ui.sections}
                  t={ui.theme}
                />
              )}

            </Box>
          ))}

          {transcript.virtualHistory.bottomSpacer > 0 ? <Box height={transcript.virtualHistory.bottomSpacer} /> : null}

          <StreamingAssistant
            cols={msgCols}
            compact={ui.compact}
            detailsMode={ui.detailsMode}
            detailsModeCommandOverride={ui.detailsModeCommandOverride}
            prevMsg={transcript.historyItems[transcript.historyItems.length - 1]}
            progress={progress}
            sections={ui.sections}
          />
        </Box>
      </ScrollBox>

      <NoSelect flexShrink={0} marginLeft={1}>
        <TranscriptScrollbar scrollRef={transcript.scrollRef} t={ui.theme} />
      </NoSelect>
      </Box>

      <StickyPromptTracker
        messages={transcript.historyItems}
        offsets={transcript.virtualHistory.offsets}
        onChange={actions.setStickyPrompt}
        scrollRef={transcript.scrollRef}
      />
    </>
  )
})

const ComposerPane = memo(function ComposerPane({
  actions,
  composer,
  status
}: Pick<AppLayoutProps, 'actions' | 'composer' | 'status'>) {
  const ui = useStore($uiState)
  const isBlocked = useStore($isBlocked)
  const sh = (composer.inputBuf[0] ?? composer.input).startsWith('!')
  const promptText = composerPromptText(icon('prompt'), ui.info?.profile_name, sh, TERMUX_TUI_MODE, composer.cols)
  const promptWidth = composerPromptWidth(promptText)
  const promptBlank = ' '.repeat(promptWidth)
  const inputColumns = stableComposerColumns(composer.cols, promptWidth, TERMUX_TUI_MODE)
  const inputHeight = inputVisualHeight(composer.input, inputColumns)
  const inputMouseRef = useRef<null | TextInputMouseApi>(null)

  const captureInputDrag = (e: GutterMouseEvent) => {
    if (e.button !== 0) {
      return
    }

    e.stopImmediatePropagation?.()
    inputMouseRef.current?.startAtBeginning()
  }

  // Drag origin matches the input box's top-left, so localRow / localCol
  // map directly into TextInput coords (after backing out the prompt cell).
  const dragFromPromptRow = (e: GutterMouseEvent) => {
    if (e.button !== 0) {
      return
    }

    e.stopImmediatePropagation?.()
    inputMouseRef.current?.dragAt(e.localRow ?? 0, (e.localCol ?? 0) - promptWidth)
  }

  // Spacer rows live on a different vertical origin; only the column is
  // parent-aligned with the input. Force row=0 so vertical drags can't
  // jump the cursor to the wrong wrapped line.
  const dragFromSpacer = (e: GutterMouseEvent) => {
    if (e.button !== 0) {
      return
    }

    e.stopImmediatePropagation?.()
    inputMouseRef.current?.dragAt(0, (e.localCol ?? 0) - promptWidth)
  }

  const endInputDrag = () => inputMouseRef.current?.end()

  return (
    <NoSelect
      flexDirection="column"
      flexShrink={0}
      fromLeftEdge
      onClick={(e: { cellIsBlank?: boolean }) => {
        if (e.cellIsBlank) {
          actions.clearSelection()
        }
      }}
      paddingX={1}
    >
      <QueuedMessages
        cols={composer.cols}
        onEdit={composer.editQueued}
        queued={composer.queuedDisplay}
        queueEditIdx={composer.queueEditIdx}
        t={ui.theme}
      />

      <BgSummaryLine />

      {status.showStickyPrompt ? (
        // A24：点击 sticky prompt 载入输入框编辑（键盘输入本就会替换它——鼠标给同款出口）
        <Box onClick={() => composer.updateInput(status.stickyPrompt)}>
          <Text color={ui.theme.color.muted} wrap="truncate-end">
              <Text color={ui.theme.color.label}>{`${icon('arrowRight')} `}</Text>

              {status.stickyPrompt}

          </Text>
        </Box>
      ) : (
        <Box height={1} onMouseDown={captureInputDrag} onMouseDrag={dragFromSpacer} onMouseUp={endInputDrag} />
      )}

      <StatusRulePane actions={actions} at="top" composer={composer} status={status} />

      {/* V4 UI 闭环（kimi 像素复刻）：输入区分隔头 ── input ────（kimi prompt.py
          _build_top_border 同形态——标题分隔线式而非框式；线宽铺满列） */}
      <Text color={ui.theme.color.border}>
        {'─'.repeat(2)} input {'─'.repeat(Math.max(0, composer.cols - 10))}
      </Text>

      <Box flexDirection="column" marginTop={ui.statusBar === 'top' ? 0 : 1} position="relative">
        <FloatingOverlays
          cols={composer.cols}
          compIdx={composer.compIdx}
          completions={composer.completions}
          onActiveSessionClose={actions.closeLiveSession}
          onActiveSessionSelect={actions.activateLiveSession}
          onCompletionSelect={composer.acceptCompletion}
          onNewLiveSession={actions.newLiveSession}
          onNewPromptSession={actions.newPromptSession}
          onPaletteSubmit={(text) => {
            composer.updateInput(text)
            composer.submit(text)
          }}
          onResumeSelect={actions.resumeById}
          pagerPageSize={composer.pagerPageSize}
        />

        {composer.input === '?' && !composer.inputBuf.length && <HelpHint onCommand={text => composer.submit(text)} t={ui.theme} />}

        {/* #4 债（full-scene 陷阱 5）：overlay 打开时不再卸载 TextInput——卸载重挂会
            丢 input 监听注册窗口，Esc 关闭后首批击键被吞。现常驻挂载，
            阻断期间 display:none + focus=false（监听注销、按键归 overlay 自身
            useInput），关闭即 focus=true 恢复——无重挂、无恢复窗口。 */}
        <Box flexDirection="column" display={isBlocked ? 'none' : undefined}>
          {composer.inputBuf.map((line, i) => (
            <Box key={i}>
              <Box width={promptWidth}>
                {i === 0 ? (
                  <PromptPrefix color={ui.theme.color.muted} promptText={promptText} width={promptWidth} />
                ) : (
                  <Text color={ui.theme.color.muted}>{promptBlank}</Text>
                )}
              </Box>

              <Text color={ui.theme.color.text}>{line || ' '}</Text>
            </Box>
          ))}

          <Box
            onMouseDown={captureInputDrag}
            onMouseDrag={dragFromPromptRow}
            onMouseUp={endInputDrag}
            position="relative"
            width={Math.max(1, composer.cols - 2)}
          >
              <Box width={promptWidth}>
                {sh ? (
                  <PromptPrefix color={ui.theme.color.shellDollar} promptText={promptText} width={promptWidth} />
                ) : composer.inputBuf.length ? (
                  <Text color={ui.theme.color.prompt}>{promptBlank}</Text>
                ) : (
                  <PromptPrefix bold color={ui.theme.color.prompt} promptText={promptText} width={promptWidth} />
                )}
              </Box>

              <Box flexGrow={0} flexShrink={0} height={inputHeight} width={inputColumns}>
                {/* Reserve the transcript scrollbar gutter too so typing never rewraps when the scrollbar column repaints. */}
                <TextInput
                  columns={inputColumns}
                  focus={!isBlocked}
                  mouseApiRef={inputMouseRef}
                  onChange={composer.updateInput}
                  onPaste={composer.handleTextPaste}
                  onSubmit={composer.submit}
                  placeholder={composer.empty ? PLACEHOLDER : ui.busy ? 'Ctrl+C to interrupt…' : ''}
                  value={composer.input}
                  vimEnabled={getVimModeEnabled()}
                  voiceRecordKey={composer.voiceRecordKey}
                />
              </Box>

      <Box position="absolute" right={0}>
        {/* A20/A24：麦克风钮常驻——未开启时显示 🎤（点击开启语音模式）；
            开启后 ◉ 点击录音 / ●REC 点击停止；GoodVibesHeart 移至语音开启态旁 */}
        {status.voiceEnabled ? (
          <Box onClick={actions.toggleVoice} flexDirection="row">
            <Text color={status.voiceRecording ? ui.theme.color.error : ui.theme.color.accent}>
              {status.voiceRecording ? `${icon('rec')} ` : `${icon('mic')} `}
            </Text>
            <GoodVibesHeart t={ui.theme} tick={status.goodVibesTick} />
          </Box>
        ) : (
          <Box onClick={actions.toggleVoiceMode}>
            <Text color={ui.theme.color.muted}>{icon('mic')} </Text>
          </Box>
        )}
      </Box>
            </Box>
        </Box>
      </Box>

      {!composer.empty && !ui.sid && (
        <Text color={ui.theme.color.muted}>
          {icon('warn')} {ui.status}
        </Text>
      )}

      <StatusRulePane actions={actions} at="bottom" composer={composer} status={status} />
    </NoSelect>
  )
})

const AgentsOverlayPane = memo(function AgentsOverlayPane() {
  const { gw } = useGateway()
  const ui = useStore($uiState)
  const overlay = useStore($overlayState)

  return (
    <AgentsOverlay
      gw={gw}
      initialHistoryIndex={findEntry(overlay, 'agents')?.initialHistoryIndex ?? 0}
      onClose={() => closeOverlay('agents')}
      t={ui.theme}
    />
  )
})

const StatusRulePane = memo(function StatusRulePane({
  actions,
  at,
  composer,
  status
}: Pick<AppLayoutProps, 'actions' | 'composer' | 'status'> & { at: 'bottom' | 'top' }) {
  const ui = useStore($uiState)
  // 宠物情绪：busy 吸积盘 / 审批被拒或错误通知坍缩 / 其余呼吸
  const outcome = useTurnSelector(state => state.outcome)

  if (ui.statusBar !== at) {
    return null
  }

  const perm = modeBadgeSpec(ui.info?.perm ?? 'smart')
  const petMood: PetMood = ui.busy ? 'busy' : outcome === 'denied' || ui.notice?.level === 'error' ? 'error' : 'idle'

  return (
    <Box marginTop={at === 'top' ? 1 : 0}>
      <StatusRule
        battery={ui.battery}
        balanceLabel={ui.balance?.label}
        balanceStale={ui.balance?.stale}
        balanceNextRefreshAt={ui.balance?.nextRefreshAt}
        balanceLow={ui.balance?.low}
        busy={ui.busy}
        cols={composer.cols}
        cwdLabel={status.cwdLabel}
        sessionTitle={ui.sessionTitle}
        indicatorStyle={ui.indicatorStyle}
        lastTurnEndedAt={status.lastTurnEndedAt}
        liveSessionCount={ui.liveSessionCount}
        model={ui.info?.model ?? ''}
        modelFast={ui.info?.fast || ui.info?.service_tier === 'priority'}
        modelReasoningEffort={ui.info?.reasoning_effort}
        notice={ui.notice}
        onSessionCountClick={() => pushOverlay({ kind: 'sessions' })}
        onBalanceClick={actions.refreshBalance}
        onUsageClick={actions.cycleUsageRange}
        onVoiceClick={actions.toggleVoiceMode}
        onCwdClick={() => pushOverlay({ kind: 'dirPicker' })}
        onModelClick={() => pushOverlay({ kind: 'modelPicker' })}
        permLabel={perm.label}
        permTone={perm.tone}
        pet={<BlackHolePet mood={petMood} t={ui.theme} />}
        selectionHint={ui.selectionHint}
        sessionStartedAt={status.sessionStartedAt}
        showCost={ui.showCost}
        status={ui.status}
        statusColor={status.statusColor}
        t={ui.theme}
        turnStartedAt={status.turnStartedAt}
        usage={ui.usage}
        usageLabel={ui.usageRange ? usageSegmentLabel(ui.usageRange) : undefined}
        usageNextRefreshAt={ui.usageRange?.nextRefreshAt}
        voiceLabel={status.voiceLabel}
      />
      {/* V4 UI 闭环（kimi 式第二行）：左 toast / 右 context%（水位着色）——
          buildStatusRows.line2 纯函数产段，数据位全部来自既有 ui state */}
      <StatusBarLine2 notice={ui.notice} t={ui.theme} usage={ui.usage as StatusBarUsage | undefined} />
    </Box>
  )
})

/** kimi 式状态栏第二行（薄渲染壳）：左 toast / 右 context%（纯函数段直渲） */
const StatusBarLine2 = memo(function StatusBarLine2(props: {
  notice?: { text?: string; level?: string } | null
  t: Theme
  usage?: StatusBarUsage
}) {
  const rows = buildStatusRows({ state: 'ready', statusText: '', usage: props.usage }, 80)
  const segs = rows.line2.segments
  if (!segs.length && !props.notice?.text) return null
  const semanticColor: Record<string, string> = {
    error: props.t.color.error, warn: props.t.color.warn, muted: props.t.color.muted, accent: props.t.color.accent,
  }
  return (
    <Box>
      {props.notice?.text ? <Text color={props.t.color.warn}>{props.notice.text.slice(0, 60)}</Text> : null}
      <Box flexGrow={1} />
      {segs.map((seg, i) => (
        <Text key={i} color={semanticColor[seg.color] ?? ''}>{i > 0 ? '  ' : ''}{seg.text}</Text>
      ))}
    </Box>
  )
})

export const AppLayout = memo(function AppLayout({
  actions,
  composer,
  mouseTracking,
  progress,
  status,
  transcript
}: AppLayoutProps) {
  const overlay = useStore($overlayState)
  const ui = useStore($uiState)

  // P2 右分栏：面板组（config/model/skills/plugins——互斥组至多 1 个）宽窗（≥80 列）
  // 渲染为右侧分栏（宽度 min(40, cols-50%)，不遮转录流）；小窗降级为全宽块（挂载点
  // 见下方 narrow 分支——与既有浮层视觉接近，如实降级不假自适应）
  const panelKind = findPanelKind(overlay)
  const panelWidth = Math.max(20, Math.min(40, composer.cols - Math.floor(composer.cols / 2)))
  const usePanelColumn = !!panelKind && composer.cols >= 80

  // Inline mode skips AlternateScreen so the host terminal's native
  // scrollback captures rows scrolled off the top; composer + progress
  // stay anchored via normal flex-column flow.
  const Shell = INLINE_MODE ? Fragment : AlternateScreen
  const shellProps = INLINE_MODE ? {} : { mouseTracking }

  return (
    <Shell {...shellProps}>
      <Box flexDirection={usePanelColumn ? 'row' : 'column'} flexGrow={1}>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {/* 启动欢迎卡片：吸积盘 6 帧（1.5s）后自消散——仅 full 动效档且
            WXNODUS_NO_INTRO 未设时出现（简约：只占启动一瞬，之后永不再现） */}
        <WelcomeCard mode={ui.info?.perm ?? 'smart'} t={ui.theme} />
        {/* 单栏内容结构：主列直接放 transcript/agents——无外层 row 包装。
            （历史回归：row 包住整个 TranscriptPane 时 BrandBar 占满整行，
            ScrollBox 被挤成右缘 2 列窄条——即用户曾看到的「双栏」与
            full-scene 空 transcript 的同一根因。滚动条几何 row 在 TranscriptPane 内部。） */}
        {findEntry(overlay, 'agents') ? (
          <PerfPane id="agents">
            <AgentsOverlayPane />
          </PerfPane>
        ) : (
          <PerfPane id="transcript">
            <TranscriptPane actions={actions} composer={composer} progress={progress} transcript={transcript} />
          </PerfPane>
        )}

        {/* P2 右分栏小窗降级：<80 列面板渲染为全宽块（转录流与输入区之间，不浮层遮蔽） */}
        {panelKind && !usePanelColumn && (
          <RightPanelPane onModelSelect={actions.onModelSelect} width={Math.max(20, composer.cols - 2)} />
        )}

        {!findEntry(overlay, 'agents') && (
          <>
            <PerfPane id="prompt">
              <PromptZone
                cols={composer.cols}
                onApprovalChoice={actions.answerApproval}
                onClarifyAnswer={actions.answerClarify}
                onSecretSubmit={actions.answerSecret}
                onSudoSubmit={actions.answerSudo}
                onFormSubmit={actions.answerForm}
                onFormCancel={actions.cancelForm}
                onHistoryAccept={text => {
                  closeOverlay('histSearch')
                  composer.updateInput(text)
                }}
                onHistoryCancel={() => closeOverlay('histSearch')}
              />
            </PerfPane>

            <PerfPane id="composer">
              <ComposerPane actions={actions} composer={composer} status={status} />
            </PerfPane>

            {SHOW_FPS && (
              <Box flexShrink={0} justifyContent="flex-end" paddingRight={1}>
                <FpsOverlay t={ui.theme} />
              </Box>
            )}
          </>
        )}
        </Box>
        {usePanelColumn && (
          <RightPanelPane onModelSelect={actions.onModelSelect} width={panelWidth} />
        )}
      </Box>
    </Shell>
  )
})

type GutterMouseEvent = {
  button: number
  localCol?: number
  localRow?: number
  stopImmediatePropagation?: () => void
}

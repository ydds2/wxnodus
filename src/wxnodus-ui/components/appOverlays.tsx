import { Ansi, Box, stringWidth, Text } from '@wxnodus/ink'
import { useAtom as useStore } from '../../app/stores/engine.js'

import { useGateway } from '../bridge/gatewayProvider.js'
import type { AppOverlaysProps } from '../bridge/interfaces.js'
import type { SecretRespondResponse, SudoRespondResponse } from '../gatewayTypes.js'
import { $overlayState, closeOverlay, patchInline, updateOverlay } from '../runtime/promptStore.js'
import { findEntry } from '../runtime/overlayStack.js'
import { $uiSessionId, $uiTheme } from '../runtime/viewStore.js'
import { hasAnsi, sanitizeAnsiForRender, stripAnsi } from '../lib/text.js'

import { ActiveSessionSwitcher } from './activeSessionSwitcher.js'
import { CommandPalette } from './commandPalette.js'
import { DirPicker } from './dirPicker.js'
import { FloatBox } from './appChrome.js'
import { HistorySearch } from './historySearch.js'
import { MaskedPrompt } from './maskedPrompt.js'
import { OverlayHint } from './overlayControls.js'
import { ApprovalPrompt, ClarifyPrompt, ConfirmPrompt } from './prompts.js'
import { DynamicFormPrompt } from './dynamicFormPrompt.js'
import { WorkspaceView } from './workspaceView.js'
import { icon, translateText } from '../glyphs.js'

const COMPLETION_WINDOW = 16

export function PromptZone({
  cols,
  onApprovalChoice,
  onClarifyAnswer,
  onSecretSubmit,
  onSudoSubmit,
  onFormSubmit,
  onFormCancel,
  onHistoryAccept,
  onHistoryCancel
}: Pick<AppOverlaysProps, 'cols' | 'onApprovalChoice' | 'onClarifyAnswer' | 'onSecretSubmit' | 'onSudoSubmit' | 'onFormSubmit' | 'onFormCancel' | 'onHistoryAccept' | 'onHistoryCancel'>) {
  const overlay = useStore($overlayState)
  const theme = useStore($uiTheme)
  const { gw } = useGateway()

  // 行内提示（审批/澄清/确认/sudo/secret/form——附着消息行，非栈；栈式重构后读 inline）
  const inline = overlay.inline

  // A24：sudo/secret 可点击取消（与 cancelOverlayFromCtrlC 同链路——空值 respond）
  const cancelSudo = () => {
    if (!inline.sudo) return
    void gw
      .request<SudoRespondResponse>('sudo.respond', { password: '', request_id: inline.sudo.requestId })
      .then(r => r && patchInline({ sudo: null }))
  }

  const cancelSecret = () => {
    if (!inline.secret) return
    void gw
      .request<SecretRespondResponse>('secret.respond', { request_id: inline.secret.requestId, value: '' })
      .then(r => r && patchInline({ secret: null }))
  }

  if (inline.approval) {
    return (
      <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
        <ApprovalPrompt cols={cols} onChoice={onApprovalChoice} req={inline.approval} t={theme} />
      </Box>
    )
  }

  if (findEntry(overlay, 'histSearch')) {
    return (
      <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
        <HistorySearch onAccept={onHistoryAccept} onCancel={onHistoryCancel} t={theme} />
      </Box>
    )
  }

  if (inline.confirm) {
    const req = inline.confirm

    const onConfirm = () => {
      patchInline({ confirm: null })
      req.onConfirm()
    }

    const onCancel = () => patchInline({ confirm: null })

    return (
      <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
        <ConfirmPrompt onCancel={onCancel} onConfirm={onConfirm} req={req} t={theme} />
      </Box>
    )
  }

  if (inline.clarify) {
    return (
      <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
        <ClarifyPrompt
          cols={cols}
          onAnswer={onClarifyAnswer}
          onCancel={() => onClarifyAnswer('')}
          req={inline.clarify}
          t={theme}
        />
      </Box>
    )
  }

  if (inline.sudo) {
    return (
      <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
          <MaskedPrompt cols={cols} icon={icon('lock')} label="需要 sudo 密码" onCancel={cancelSudo} onSubmit={onSudoSubmit} t={theme} />
      </Box>
    )
  }

  if (inline.secret) {
    return (
      <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
        <MaskedPrompt
          cols={cols}
          icon={icon('key')}
          label={inline.secret.prompt}
          onCancel={cancelSecret}
          onSubmit={onSecretSubmit}
          sub={`环境变量：${inline.secret.envVar}`}
          t={theme}
        />
      </Box>
    )
  }

  // 动态内容表（多字段敏感输入——/input 与 credential_form 工具）
  if (inline.form) {
    return (
      <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
        <DynamicFormPrompt
          cols={cols}
          fields={inline.form.fields}
          prompt={inline.form.prompt}
          onSubmit={onFormSubmit}
          onCancel={onFormCancel}
          t={theme}
        />
      </Box>
    )
  }

  return null
}

export function FloatingOverlays({
  cols,
  compIdx,
  completions,
  onActiveSessionSelect,
  onActiveSessionClose,
  onCompletionSelect,
  onNewLiveSession,
  onNewPromptSession,
  onPaletteSubmit,
  onResumeSelect,
  pagerPageSize
}: Pick<
  AppOverlaysProps,
  | 'cols'
  | 'compIdx'
  | 'completions'
  | 'onActiveSessionSelect'
  | 'onActiveSessionClose'
  | 'onCompletionSelect'
  | 'onNewLiveSession'
  | 'onNewPromptSession'
  | 'onPaletteSubmit'
  | 'onResumeSelect'
  | 'pagerPageSize'
>) {
  const { gw } = useGateway()
  const overlay = useStore($overlayState)
  const sid = useStore($uiSessionId)
  const theme = useStore($uiTheme)

  // 栈式重构后：每个 kind 的存在性由 findEntry 判定（栈内至多 1 个）；
  // 互斥组保证面板/选择器不同时出现。渲染结构保持「常驻 FloatBox + display 切换」
  // 的既有约束（React 19 并发下条件挂载曾产生错位节点——见下方 PATCH 注释）。
  const pagerEntry = findEntry(overlay, 'pager')
  const wsEntry = findEntry(overlay, 'workspace')
  const sessionsOn = !!findEntry(overlay, 'sessions')
  const paletteOn = !!findEntry(overlay, 'commandPalette')
  const dirPickerOn = !!findEntry(overlay, 'dirPicker')

  // Fixed viewport centered on compIdx — previously the slice end was
  // compIdx + 8 so the dropdown grew from 8 rows to 16 as the user scrolled
  // down, bouncing the height on every keystroke.
  const viewportSize = Math.min(COMPLETION_WINDOW, completions.length)

  const start = Math.max(0, Math.min(compIdx - Math.floor(COMPLETION_WINDOW / 2), completions.length - viewportSize))

  // PATCH(wxnodus): absolute Box / FloatBox 常驻，display 切换显隐——React 19
  // 并发下条件渲染的挂载/卸载会在树中产生错位节点（overlay 挂到错误父），
  // 导致 modelPicker/sessions 等永不显示。常驻结构保证 React 只更新 props，
  // 不增删节点，树结构稳定。children 条件渲染（display:none 时组件卸载，
  // useInput 随之注销，避免隐藏时拦截键盘输入）。
  return (
    <Box alignItems="flex-start" bottom="100%" flexDirection="column" left={0} position="absolute" right={0}>
      <FloatBox color={theme.color.border} display={sessionsOn ? undefined : 'none'}>
        {sessionsOn && (
          <ActiveSessionSwitcher
            currentSessionId={sid}
            gw={gw}
            onCancel={() => closeOverlay('sessions')}
            onClose={onActiveSessionClose}
            onNew={onNewLiveSession}
            onNewPrompt={onNewPromptSession}
            onResume={onResumeSelect}
            onSelect={onActiveSessionSelect}
            t={theme}
          />
        )}
      </FloatBox>

      {/* P2 右分栏：面板组（config/model/skills/plugins）已迁至 appLayout 的右侧分栏
          （RightPanelPane）——不再以浮层遮蔽转录流；小窗 <80 列自动降级为全宽块 */}

      <FloatBox color={theme.color.border} display={paletteOn ? undefined : 'none'}>
        {paletteOn && (
          <CommandPalette
            cols={cols}
            currentSessionId={sid}
            gw={gw}
            onClose={() => closeOverlay('commandPalette')}
            onSessionSelect={onActiveSessionSelect}
            onSubmit={onPaletteSubmit}
            t={theme}
          />
        )}
      </FloatBox>

      {/* A24：目录选择器（点击状态栏 cwd 打开——浏览/切换工作目录） */}
      <FloatBox color={theme.color.border} display={dirPickerOn ? undefined : 'none'}>
        {dirPickerOn && <DirPicker t={theme} />}
      </FloatBox>

      {/* P1/P2 工作台：status/doctor 结构化 + sessions 会话工作台（w 三标签切换、
          Esc 全局统一出栈）——status/doctor 数据由 slash 拦截经 RPC 注入；
          sessions 标签渲染 ActiveSessionSwitcher（Ctrl+X 快切浮层同组件双挂载，互不干扰） */}
      <FloatBox color={theme.color.border} display={wsEntry ? undefined : 'none'}>
        {wsEntry && wsEntry.ws !== 'sessions' && (
          <WorkspaceView data={wsEntry.data} onClose={() => closeOverlay('workspace')} t={theme} ws={wsEntry.ws} />
        )}
        {wsEntry && wsEntry.ws === 'sessions' && (
          <ActiveSessionSwitcher
            currentSessionId={sid}
            gw={gw}
            onCancel={() => closeOverlay('workspace')}
            onClose={onActiveSessionClose}
            onNew={onNewLiveSession}
            onNewPrompt={onNewPromptSession}
            onResume={onResumeSelect}
            onSelect={onActiveSessionSelect}
            t={theme}
          />
        )}
      </FloatBox>

      {/* pager：内容首行自带 box-drawing 边框（╔╭┌ lines() 面板）时外层去边框——
          避免双边框叠加（修复 /help 双层壁）；否则 double 边框兜底 */}
      <FloatBox
        color={theme.color.border}
        display={pagerEntry ? undefined : 'none'}
        noBorder={!!pagerEntry && /^[╔╭┌]/.test(pagerEntry.pager.lines[0] ?? '')}
      >
        {pagerEntry && (
          <Box flexDirection="column" paddingX={1} paddingY={1}>
            {pagerEntry.pager.title && (
              <Box flexDirection="column" marginBottom={1}>
                {/* A24：标题行右侧 ✕ 关闭（此前仅 Esc/q） */}
                <Box flexDirection="row" justifyContent="space-between">
                  <Text bold color={theme.color.accent}>
                    {icon('diamond')} {pagerEntry.pager.title}
                  </Text>
                  <Box onClick={() => closeOverlay('pager')}>
                    <Text color={theme.color.muted}>{icon('close')}</Text>
                  </Box>
                </Box>
                {/* 分隔线：按可见行最大宽度（strip ANSI 后算宽，防止转义序列干扰） */}
                <Text color={theme.color.border}>
                  {'─'.repeat(
                    Math.max(
                      8,
                      ...pagerEntry.pager.lines
                        .slice(pagerEntry.pager.offset, pagerEntry.pager.offset + pagerPageSize)
                        .map(l => stringWidth(stripAnsi(l)) + 4)
                    )
                  )}
                </Text>
              </Box>
            )}

            {pagerEntry.pager.lines.slice(pagerEntry.pager.offset, pagerEntry.pager.offset + pagerPageSize).map((line, i) =>
              hasAnsi(line) ? (
                <Ansi key={i}>{sanitizeAnsiForRender(line)}</Ansi>
              ) : (
                <Text key={i}>{translateText(line)}</Text>
              )
            )}

            <Box flexDirection="row" marginTop={1}>
              {/* A22 鼠标化：翻页按钮（与 PgDn/b 同语义） */}
              <Box
                onClick={() =>
                  updateOverlay('pager', e => ({
                    ...e,
                    pager: { ...e.pager, offset: Math.max(0, e.pager.offset - pagerPageSize) }
                  }))
                }
              >
                <Text bold color={theme.color.accent}>
                  ◀ 上一页
                </Text>
              </Box>
              <Text color={theme.color.muted}>{'  '}</Text>
              <Box
                onClick={() =>
                  updateOverlay('pager', e => ({
                    ...e,
                    pager: {
                      ...e.pager,
                      offset: Math.min(e.pager.offset + pagerPageSize, Math.max(0, e.pager.lines.length - 1))
                    }
                  }))
                }
              >
                <Text bold color={theme.color.accent}>
                  下一页 ▶
                </Text>
              </Box>
              <Text>{'   '}</Text>
              <OverlayHint t={theme}>
                {(() => {
                  // 波 2 ③：[/] hunk 跳转提示（opencode diff-viewer.tsx:282-315 对标——
                  // 回滚 diff 等含 @@ hunk 的 pager 内容才显示，避免普通文本噪音）；
                  // 2026-08-19：结构化 diff 查看器再叠加 r 键逐 hunk 回滚提示
                  const hasHunks = pagerEntry.pager.lines.some(l => /^@@ -\d/.test(l.trim()))
                  const jump = hasHunks ? ' · [/] hunk 跳转' : ''
                  const revert = pagerEntry.pager.diff?.view === 'tree' ? '' : pagerEntry.pager.diff ? ' · r 回滚 · m 标记已审 · t 文件树' : ''
                  return pagerEntry.pager.offset + pagerPageSize < pagerEntry.pager.lines.length
                    ? `↑↓/jk 行 · Enter/Space/PgDn 页 · b/PgUp 返回 · g/G 顶/底${jump}${revert} · Esc/q 关闭（${Math.min(pagerEntry.pager.offset + pagerPageSize, pagerEntry.pager.lines.length)}/${pagerEntry.pager.lines.length} 行）`
                    : `已到末尾 · ↑↓/jk · b/PgUp 返回 · g 顶部${jump}${revert} · Esc/q 关闭（共 ${pagerEntry.pager.lines.length} 行）`
                })()}
              </OverlayHint>
            </Box>
          </Box>
        )}
      </FloatBox>

      <FloatBox color={theme.color.primary} display={completions.length ? undefined : 'none'}>
        {!!completions.length && (
          <Box flexDirection="column" width={Math.max(28, cols - 6)}>
            {/* A11：name/meta 两列对齐（参考同款 nameW）——meta 独立列，display 不抖动 */}
            {completions
              .slice(start, start + viewportSize)
              .reduce((acc: number, item) => Math.max(acc, item.display.length), 0) > 0 ? (
              (() => {
                const nameW = completions.slice(start, start + viewportSize).reduce((acc: number, item) => Math.max(acc, item.display.length), 0)

                return completions.slice(start, start + viewportSize).map((item, i) => {
                  const active = start + i === compIdx

                  return (
                    // A22 鼠标化：点击补全行 = 接受（与 Tab 同语义——文本并入输入区）
                    <Box
                      backgroundColor={active ? theme.color.completionCurrentBg : theme.color.completionBg}
                      flexDirection="row"
                      key={`${start + i}:${item.text}:${item.display}:${item.meta ?? ''}`}
                      onClick={() => onCompletionSelect(start + i)}
                      width="100%"
                    >
                      <Box flexShrink={0} width={nameW + 2}>
                        <Text bold color={theme.color.label}>
                          {' '}
                          {item.display}
                        </Text>
                      </Box>
                      {item.meta ? (
                        <Text
                          backgroundColor={active ? theme.color.completionMetaCurrentBg : theme.color.completionMetaBg}
                          color={theme.color.muted}
                          wrap="truncate-end"
                        >
                          {' '}
                          {item.meta}
                        </Text>
                      ) : null}
                    </Box>
                  )
                })
              })()
            ) : null}
            {completions.length > viewportSize && (
              <Text color={theme.color.muted}>
                {' '}
                {compIdx + 1}/{completions.length} · 上下键选择 · PgUp/PgDn 翻页
              </Text>
            )}
          </Box>
        )}
      </FloatBox>
    </Box>
  )
}

import { Ansi, Box, stringWidth, Text } from '@wxnodus/ink'
import { useAtom as useStore } from '../../app/stores/engine.js'

import { useGateway } from '../bridge/gatewayProvider.js'
import type { AppOverlaysProps } from '../bridge/interfaces.js'
import type { SecretRespondResponse, SudoRespondResponse } from '../gatewayTypes.js'
import { $overlayState, patchOverlayState } from '../runtime/promptStore.js'
import { $uiSessionId, $uiTheme } from '../runtime/viewStore.js'
import { hasAnsi, sanitizeAnsiForRender, stripAnsi } from '../lib/text.js'

import { ActiveSessionSwitcher } from './activeSessionSwitcher.js'
import { CommandPalette } from './commandPalette.js'
import { DirPicker } from './dirPicker.js'
import { FloatBox } from './appChrome.js'
import { MaskedPrompt } from './maskedPrompt.js'
import { ModelPicker } from './modelPicker.js'
import { OverlayHint } from './overlayControls.js'
import { PluginsHub } from './pluginsHub.js'
import { ApprovalPrompt, ClarifyPrompt, ConfirmPrompt } from './prompts.js'
import { DynamicFormPrompt } from './dynamicFormPrompt.js'
import { SkillsHub } from './skillsHub.js'
import { icon, translateText } from '../glyphs.js'

const COMPLETION_WINDOW = 16

export function PromptZone({
  cols,
  onApprovalChoice,
  onClarifyAnswer,
  onSecretSubmit,
  onSudoSubmit,
  onFormSubmit,
  onFormCancel
}: Pick<AppOverlaysProps, 'cols' | 'onApprovalChoice' | 'onClarifyAnswer' | 'onSecretSubmit' | 'onSudoSubmit' | 'onFormSubmit' | 'onFormCancel'>) {
  const overlay = useStore($overlayState)
  const theme = useStore($uiTheme)
  const { gw } = useGateway()

  // A24：sudo/secret 可点击取消（与 cancelOverlayFromCtrlC 同链路——空值 respond）
  const cancelSudo = () => {
    if (!overlay.sudo) return
    void gw
      .request<SudoRespondResponse>('sudo.respond', { password: '', request_id: overlay.sudo.requestId })
      .then(r => r && patchOverlayState({ sudo: null }))
  }

  const cancelSecret = () => {
    if (!overlay.secret) return
    void gw
      .request<SecretRespondResponse>('secret.respond', { request_id: overlay.secret.requestId, value: '' })
      .then(r => r && patchOverlayState({ secret: null }))
  }

  if (overlay.approval) {
    return (
      <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
        <ApprovalPrompt cols={cols} onChoice={onApprovalChoice} req={overlay.approval} t={theme} />
      </Box>
    )
  }

  if (overlay.confirm) {
    const req = overlay.confirm

    const onConfirm = () => {
      patchOverlayState({ confirm: null })
      req.onConfirm()
    }

    const onCancel = () => patchOverlayState({ confirm: null })

    return (
      <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
        <ConfirmPrompt onCancel={onCancel} onConfirm={onConfirm} req={req} t={theme} />
      </Box>
    )
  }

  if (overlay.clarify) {
    return (
      <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
        <ClarifyPrompt
          cols={cols}
          onAnswer={onClarifyAnswer}
          onCancel={() => onClarifyAnswer('')}
          req={overlay.clarify}
          t={theme}
        />
      </Box>
    )
  }

  if (overlay.sudo) {
    return (
      <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
          <MaskedPrompt cols={cols} icon={icon('lock')} label="需要 sudo 密码" onCancel={cancelSudo} onSubmit={onSudoSubmit} t={theme} />
      </Box>
    )
  }

  if (overlay.secret) {
    return (
      <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
        <MaskedPrompt
          cols={cols}
          icon={icon('key')}
          label={overlay.secret.prompt}
          onCancel={cancelSecret}
          onSubmit={onSecretSubmit}
          sub={`环境变量：${overlay.secret.envVar}`}
          t={theme}
        />
      </Box>
    )
  }

  // 动态内容表（多字段敏感输入——/input 与 credential_form 工具）
  if (overlay.form) {
    return (
      <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
        <DynamicFormPrompt
          cols={cols}
          fields={overlay.form.fields}
          prompt={overlay.form.prompt}
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
  onModelSelect,
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
  | 'onModelSelect'
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
      <FloatBox color={theme.color.border} display={overlay.sessions ? undefined : 'none'}>
        {overlay.sessions && (
          <ActiveSessionSwitcher
            currentSessionId={sid}
            gw={gw}
            onCancel={() => patchOverlayState({ sessions: false })}
            onClose={onActiveSessionClose}
            onNew={onNewLiveSession}
            onNewPrompt={onNewPromptSession}
            onResume={onResumeSelect}
            onSelect={onActiveSessionSelect}
            t={theme}
          />
        )}
      </FloatBox>

      <FloatBox color={theme.color.border} display={overlay.modelPicker ? undefined : 'none'}>
        {overlay.modelPicker && (
          <ModelPicker
            gw={gw}
            onCancel={() => patchOverlayState({ modelPicker: false })}
            onSelect={onModelSelect}
            sessionId={sid}
            t={theme}
          />
        )}
      </FloatBox>

      <FloatBox color={theme.color.border} display={overlay.skillsHub ? undefined : 'none'}>
        {overlay.skillsHub && <SkillsHub gw={gw} onClose={() => patchOverlayState({ skillsHub: false })} t={theme} />}
      </FloatBox>

      <FloatBox color={theme.color.border} display={overlay.commandPalette ? undefined : 'none'}>
        {overlay.commandPalette && (
          <CommandPalette
            cols={cols}
            currentSessionId={sid}
            gw={gw}
            onClose={() => patchOverlayState({ commandPalette: false })}
            onSessionSelect={onActiveSessionSelect}
            onSubmit={onPaletteSubmit}
            t={theme}
          />
        )}
      </FloatBox>

      <FloatBox color={theme.color.border} display={overlay.pluginsHub ? undefined : 'none'}>
        {overlay.pluginsHub && <PluginsHub gw={gw} onClose={() => patchOverlayState({ pluginsHub: false })} t={theme} />}
      </FloatBox>

      {/* A24：目录选择器（点击状态栏 cwd 打开——浏览/切换工作目录） */}
      <FloatBox color={theme.color.border} display={overlay.dirPicker ? undefined : 'none'}>
        {overlay.dirPicker && <DirPicker t={theme} />}
      </FloatBox>

      {/* pager：内容首行自带 box-drawing 边框（╔╭┌ lines() 面板）时外层去边框——
          避免双边框叠加（修复 /help 双层壁）；否则 double 边框兜底 */}
      <FloatBox
        color={theme.color.border}
        display={overlay.pager ? undefined : 'none'}
        noBorder={!!overlay.pager && /^[╔╭┌]/.test(overlay.pager.lines[0] ?? '')}
      >
        {overlay.pager && (
          <Box flexDirection="column" paddingX={1} paddingY={1}>
            {overlay.pager.title && (
              <Box flexDirection="column" marginBottom={1}>
                {/* A24：标题行右侧 ✕ 关闭（此前仅 Esc/q） */}
                <Box flexDirection="row" justifyContent="space-between">
                  <Text bold color={theme.color.accent}>
                    {icon('diamond')} {overlay.pager.title}
                  </Text>
                  <Box onClick={() => patchOverlayState({ pager: null })}>
                    <Text color={theme.color.muted}>{icon('close')}</Text>
                  </Box>
                </Box>
                {/* 分隔线：按可见行最大宽度（strip ANSI 后算宽，防止转义序列干扰） */}
                <Text color={theme.color.border}>
                  {'─'.repeat(
                    Math.max(
                      8,
                      ...overlay.pager.lines
                        .slice(overlay.pager.offset, overlay.pager.offset + pagerPageSize)
                        .map(l => stringWidth(stripAnsi(l)) + 4)
                    )
                  )}
                </Text>
              </Box>
            )}

            {overlay.pager.lines.slice(overlay.pager.offset, overlay.pager.offset + pagerPageSize).map((line, i) =>
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
                  patchOverlayState({
                    pager: { ...overlay.pager!, offset: Math.max(0, overlay.pager!.offset - pagerPageSize) }
                  })
                }
              >
                <Text bold color={theme.color.accent}>
                  ◀ 上一页
                </Text>
              </Box>
              <Text color={theme.color.muted}>{'  '}</Text>
              <Box
                onClick={() =>
                  patchOverlayState({
                    pager: {
                      ...overlay.pager!,
                      offset: Math.min(overlay.pager!.offset + pagerPageSize, Math.max(0, overlay.pager!.lines.length - 1))
                    }
                  })
                }
              >
                <Text bold color={theme.color.accent}>
                  下一页 ▶
                </Text>
              </Box>
              <Text>{'   '}</Text>
              <OverlayHint t={theme}>
                {overlay.pager.offset + pagerPageSize < overlay.pager.lines.length
                  ? `↑↓/jk 行 · Enter/Space/PgDn 页 · b/PgUp 返回 · g/G 顶/底 · Esc/q 关闭（${Math.min(overlay.pager.offset + pagerPageSize, overlay.pager.lines.length)}/${overlay.pager.lines.length} 行）`
                  : `已到末尾 · ↑↓/jk · b/PgUp 返回 · g 顶部 · Esc/q 关闭（共 ${overlay.pager.lines.length} 行）`}
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

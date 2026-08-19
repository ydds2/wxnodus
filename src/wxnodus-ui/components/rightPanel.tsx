// src/wxnodus-ui/components/rightPanel.tsx — P2 右分栏（2026-08-20）
// 面板组（config/model/skills/plugins——互斥组保证至多 1 个）迁出浮层：
// 宽窗（≥80 列）渲染为右侧分栏（宽度 min(40, cols-50%)，不遮转录流）；
// 小窗降级为全宽块（appLayout 负责布局位；本组件纯渲染）。
// 渲染与既有 FloatBox 版逐 prop 对齐（gw/sid/onSelect/onClose 同源）。
import { Box } from '@wxnodus/ink'
import { useAtom as useStore } from '../../app/stores/engine.js'

import { useGateway } from '../bridge/gatewayProvider.js'
import { $overlayState, closeOverlay } from '../runtime/promptStore.js'
import { findPanelKind } from '../runtime/overlayStack.js'
import { $uiSessionId, $uiTheme } from '../runtime/viewStore.js'

import { ConfigPanel } from './configPanel.js'
import { ModelPicker } from './modelPicker.js'
import { SkillsHub } from './skillsHub.js'
import { PluginsHub } from './pluginsHub.js'

export function RightPanelPane({
  onModelSelect,
  width
}: {
  onModelSelect: (value: string) => void
  width: number
}) {
  const { gw } = useGateway()
  const overlay = useStore($overlayState)
  const sid = useStore($uiSessionId)
  const theme = useStore($uiTheme)

  const kind = findPanelKind(overlay)
  if (!kind) {
    return null
  }

  return (
    <Box
      borderColor={theme.color.border}
      borderStyle="single"
      flexDirection="column"
      flexShrink={0}
      paddingX={1}
      width={width}
    >
      {kind === 'configPanel' && <ConfigPanel gw={gw} onClose={() => closeOverlay('configPanel')} t={theme} />}
      {kind === 'modelPicker' && (
        <ModelPicker
          gw={gw}
          onCancel={() => closeOverlay('modelPicker')}
          onSelect={onModelSelect}
          sessionId={sid}
          t={theme}
        />
      )}
      {kind === 'skillsHub' && <SkillsHub gw={gw} onClose={() => closeOverlay('skillsHub')} t={theme} />}
      {kind === 'pluginsHub' && <PluginsHub gw={gw} onClose={() => closeOverlay('pluginsHub')} t={theme} />}
    </Box>
  )
}

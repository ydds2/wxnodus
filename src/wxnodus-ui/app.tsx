// src/wxnodus-ui/app.tsx — TUI 根组件装配（provider/布局/输入处理组合）
import { useAtom as useStore } from '../app/stores/engine.js'

import { GatewayProvider } from './bridge/gatewayProvider.js'
import { $uiState } from './runtime/viewStore.js'
import { useMainApp } from './hooks/useSessionShell.js'
import { AppLayout } from './components/appLayout.js'
import type { GatewayClient } from './gatewayClient.js'

export function App({ gw }: { gw: GatewayClient }) {
  const { appActions, appComposer, appProgress, appStatus, appTranscript, gateway } = useMainApp(gw)
  const { mouseTracking } = useStore($uiState)

  return (
    <GatewayProvider value={gateway}>
      <AppLayout
        actions={appActions}
        composer={appComposer}
        mouseTracking={mouseTracking}
        progress={appProgress}
        status={appStatus}
        transcript={appTranscript}
      />
    </GatewayProvider>
  )
}

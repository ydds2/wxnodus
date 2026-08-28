import type { PanelSection } from '../types.js'

export const SETUP_REQUIRED_TITLE = '需要配置模型提供方'

export const buildSetupRequiredSections = (): PanelSection[] => [
  {
    text: 'WxNodus 需要先配置模型密钥才能开始会话。'
  },
  {
    rows: [
      ['/model', '就地配置提供方 + 模型'],
      ['/setup', '运行完整首次设置向导'],
      ['Ctrl+C', '退出后手动运行设置']
    ],
    title: '操作'
  }
]

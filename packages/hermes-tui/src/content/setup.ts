import type { PanelSection } from '../types.js'

export const SETUP_REQUIRED_TITLE = '需要初始配置'

export const buildSetupRequiredSections = (): PanelSection[] => [
  {
    text: 'WxNodus 需要先配置模型提供方，才能开始会话。'
  },
  {
    rows: [
      ['/model', '就地配置提供方与模型（含添加自定义接口）'],
      ['/setup', '运行完整首次配置向导'],
      ['Ctrl+C', '退出后在命令行运行 wxnodus /model set-key 手动配置']
    ],
    title: '可用操作'
  }
]

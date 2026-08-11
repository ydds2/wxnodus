import { isMac, isRemoteShell } from '../lib/platform.js'

const action = isMac ? 'Cmd' : 'Ctrl'
const paste = isMac ? 'Cmd' : 'Alt'

const copyHotkeys: [string, string][] = isMac
  ? [
      ['Cmd+C', '复制所选'],
      ['Ctrl+C', '中断 / 清空草稿 / 退出']
    ]
  : isRemoteShell()
    ? [
        ['Cmd+C', '由终端转发时复制所选'],
        ['Ctrl+C', '复制所选 / 中断 / 清空草稿 / 退出']
      ]
    : [['Ctrl+C', '复制所选 / 中断 / 清空草稿 / 退出']]

export const HOTKEYS: [string, string][] = [
  ...copyHotkeys,
  [action + '+D', '退出'],
  [action + '+G / Alt+G', '打开 $EDITOR（VSCode/Cursor 用 Alt+G 兜底）'],
  [action + '+L', '重绘界面'],
  [action + '+O', '打开模型选择器（保留草稿）'],
  ['Alt+D / Option+D', '切换右侧详情面板（双栏布局：清单/工具/上下文/子代理）'],
  [paste + '+V / /paste', '粘贴文本；/paste 附带剪贴板图片'],
  ['Tab', '应用补全'],
  ['↑/↓', '补全候选 / 队列编辑 / 历史'],
  ['Ctrl+X', '打开会话切换器（编辑中删除排队消息）'],
  [action + '+A/E', '行首 / 行尾'],
  [action + '+Z / ' + action + '+Y', '撤销 / 重做输入编辑'],
  [action + '+W', '删除单词'],
  [action + '+U/K', '删除到行首 / 行尾'],
  [action + '+←/→', '按词跳转'],
  ['Home/End', '行首 / 行尾'],
  ['Shift+Enter / Alt+Enter', '插入换行'],
  ['\\+Enter', '多行续行（兜底）'],
  ['!<cmd>', '运行 shell 命令（如 !ls、!git status）'],
  ['{!<cmd>}', '行内插入 shell 输出（如 "分支是 {!git branch --show-current}"）']
]

import io

def rd(p):
    return io.open(p, encoding='utf-8').read()

def wr(p, t):
    io.open(p, 'w', encoding='utf-8', newline='\n').write(t)

def rep(path, old, new, label):
    t = rd(path)
    assert old in t, f'MISS {path}: {label}'
    assert t.count(old) == 1, f'MULTI {path}: {label}'
    wr(path, t.replace(old, new))
    print('OK', path, label)

GUARD_IMPORTS = "import { topEntry } from '../runtime/overlayStack.js'\nimport { getOverlayState } from '../runtime/promptStore.js'"

# 1) dirPicker：Esc=上级目录导航（分层语义）——非栈顶时 Esc 归顶层
rep('src/wxnodus-ui/components/dirPicker.tsx',
    "import { closeOverlay } from '../runtime/promptStore.js'",
    "import { closeOverlay, getOverlayState } from '../runtime/promptStore.js'\nimport { topEntry } from '../runtime/overlayStack.js'",
    'imports')
rep('src/wxnodus-ui/components/dirPicker.tsx',
    """  useInput((ch, key) => {
    if (key.escape) {
      const parent = parentOf(path)""",
    """  useInput((ch, key) => {
    // P1 收尾：Esc 仅当本选择器为栈顶时消费——pager/工作台盖在上方时 Esc 归顶层
    // （防一次 Esc 弹两层 / 静默改内部目录状态）
    if (key.escape && topEntry(getOverlayState())?.kind !== 'dirPicker') {
      return
    }
    if (key.escape) {
      const parent = parentOf(path)""",
    'guard')

# 2) configPanel：Esc=close（纯关闭）——非栈顶时让位
rep('src/wxnodus-ui/components/configPanel.tsx',
    "import { Box, Text } from '@wxnodus/ink'",
    "import { Box, Text } from '@wxnodus/ink'\nimport { topEntry } from '../runtime/overlayStack.js'\nimport { getOverlayState } from '../runtime/promptStore.js'",
    'imports')
rep('src/wxnodus-ui/components/configPanel.tsx',
    """  useInput((_input, key) => {
    const r = handleConfigPanelKey(state, { upArrow: key.upArrow, downArrow: key.downArrow, return: key.return, escape: key.escape }, rows.length)""",
    """  useInput((_input, key) => {
    // P1 收尾：Esc 仅当本面板为栈顶时消费（防一次 Esc 弹两层）
    if (key.escape && topEntry(getOverlayState())?.kind !== 'configPanel') {
      return
    }
    const r = handleConfigPanelKey(state, { upArrow: key.upArrow, downArrow: key.downArrow, return: key.return, escape: key.escape }, rows.length)""",
    'guard')

# 3) commandPalette：Esc/ctrl+c=close——非栈顶让位
rep('src/wxnodus-ui/components/commandPalette.tsx',
    "import { Box, Text } from '@wxnodus/ink'",
    "import { Box, Text } from '@wxnodus/ink'\nimport { topEntry } from '../runtime/overlayStack.js'\nimport { getOverlayState } from '../runtime/promptStore.js'",
    'imports')
rep('src/wxnodus-ui/components/commandPalette.tsx',
    """  useInput((ch, key) => {
    if (key.escape || (key.ctrl && ch.toLowerCase() === 'c')) {
      onClose()
      return
    }""",
    """  useInput((ch, key) => {
    // P1 收尾：Esc/Ctrl+C 仅当本面板为栈顶时消费（防一次 Esc 弹两层）
    if ((key.escape || (key.ctrl && ch.toLowerCase() === 'c')) && topEntry(getOverlayState())?.kind !== 'commandPalette') {
      return
    }
    if (key.escape || (key.ctrl && ch.toLowerCase() === 'c')) {
      onClose()
      return
    }""",
    'guard')

# 4) historySearch：Esc/ctrl+c=cancel——非栈顶让位
rep('src/wxnodus-ui/components/historySearch.tsx',
    "import { Box, Text } from '@wxnodus/ink'",
    "import { Box, Text } from '@wxnodus/ink'\nimport { topEntry } from '../runtime/overlayStack.js'\nimport { getOverlayState } from '../runtime/promptStore.js'",
    'imports')
rep('src/wxnodus-ui/components/historySearch.tsx',
    """  useInput((ch, key) => {
    if (key.escape || (key.ctrl && ch === 'c')) {
      onCancel()
      return
    }""",
    """  useInput((ch, key) => {
    // P1 收尾：Esc/Ctrl+C 仅当本面板为栈顶时消费（防一次 Esc 弹两层）
    if ((key.escape || (key.ctrl && ch === 'c')) && topEntry(getOverlayState())?.kind !== 'histSearch') {
      return
    }
    if (key.escape || (key.ctrl && ch === 'c')) {
      onCancel()
      return
    }""",
    'guard')

# 5) modelPicker：Esc 分层语义（断开确认回列表 / 列表级 back）——非栈顶时 Esc 归顶层
rep('src/wxnodus-ui/components/modelPicker.tsx',
    "import { Box, Text } from '@wxnodus/ink'",
    "import { Box, Text } from '@wxnodus/ink'\nimport { topEntry } from '../runtime/overlayStack.js'\nimport { getOverlayState } from '../runtime/promptStore.js'",
    'imports')
rep('src/wxnodus-ui/components/modelPicker.tsx',
    """  useInput((ch, key) => {
    // Disconnect confirmation stage""",
    """  useInput((ch, key) => {
    // P1 收尾：Esc 仅当本面板为栈顶时消费——pager/工作台盖在上方时 Esc 归顶层
    // （防一次 Esc 弹两层 / 静默改内部 stage 状态）
    if (key.escape && topEntry(getOverlayState())?.kind !== 'modelPicker') {
      return
    }
    // Disconnect confirmation stage""",
    'guard')

# 6) agentsOverlay 两处：Esc/q 关闭语义——非栈顶让位
rep('src/wxnodus-ui/components/agentsOverlay.tsx',
    "import { closeOverlay, pushOverlay } from '../runtime/promptStore.js'",
    "import { closeOverlay, getOverlayState, pushOverlay } from '../runtime/promptStore.js'\nimport { topEntry } from '../runtime/overlayStack.js'",
    'imports')
rep('src/wxnodus-ui/components/agentsOverlay.tsx',
    """  useInput((ch, key) => {
    if (key.escape || ch === 'q') {
      onClose()
    }
  })""",
    """  useInput((ch, key) => {
    // P1 收尾：Esc/q 仅当本浮层为栈顶时消费（防一次 Esc 弹两层）
    if ((key.escape || ch === 'q') && topEntry(getOverlayState())?.kind !== 'agents') {
      return
    }
    if (key.escape || ch === 'q') {
      onClose()
    }
  })""",
    'guard 651')
rep('src/wxnodus-ui/components/agentsOverlay.tsx',
    """  useInput((ch, key) => {
    if (ch === 'q') {
      return closeWithCleanup()
    }

    if (key.escape) {
      return mode === 'detail' ? setMode('list') : closeWithCleanup()
    }""",
    """  useInput((ch, key) => {
    // P1 收尾：Esc/q 仅当本浮层为栈顶时消费（防一次 Esc 弹两层 / 静默改内部 mode）
    if ((key.escape || ch === 'q') && topEntry(getOverlayState())?.kind !== 'agents') {
      return
    }
    if (ch === 'q') {
      return closeWithCleanup()
    }

    if (key.escape) {
      return mode === 'detail' ? setMode('list') : closeWithCleanup()
    }""",
    'guard 861')

# 7) activeSessionSwitcher：Esc 仅栈顶消费（过滤态 Esc 属本层，同样受门控保护）
rep('src/wxnodus-ui/components/activeSessionSwitcher.tsx',
    "import { filterSessionRows } from '../lib/sessionFilter.js'",
    "import { filterSessionRows } from '../lib/sessionFilter.js'\nimport { topEntry } from '../runtime/overlayStack.js'\nimport { getOverlayState } from '../runtime/promptStore.js'",
    'imports')
rep('src/wxnodus-ui/components/activeSessionSwitcher.tsx',
    """    const lower = ch?.toLowerCase() ?? ''
    const isCtrl = (letter: string) => key.ctrl && (lower === letter || ch === ctrlChar(letter))

    // P1 收尾：/ 进入过滤态""",
    """    const lower = ch?.toLowerCase() ?? ''
    const isCtrl = (letter: string) => key.ctrl && (lower === letter || ch === ctrlChar(letter))

    // P1 收尾：Esc 仅当本选择器为栈顶时消费——pager/工作台盖在上方时 Esc 归顶层
    if (key.escape && topEntry(getOverlayState())?.kind !== 'sessions') {
      return
    }

    // P1 收尾：/ 进入过滤态""",
    'guard')

print('DONE esc guards')

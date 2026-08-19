import io

def rd(p):
    return io.open(p, encoding='utf-8').read()

def wr(p, t):
    io.open(p, 'w', encoding='utf-8', newline='\n').write(t)

# 1) textInput: 移除已无引用的 editorLaunch import
P = 'src/wxnodus-ui/components/textInput.tsx'
t = rd(P)
old = "import { resolveEditorCommand, runExternalEditor } from '../lib/editorLaunch.js'\n"
assert old in t
t = t.replace(old, '')
wr(P, t)
print('OK textInput import')

# 2) vimMode.ts: NORMAL 激活标志
P = 'src/wxnodus-ui/config/vimMode.ts'
t = rd(P)
add = """

// ── vim NORMAL 激活标志（P1 裁决 2026-08-20）：textInput 在模态变化时同步；
// useKeyBindings 消费——Ctrl+R 历史搜索在 vim NORMAL 下让位 vim redo（双触发裁决，
// keymap registry diagnoseKeymap 实测证据：global.history × vim.redo）。
let VIM_NORMAL_ACTIVE = false

/** vim 模态变化时由 textInput 同步（mode !== 'insert' 即 NORMAL/VISUAL 激活） */
export function setVimNormalActive(active: boolean): void {
  VIM_NORMAL_ACTIVE = active
}

export function getVimNormalActive(): boolean {
  return VIM_NORMAL_ACTIVE
}
"""
t = t.rstrip() + '\n' + add
wr(P, t)
print('OK vimMode flag')

# 3) textInput: 模态变化同步标志（两处 setVimModeUi）
P = 'src/wxnodus-ui/components/textInput.tsx'
t = rd(P)
import re
m = re.search(r"import \{([^}]*)\} from '\.\./config/vimMode\.js'", t)
assert m, 'vimMode import not found'
t = t.replace(m.group(0), "import { getVimModeEnabled, setVimNormalActive } from '../config/vimMode.js'")
n1 = t.count('          setVimModeUi(esc.state.mode)\n          setVimNormalActive(esc.state.mode !== \'insert\')')
if n1 == 0:
    old1 = '          setVimModeUi(esc.state.mode)\n'
    assert old1 in t, 'esc setVimModeUi site missing'
    t = t.replace(old1, "          setVimModeUi(esc.state.mode)\n          setVimNormalActive(esc.state.mode !== 'insert')\n")
old2 = '        setVimModeUi(out.state.mode)\n'
assert old2 in t, 'out setVimModeUi site missing'
t = t.replace(old2, "        setVimModeUi(out.state.mode)\n        setVimNormalActive(out.state.mode !== 'insert')\n")
wr(P, t)
print('OK textInput sync sites')

# 4) useKeyBindings: Ctrl+R 门控
P = 'src/wxnodus-ui/hooks/useKeyBindings.ts'
t = rd(P)
old = "import { getActiveKeymap, matchesAny } from '../config/keymap.js'"
assert old in t
t = t.replace(old, "import { getActiveKeymap, matchesAny } from '../config/keymap.js'\nimport { getVimNormalActive } from '../config/vimMode.js'")
old = """      // Ctrl+R：历史反向搜索（bash readline 同款）——overlay 阻断 composer 输入，
      // 搜索组件自身 useInput 消费字符/Ctrl+R/Enter/Esc；此处只负责打开
      if (isCtrl(key, ch, 'r') && !findEntry(overlay, 'histSearch') && !cState.historyIdx) {
        return pushOverlay({ kind: 'histSearch' })
      }"""
new = """      // Ctrl+R：历史反向搜索（bash readline 同款）——overlay 阻断 composer 输入，
      // 搜索组件自身 useInput 消费字符/Ctrl+R/Enter/Esc；此处只负责打开。
      // P1 裁决：vim NORMAL 下 Ctrl+R 是 redo（vimHandleKey 消费）——门控让位，消除双触发
      if (isCtrl(key, ch, 'r') && !getVimNormalActive() && !findEntry(overlay, 'histSearch') && !cState.historyIdx) {
        return pushOverlay({ kind: 'histSearch' })
      }"""
assert old in t
t = t.replace(old, new)
wr(P, t)
print('OK useKeyBindings gate')

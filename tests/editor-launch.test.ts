// tests/editor-launch.test.ts — ② 波 1：外部编辑器探测链与临时文件往返（kimi editor.py:18-50 / crush ui.go:3688-3725 对标）
import { describe, expect, it } from 'vitest'
import { resolveEditorCommand, runExternalEditor } from '../src/wxnodus-ui/lib/editorLaunch.js'

// 真 spawn 假编辑器：node -e 脚本向 argv[1]（临时文件）追加标记——验证往返链路
const FAKE_EDITOR = ['node', '-e', "require('fs').appendFileSync(process.argv[1], ' EDITOR_ADDED')"]

describe('resolveEditorCommand（探测链）', () => {
  it('$VISUAL 优先于 $EDITOR；命令串按空白切分', () => {
    expect(resolveEditorCommand({ VISUAL: 'vim -u NONE', EDITOR: 'nano', platform: 'linux' })).toEqual(['vim', '-u', 'NONE'])
    expect(resolveEditorCommand({ EDITOR: 'code --wait', platform: 'linux' })).toEqual(['code', '--wait'])
  })

  it('都未配置 → 系统默认（win32 code --wait / 其余 vi；code 缺失由降级链兜底 notepad）', () => {
    expect(resolveEditorCommand({ platform: 'win32' })).toEqual(['code', '--wait'])
    expect(resolveEditorCommand({ platform: 'linux' })).toEqual(['vi'])
  })
})

describe('runExternalEditor（临时文件往返）', () => {
  it('真实往返：草稿写临时文件 → 假编辑器追加 → 读回（CRLF 归一）', () => {
    const res = runExternalEditor({ command: FAKE_EDITOR, text: 'hello\nworld\r\n' })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.text).toBe('hello\nworld\n EDITOR_ADDED')
  })

  it('编辑器不存在（ENOENT）→ 走降级链成功', () => {
    const res = runExternalEditor({
      command: ['definitely-missing-editor-xyz'],
      fallback: [FAKE_EDITOR],
      text: 'draft',
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.text).toBe('draft EDITOR_ADDED')
  })

  it('全部候选失败 → 诚实返回 error（调用方保留草稿）', () => {
    const res = runExternalEditor({
      command: ['definitely-missing-editor-xyz'],
      fallback: [['also-missing-editor-abc']],
      text: 'draft-kept',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('未找到可用编辑器')
  })

  it('编辑器不改文件（用户直接退出）→ 原草稿返回', () => {
    const res = runExternalEditor({
      command: ['node', '-e', '/* no-op */'],
      text: 'unchanged',
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.text).toBe('unchanged')
  })
})

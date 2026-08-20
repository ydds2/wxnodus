// tests/vim-command.test.ts — 波 3 ②：/vim 命令切换 settings.vimMode（gemini vimCommand.ts:9-19 对标）
import { describe, expect, it } from 'vitest'
import { createCommandBus } from '../src/app/CommandBus.js'
import { registerProfileMemoryBuildCommands } from '../src/commands/ext/profileMemoryBuildCommands.js'

describe('/vim 切换 vim 模态开关', () => {
  it('开→关 两次切换落盘 settings.vimMode（配置水合数据源）', async () => {
    const settings: Record<string, unknown> = { lang: 'zh' }
    const bus = createCommandBus()
    const ctx = {
      config: {
        get: () => settings,
        getKey: () => undefined,
        setKey: (_p: string, k: string, v: unknown) => { settings[k] = v },
      },
      db: undefined,
    } as any
    registerProfileMemoryBuildCommands(bus as any, ctx)

    const on = await (bus as any).execute('/vim')
    expect(on.output).toContain('已开启 vim 模态编辑')
    expect(settings.vimMode).toBe(true)

    const off = await (bus as any).execute('/vim')
    expect(off.output).toContain('已关闭')
    expect(settings.vimMode).toBe(false)
  })
})

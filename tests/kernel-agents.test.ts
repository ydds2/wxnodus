// tests/kernel-agents.test.ts — P0-2 自定义 agent 定义：frontmatter 解析 + 双目录加载/覆盖
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadAgentDefs, findAgentDef } from '../src/kernel/agents.js'

let dir = ''

function setup(): string {
  dir = mkdtempSync(join(tmpdir(), 'wx-agents-'))
  return dir
}

afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} })

const GOOD_MD = `---
name: reviewer
description: 代码审查
mode: plan
tools: [fs_read, grep]
---
你是审查专家。
`

describe('loadAgentDefs — 自定义 agent 定义', () => {
  it('解析 frontmatter + 正文指令；工具白名单/模式生效', () => {
    const d = setup()
    mkdirSync(join(d, '.wxnodus', 'agents'), { recursive: true })
    writeFileSync(join(d, '.wxnodus', 'agents', 'reviewer.md'), GOOD_MD, 'utf8')
    const defs = loadAgentDefs(d, join(d, 'data'))
    expect(defs.length).toBe(1)
    expect(defs[0]).toMatchObject({
      name: 'reviewer',
      description: '代码审查',
      mode: 'plan',
      tools: ['fs_read', 'grep'],
      instructions: '你是审查专家。',
    })
  })

  it('项目级覆盖用户级同名 agent；非法文件跳过', () => {
    const d = setup()
    mkdirSync(join(d, '.wxnodus', 'agents'), { recursive: true })
    mkdirSync(join(d, 'data', 'agents'), { recursive: true })
    writeFileSync(join(d, 'data', 'agents', 'dup.md'), '---\nname: dup\ndescription: 用户级\n---\n用户指令', 'utf8')
    writeFileSync(join(d, '.wxnodus', 'agents', 'dup.md'), '---\nname: dup\ndescription: 项目级\n---\n项目指令', 'utf8')
    writeFileSync(join(d, '.wxnodus', 'agents', 'bad.md'), 'no frontmatter', 'utf8') // 非法跳过
    const defs = loadAgentDefs(d, join(d, 'data'))
    expect(defs.length).toBe(1)
    expect(defs[0]!.description).toBe('项目级')
    expect(defs[0]!.instructions).toBe('项目指令')
  })

  it('无 tools 字段 → 只读子代理集（tools undefined）', () => {
    const d = setup()
    mkdirSync(join(d, '.wxnodus', 'agents'), { recursive: true })
    writeFileSync(join(d, '.wxnodus', 'agents', 'plain.md'), '---\nname: plain\ndescription: x\n---\n正文', 'utf8')
    expect(loadAgentDefs(d, join(d, 'data'))[0]!.tools).toBeUndefined()
  })

  it('findAgentDef 按名查找；不存在返回 null', () => {
    const d = setup()
    mkdirSync(join(d, '.wxnodus', 'agents'), { recursive: true })
    writeFileSync(join(d, '.wxnodus', 'agents', 'reviewer.md'), GOOD_MD, 'utf8')
    expect(findAgentDef('reviewer', d, join(d, 'data'))?.name).toBe('reviewer')
    expect(findAgentDef('nope', d, join(d, 'data'))).toBeNull()
  })
})

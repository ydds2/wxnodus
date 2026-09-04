// tests/cli-surface-copy.test.ts — 文案防漂移（A5，2026-09-04）
// 锁定 CLI 表面文案单一事实源：--help 头版本、package.json description、README 关键承诺行、
// user-guide 命令表与 SLASH 动态一致、QUICK /help 计数——任何漂移即红（治本，杜绝 V3 残留类缺陷复发）。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SLASH } from '../src/commands/registry.js'
import { QUICK_COMMANDS } from '../src/tui/commands.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

describe('CLI 表面文案防漂移（A5）', () => {
  it('--help 头为 V4 且列全已实现旗标（V3 残留即红）', () => {
    const usage = read('src/cli/args.ts')
    expect(usage).toContain('WxNodus V4')
    expect(usage).not.toContain('WxNodus V3')
    for (const f of ['--data-dir', '--workspace', '--output-schema', '--ephemeral']) expect(usage).toContain(f)
  })

  it('--help 真实输出面（i18n cli.usage 双语目录）同步 V4（args.ts 与目录双锁）', () => {
    for (const p of ['src/application/i18n/catalogs/zh-CN.ts', 'src/application/i18n/catalogs/en.ts']) {
      const usage = read(p)
      expect(usage, p).toContain('WxNodus V4')
      expect(usage, p).not.toContain('WxNodus V3')
      for (const f of ['--data-dir', '--workspace', '--output-schema', '--ephemeral']) expect(usage, p).toContain(f)
    }
  })

  it('package.json description 为 V4', () => {
    const pkg = JSON.parse(read('package.json')) as { description: string }
    expect(pkg.description).toContain('V4')
    expect(pkg.description).not.toContain('V3')
  })

  it('README「算一下」行标注 legacy 开关（承诺与默认行为一致）', () => {
    const line = read('README.md').split('\n').find(l => l.includes('算一下 2+3*4'))
    expect(line).toBeTruthy()
    expect(line).toContain('WXNODUS_LEGACY_OFFLINE=1')
  })

  it('user-guide 命令表行数 = SLASH 全集（动态一致——漂移即红）', () => {
    const rows = read('docs/user-guide.md').split('\n').filter(l => /^\|\s*`\/[a-z0-9-]+`/.test(l))
    expect(rows.length).toBe(SLASH.length)
  })

  it('QUICK /help desc 计数与 SLASH 动态一致', () => {
    const help = QUICK_COMMANDS.find(c => c.cmd === '/help')
    expect(help).toBeTruthy()
    expect(help!.desc).toContain(String(SLASH.length))
  })
})

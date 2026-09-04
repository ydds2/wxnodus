// tests/semver-range.test.ts — 版本范围匹配（2026-09-03 · P3b）纯函数契约
// Minecraft modpack targetWxnodus 兼容矩阵：比较符/通配/^/~/精确/多 token AND；非法输入 fail-closed。
import { describe, it, expect } from 'vitest'
import { parseVersion, versionInRange } from '../src/kernel/semverRange.js'

describe('parseVersion', () => {
  it('标准三段 + v 前缀 + 缺省补零', () => {
    expect(parseVersion('4.0.2')).toEqual([4, 0, 2])
    expect(parseVersion('v4.0')).toEqual([4, 0, 0])
    expect(parseVersion('4')).toEqual([4, 0, 0])
    expect(parseVersion('abc')).toBeNull()
  })
})

describe('versionInRange（兼容矩阵）', () => {
  it('比较符：>=4.0.2 <5', () => {
    expect(versionInRange('4.0.2', '>=4.0.2 <5')).toBe(true)
    expect(versionInRange('4.9.9', '>=4.0.2 <5')).toBe(true)
    expect(versionInRange('4.0.1', '>=4.0.2 <5')).toBe(false)
    expect(versionInRange('5.0.0', '>=4.0.2 <5')).toBe(false)
  })
  it('通配：4.0.x / 4.x', () => {
    expect(versionInRange('4.0.7', '4.0.x')).toBe(true)
    expect(versionInRange('4.1.0', '4.0.x')).toBe(false)
    expect(versionInRange('4.3.1', '4.x')).toBe(true)
    expect(versionInRange('5.0.0', '4.x')).toBe(false)
  })
  it('^ 主版本兼容 / ~ 次版本锁定', () => {
    expect(versionInRange('4.5.0', '^4.0.0')).toBe(true)
    expect(versionInRange('5.0.0', '^4.0.0')).toBe(false)
    expect(versionInRange('1.2.9', '~1.2.3')).toBe(true)
    expect(versionInRange('1.3.0', '~1.2.3')).toBe(false)
  })
  it('精确版本与 *', () => {
    expect(versionInRange('4.0.2', '4.0.2')).toBe(true)
    expect(versionInRange('4.0.3', '4.0.2')).toBe(false)
    expect(versionInRange('0.0.1', '*')).toBe(true)
  })
  it('非法 token → false（fail-closed——不兼容绝不带病安装）', () => {
    expect(versionInRange('4.0.2', '>>4.0.0')).toBe(false)
    expect(versionInRange('4.0.2', '')).toBe(false)
    expect(versionInRange('not-a-version', '>=4.0.0')).toBe(false)
  })
})

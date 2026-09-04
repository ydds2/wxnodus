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

// K2（2026-09-04）：版本解析统一出口——两调用方与 parseVersion 的行为一致性契约。
// selfUpdate.isNewerVersion / bundle.bundleVersionOk 主三段解析已切至 parseVersion；
// 预发布/fail 方向差异是业务语义（更新比对 fail-closed vs 兼容门槛 fail-open），本表如实锚定。
import { isNewerVersion } from '../src/kernel/selfUpdate.js'
import { bundleVersionOk } from '../src/kernel/bundle.js'

describe('K2 调用方一致性（parseVersion 单一出口）', () => {
  it('主三段比较与 parseVersion 对齐（isNewerVersion）', () => {
    expect(isNewerVersion('4.0.3', '4.0.2')).toBe(true)
    expect(isNewerVersion('4.1.0', '4.0.9')).toBe(true)
    expect(isNewerVersion('5.0.0', '4.99.99')).toBe(true)
    expect(isNewerVersion('4.0.2', '4.0.2')).toBe(false)
    expect(isNewerVersion('4.0.1', '4.0.2')).toBe(false)
    expect(isNewerVersion('0.1.0', '0.0.9')).toBe(true) // 0.x 段无特判（数值比较——与旧实现一致）
  })
  it('v/V 前缀与预发布语义（正式 > 预发布；预发布字典序）', () => {
    expect(isNewerVersion('v4.0.3', '4.0.2')).toBe(true)
    expect(isNewerVersion('V4.0.3', '4.0.2')).toBe(true)
    expect(isNewerVersion('4.0.3-rc.1', '4.0.3')).toBe(false) // 同号：预发布 < 正式
    expect(isNewerVersion('4.0.3', '4.0.3-rc.1')).toBe(true)
    expect(isNewerVersion('4.0.3-rc.2', '4.0.3-rc.1')).toBe(true) // 预发布字典序
    expect(isNewerVersion('4.0.3-rc.1', '4.0.3-rc.2')).toBe(false)
  })
  it('非法输入 → isNewerVersion fail-closed false（parseVersion null 传播）', () => {
    expect(isNewerVersion('not-a-version', '4.0.2')).toBe(false)
    expect(isNewerVersion('4.0.3', 'oops')).toBe(false)
  })
  it('bundleVersionOk：剥预发布按主三段 + 非法 fail-open true（兼容门槛语义）', () => {
    expect(bundleVersionOk('4.0.2', '4.0.2')).toBe(true)
    expect(bundleVersionOk('4.0.2', '4.0.3')).toBe(true)
    expect(bundleVersionOk('4.1.0', '4.0.9')).toBe(false)
    expect(bundleVersionOk('4.0.0-rc.1', '4.0.0')).toBe(true) // 预发布剥除：4.0.0 ≥ 4.0.0
    expect(bundleVersionOk('not-a-version', '4.0.2')).toBe(true) // fail-open——不误拒旧包
    expect(bundleVersionOk('v4.0.2', 'V4.0.2')).toBe(true)
  })
})

// tests/kernel-jsonSchema.test.ts — --output-schema 零依赖校验器
import { describe, expect, it } from 'vitest'

import { validateJsonSchema } from '../src/kernel/jsonSchema.js'

describe('validateJsonSchema — 轻量 JSON Schema 校验', () => {
  it('类型与 required 校验通过/失败', () => {
    const schema = { type: 'object', properties: { name: { type: 'string' }, age: { type: 'integer' } }, required: ['name'] }
    expect(validateJsonSchema({ name: 'x', age: 3 }, schema)).toEqual([])
    const v = validateJsonSchema({ age: '3' }, schema)
    expect(v.some(x => x.message.includes('缺少必填字段'))).toBe(true)
    expect(v.some(x => x.message.includes('期望 integer'))).toBe(true)
  })

  it('嵌套对象与数组 items 校验', () => {
    const schema = {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
      },
    }
    expect(validateJsonSchema({ items: [{ id: 1 }, { id: 2 }] }, schema)).toEqual([])
    const v = validateJsonSchema({ items: [{ id: 1 }, { name: 'x' }] }, schema)
    expect(v.some(x => x.path.includes('[1].id'))).toBe(true)
  })

  it('顶层数组 schema', () => {
    expect(validateJsonSchema([1, 2, 3], { type: 'array', items: { type: 'integer' } })).toEqual([])
    expect(validateJsonSchema([1, 'x'], { type: 'array', items: { type: 'integer' } }).length).toBe(1)
  })

  it('类型不匹配根节点', () => {
    expect(validateJsonSchema('str', { type: 'object' }).some(x => x.path === '' && x.message.includes('object'))).toBe(true)
  })
})

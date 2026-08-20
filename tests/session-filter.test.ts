// tests/session-filter.test.ts — P1 收尾：会话搜索过滤纯函数契约
import { describe, expect, it } from 'vitest'
import { filterSessionRows, matchSessionFilter } from '../src/wxnodus-ui/lib/sessionFilter.js'

const rows = [
  { id: 'sess-7f3a', title: '商城重构', preview: '重构订单模块' },
  { id: 'sess-3c21', title: '数据迁移脚本', preview: 'pg_dump 增量' },
  { id: 'sess-91aa', title: '离线模型调优', preview: 'qwen 量化' }
]

describe('matchSessionFilter', () => {
  it('id/title/preview 任一命中（大小写不敏感）', () => {
    expect(matchSessionFilter('sess-7f3a', '商城重构', '', '商城')).toBe(true)
    expect(matchSessionFilter('sess-3c21', '', 'PG_DUMP 增量', 'pg_dump')).toBe(true)
    expect(matchSessionFilter('sess-91aa', '', '', 'SESS-91AA')).toBe(true)
    expect(matchSessionFilter('sess-91aa', '离线模型调优', '', '不相关')).toBe(false)
  })

  it('空 query 恒通过', () => {
    expect(matchSessionFilter('x', 'y', 'z', '  ')).toBe(true)
    expect(matchSessionFilter('x', 'y', 'z', '')).toBe(true)
  })
})

describe('filterSessionRows', () => {
  it('过滤命中行；空 query 零拷贝返回原数组', () => {
    expect(filterSessionRows(rows, '商城')).toEqual([rows[0]])
    expect(filterSessionRows(rows, '量化')).toEqual([rows[2]])
    expect(filterSessionRows(rows, '   ')).toBe(rows)
  })

  it('无命中 → 空数组', () => {
    expect(filterSessionRows(rows, '不存在的会话')).toEqual([])
  })
})

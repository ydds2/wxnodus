// 工具关键参数提取（kimi extract_key_argument 语义·实现原创）
import { describe, it, expect } from 'vitest';
import { keyArgumentOf } from '../src/wxnodus-ui/lib/keyArg.js';

describe('keyArgumentOf', () => {
  it('关键键优先级：path > command > query > 标识 > 任务兜底', () => {
    expect(keyArgumentOf('{"path":"src/a.ts","command":"x"}')).toBe('src/a.ts')
    expect(keyArgumentOf('{"command":"npm test","cwd":"/p"}')).toBe('npm test')
    expect(keyArgumentOf('{"query":"黑洞","limit":5}')).toBe('黑洞')
    expect(keyArgumentOf('{"url":"https://x.dev/api","method":"GET"}')).toBe('https://x.dev/api')
  })
  it('半截 JSON（流式中途）正则级提取；无关键键取首个字符串值', () => {
    expect(keyArgumentOf('{"path":"src/lon')).toBe('src/lon')
    expect(keyArgumentOf('{"foo":"bar","n":1}')).toBe('bar')
  })
  it('截断与净化：超 80 截…；空白折叠；空/非串输入 null', () => {
    expect(keyArgumentOf(`{"command":"${'a'.repeat(120)}"}`)).toHaveLength(80)
    expect(keyArgumentOf('{"command":"a\n b"}')).toBe('a b')
    expect(keyArgumentOf(undefined)).toBeNull()
    expect(keyArgumentOf('123')).toBeNull()
  })
})

// tests/kernel-redact.test.ts — P1 审批脱敏：凭据形状打码
import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../src/kernel/redact.js';

describe('redactSecrets 脱敏', () => {
  it('sk- 密钥打码且保留头尾', () => {
    const r = redactSecrets('curl -H "Authorization: Bearer sk-abcdefghijklmnop1234567890"');
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.text).toContain('***');
    expect(r.text).not.toContain('sk-abcdefghijklmnop1234567890');
  });
  it('JWT 打码', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const r = redactSecrets(`token=${jwt}`);
    expect(r.text).not.toContain('eyJhbGci');
  });
  it('KEY=值 形状打码', () => {
    const r = redactSecrets('export API_KEY=mysecretvalue123456');
    expect(r.text).not.toContain('mysecretvalue123456');
  });
  it('普通文本不受影响', () => {
    const r = redactSecrets('hello world 你好');
    expect(r.hits.length).toBe(0);
    expect(r.text).toBe('hello world 你好');
  });
  it('空文本安全', () => {
    expect(redactSecrets('').text).toBe('');
  });
  it('命中记录含标签（审计留痕）', () => {
    const r = redactSecrets('x sk-abc1234567890 y');
    expect(r.hits[0]?.label).toBe('密钥');
  });
});

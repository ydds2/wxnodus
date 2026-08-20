// tests/kernel-dynamicForm.test.ts — 动态内容表：提交校验/引用提取/仅内存 vault
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretVault } from '../src/kernel/secrets.js';
import { commitFormValues, validateFormResponse, extractSecretRefs } from '../src/kernel/dynamicForm.js';

describe('dynamicForm 动态内容表', () => {
  it('commitFormValues 录入仅内存 vault；重复字段覆盖', () => {
    const vault = createSecretVault();
    const fields = [{ name: 'api_key', label: 'API 密钥', kind: 'key' as const }, { name: 'username', label: '用户名', kind: 'text' as const }];
    const committed = commitFormValues(vault, { api_key: 'sk-123', username: 'alice' }, fields);
    expect(committed).toEqual(['api_key', 'username']);
    expect(vault.getSecret('api_key')).toBe('sk-123');
    expect(vault.getSecret('username')).toBe('alice');
    // 覆盖更新
    commitFormValues(vault, { api_key: 'sk-999' }, fields);
    expect(vault.getSecret('api_key')).toBe('sk-999');
    // 清空（/security off 语义）
    vault.clearSecrets();
    expect(vault.getSecret('api_key')).toBeUndefined();
  });

  it('validateFormResponse 检出缺失/空值字段', () => {
    const fields = [{ name: 'a', kind: 'password' as const }, { name: 'b', kind: 'key' as const }];
    expect(validateFormResponse({ a: 'x', b: 'y' }, fields)).toEqual([]);
    expect(validateFormResponse({ a: 'x' }, fields)).toEqual(['b']);
    expect(validateFormResponse({ a: '  ', b: '' }, fields)).toEqual(['a', 'b']);
  });

  it('extractSecretRefs 提取 $WXNODUS_SECRET_<NAME> 引用', () => {
    expect(extractSecretRefs('echo $WXNODUS_SECRET_api_key && echo $WXNODUS_SECRET_PWD')).toEqual(['api_key', 'PWD']);
    expect(extractSecretRefs('无引用')).toEqual([]);
  });
});


// ── P0：审计留痕（字段名不含值）──
describe('表单请求审计', () => {
  it('credential.form_request 写入 audit 且不含值', async () => {
    const { openDB, closeDB } = await import('../src/store/db.js');
    const d = mkdtempSync(join(tmpdir(), 'wx-audit-'));
    const db = openDB(d);
    try {
      const { appendAudit } = await import('../src/store/db.js');
      appendAudit(db, 'credential.form_request', { source: 'test', fields: ['api_key', 'password'] });
      const row = db.prepare(`SELECT event, payload FROM audit ORDER BY id DESC LIMIT 1`).get() as any;
      expect(row.event).toBe('credential.form_request');
      expect(row.payload).toContain('api_key');
      expect(row.payload).not.toContain('sk-'); // 值绝不入审计
    } finally { closeDB(db); try { rmSync(d, { recursive: true, force: true }); } catch {} }
  });
});

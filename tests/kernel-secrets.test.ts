// tests/kernel-secrets.test.ts — P3 安全注入：内存保险库/通道关闭即清/工具注入链路
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretVault } from '../src/kernel/secrets.js';
import { coreTools } from '../src/kernel/tools.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wx-sec-'));
});

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 延迟解锁 */ }
});

describe('SecretVault 内存保险库', () => {
  it('sudo 密码 set/get/clear', () => {
    const v = createSecretVault();
    expect(v.hasSudo()).toBe(false);
    v.setSudoPassword('p@ss');
    expect(v.getSudoPassword()).toBe('p@ss');
    expect(v.hasSudo()).toBe(true);
    v.clearSudoPassword();
    expect(v.getSudoPassword()).toBeNull();
    expect(v.hasSudo()).toBe(false);
  });
  it('环境变量密钥 set/get/clear/names', () => {
    const v = createSecretVault();
    expect(v.getSecret('OPENAI')).toBeUndefined();
    v.setSecret('OPENAI', 'sk-123');
    v.setSecret('GH_TOKEN', 'ghp_456');
    expect(v.getSecret('OPENAI')).toBe('sk-123');
    expect(v.secretNames().sort()).toEqual(['GH_TOKEN', 'OPENAI']);
    v.clearSecrets();
    expect(v.secretNames()).toEqual([]);
  });
  it('clearAll 全量清除（关闭注入通道语义）', () => {
    const v = createSecretVault();
    v.setSudoPassword('pw');
    v.setSecret('A', '1');
    v.setSecret('B', '2');
    v.clearAll();
    expect(v.getSudoPassword()).toBeNull();
    expect(v.secretNames()).toEqual([]);
  });
});

describe('bash 工具安全注入', () => {
  const bash = coreTools().bash!;
  const ctx = (over: Record<string, any> = {}) => ({
    cwd: process.cwd(), dataDir: dir, signal: undefined as any,
    secrets: { vault: createSecretVault(), sudoEnabled: true, secretEnabled: true },
    ...over,
  });

  it('占位符替换：vault 有值直接注入，不进模型上下文', async () => {
    const c = ctx();
    c.secrets.vault.setSecret('API_KEY', 'sk-secret-123');
    const r = await bash.run({ command: 'echo $WXNODUS_SECRET_API_KEY' }, c);
    expect(String(r)).toContain('sk-secret-123');
  });

  it('占位符缺失 → 经 requestSecret 用户输入 → 缓存后注入', async () => {
    const c = ctx();
    let asked = 0;
    c.requestSecret = async (kind, _prompt, name) => { asked++; expect(kind).toBe('secret'); expect(name).toBe('DB_PASS'); return 'db-pass-value'; };
    const r = await bash.run({ command: 'echo $WXNODUS_SECRET_DB_PASS' }, c);
    expect(String(r)).toContain('db-pass-value');
    expect(asked).toBe(1);
    expect(c.secrets.vault.getSecret('DB_PASS')).toBe('db-pass-value'); // 已缓存（通道关闭即清）
  });

  it('占位符缺失且用户拒绝 → 拒绝执行并提示', async () => {
    const c = ctx();
    c.requestSecret = async () => null;
    const r = await bash.run({ command: 'echo $WXNODUS_SECRET_GH' }, c);
    expect(String(r)).toContain('缺少密钥');
    expect(String(r)).toContain('GH');
  });

  it('通道关闭（secretEnabled:false）→ 提示开启，不执行', async () => {
    const c = ctx({ secrets: { vault: createSecretVault(), sudoEnabled: true, secretEnabled: false } });
    const r = await bash.run({ command: 'echo $WXNODUS_SECRET_X' }, c);
    expect(String(r)).toContain('通道未开启');
  });

  it('sudo 命令：requestSecret 被调用于密码、密码入缓存（stdin 注入，不进 argv）', async () => {
    const c = ctx();
    let asked = 0;
    c.requestSecret = async (kind) => { asked++; expect(kind).toBe('sudo'); return 'sudo-pw-123'; };
    const r = await bash.run({ command: 'sudo echo hi' }, c);
    expect(asked).toBe(1);
    expect(c.secrets.vault.getSudoPassword()).toBe('sudo-pw-123'); // 已缓存
    // 第二次执行不再询问（缓存命中）
    await bash.run({ command: 'sudo echo hi' }, c);
    expect(asked).toBe(1);
  });

  it('sudo 通道关闭 → 提示开启，密码不缓存', async () => {
    const c = ctx({ secrets: { vault: createSecretVault(), sudoEnabled: false, secretEnabled: true } });
    const r = await bash.run({ command: 'sudo echo hi' }, c);
    expect(String(r)).toContain('通道未开启');
    expect(c.secrets.vault.getSudoPassword()).toBeNull();
  });

  it('sudo 拒绝输入 → 拒绝执行并提示', async () => {
    const c = ctx();
    c.requestSecret = async () => null;
    const r = await bash.run({ command: 'sudo echo hi' }, c);
    expect(String(r)).toContain('输入不可用');
  });

  it('无 secrets 通道（agent 默认）→ sudo 提示开启', async () => {
    const c = { cwd: process.cwd(), dataDir: dir, signal: undefined as any };
    const r = await bash.run({ command: 'sudo echo hi' }, c);
    expect(String(r)).toContain('通道未开启');
  });
});

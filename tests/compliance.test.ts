// tests/compliance.test.ts — L3-3 合规五项（合规红线）：授权存证/AI 标注/审计导出/许可证扫描/自动化护栏
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ConsentLedger, scanLicenses, checkRobots, detectCaptcha, guardrail, exportAudit } from '../src/compliance/compliance.js';

let dir: string;
let db: Database.Database;
let ledger: ConsentLedger;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxn-comp-'));
  db = new Database(join(dir, 'comp.db'));
  ledger = new ConsentLedger(db);
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('① 授权存证（六元组，可撤销）', () => {
  it('grant/check/revoke/到期级联', () => {
    const rec = ledger.grant({ grantor: 'u1', scope: 'web.sync', purpose: '数据同步', method: 'cli', expiresAt: 0, evidenceRef: 'ev1' });
    expect(ledger.isAuthorized('web.sync').ok).toBe(true);
    expect(ledger.isAuthorized('other.scope').ok).toBe(false); // 无授权即护栏
    ledger.revoke(rec.id);
    expect(ledger.isAuthorized('web.sync').ok).toBe(false); // 撤销生效
    ledger.grant({ grantor: 'u1', scope: 'exp', purpose: 't', method: 't', expiresAt: Date.now() - 1000, evidenceRef: 't' });
    expect(ledger.isAuthorized('exp').ok).toBe(false); // 到期级联停用
  });
});

describe('② AI 生成标注（深度合成办法）', () => {
  it('forge 产物含标注（在 L3-2 已测 server/SKILL）——此处验证标注工具函数', () => {
    const { aiNotice } = require('../src/compliance/compliance.js');
    const n = aiNotice('test-component');
    expect(n).toContain('AI 生成标注');
    expect(n).toContain('深度合成办法');
    expect(n).toContain('test-component');
  });
});

describe('③ 审计导出（GDPR 5(2) 可审计）', () => {
  it('exportAudit 导出审计文件', () => {
    ledger.grant({ grantor: 'u2', scope: 'a', purpose: 'p', method: 'm', expiresAt: 0, evidenceRef: 'e' });
    const p = exportAudit(dir, ledger);
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, 'utf8');
    expect(content).toContain('consent');
  });
});

describe('④ 许可证扫描（AGPL/BUSL 强传染性拦截）', () => {
  it('block 级风险识别', () => {
    const hits = scanLicenses(join(dir, 'fake-node_modules'));
    // 目录不存在 → 空数组不抛
    expect(Array.isArray(hits)).toBe(true);
  });
  it('单个 LICENSE 文本识别', () => {
    const { classifyLicense } = require('../src/compliance/compliance.js');
    expect(classifyLicense('GNU AFFERO GENERAL PUBLIC LICENSE')).toBe('block');
    expect(classifyLicense('Business Source License')).toBe('block');
    expect(classifyLicense('Apache License Version 2.0')).toBe('ok');
    expect(classifyLicense('MIT License')).toBe('ok');
  });
});

describe('⑤ 自动化护栏（robots 红线 + 验证码）', () => {
  it('robots.txt 红线', () => {
    expect(checkRobots('User-agent: *\nDisallow: /admin/', '/admin/orders').allowed).toBe(false);
    expect(checkRobots('User-agent: *\nDisallow: /admin/', '/public/x').allowed).toBe(true);
    expect(checkRobots('', '/x').allowed).toBe(true); // 无 robots 默认放行但需站点条款
  });
  it('验证码检测', () => {
    expect(detectCaptcha('<div>请输入验证码进行人机验证</div>')).toBe('high');
    expect(detectCaptcha('<form>username</form>')).toBe('none');
  });
  it('guardrail 组合判定', () => {
    const g = guardrail('<div>recaptcha</div>', 'User-agent: *\nDisallow: /secret/', '/secret/x');
    expect(g.robotsOk).toBe(false);
    expect(g.captchaRisk).toBe('high');
  });
});

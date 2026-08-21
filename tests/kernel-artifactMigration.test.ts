// tests/kernel-artifactMigration.test.ts — V4 P5-2：用户产物迁移框架
// 验收对齐卡片：①产物清单状态（ok/missing/corrupt）②迁移器链 dry-run/备份/原子应用
// ③迁移失败 fail-safe——绝不半迁移（旧数据完好）④幂等重入 ⑤历史记录
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  USER_ARTIFACTS, artifactStatus, runMigrations, migrationHistory,
  type ArtifactMigrator,
} from '../src/kernel/artifactMigration.js';

const work = () => {
  mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
  return mkdtempSync(join(process.cwd(), '.tmp', 'wx-mig-'));
};
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

/** 构造「v3.0 老数据」夹具：核心产物各就各位 */
const legacyFixture = (d: string) => {
  writeFileSync(join(d, 'settings.json'), JSON.stringify({ model: 'old-model', apiKeyEnc: 'enc::v3' }), 'utf8');
  writeFileSync(join(d, 'permissions.json'), JSON.stringify([{ tool: 'bash', decision: 'ask' }]), 'utf8');
  writeFileSync(join(d, 'mcp.json'), JSON.stringify({ servers: {} }), 'utf8');
  mkdirSync(join(d, 'skills', 'my-skill'), { recursive: true });
  writeFileSync(join(d, 'skills', 'my-skill', 'SKILL.md'), '# 技能', 'utf8');
  mkdirSync(join(d, 'plugins'), { recursive: true });
  writeFileSync(join(d, 'nodus.db'), 'sqlite-bytes-v3', 'utf8');
  writeFileSync(join(d, 'events.jsonl'), '{"type":"user"}\n', 'utf8');
};

describe('artifactStatus 产物清单', () => {
  it('老数据夹具：核心产物 ok；未创建的 missing（新装合法）', () => {
    const d = work(); dirs.push(d);
    legacyFixture(d);
    const st = artifactStatus(d);
    const by = (id: string) => st.find(s => s.spec.id === id)!;
    expect(by('settings').state).toBe('ok');
    expect(by('permissions').state).toBe('ok');
    expect(by('mcp-config').state).toBe('ok');
    expect(by('skills').state).toBe('ok');
    expect(by('sessions-db').state).toBe('ok');
    expect(by('themes').state).toBe('missing'); // 未用主题能力
    expect(by('projects').state).toBe('missing');
  });
  it('corrupt 检出：settings.json 非 JSON 对象', () => {
    const d = work(); dirs.push(d);
    writeFileSync(join(d, 'settings.json'), 'NOT-JSON{{{', 'utf8');
    const st = artifactStatus(d);
    expect(st.find(s => s.spec.id === 'settings')!.state).toBe('corrupt');
  });
  it('清单含约束四全部资产类别（密钥档案/权限/插件/技能/MCP/会话库/事件流/项目产物）', () => {
    const ids = USER_ARTIFACTS.map(a => a.id);
    for (const id of ['settings', 'permissions', 'skills', 'plugins', 'mcp-config', 'sessions-db', 'events', 'session-streams', 'projects', 'undo-shadows']) {
      expect(ids, id).toContain(id);
    }
  });
});

describe('runMigrations 迁移器链', () => {
  /** 示例迁移器：v3 老形态 settings.model 前缀迁移（old- → 新命名空间） */
  const makeRenamer = (failAt?: string): ArtifactMigrator => ({
    id: 'v4-settings-model-rename',
    artifacts: ['settings'],
    detects: d => {
      try { return String(JSON.parse(readFileSync(join(d, 'settings.json'), 'utf8')).model ?? '').startsWith('old-'); } catch { return false; }
    },
    plan: d => [`settings.model: ${JSON.parse(readFileSync(join(d, 'settings.json'), 'utf8')).model} → v4/${JSON.parse(readFileSync(join(d, 'settings.json'), 'utf8')).model}`],
    apply: d => {
      if (failAt === 'v4-settings-model-rename') return { ok: false, error: '注入失败（中断测试）' };
      const s = JSON.parse(readFileSync(join(d, 'settings.json'), 'utf8'));
      s.model = `v4/${s.model}`;
      writeFileSync(join(d, 'settings.json'), JSON.stringify(s), 'utf8');
      return { ok: true };
    },
  });
  /** 第二个迁移器：skills 目录打标 */
  const marker: ArtifactMigrator = {
    id: 'v4-skills-marker',
    artifacts: ['skills'],
    detects: d => !existsSync(join(d, 'skills', '.v4-migrated')),
    plan: () => ['skills/.v4-migrated 标记写入'],
    apply: d => { writeFileSync(join(d, 'skills', '.v4-migrated'), '1', 'utf8'); return { ok: true }; },
  };

  it('老数据 → 迁移 → 全产物兼容断言（验收主线）', () => {
    const d = work(); dirs.push(d);
    legacyFixture(d);
    const r = runMigrations(d, [makeRenamer(), marker]);
    expect(r.ok).toBe(true);
    expect(r.applied).toEqual(['v4-settings-model-rename', 'v4-skills-marker']);
    // 迁移后：settings.model 已进 v4 命名空间、密钥加密态原样、其他产物未动
    const s = JSON.parse(readFileSync(join(d, 'settings.json'), 'utf8'));
    expect(s.model).toBe('v4/old-model');
    expect(s.apiKeyEnc).toBe('enc::v3'); // 加密态迁移——不重加密不丢
    expect(readFileSync(join(d, 'nodus.db'), 'utf8')).toBe('sqlite-bytes-v3'); // 会话库原样
    expect(readFileSync(join(d, 'skills', 'my-skill', 'SKILL.md'), 'utf8')).toBe('# 技能');
    expect(existsSync(join(d, 'skills', '.v4-migrated'))).toBe(true);
    // 备份保留（回滚出口）+ 历史记录
    expect(r.backupDir).toBeTruthy();
    expect(existsSync(join(r.backupDir!, 'settings.json'))).toBe(true);
    expect(migrationHistory(d).map(h => h.id)).toContain('v4-settings-model-rename');
  });

  it('幂等重入：迁移后再跑零动作零备份', () => {
    const d = work(); dirs.push(d);
    legacyFixture(d);
    runMigrations(d, [makeRenamer(), marker]);
    const again = runMigrations(d, [makeRenamer(), marker]);
    expect(again.ok).toBe(true);
    expect(again.applied).toEqual([]);
    expect(again.backupDir).toBeNull();
  });

  it('迁移中断注入 → 旧数据完好（绝不半迁移——验收红线）', () => {
    const d = work(); dirs.push(d);
    legacyFixture(d);
    // 第一个成功、第二个注入失败 → 整体回滚（含已应用的第一个）
    const r = runMigrations(d, [makeRenamer(), { ...marker, apply: () => ({ ok: false, error: '注入中断' }) }]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('注入中断');
    // 回滚后：settings 回到旧形态、skills 标记不存在（第一个迁移器的效果也被回滚）
    const s = JSON.parse(readFileSync(join(d, 'settings.json'), 'utf8'));
    expect(s.model).toBe('old-model');
    expect(s.apiKeyEnc).toBe('enc::v3');
    expect(existsSync(join(d, 'skills', '.v4-migrated'))).toBe(false);
    expect(readFileSync(join(d, 'nodus.db'), 'utf8')).toBe('sqlite-bytes-v3');
  });

  it('备份失败 → 拒绝执行迁移（不半迁移的前置防线）', () => {
    const d = work(); dirs.push(d);
    legacyFixture(d);
    // 备份制造真冲突：migrations 路径本身是文件（mkdir 备份目录必然 ENOTDIR——
    // backups/<ts> 处放文件会被 rmSync 预清理，构不成失败）
    writeFileSync(join(d, 'migrations'), 'blocker', 'utf8');
    const r = runMigrations(d, [makeRenamer()], { now: () => 12345 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('备份失败');
    const s = JSON.parse(readFileSync(join(d, 'settings.json'), 'utf8'));
    expect(s.model).toBe('old-model'); // 未被动过
  });
});

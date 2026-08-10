// tests/kernel-skills.test.ts — L2-5 本地技能生态：frontmatter 解析/发现/加载/安装/创建
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkillMd, discoverSkills, loadSkill, installSkill, writeSkill, skillContentForModel } from '../src/kernel/skills.js';

let dir: string;
let dataDir: string;
let cwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wx-skills-'));
  dataDir = join(dir, 'data');
  cwd = join(dir, 'proj');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseSkillMd frontmatter 解析', () => {
  it('解析标量键（含引号）', () => {
    const { meta, body } = parseSkillMd('---\nname: "test-skill"\ndescription: 一个测试技能\nversion: 1.0\n---\n# 正文\n步骤一');
    expect(meta.name).toBe('test-skill');
    expect(meta.description).toBe('一个测试技能');
    expect(meta.version).toBe('1.0');
    expect(body).toContain('步骤一');
  });
  it('无 frontmatter 时整文当正文', () => {
    const { meta, body } = parseSkillMd('# 只有正文');
    expect(Object.keys(meta).length).toBe(0);
    expect(body).toContain('只有正文');
  });
  it('兼容 CRLF 与缺失说明', () => {
    const { meta, body } = parseSkillMd('---\r\nname: "a"\r\n---\r\n正文');
    expect(meta.name).toBe('a');
    expect(body).toBe('正文');
  });
});

describe('技能发现（三级目录）', () => {
  it('项目级优先，用户级与 forge 产物并入', () => {
    // 项目级
    mkdirSync(join(cwd, '.wxnodus', 'skills', 'proj-skill'), { recursive: true });
    writeFileSync(join(cwd, '.wxnodus', 'skills', 'proj-skill', 'SKILL.md'), '---\nname: "proj-skill"\ndescription: 项目技能\n---\n正文');
    // 用户级
    mkdirSync(join(dataDir, 'skills', 'user-skill'), { recursive: true });
    writeFileSync(join(dataDir, 'skills', 'user-skill', 'SKILL.md'), '---\nname: "user-skill"\ndescription: 用户技能\n---\n正文');
    // forge 产物（data/forge/<pkg>/<name>/SKILL.md）
    mkdirSync(join(dataDir, 'forge', 'demo', 'forge-skill'), { recursive: true });
    writeFileSync(join(dataDir, 'forge', 'demo', 'forge-skill', 'SKILL.md'), '---\nname: "forge-skill"\ndescription: 锻造技能\n---\n正文');

    const all = discoverSkills(dataDir, cwd);
    expect(all.map(s => s.name).sort()).toEqual(['forge-skill', 'proj-skill', 'user-skill']);
    const proj = all.find(s => s.name === 'proj-skill')!;
    expect(proj.source).toBe('project');
  });
  it('同名去重（项目级优先）', () => {
    mkdirSync(join(cwd, '.wxnodus', 'skills', 'same'), { recursive: true });
    writeFileSync(join(cwd, '.wxnodus', 'skills', 'same', 'SKILL.md'), '---\nname: "dup"\n---\n项目版');
    mkdirSync(join(dataDir, 'skills', 'same'), { recursive: true });
    writeFileSync(join(dataDir, 'skills', 'same', 'SKILL.md'), '---\nname: "dup"\n---\n用户版');
    const all = discoverSkills(dataDir, cwd);
    expect(all.filter(s => s.name === 'dup').length).toBe(1);
    expect(all.find(s => s.name === 'dup')!.source).toBe('project');
  });
});

describe('加载/安装/创建', () => {
  it('loadSkill 按名返回正文与元信息', () => {
    writeSkill(dataDir, 'calc-helper', '计算辅助技能', '1. 读题 2. 计算 3. 校验');
    const s = loadSkill(dataDir, cwd, 'calc-helper');
    expect(s).not.toBeNull();
    expect(s!.meta.description).toBe('计算辅助技能');
    expect(s!.body).toContain('读题');
    expect(s!.meta.source).toBe('user');
  });
  it('loadSkill 未找到返回 null', () => {
    expect(loadSkill(dataDir, cwd, 'nope')).toBeNull();
  });
  it('installSkill 复制目录到用户级技能库', () => {
    const src = join(dir, 'ext-skill');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'SKILL.md'), '---\nname: "ext-skill"\ndescription: 外部技能\n---\n工作流');
    const target = installSkill(dataDir, src);
    expect(existsSync(join(target, 'SKILL.md'))).toBe(true);
    expect(loadSkill(dataDir, cwd, 'ext-skill')).not.toBeNull();
  });
  it('installSkill 非技能目录抛错', () => {
    const bad = join(dir, 'bad');
    mkdirSync(bad, { recursive: true });
    expect(() => installSkill(dataDir, bad)).toThrow(/SKILL\.md/);
  });
  it('writeSkill ai_generated 标注', () => {
    const dir2 = writeSkill(dataDir, 'ai-skill', '描述', '工作流', { aiGenerated: true });
    expect(readFileSync(join(dir2, 'SKILL.md'), 'utf8')).toContain('ai_generated: true');
  });
  it('skillContentForModel 带标题头且截断', () => {
    writeSkill(dataDir, 'big', '大技能', 'x'.repeat(9000));
    const content = skillContentForModel(dataDir, cwd, 'big');
    expect(content.startsWith('[技能 big]')).toBe(true);
    expect(content.length).toBeLessThanOrEqual(8000);
    expect(skillContentForModel(dataDir, cwd, 'missing')).toBe('');
  });
});

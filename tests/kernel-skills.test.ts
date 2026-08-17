// tests/kernel-skills.test.ts — L2-5 本地技能生态：frontmatter 解析/发现/加载/安装/创建
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkillMd, discoverSkills, loadSkill, installSkill, writeSkill, skillContentForModel, parseFlow } from '../src/kernel/skills.js';

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
  it('skillContentForModel 带标题头且截断显式标注（模型知道技能有剩余）', () => {
    writeSkill(dataDir, 'big', '大技能', 'x'.repeat(9000));
    const content = skillContentForModel(dataDir, cwd, 'big');
    expect(content.startsWith('[技能 big]')).toBe(true);
    expect(content).toContain('已截断');
    expect(content).toContain('共');
    expect(content).toContain('剩余');
    expect(skillContentForModel(dataDir, cwd, 'missing')).toBe('');
  });
});

// ── P3b：安装 / 创建 / 模型注入 / 优先级 ──
describe('技能安装与创建', () => {
  it('installSkill 复制到用户级并保留正文', () => {
    const src = join(dir, 'src-skill');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'SKILL.md'), '---\nname: "copied-skill"\ndescription: 复制测试\n---\n# 正文');
    const target = installSkill(dataDir, src);
    expect(existsSync(join(target, 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(target, 'SKILL.md'), 'utf-8')).toContain('copied-skill');
    const s = loadSkill(dataDir, cwd, 'copied-skill');
    expect(s?.body).toContain('正文');
  });
  it('writeSkill 创建含 ai_generated 标注', () => {
    const p = writeSkill(dataDir, 'gen-skill', '生成技能', '步骤：1. 做 X\n2. 做 Y', { aiGenerated: true });
    expect(existsSync(join(p, 'SKILL.md'))).toBe(true);
    const raw = readFileSync(join(p, 'SKILL.md'), 'utf-8');
    expect(raw).toContain('ai_generated: true');
    expect(parseSkillMd(raw).body).toContain('做 X');
  });
  it('skillContentForModel 注入正文', () => {
    writeSkill(dataDir, 'for-model', '注入测试', '操作说明 ABC');
    const content = skillContentForModel(dataDir, cwd, 'for-model');
    expect(content).toContain('操作说明 ABC');
  });
  it('不存在技能返回空', () => {
    expect(skillContentForModel(dataDir, cwd, 'ghost')).toBe('');
  });
  it('发现优先级：项目级覆盖用户级同名', () => {
    writeSkill(dataDir, 'dup', '用户版', '用户正文');
    const proj = join(cwd, '.wxnodus', 'skills', 'dup');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'SKILL.md'), '---\nname: "dup"\ndescription: 项目版\n---\n项目正文');
    const found = discoverSkills(dataDir, cwd).filter(s => s.name === 'dup');
    expect(found[0]!.source).toBe('project');
    const loaded = loadSkill(dataDir, cwd, 'dup');
    expect(loaded?.body).toContain('项目正文');
  });
});

// ── P2：Flow skills（流程图驱动）──
describe('Flow skills', () => {
  it('parseFlow 解析节点链与节点指令', () => {
    const body = [
      '## 节点: 准备',
      '检查环境、安装依赖',
      '',
      '## 节点: 构建',
      '执行 npm run build',
    ].join('\n');
    const nodes = parseFlow(body, '准备 → 构建');
    expect(nodes?.length).toBe(2);
    expect(nodes?.[0]?.name).toBe('准备');
    expect(nodes?.[0]?.instruction).toContain('检查环境');
    expect(nodes?.[1]?.instruction).toContain('build');
  });
  it('无 flow 字段 → null；无节点段落 → 占位指令', () => {
    expect(parseFlow('正文', undefined)).toBeNull();
    const nodes = parseFlow('没有节点段落', 'A → B');
    expect(nodes?.[1]?.instruction).toContain('无说明');
  });
  it('writeSkill 支持 flow frontmatter 并可读回', () => {
    const dir = writeSkill(dataDir, 'flow-skill', '流程技能', '工作流内容', { flow: '准备 → 部署' });
    const raw = readFileSync(join(dir, 'SKILL.md'), 'utf-8');
    expect(raw).toContain('flow: "准备 → 部署"');
    const parsed = parseSkillMd(raw);
    expect(parsed.meta.flow).toBe('准备 → 部署');
  });
});

// ── P3：跨品牌技能发现（agentskills.io 生态——Cursor CLI 同款）──
describe('跨品牌技能目录', () => {
  it('发现 .claude/.agents/.codex/.gemini/skills 技能，标注 brand 来源', () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-sk2-'));
    try {
      const cwd = join(d, 'proj');
      for (const brand of ['.claude', '.agents', '.codex', '.gemini']) {
        mkdirSync(join(cwd, brand, 'skills', `sk-${brand.slice(1)}`), { recursive: true });
        writeFileSync(join(cwd, brand, 'skills', `sk-${brand.slice(1)}`, 'SKILL.md'), `---\nname: ${brand.slice(1)}-skill\ndescription: 来自 ${brand} 的技能\n---\n正文`);
      }
      const list = discoverSkills(d, cwd);
      expect(list).toHaveLength(4);
      expect(list.every(s => s.source === 'brand')).toBe(true);
      expect(list.map(s => s.name).sort()).toEqual(['agents-skill', 'claude-skill', 'codex-skill', 'gemini-skill']);
    } finally { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  });
  it('loadSkill 可加载品牌技能，且项目 .wxnodus 优先级更高（同名去重）', () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-sk3-'));
    try {
      const cwd = join(d, 'proj');
      mkdirSync(join(cwd, '.wxnodus', 'skills', 'dup'), { recursive: true });
      writeFileSync(join(cwd, '.wxnodus', 'skills', 'dup', 'SKILL.md'), '---\nname: dup\ndescription: 项目版\n---\n项目正文');
      mkdirSync(join(cwd, '.claude', 'skills', 'dup'), { recursive: true });
      writeFileSync(join(cwd, '.claude', 'skills', 'dup', 'SKILL.md'), '---\nname: dup\ndescription: 品牌版\n---\n品牌正文');
      const loaded = loadSkill(d, cwd, 'dup');
      expect(loaded?.body).toContain('项目正文');
      expect(loaded?.meta.source).toBe('project');
      // discover 去重：同名只保留项目版
      expect(discoverSkills(d, cwd).filter(s => s.name === 'dup')).toHaveLength(1);
    } finally { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  });
});

// ── P3：effort frontmatter（Claude Code skill effort 对齐）──
describe('effort frontmatter', () => {
  it('解析 effort: high 并映射到 SkillMeta；非法值忽略', () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-sk4-'));
    try {
      const cwd = join(d, 'proj');
      mkdirSync(join(cwd, '.wxnodus', 'skills', 'deep'), { recursive: true });
      writeFileSync(join(cwd, '.wxnodus', 'skills', 'deep', 'SKILL.md'), '---\nname: deep\ndescription: 深度分析\neffort: high\n---\n正文');
      mkdirSync(join(cwd, '.wxnodus', 'skills', 'bad'), { recursive: true });
      writeFileSync(join(cwd, '.wxnodus', 'skills', 'bad', 'SKILL.md'), '---\nname: bad\neffort: extreme\n---\n正文');
      const list = discoverSkills(d, cwd);
      const deep = list.find(s => s.name === 'deep');
      expect(deep?.effort).toBe('high');
      const bad = list.find(s => s.name === 'bad');
      expect(bad?.effort).toBeUndefined();
      expect(loadSkill(d, cwd, 'deep')?.meta.effort).toBe('high');
    } finally { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  });
});

// tests/kernel-assimilate.test.ts — 黑洞引擎同化器：目录 100% 同化 + 素材 AI 消化
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSkillSources, assimilateDir, assimilateMaterial, readMaterial } from '../src/kernel/assimilate.js';
import { discoverSkills, loadSkill } from '../src/kernel/skills.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wx-asm-'));
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

const skillMd = (name: string, desc: string, extra = '') =>
  `---\nname: "${name}"\ndescription: "${desc}"\n${extra}---\n\n# ${name}\n\n## 目标\n${desc}\n\n## 工作流\n1. 第一步 2. 第二步`;

describe('scanSkillSources 扫描识别', () => {
  it('识别标准 SKILL.md / 跨品牌结构 / skill.md 变体；忽略普通文档', () => {
    const d = tmp();
    mkdirSync(join(d, 'alpha'), { recursive: true });
    writeFileSync(join(d, 'alpha', 'SKILL.md'), skillMd('alpha', '标准技能'));
    mkdirSync(join(d, '.claude', 'skills', 'brand-skill'), { recursive: true });
    writeFileSync(join(d, '.claude', 'skills', 'brand-skill', 'SKILL.md'), skillMd('brand-skill', '跨品牌技能'));
    mkdirSync(join(d, 'lowercase'), { recursive: true });
    writeFileSync(join(d, 'lowercase', 'skill.md'), skillMd('lowercase', '小写变体'));
    writeFileSync(join(d, 'notes.md'), '普通文档无 frontmatter'); // 不应被识别
    mkdirSync(join(d, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(d, 'node_modules', 'pkg', 'SKILL.md'), skillMd('ignored', '应被忽略'));
    const srcs = scanSkillSources(d);
    expect(srcs.map(s => s.name).sort()).toEqual(['alpha', 'brand-skill', 'lowercase']);
    expect(srcs.find(s => s.name === 'alpha')!.format).toBe('standard');
    expect(srcs.find(s => s.name === 'lowercase')!.format).toBe('standard'); // Windows 大小写不敏感
  });

  it('游离 md 含完整 frontmatter → 变体技能', () => {
    const d = tmp();
    writeFileSync(join(d, 'instruction.md'), skillMd('free', '游离技能'));
    const srcs = scanSkillSources(d);
    expect(srcs).toHaveLength(1);
    expect(srcs[0]!.name).toBe('free');
  });

  it('空目录/无技能 → 空结果', () => {
    const d = tmp();
    expect(scanSkillSources(d)).toEqual([]);
  });
});

describe('assimilateDir 目录 100% 同化', () => {
  it('批量同化全部合法技能（含附带资源文件复制）', () => {
    const data = tmp();
    const src = tmp();
    mkdirSync(join(src, 'alpha'), { recursive: true });
    writeFileSync(join(src, 'alpha', 'SKILL.md'), skillMd('alpha', '标准技能', 'flow: "A → B"\n'));
    writeFileSync(join(src, 'alpha', 'helper.js'), 'console.log("资源")'); // 附带资源
    mkdirSync(join(src, '.claude', 'skills', 'beta'), { recursive: true });
    writeFileSync(join(src, '.claude', 'skills', 'beta', 'SKILL.md'), skillMd('beta', '跨品牌'));
    const r = assimilateDir(data, src);
    expect(r.assimilated).toHaveLength(2);
    expect(r.skipped).toHaveLength(0);
    expect(r.invalid).toHaveLength(0);
    // 同化后 discoverSkills 可见（source: user）
    const metas = discoverSkills(data, src);
    expect(metas.map(m => m.name).sort()).toEqual(['alpha', 'beta']);
    expect(metas.find(m => m.name === 'alpha')!.flow).toBe('A → B');
    // 附带资源复制
    expect(existsSync(join(data, 'skills', 'alpha', 'helper.js'))).toBe(true);
    // loadSkill 可加载
    const loaded = loadSkill(data, src, 'beta');
    expect(loaded?.body).toContain('## 工作流');
  });

  it('同名冲突默认跳过，--force 覆盖', () => {
    const data = tmp();
    const src = tmp();
    mkdirSync(join(src, 'dup'), { recursive: true });
    writeFileSync(join(src, 'dup', 'SKILL.md'), skillMd('dup', 'v2 版本'));
    // 预置同名旧技能
    mkdirSync(join(data, 'skills', 'dup'), { recursive: true });
    writeFileSync(join(data, 'skills', 'dup', 'SKILL.md'), skillMd('dup', '旧版本'));
    const r1 = assimilateDir(data, src);
    expect(r1.skipped).toHaveLength(1);
    expect(r1.skipped[0]!.reason).toContain('已存在');
    expect(loadSkill(data, src, 'dup')!.meta.description).toBe('旧版本'); // 未被覆盖
    const r2 = assimilateDir(data, src, { force: true });
    expect(r2.assimilated).toHaveLength(1);
    expect(loadSkill(data, src, 'dup')!.meta.description).toBe('v2 版本'); // 已覆盖
  });

  it('无效技能（无名称/空正文）跳过并报告；无技能目录报 invalid', () => {
    const data = tmp();
    const src = tmp();
    mkdirSync(join(src, 'bad'), { recursive: true });
    writeFileSync(join(src, 'bad', 'SKILL.md'), '---\nname: "bad"\n---\n'); // 无描述且正文空
    const r = assimilateDir(data, src);
    expect(r.invalid.some(i => i.reason.includes('无描述'))).toBe(true);
    expect(r.assimilated).toHaveLength(0);
    const empty = tmp();
    const r2 = assimilateDir(data, empty);
    expect(r2.invalid).toHaveLength(1);
  });
});

describe('assimilateMaterial 素材 AI 消化', () => {
  it('LLM 产出 → 落盘 SKILL.md + ai_generated 标注 + flow 保留', async () => {
    const data = tmp();
    const dir = await assimilateMaterial(data, '这是一个 markdown 转 PPT 的教程素材', {
      name: 'md2ppt',
      description: 'Markdown 转 PPT 演示文稿',
      flow: '解析 → 生成 → 导出',
      llm: async (prompt) => {
        expect(prompt).toContain('md2ppt');
        expect(prompt).toContain('素材');
        return '1. 解析 markdown 结构\n2. 映射到 PPT 版式\n3. 导出文件';
      },
    });
    expect(dir).toContain('skills');
    const text = readFileSync(join(data, 'skills', 'md2ppt', 'SKILL.md'), 'utf8');
    expect(text).toContain('ai_generated: true'); // 深度合成办法强制标注
    expect(text).toContain('flow: "解析 → 生成 → 导出"');
    expect(text).toContain('## 工作流');
    // discoverSkills 可见
    const metas = discoverSkills(data, process.cwd());
    expect(metas.find(m => m.name === 'md2ppt')?.aiGenerated).toBe(true);
  });

  it('LLM 返回空 → 兜底工作流（不产空技能）', async () => {
    const data = tmp();
    await assimilateMaterial(data, '素材', { name: 'fallback-skill', llm: async () => '' });
    const text = readFileSync(join(data, 'skills', 'fallback-skill', 'SKILL.md'), 'utf8');
    expect(text).toContain('1. 理解任务');
  });
});

describe('readMaterial 素材读取', () => {
  it('本地文件读取 + 超限拒绝', async () => {
    const d = tmp();
    const f = join(d, 'material.md');
    writeFileSync(f, '# 素材内容\n步骤说明');
    expect(await readMaterial(f)).toContain('步骤说明');
    await expect(readMaterial(join(d, 'missing.md'))).rejects.toThrow('不存在');
  });
});

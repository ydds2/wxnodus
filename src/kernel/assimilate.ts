// src/kernel/assimilate.ts — 黑洞引擎同化器（技能同化）
// 通道 A：目录 100% 同化（确定性，无需 AI）——扫描指定目录的全部技能格式
//         （标准 SKILL.md / 跨品牌 .claude/.agents/.codex/.gemini / skill.md 变体），
//         规范化 frontmatter → 写入 data/skills/<name>/，附带资源一并复制
// 通道 B：素材 AI 消化——文件/URL/最近对话素材 → LLM 提炼 SKILL.md 工作流 →
//         writeSkill（ai_generated: true 强制标注，深度合成办法）
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseSkillMd, writeSkill } from './skills.js';

export interface SkillSource {
  /** 技能目录（含 SKILL.md 或变体文件） */
  dir: string;
  /** 技能定义文件路径 */
  file: string;
  /** 技能名（目录名兜底） */
  name: string;
  format: 'standard' | 'variant';
}

export interface AssimilateResult {
  assimilated: Array<{ name: string; from: string; to: string }>;
  skipped: Array<{ name: string; from: string; reason: string }>;
  invalid: Array<{ file: string; reason: string }>;
}

export interface AssimilateOptions {
  /** 同名已存在时覆盖（默认跳过） */
  force?: boolean;
}

// ── 扫描：递归识别目录中的全部技能源 ──
// 识别规则：
//   目录含 SKILL.md / skill.md（任意大小写）→ 技能（standard/variant）
//   游离 md 文件含 frontmatter 且 name+description 齐全 → 技能变体
// 忽略：node_modules / .git / 隐藏目录（.claude 等跨品牌目录本身要扫——白名单例外）
export function scanSkillSources(dir: string): SkillSource[] {
  const out: SkillSource[] = [];
  const seen = new Set<string>();
  const walk = (d: string, depth: number): void => {
    if (depth > 8) return; // 深度上限防目录爆炸
    let entries: string[] = [];
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      if (e === 'node_modules' || e === '.git' || e === 'dist' || e === 'build') continue;
      const p = join(d, e);
      let st: ReturnType<typeof statSync>;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        const skillFile = ['SKILL.md', 'skill.md'].map(f => join(p, f)).find(f => existsSync(f));
        if (skillFile) {
          const key = skillFile.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            // Windows 文件系统大小写不敏感（skill.md 与 SKILL.md 同文件）——目录型统一 standard
            out.push({ dir: p, file: skillFile, name: basename(p), format: 'standard' });
          }
          continue; // 技能目录内部不再递归
        }
        walk(p, depth + 1);
      } else if (e.toLowerCase().endsWith('.md')) {
        // 游离 md 变体：必须含完整 frontmatter（name + description）才收——防误收普通文档
        const key = p.toLowerCase();
        if (seen.has(key)) continue;
        try {
          const text = readFileSync(p, 'utf8');
          const { meta } = parseSkillMd(text);
          if (meta.name && meta.description) {
            seen.add(key);
            out.push({ dir: d, file: p, name: meta.name, format: 'variant' });
          }
        } catch { /* 读取失败跳过 */ }
      }
    }
  };
  walk(dir, 0);
  return out;
}

/** 正文首段提取（frontmatter description 缺失时兜底） */
function extractDesc(body: string): string {
  const line = body.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#') && !l.startsWith('>') && !l.startsWith('|'));
  return (line ?? '').slice(0, 120);
}

// ── 通道 A：目录 100% 同化（确定性批量吸收）──
export function assimilateDir(dataDir: string, dir: string, opts: AssimilateOptions = {}): AssimilateResult {
  const result: AssimilateResult = { assimilated: [], skipped: [], invalid: [] };
  const sources = scanSkillSources(dir);
  if (!sources.length) {
    result.invalid.push({ file: dir, reason: '未识别到任何技能（需要 SKILL.md 或带 frontmatter 的 md 文档）' });
    return result;
  }
  const done = new Set<string>(); // 同批同名去重（首见优先）
  for (const src of sources) {
    try {
      const text = readFileSync(src.file, 'utf8');
      const { meta, body } = parseSkillMd(text);
      const name = (meta.name || src.name).trim().replace(/[\\/:"*?<>|]/g, '_');
      if (!name) { result.invalid.push({ file: src.file, reason: '技能名缺失' }); continue; }
      if (done.has(name.toLowerCase())) continue; // 同批同名（大小写不敏感）跳过
      done.add(name.toLowerCase());
      const desc = (meta.description || extractDesc(body)).trim();
      if (!desc && !body.trim()) { result.invalid.push({ file: src.file, reason: '无描述且正文为空' }); continue; }
      const target = join(dataDir, 'skills', name);
      if (existsSync(join(target, 'SKILL.md')) && !opts.force) {
        result.skipped.push({ name, from: src.file, reason: '同名技能已存在（--force 覆盖）' });
        continue;
      }
      // 同化：先复制整个技能目录（附带资源/脚本），再写入规范化 SKILL.md（覆盖）
      mkdirSync(target, { recursive: true });
      try { cpSync(src.dir, target, { recursive: true }); } catch { /* 附带资源复制失败不阻断 */ }
      const front = ['---', `name: "${name}"`, `description: "${desc}"`];
      if (meta.version) front.push(`version: "${meta.version}"`);
      if (meta.flow) front.push(`flow: "${meta.flow}"`);
      if (meta.effort) front.push(`effort: "${meta.effort}"`);
      if (meta.ai_generated === 'true') front.push('ai_generated: true');
      front.push('---', '');
      writeFileSync(join(target, 'SKILL.md'), front.join('\n') + '\n' + body.trim() + '\n', 'utf8');
      result.assimilated.push({ name, from: src.file, to: target });
    } catch (e: any) {
      result.invalid.push({ file: src.file, reason: String(e?.message ?? e).slice(0, 120) });
    }
  }
  return result;
}

// ── 通道 B：素材 AI 消化（LLM 提炼 SKILL.md）──
export interface DigestMaterialOptions {
  name: string;
  description?: string;
  /** LLM 回调（命令层注入真实调用 / 测试注入 mock）——只收文本输出 */
  llm: (prompt: string) => Promise<string>;
  flow?: string;
  effort?: 'low' | 'medium' | 'high';
}

export async function assimilateMaterial(dataDir: string, material: string, opts: DigestMaterialOptions): Promise<string> {
  const prompt = `你是 WxNodus 黑洞引擎的技能同化器。把以下素材消化提炼为可复用的技能工作流。
技能名：${opts.name}
${opts.description ? `技能描述：${opts.description}` : ''}
要求：
- 只输出 Markdown 工作流正文（分步、可执行、中文），不要多余说明
- 输出可用 \`## 节点: <名>\` 分段（配合 flow 字段驱动 /flow 流程）
素材（最多 12000 字符）：
${material.slice(0, 12000)}`;
  const workflow = (await opts.llm(prompt)).trim() || '1. 理解任务 2. 制定步骤 3. 执行并验证';
  return writeSkill(dataDir, opts.name, opts.description ?? opts.name, workflow, {
    aiGenerated: true, // 深度合成办法：AI 生成技能强制标注
    flow: opts.flow,
  });
}

/** 读取素材（本地文件 / URL——URL 经 SSRF 三层防护） */
export async function readMaterial(input: string): Promise<string> {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const { safeFetchText } = await import('./ssrf.js');
    const r = await safeFetchText(trimmed);
    if ('error' in r) throw new Error(`URL 抓取被拦截：${r.error}`);
    if (r.text.length > 200_000) throw new Error('素材过大（>200KB）——请分段或截取核心内容');
    return r.text;
  }
  if (!existsSync(trimmed)) throw new Error(`素材不存在：${trimmed}`);
  const st = statSync(trimmed);
  if (st.size > 200_000) throw new Error('素材过大（>200KB）——请分段或截取核心内容');
  return readFileSync(trimmed, 'utf8');
}

// src/kernel/skills.ts — L2-5 本地技能生态（SKILL.md，agentskills.io 兼容子集）
// 设计：本地优先——技能 = 目录下的 SKILL.md（YAML frontmatter + Markdown 正文），
//       发现目录按优先级：项目 <cwd>/.wxnodus/skills → 用户 <dataDir>/skills → forge 生成物
//       全部本地文件操作，不依赖外部技能市场；frontmatter 仅标量键，手写解析零依赖
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, cpSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface SkillMeta {
  name: string;
  description: string;
  version?: string;
  aiGenerated?: boolean;
  source: 'project' | 'user' | 'forge';
  path: string;
  /** 流程节点链（frontmatter flow: "A → B"）——/flow 驱动 */
  flow?: string;
}

export interface LoadedSkill {
  meta: SkillMeta;
  body: string;
}

const SKILL_FILE = 'SKILL.md';

// ── frontmatter 解析（`---` 分隔 + `key: value` 标量，支持引号）──
export function parseSkillMd(text: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta, body: text };

  for (const raw of m[1]!.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    let value = line.slice(idx + 1).trim();
    // 引号包裹的标量（"..." 或 '...'）
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body: (m[2] ?? '').trim() };
}

// ── 技能发现（三级目录，返回全部元信息）────────────
export function discoverSkills(dataDir: string, cwd: string): SkillMeta[] {
  const out: SkillMeta[] = [];
  const seen = new Set<string>();

  const collect = (base: string, source: SkillMeta['source']) => {
    if (!existsSync(base)) return;
    let entries: string[] = [];
    try { entries = readdirSync(base); } catch { return; }
    for (const name of entries) {
      const dir = join(base, name);
      const skillFile = join(dir, SKILL_FILE);
      if (!statSync(dir).isDirectory() || !existsSync(skillFile)) continue;
      const text = readFileSync(skillFile, 'utf8');
      const { meta } = parseSkillMd(text);
      const key = (meta.name || name).toLowerCase();
      if (seen.has(key)) continue; // 项目级优先，同名校验去重
      seen.add(key);
      out.push({
        name: meta.name || name,
        description: meta.description || '',
        version: meta.version,
        aiGenerated: meta.ai_generated === 'true',
        source,
        path: dir,
      });
    }
  };

  // 优先级：项目 → 用户 → forge 产物
  collect(join(cwd, '.wxnodus', 'skills'), 'project');
  collect(join(dataDir, 'skills'), 'user');
  if (existsSync(join(dataDir, 'forge'))) {
    try {
      for (const p of readdirSync(join(dataDir, 'forge'))) {
        collect(join(dataDir, 'forge', p), 'forge');
      }
    } catch { /* 忽略 */ }
  }
  return out;
}

// ── 按名加载（返回正文 + 元信息；未找到返回 null）────
export function loadSkill(dataDir: string, cwd: string, name: string): LoadedSkill | null {
  const needle = name.toLowerCase().trim();
  if (!needle) return null;
  const dirs: Array<{ base: string; source: SkillMeta['source'] }> = [
    { base: join(cwd, '.wxnodus', 'skills'), source: 'project' },
    { base: join(dataDir, 'skills'), source: 'user' },
  ];
  // forge 产物（data/forge/<pkg>/<name>/SKILL.md）
  const forgeBase = join(dataDir, 'forge');
  if (existsSync(forgeBase)) {
    try {
      for (const p of readdirSync(forgeBase)) {
        dirs.push({ base: join(forgeBase, p), source: 'forge' });
      }
    } catch { /* 忽略 */ }
  }
  for (const { base, source } of dirs) {
    const dir = join(base, name);
    const skillFile = join(dir, SKILL_FILE);
    if (!existsSync(skillFile)) continue;
    const text = readFileSync(skillFile, 'utf8');
    const { meta, body } = parseSkillMd(text);
    return {
      meta: { name: meta.name || name, description: meta.description || '', version: meta.version, aiGenerated: meta.ai_generated === 'true', source, path: dir },
      body,
    };
  }
  return null;
}

// ── 安装（复制本地目录到用户级技能库）──────────────
export function installSkill(dataDir: string, srcDir: string): string {
  if (!existsSync(srcDir) || !existsSync(join(srcDir, SKILL_FILE))) {
    throw new Error(`不是有效技能目录（缺 ${SKILL_FILE}）：${srcDir}`);
  }
  const { meta } = parseSkillMd(readFileSync(join(srcDir, SKILL_FILE), 'utf8'));
  const name = meta.name || srcDir.split(/[\\/]/).pop() || 'skill';
  const target = join(dataDir, 'skills', name);
  mkdirSync(target, { recursive: true });
  cpSync(srcDir, target, { recursive: true });
  return target;
}

// ── 创建技能（/skill new 与 /learn 共用）────────────
export function writeSkill(dataDir: string, name: string, description: string, workflow: string, opts: { aiGenerated?: boolean; flow?: string } = {}): string {
  const dir = join(dataDir, 'skills', name);
  mkdirSync(dir, { recursive: true });
  const front = [
    '---',
    `name: "${name}"`,
    `description: "${description}"`,
  ];
  if (opts.flow) front.push(`flow: "${opts.flow}"`);
  if (opts.aiGenerated) front.push('ai_generated: true');
  front.push('---', '');
  const body = [
    `# ${name}`,
    opts.aiGenerated ? '> ⚠️ AI 生成标注（深度合成办法 第二十条）' : '',
    '## 目标',
    description,
    '## 工作流',
    workflow,
  ].filter(Boolean).join('\n');
  writeFileSync(join(dir, SKILL_FILE), front.join('\n') + '\n' + body + '\n', 'utf8');
  return dir;
}

// ── Flow skills（P2）：从 SKILL.md 解析节点流程 ──
// frontmatter flow: "准备 → 构建 → 部署"（→ 分隔节点链）
// 正文每节点一段：## 节点: 准备 + 执行说明
export interface FlowNode { name: string; instruction: string }

export function parseFlow(skillBody: string, flowField: string | undefined): FlowNode[] | null {
  const names = (flowField ?? '').split(/→|->/).map(n => n.trim()).filter(Boolean);
  if (!names.length) return null;
  // 按 ## 节点: <名> 分段提取指令
  const sections = new Map<string, string>();
  const re = /^##\s*节点\s*[:：]\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  let lastKey: string | null = null;
  const lines = skillBody.split(/\r?\n/);
  for (const line of lines) {
    const hit = re.exec(line);
    if (hit) { lastKey = hit[1]!.trim(); sections.set(lastKey, ''); continue; }
    if (lastKey) sections.set(lastKey, (sections.get(lastKey) ?? '') + line + '\n');
  }
  return names.map(name => ({ name, instruction: (sections.get(name) ?? '（节点无说明，按名称执行）').trim() }));
}

// ── 技能工具：注入 SKILL.md 正文给模型（≤8000 字符）──
export function skillContentForModel(dataDir: string, cwd: string, name: string): string {
  const s = loadSkill(dataDir, cwd, name);
  if (!s) return '';
  const head = `[技能 ${s.meta.name}] ${s.meta.description}\n`;
  return (head + s.body).slice(0, 8000);
}

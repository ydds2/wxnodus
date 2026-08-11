// src/kernel/repoMap.ts — P3: 仓库地图（aider repo-map 自研轻量版，无 tree-sitter 依赖）
// 设计：扫描工作区（过滤黑名单目录/二进制/超大文件）→ 按语言正则启发式提取符号
//       （函数/类/接口/导出声明）→ 按符号量排序 → 按 token 预算截断渲染。
//       供 /map 命令与 repo_map 工具使用（模型获得项目结构先验，参照 aider 的
//       repo map 思想：先看地图再动代码，减少盲目搜索）。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, relative, sep } from 'node:path';

export interface RepoMapFile {
  /** 相对路径（正斜杠分隔） */
  path: string;
  /** 提取的符号声明行 */
  symbols: string[];
  /** 排序权重（符号数；同权按路径字典序保证确定性） */
  weight: number;
}

export interface RepoMapResult {
  /** 渲染后的地图文本（已按预算截断） */
  map: string;
  /** 预算内文件（全量映射表，供调试） */
  files: RepoMapFile[];
  /** 扫描文件总数 */
  scanned: number;
  /** 跳过文件数（黑名单/二进制/超大） */
  skipped: number;
  /** 因预算截断的文件数 */
  truncated: number;
}

// 黑名单目录（任意层级命中即跳过——含 .git 与常见构建产物）
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'coverage', 'build', 'out', '.next', '.nuxt',
  '.venv', 'venv', '__pycache__', '.wxnodus', '.zcode', 'data', '.idea', '.vscode',
]);
// 二进制/无关扩展（跳过）
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svgz',
  '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib',
  '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.avi', '.mov',
  '.db', '.sqlite', '.sqlite3', '.lock', '.map', '.min.js', '.wasm',
]);
const MAX_FILE_BYTES = 1_000_000;
const SYMBOL_LINE_MAX = 120;

// ── 语言符号启发式（每行声明匹配，取整行）────────────
const SYMBOL_PATTERNS: Array<{ exts: string[]; re: RegExp }> = [
  // TS/JS 家族：函数/类/接口/类型/枚举/导出箭头函数
  { exts: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'], re: /^(export\s+(default\s+)?)?(async\s+)?(function\s+\w+|class\s+\w+|interface\s+\w+|type\s+\w+\s*=|enum\s+\w+|abstract\s+class\s+\w+|\w+\s*=\s*(async\s*)?\([\w\s,=:?[\]]*\)\s*=>|const\s+\w+\s*=\s*(async\s*)?\([\w\s,=:?[\]]*\)\s*=>)/ },
  // Python：def/class
  { exts: ['.py'], re: /^(async\s+def\s+\w+|def\s+\w+|class\s+\w+)/ },
  // Go：func/type struct/interface
  { exts: ['.go'], re: /^(func\s+\([^)]*\)\s*\w+\(|func\s+\w+\(|type\s+\w+\s+(struct|interface)\b)/ },
  // Rust：fn/struct/enum/trait/impl
  { exts: ['.rs'], re: /^(pub\s+)?(async\s+)?(fn\s+\w+|struct\s+\w+|enum\s+\w+|trait\s+\w+|impl\b)/ },
  // Java：类/接口/枚举/方法（public/private/protected/static 前缀）
  { exts: ['.java'], re: /^(public|private|protected)\s+(static\s+)?(final\s+)?(class\s+\w+|interface\s+\w+|enum\s+\w+|\w+[\w<>,\s]*\s+\w+\s*\()/ },
  // C/C++：函数签名/typedef/struct/enum/class
  { exts: ['.c', '.h', '.cpp', '.cc', '.hpp', '.cxx'], re: /^(static\s+|inline\s+|const\s+)?[\w:*<>,\s]+\s+\w+\s*\([^;]*\)\s*\{?$|^(typedef|struct|enum|class|union)\s+\w+/ },
  // Shell：函数
  { exts: ['.sh', '.bash'], re: /^\w+\s*\(\s*\)\s*\{/ },
  // Markdown/文档不做符号提取（跳过渲染，仅登记文件名）
];

function langIndex(file: string): number {
  const e = extname(file).toLowerCase();
  for (let i = 0; i < SYMBOL_PATTERNS.length; i++) {
    if (SYMBOL_PATTERNS[i]!.exts.includes(e)) return i;
  }
  return -1;
}

/** 提取单个文件的符号声明行（按语言启发式；无匹配语言返回空） */
export function extractSymbols(filePath: string, content: string): string[] {
  const idx = langIndex(filePath);
  if (idx < 0) return [];
  const re = SYMBOL_PATTERNS[idx]!.re;
  const out: string[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    if (re.test(line)) {
      out.push(line.length > SYMBOL_LINE_MAX ? line.slice(0, SYMBOL_LINE_MAX) + '…' : line);
    }
  }
  return out;
}

function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith('.');
}

function walk(dir: string, cwd: string, files: Array<{ abs: string; rel: string }>, skipped: { n: number }): void {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (shouldSkipDir(e.name)) continue;
      walk(join(dir, e.name), cwd, files, skipped);
    } else if (e.isFile()) {
      const abs = join(dir, e.name);
      const rel = relative(cwd, abs).split(sep).join('/');
      const low = e.name.toLowerCase();
      if (BINARY_EXT.has(extname(low))) { skipped.n++; continue; }
      if (low.endsWith('.min.js') || low.startsWith('.')) { skipped.n++; continue; }
      let size = 0;
      try { size = statSync(abs).size; } catch { continue; }
      if (size > MAX_FILE_BYTES) { skipped.n++; continue; }
      files.push({ abs, rel });
    }
  }
}

/**
 * 构建仓库地图。
 * @param cwd 工作区根
 * @param opts.budgetTokens 预算（约 chars/4 折算 token，默认 2000）
 * @param opts.maxFiles 参与排序的最大文件数（默认 500，防超大仓库卡顿）
 */
export function buildRepoMap(cwd: string, opts: { budgetTokens?: number; maxFiles?: number } = {}): RepoMapResult {
  const budget = Math.max(100, Math.floor(opts.budgetTokens ?? 2000) * 4); // 预算字符数
  const maxFiles = Math.max(1, Math.floor(opts.maxFiles ?? 500));
  const files: Array<{ abs: string; rel: string }> = [];
  const skipped = { n: 0 };
  walk(cwd, cwd, files, skipped);

  // 先读内容提取符号；再统计符号名全仓引用次数（aider 依赖图排序的轻量近似——
  // 被引用越多的符号所在文件越核心，如入口/工具层优先入预算）
  const readContent = (f: { abs: string; rel: string }): string => {
    try { return readFileSync(f.abs, 'utf8').slice(0, MAX_FILE_BYTES); } catch { return ''; }
  };
  const firstIdentifier = (line: string): string => {
    const m = /[A-Za-z_$][\w$]*/.exec(line.replace(/^(export\s+(default\s+)?|async\s+|function\s+|class\s+|interface\s+|type\s+|enum\s+|const\s+|def\s+|pub\s+|fn\s+|func\s+)/, ''));
    return m ? m[0] : '';
  };
  const contents = files.slice(0, maxFiles).map(f => ({ f, content: readContent(f) }));
  const refCount = new Map<string, number>();
  for (const { content } of contents) {
    for (const m of content.matchAll(/\b[A-Za-z_$][\w$]{2,}\b/g)) {
      refCount.set(m[0], (refCount.get(m[0]) ?? 0) + 1);
    }
  }
  const mapped: RepoMapFile[] = contents.map(({ f, content }) => {
    const symbols = extractSymbols(f.rel, content);
    // 权重 = 符号数 × 10 + 本文件符号的全仓引用次数（图排序近似）
    let refs = 0;
    for (const s of symbols) {
      const id = firstIdentifier(s);
      if (id) refs += refCount.get(id) ?? 0;
    }
    return { path: f.rel, symbols, weight: symbols.length * 10 + refs };
  }).sort((a, b) => b.weight - a.weight || (a.path < b.path ? -1 : 1));

  // 渲染 + 预算截断
  const linesOut: string[] = ['# 仓库地图（符号索引，token 预算内）'];
  let used = linesOut[0]!.length;
  let truncated = 0;
  const included: RepoMapFile[] = [];
  for (const f of mapped) {
    const block: string[] = [];
    if (f.symbols.length) {
      block.push(`## ${f.path}`, ...f.symbols.map(s => `  ${s}`));
    } else {
      block.push(`## ${f.path}（无符号——普通数据/资源）`);
    }
    const blockLen = block.join('\n').length + 1;
    if (used + blockLen > budget) { truncated++; continue; }
    linesOut.push(...block);
    used += blockLen;
    included.push(f);
  }
  if (truncated > 0) linesOut.push(`…（预算截断：${truncated} 个文件未纳入，/map <更大的预算> 查看完整）`);

  return {
    map: linesOut.join('\n'),
    files: included,
    scanned: files.length,
    skipped: skipped.n,
    truncated,
  };
}

// src/kernel/projectScan.ts — L2-7 /init 项目分析（本地扫描生成 AGENTS.md）
// 设计：确定性本地扫描（不依赖模型）——读取真实文件内容生成结构化项目概览，
//       内容是真实扫描结果（构建命令/测试命令/目录结构），非假数据。
//       有 key 时可经 /init --ai 用模型润色（可选，默认纯本地）。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface ProjectProfile {
  type: string;
  buildCmd: string;
  testCmd: string;
  runCmd: string;
  structure: string[];
  readme: string;
  manifest: Record<string, string>;
}

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__', '.venv', 'venv', 'target', '.idea', '.vscode', 'data', '.wxnodus', 'coverage']);

function safeRead(p: string, limit = 2000): string {
  try { return readFileSync(p, 'utf8').slice(0, limit); } catch { return ''; }
}

// 扫描顶层目录与关键清单文件
export function scanProject(cwd: string): ProjectProfile {
  const structure: string[] = [];
  try {
    for (const entry of readdirSync(cwd)) {
      if (IGNORED.has(entry) || entry.startsWith('.')) continue;
      const full = join(cwd, entry);
      const isDir = statSync(full).isDirectory();
      structure.push(isDir ? `${entry}/` : entry);
    }
  } catch { /* 不可读目录 */ }

  let type = '未知';
  let buildCmd = '';
  let testCmd = '';
  let runCmd = '';
  const manifest: Record<string, string> = {};

  // package.json（Node/TS）
  if (existsSync(join(cwd, 'package.json'))) {
    type = 'Node.js/TypeScript';
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
      const scripts: Record<string, string> = pkg.scripts ?? {};
      manifest['名称'] = String(pkg.name ?? '');
      buildCmd = scripts.build ? `npm run build` : (scripts.compile ? `npm run compile` : '（无构建脚本）');
      testCmd = scripts.test ? `npm test` : (scripts['test:unit'] ? `npm run test:unit` : '（无测试脚本）');
      runCmd = scripts.start ? `npm start` : (scripts.dev ? `npm run dev` : '（无启动脚本）');
    } catch { /* JSON 解析失败 */ }
  }

  // pyproject.toml / requirements.txt（Python）
  if (existsSync(join(cwd, 'pyproject.toml'))) {
    type = 'Python';
    buildCmd = 'pip install -e .';
    testCmd = existsSync(join(cwd, 'pytest.ini')) || existsSync(join(cwd, 'pyproject.toml')) ? 'pytest' : '（无测试脚本）';
    runCmd = 'python -m <模块>';
  } else if (existsSync(join(cwd, 'requirements.txt'))) {
    type = 'Python';
    buildCmd = 'pip install -r requirements.txt';
    testCmd = '（无测试脚本）';
  }

  // go.mod（Go）
  if (existsSync(join(cwd, 'go.mod'))) {
    type = 'Go';
    buildCmd = 'go build ./...';
    testCmd = 'go test ./...';
    runCmd = 'go run .';
  }

  // Cargo.toml（Rust）
  if (existsSync(join(cwd, 'Cargo.toml'))) {
    type = 'Rust';
    buildCmd = 'cargo build';
    testCmd = 'cargo test';
    runCmd = 'cargo run';
  }

  // 其他清单
  if (existsSync(join(cwd, 'tsconfig.json'))) manifest['TypeScript'] = 'tsconfig.json 存在';
  if (existsSync(join(cwd, 'README.md'))) manifest['README'] = '存在';
  else if (existsSync(join(cwd, 'readme.md'))) manifest['README'] = '存在（小写）';

  const readme = safeRead(existsSync(join(cwd, 'README.md')) ? join(cwd, 'README.md') : join(cwd, 'readme.md'), 1500);

  return { type, buildCmd, testCmd, runCmd, structure: structure.slice(0, 40), readme, manifest };
}

// 生成 AGENTS.md（中文确定性模板）
export function renderAgentsMd(profile: ProjectProfile): string {
  const lines: string[] = [
    '# AGENTS.md',
    '',
    '> 由 wxnodus `/init` 本地扫描生成（确定性结果，可 `--overwrite` 重新生成）。',
    '',
    '## 项目概览',
    '',
    `- 类型：${profile.type}`,
    ...Object.entries(profile.manifest).filter(([, v]) => v).map(([k, v]) => `- ${k}：${v}`),
    '',
    '## 常用命令',
    '',
    `- 构建：${profile.buildCmd || '（未检测到）'}`,
    `- 测试：${profile.testCmd || '（未检测到）'}`,
    `- 运行：${profile.runCmd || '（未检测到）'}`,
    '',
    '## 目录结构（顶层）',
    '',
    '```',
    ...profile.structure.map(e => ` ${e}`),
    '```',
    '',
  ];

  if (profile.readme.trim()) {
    lines.push('## README 摘要', '', '> 自动截取，完整内容见 README.md', '', profile.readme.trim().slice(0, 1200), '', '');
  }

  lines.push(
    '## 约定',
    '',
    '- 修改代码前先阅读相关文件，保持现有风格',
    '- 改动后运行测试命令验证',
    '- 生成/修改文件遵循仓库既有结构',
    '',
  );

  return lines.join('\n');
}

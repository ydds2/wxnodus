// W6「装上能跑对」冒烟自校验脚本（V4 P3-5）——干净安装树冒烟：
// 1) 根 package.json 存在且 version 非 0.0.0、type=module
// 2) node <entry> --version 输出非 0.0.0
// 3) manifest buildAbi 与当前 ABI 一致
// 用法：node smoke-installed.mjs <安装根目录> <entry相对路径>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.argv[2];
const entry = process.argv[3] ?? 'dist/cli/index.js';
const fail = (code, msg) => { console.error(`SMOKE_FAIL(${code}): ${msg}`); process.exit(1); };

// ① 根 package.json
let pkg;
try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); }
catch { fail('NO_ROOT_PKG', '安装树缺根 package.json——--version 将恒 0.0.0 且低版 Node 按 CJS 解析 ESM 崩'); }
if (pkg.type !== 'module') fail('PKG_NOT_ESM', `type=${pkg.type}（须 module）`);
if (!pkg.version || pkg.version === '0.0.0') fail('VERSION_ZERO', `version=${pkg.version}`);

// ② manifest ABI
try {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  if (manifest.buildAbi && manifest.buildAbi !== Number(process.versions.modules)) {
    fail('ABI_MISMATCH', `manifest ${manifest.buildAbi} vs local ${process.versions.modules}`);
  }
} catch (e) { if (String(e.code) !== 'ENOENT') fail('MANIFEST_BAD', String(e.message)); }

// ③ 入口 --version 冒烟
try {
  const out = execFileSync('node', [join(root, entry), '--version'], { encoding: 'utf8', timeout: 30_000 }).trim();
  if (!out || out === '0.0.0' || out === 'undefined') fail('ENTRY_VERSION_BAD', `--version → ${out}`);
  console.log(`SMOKE_OK: version=${out} abi=${process.versions.modules}`);
} catch (e) { fail('ENTRY_CRASH', String(e.message).slice(0, 200)); }

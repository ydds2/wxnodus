// W6「装上能跑对」冒烟自校验脚本（V4 P3-5）——干净安装树冒烟：
// 1) 根 package.json 存在且 version 非 0.0.0、type=module
// 2) node <entry> --version 输出非 0.0.0
// 3) manifest ABI 与本机一致（或本机 ABI 在 nativeAbis 侧车清单内——V4 C1 多 ABI 安装合法态）
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

// ② manifest ABI（V4 C1：侧车安装允许「本机 ABI ∈ manifest.nativeAbis」——Node 24 装 127 打包 + 137 侧车是合法态）
try {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const localAbi = Number(process.versions.modules);
  const sidecarHit = Array.isArray(manifest.nativeAbis) && manifest.nativeAbis.some(s => Number(s.abi) === localAbi);
  if (manifest.buildAbi && manifest.buildAbi !== localAbi && !sidecarHit) {
    fail('ABI_MISMATCH', `manifest ${manifest.buildAbi} vs local ${localAbi}（且无 ${localAbi} 侧车）`);
  }
  if (manifest.buildAbi && manifest.buildAbi !== localAbi && sidecarHit) {
    console.log(`SMOKE_ABI_SIDECAR: manifest ${manifest.buildAbi} vs local ${localAbi}（${localAbi} 侧车已声明）`);
  }
} catch (e) { if (String(e.code) !== 'ENOENT') fail('MANIFEST_BAD', String(e.message)); }

// ③ 入口 --version 冒烟
try {
  const out = execFileSync('node', [join(root, entry), '--version'], { encoding: 'utf8', timeout: 30_000 }).trim();
  if (!out || out === '0.0.0' || out === 'undefined') fail('ENTRY_VERSION_BAD', `--version → ${out}`);
  console.log(`SMOKE_OK: version=${out} abi=${process.versions.modules}`);
} catch (e) { fail('ENTRY_CRASH', String(e.message).slice(0, 200)); }

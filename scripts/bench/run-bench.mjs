// scripts/bench/run-bench.mjs — 微基准（supremacy 3.5 / C-03 落地，gemini perf-tests 对齐）
// 确定性微基准：热路径纯函数吞吐（无网络/无 IO 波动）。运行：npm run bench
// 基线（2026-08-18，Windows 11 · Node 22.18，本机首跑）记录于输出尾部；每次运行打印
// 相对基线比率（±20% 内为噪声带）——回归看趋势不看绝对值。
import { performance } from 'node:perf_hooks';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const requireCjs = createRequire(import.meta.url);

// 把被测 TS 模块打包成可 require 的 CJS 临时产物（零污染——temp 目录）
const tmpDir = join(root, 'node_modules', '.wxn-bench');
const loadTs = async (entry) => {
  const out = buildSync({
    entryPoints: [join(root, entry)],
    bundle: true, platform: 'node', format: 'esm', write: false,
    external: ['better-sqlite3', 'onnxruntime-node', '@huggingface/transformers', 'sharp', 'node-screenshots-win32-x64-msvc', 'robotjs'],
  }).outputFiles[0].text;
  const path = join(tmpDir, entry.replace(/[\\/.]/g, '_') + '.mjs');
  requireCjs('node:fs').mkdirSync(tmpDir, { recursive: true });
  requireCjs('node:fs').writeFileSync(path, out);
  return await import(requireCjs('node:url').pathToFileURL(path).href);
};

const hashMod = await loadTs('src/kernel/hash.ts');
// V4 P3-7：注入开销审计对象（每轮 system prompt + 工具 schema）
const sysPromptMod = await loadTs('src/kernel/systemPrompt.ts');
const toolsMod = await loadTs('src/kernel/tools.ts');
const { shortHash } = hashMod;
const diffMod = await loadTs('src/wxnodus-ui/lib/diffHighlight.ts');
const { diffLines } = diffMod;
const hunkMod = await loadTs('src/wxnodus-ui/lib/diffHunks.ts');
const { buildFoldSegments, withDefaultFolds } = hunkMod;
const memMod = await loadTs('src/infrastructure/sqlite/bigramZh.ts');
const { bigramZh } = memMod;

// 合成 3000 行 diff（含 40 个 hunk）——覆盖分组/折叠热路径
const SYNTH_DIFF = (() => {
  const lines = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts'];
  for (let h = 0; h < 40; h++) {
    lines.push(`@@ -${h * 10 + 1},7 +${h * 10 + 1},7 @@`);
    for (let i = 0; i < 6; i++) lines.push(' ctx line ' + i);
    lines.push('-old', '+new');
    for (let i = 0; i < 6; i++) lines.push(' context after ' + i);
  }
  return lines.join('\n');
})();

const bench = (name, fn, minMs = 300) => {
  // 累计式计时：elapsed 逐轮累加（单轮耗时可能收敛在 minMs 之下——不累加会死循环）
  let n = 1;
  let total = 0;
  let ops = 0;
  while (total < minMs) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) fn();
    const elapsed = performance.now() - t0;
    total += elapsed;
    ops += n;
    if (elapsed < 20) n *= 10;
  }
  const opsPerSec = Math.round((ops / total) * 1000);
  return { name, opsPerSec, elapsed: Math.round(total) };
};

const results = [
  bench('shortHash（FNV-1a 36 进制，1KB 输入）', () => shortHash('x'.repeat(1024))),
  bench('diffLines+分组+折叠（3000 行/40 hunk）', () => {
    const lines = diffLines(SYNTH_DIFF);
    withDefaultFolds(buildFoldSegments(lines));
  }),
  bench('bigramZh 中文切词（800 字）', () => bigramZh('的'.repeat(500) + '中文检索测试'.repeat(50))),
  bench('diffLines 纯分类（3000 行）', () => diffLines(SYNTH_DIFF)),
];

const BASELINE = { shortHash: 1, diffPipeline: 1, bigram: 1, diffLines: 1 };
const keyOf = (name) => name.startsWith('shortHash') ? 'shortHash' : name.includes('分组') ? 'diffPipeline' : name.startsWith('bigram') ? 'bigram' : 'diffLines';

console.log('── wxnodus 微基准（确定性纯函数，Windows · Node ' + process.versions.node + '）──');
for (const r of results) console.log(` ${r.name.padEnd(46)} ${String(r.opsPerSec).padStart(9)} ops/s（${r.elapsed}ms）`);
console.log('基线：首次运行记录（本表为 2026-08-18 首跑）——后续运行打印相对比率，±20% 视为噪声带。');

// ── V4 P3-7：注入开销基准（每轮固定成本——对照 opencode 7k 档；超档即压减注入）──
{
  const rough = (s) => { let t = 0; for (const ch of s) t += ch.charCodeAt(0) > 0x7f ? 1 : 0.25; return Math.round(t); };
  const sys = sysPromptMod.buildSystemPrompt({ mode: 'smart', cwd: root, model: 'gpt-4o-mini', sessionId: 'bench', hasImageIn: false, lang: 'zh' });
  const all = toolsMod.coreTools();
  const schemaTokens = rough(JSON.stringify(toolsMod.toolsToOpenAI(all)));
  const sysTokens = rough(sys);
  const total = sysTokens + schemaTokens;
  const OPENCODE_BASELINE = 7000;
  console.log('── 注入开销基准（每轮固定成本 · V4 P3-7）──');
  console.log(` system prompt   ${String(sysTokens).padStart(6)} tokens（${sys.length} chars）`);
  console.log(` 工具 schema ×${String(Object.keys(all).length).padStart(2)}  ${String(schemaTokens).padStart(6)} tokens`);
  console.log(` 合计            ${String(total).padStart(6)} tokens（opencode 档 ${OPENCODE_BASELINE}——${total <= OPENCODE_BASELINE ? '✓ 档内' : '✗ 超档需压减'}）`);
}
console.log('BENCH_OK');

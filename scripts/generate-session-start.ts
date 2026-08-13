// scripts/generate-session-start.ts — SessionStart 显式生成 demo：
// 用法：npm exec -- tsx scripts/generate-session-start.ts [sessionId] [--out <dir>]
// 产出：<out>/session-start.json（身份/locale/模型/钩子/能力 + sha256 绑定）
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SessionStartGenerator } from '../src/application/sessions/sessionStartGenerator.js';
import { readLocaleFile } from '../src/application/bootstrap/preBootstrapOnboarding.js';
import { resolveDataDir } from '../src/kernel/paths.js';

const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const outDir = outFlag >= 0 ? resolve(args[outFlag + 1] ?? '.') : process.cwd();
const sessionId = args.filter((arg, index) => arg !== '--out' && index !== outFlag + 1).find(arg => !arg.startsWith('--')) ?? `sess-${Date.now().toString(36)}`;
const dataDir = resolveDataDir(process.cwd());

const userConfig = join(dataDir, 'config.json');
const locale = (await readLocaleFile(userConfig)) ?? 'zh-CN';
const generator = new SessionStartGenerator({
  locale: () => locale,
  model: () => 'glm-4v-flash',
  dataDir: () => dataDir,
  hooks: () => [{ id: 'blackhole-recall', kind: 'on-session-start', enabled: true }],
  capabilities: () => ['process.execute', 'filesystem.read', 'memory.hybrid-recall'],
  now: () => new Date().toISOString(),
});
const generated = generator.generate(sessionId);
if (!generated.ok) {
  process.stderr.write(`SESSION_START_GENERATION_FAILED: ${generated.error.code}\n`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'session-start.json');
writeFileSync(outFile, `${JSON.stringify(generated.value, null, 2)}\n`, 'utf8');
process.stdout.write(`SessionStart 已生成：${outFile}\n${JSON.stringify({ sessionId, locale, sha256: generated.value.sha256 }, null, 2)}\n`);

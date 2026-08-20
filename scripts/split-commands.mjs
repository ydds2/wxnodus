// scripts/split-commands.mjs — handlersExt 巨文件拆分生成器（一次性工具，audit §13.46）
// 与上轮失败方案的区别：导入清单按「块内标识符实际用法」确定性生成——不依赖 tsc 迭代修剪。
// 用法：node scripts/split-commands.mjs（幂等可重跑；对 HEAD 状态工作）
import { readFileSync, writeFileSync } from 'node:fs';

const P = 'src/commands/handlersExt.ts';
const L = readFileSync(P, 'utf8').split('\n');
const findLine = (prefix) => L.findIndex(l => l.startsWith(prefix));
const b2Start = findLine('  // ── 会话类 ');
const b3Start = findLine('  // ── 档案体系');
const b4Start = findLine('  // ── 视觉类 ');
if (b2Start < 0 || b3Start < 0 || b4Start < 0) throw new Error('anchor missing');
const block2 = L.slice(b2Start, b3Start).join('\n');
const block3 = L.slice(b3Start, b4Start).join('\n');
const movedRegion = L.slice(41, 92).join('\n'); // scriptRecording/renderWaterfall/parse*
const stateText = movedRegion.slice(0, movedRegion.indexOf('export function renderWaterfall'));
const renderText = movedRegion.slice(movedRegion.indexOf('export function renderWaterfall'), movedRegion.indexOf('/** /profile add'));
const parseText = movedRegion.slice(movedRegion.indexOf('/** /profile add'));

// 1) 解析 HEAD 顶层 import（模块 → 名字列表）
const importLines = L.filter(l => /^import /.test(l));
const parseImport = (line) => {
  const m = line.match(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+'(.*)'/);
  if (!m) return null;
  return { mod: m[3], names: m[2].split(',').map(s => s.trim()).filter(Boolean) };
};
const entries = importLines.map(parseImport).filter(Boolean);

// 2) 按用法过滤：块文本（含被移动的模块级片段）中出现 \bname\b 即保留
const used = (text, name) => new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`).test(text);
function importsFor(text, keepExtRegisters = false) {
  const out = [];
  for (const e of entries) {
    if (!keepExtRegisters && /\.\/ext\//.test(e.mod)) continue;
    const kept = e.names.filter(n => used(text, n.replace(/^type\s+/, '')));
    if (kept.length) out.push(`import ${line.startsWith ? '' : ''}{ ${kept.join(', ')} } from '${e.mod}';`);
  }
  return out;
}
// 修正：type 前缀保留（上面丢掉了 `type ` 前缀信息——重做）
function importsFor2(text, keepExtRegisters = false, excludeMods = /never/) {
  const out = [];
  for (const raw of importLines) {
    const m = raw.match(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+'(.*)'/);
    if (!m) continue;
    const mod = m[3];
    if (!keepExtRegisters && /\.\/ext\//.test(mod)) continue;
    if (excludeMods.test(mod)) continue;
    const kept = m[2].split(',').map(s => s.trim()).filter(Boolean).filter(spec => used(text, spec.replace(/^type\s+/, '')));
    if (kept.length) out.push(`import ${m[1] ?? ''}{ ${kept.join(', ')} } from '${mod}';`);
  }
  return out;
}

// 3) 深路径化 + handlers 路径修正（ext 模块深一层）
const deepen = (line) => line
  .replace(/from '\.\.\//g, "from '../../")
  .replace(/from '\.\/handlers\.js'/g, "from '../handlers.js'")
  .replace(/from '\.\.\/app\/CommandBus\.js'/g, "from '../../app/CommandBus.js'");

const linesHelper = L.slice(36, 40).join('\n');
const ctxImport = (text) => {
  const need = [];
  if (/\bHandlerCtx\b/.test(text)) need.push('type HandlerCtx');
  if (/\bc\s*\(/.test(text)) need.push('c');
  if (/\bCommandBus\b/.test(text)) need.push('type CommandBus');
  if (/\bStructuredCommand\b/.test(text)) need.push('type StructuredCommand');
  return need;
};

const build = (name, block, extraText, header) => {
  const deepenedBlock = block.replace(/import\('\.\.\//g, "import('../../");
  const body = deepenedBlock + '\n' + extraText;
  const imports = importsFor2(body, false, /\.\/handlers\.js|\.\.\/app\/CommandBus\.js/).map(deepen);
  const ctx = ctxImport(body);
  const ctxLines = [];
  const hC = ['c', 'type HandlerCtx'].filter(x => ctx.includes(x));
  if (hC.length || true) ctxLines.push(`import { ${['c', 'type HandlerCtx'].filter(x => x === 'type HandlerCtx' || hC.includes(x)).join(', ')} } from '../handlers.js';`);
  const cmd = ['type CommandBus', 'type StructuredCommand'].filter(x => ctx.includes(x));
  if (cmd.length || true) ctxLines.push(`import { ${['type CommandBus', 'type StructuredCommand'].filter(x => x === 'type CommandBus' || cmd.includes(x)).join(', ')} } from '../../app/CommandBus.js';`);
  const content = `${header}\n${imports.join('\n')}\n${ctxLines.join('\n')}\n\n${linesHelper}\n\n${extraText}\n\nexport function ${name}(bus: CommandBus, ctx: HandlerCtx): void {\n${deepenedBlock}\n}\n`;
  writeFileSync(`src/commands/ext/${name === 'registerSessionCommands' ? 'sessionCommands' : 'profileMemoryBuildCommands'}.ts`, content);
  console.log(name, 'imports:', imports.length + ctxLines.length);
};

build('registerSessionCommands', block2, stateText + '\n' + renderText,
  '// src/commands/ext/sessionCommands.ts — 会话/系统工具类命令（handlersExt 巨文件拆分第 2 块，audit §13.46）\n// /resume /new /title /offline /undo /versions /snapshot /script /fork /checkpoint /reload-skills /map /init /usage /cost');
build('registerProfileMemoryBuildCommands', block3, parseText,
  '// src/commands/ext/profileMemoryBuildCommands.ts — 档案/余额/记忆/构建/安全/系统类命令（handlersExt 巨文件拆分第 3 块，audit §13.46）\n// /profile /balance /config /warp /fortune /context /compact /digest /curator /deploy /forge /skill /learn /assimilate /gate /fdr /evidence /sandbox /compliance /consent /audit /encrypt /lang /logs /bench');

// 4) handlersExt 重组：删两块 + 被移动片段；重算自身导入（用法过滤，单次确定）
const remaining = [...L.slice(0, 5), ...L.slice(36, 40), ...L.slice(92, b2Start), ...L.slice(b4Start)].join('\n');
const headBlock = [
  ...L.slice(0, 4), // 头部注释
  ...L.slice(36, 40), // lines 助手
];
const bodyTail = [...L.slice(92, b2Start), ...L.slice(b4Start)];
const bodyText = bodyTail.join('\n');
const filtered = importsFor2(bodyText, true, /never/);
const reexports = [
  '// renderWaterfall/parseProfileAddArgs/parseBalanceSetArgs 已迁至 ext 模块（拆分第 2/3 块 audit §13.46）——re-export 保持导入兼容',
  "export { renderWaterfall } from './ext/sessionCommands.js';",
  "export { parseProfileAddArgs, parseBalanceSetArgs } from './ext/profileMemoryBuildCommands.js';",
];
const calls = [
  '  // ── 会话/系统工具类已迁至 ext/sessionCommands.ts（拆分第 2 块 audit §13.46）──',
  '  registerSessionCommands(bus, ctx);',
  '  // ── 档案/记忆/构建/安全/系统类已迁至 ext/profileMemoryBuildCommands.ts（拆分第 3 块 audit §13.46）──',
  '  registerProfileMemoryBuildCommands(bus, ctx);',
];
// 插入 register 导入（若 filtered 未含——直接追加）
if (!filtered.some(l => l.includes('registerSessionCommands'))) filtered.push("import { registerSessionCommands } from './ext/sessionCommands.js';");
if (!filtered.some(l => l.includes('registerProfileMemoryBuildCommands'))) filtered.push("import { registerProfileMemoryBuildCommands } from './ext/profileMemoryBuildCommands.js';");
const out = [...headBlock, ...filtered, ...reexports, ...bodyTail].join('\n');
writeFileSync(P, out);
console.log('handlersExt lines now:', out.split('\n').length);

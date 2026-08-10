import { spawn } from 'node-pty';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'dist', 'cli', 'index.js');
let out = '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const strip = s => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
const typeKeys = async s => { for (const ch of s) { p.write(ch); await sleep(30); } };
const submit = async s => { await typeKeys(s); await sleep(120); p.write('\r'); };
const waitFor = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(500); } return fn(); };
const p = spawn(process.execPath, [BIN], { name: 'xterm-256color', cols: 110, rows: 30, cwd: ROOT, env: { ...process.env, TERM: 'xterm-256color' }, useConpty: false });
p.onData(d => { out += d; });
const results = [];
const check = (name, cond) => { results.push({ name, ok: cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); };
await sleep(2500);
// 插件命令 /example.hello
await submit('/example.hello 插件测试');
await waitFor(() => strip(out).includes('插件命令收到'));
check('插件命令 /example.hello 执行', strip(out).includes('插件命令收到'));
// AI 调用插件工具 example_greet（弹窗自动选 2）
await submit('请用 example_greet 工具对「wxnodus」用中文打招呼');
let approved = false;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  const s = strip(out);
  if (!approved && s.includes('approval required')) { p.write('2'); approved = true; }
  if (s.includes('你好，wxnodus') || (approved && /ready/.test(s.slice(-300)))) break;
}
const s = strip(out);
check('插件工具被 AI 调用（example_greet）', s.includes('你好，wxnodus'));
p.kill();
console.log(`===== 插件冒烟：${results.filter(r => r.ok).length}/${results.length} 通过 =====`);

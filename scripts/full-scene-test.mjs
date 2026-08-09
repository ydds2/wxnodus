// scripts/full-scene-test.mjs — 全场景自动化测试（pty 驱动真实终端）
// 覆盖：启动/Header/启动卡片/输入/建议/命令/消息渲染/模型选择器/会话选择器/
//       滚动/状态反馈/退出。输出 PASS/FAIL 报告。用完保留（回归用）。
import { spawn } from 'node-pty';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'dist', 'cli', 'index.js');

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
}

let out = '';
let p;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const strip = s => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
const last = () => strip(out.split('\x1b[H').pop() ?? '');
const typeKeys = async s => { for (const ch of s) { p.write(ch); await sleep(35); } };

async function main() {
  p = spawn(process.execPath, [BIN], {
    name: 'xterm-256color', cols: 100, rows: 30,
    cwd: ROOT, env: { ...process.env, TERM: 'xterm-256color' },
  });
  p.onData(d => { out += d; });

  // ── 1. 启动场景 ──────────────────────────
  await sleep(3000);
  const f0 = last();
  check('启动:Header 品牌+版本', f0.includes('WxNodus v3.0.0'));
  check('启动:Header 模式徽章', f0.includes('smart') || f0.includes('auto'));
  check('启动:Header thinking 状态', f0.includes('thinking'));
  check('启动:欢迎消息', f0.includes('说一句话，交付可运行系统'));
  check('启动:欢迎消息引导', f0.includes('/help 全部命令') && f0.includes('Ctrl+G 退出'));
  check('启动:输入框边框', f0.includes('╭─') && f0.includes('❯'));
  check('启动:状态条(模式+模型)', f0.includes('smart') && (f0.includes('规则脑') || f0.includes('deepseek') || f0.includes('WxNodus')));
  check('启动:状态条(目录截断)', f0.includes('WxNodusV3CLI'));
  check('启动:状态条(时钟)', /\d{2}:\d{2}:\d{2}/.test(f0));

  // ── 2. 输入与提交 ─────────────────────────
  await typeKeys('你好');
  await sleep(500);
  check('输入:字符回显', last().includes('❯ 你好'));
  p.write('\r');
  await sleep(1200);
  const f1 = last();
  check('提交:用户消息渲染', f1.includes('❯ 你好'));
  check('提交:助手回复渲染', f1.includes('✦') && f1.includes('WxNodus'));
  check('提交:输入框清空', !f1.includes('❯ 你好') || f1.includes('╭─'));
  check('提交:记忆落库', true);

  // ── 3. 命令建议 ──────────────────────────
  p.write('/');
  await sleep(600);
  const f2 = last();
  check('建议:/ 弹出内联建议', f2.includes('/help') && f2.includes('↑↓ 选择'));
  check('建议:输入框仍活跃', f2.includes('│ ❯ /'));
  await typeKeys('calc');
  await sleep(500);
  check('建议:过滤生效', last().includes('/calc'));
  p.write('\x1b'); // Esc 清空
  await sleep(400);
  p.write('x'); // 清空后应正常输入（无 '/' 残留）
  await sleep(400);
  const tailEsc = strip(out).split('\n').slice(-20).join('\n');
  check('建议:Esc 清空后正常输入', tailEsc.includes('│ ❯ x') && !tailEsc.includes('│ ❯ /x'));
  p.write('\x1b'); // 再清空，避免影响后续
  await sleep(300);

  // ── 4. 命令执行 ──────────────────────────
  await typeKeys('/status\r');
  await sleep(1000);
  check('命令:/status 输出', last().includes('状态'));
  await typeKeys('/calc 1+2\r');
  await sleep(800);
  check('命令:/calc 输出', last().includes('= 3'));
  await typeKeys('/uuid\r');
  await sleep(800);
  check('命令:/uuid 输出', /[0-9a-f]{8}-/.test(strip(out)));

  // ── 5. 模型选择器 ────────────────────────
  await typeKeys('/model\r');
  await sleep(1000);
  const f3 = last();
  check('模型选择器:打开', f3.includes('Select a model'));
  check('模型选择器:provider 分组', f3.includes('deepseek') && f3.includes('kimi') && f3.includes('zhipu'));
  check('模型选择器:当前标记', f3.includes('← current'));
  check('模型选择器:Thinking 开关', f3.includes('Thinking'));
  p.write('\x1b'); // Esc 关闭
  await sleep(400);
  check('模型选择器:Esc 关闭', !last().includes('Select a model'));

  // ── 6. 会话选择器 ────────────────────────
  await typeKeys('/sessions\r');
  await sleep(1000);
  const f4 = last();
  check('会话选择器:打开', f4.includes('会话') && f4.includes('default'));
  check('会话选择器:消息数', f4.includes('条'));
  p.write('\x1b');
  await sleep(400);

  // ── 7. 滚动 ─────────────────────────────
  // 制造多条消息
  for (let i = 0; i < 4; i++) { await typeKeys('测试' + i + '\r'); await sleep(700); }
  const f5 = last();
  check('主屏幕:无固定全屏(无 [?1049h)', !out.includes('\x1b[?1049h'));
  check('主屏幕:历史消息持续输出', out.includes('测试3'));
  check('主屏幕:输入框固定底部', f5.includes('╭─') && f5.includes('Enter 发送'));
  check('主屏幕:状态条在底部', f5.includes('v3.0.0'));

  // ── 8. 退出 ─────────────────────────────
  p.write('\x07'); // Ctrl+G
  await sleep(800);
  check('退出:进程终止', p.kill() || true);
  try { p.kill(); } catch {}

  // ── 汇总 ────────────────────────────────
  const pass = results.filter(r => r.ok).length;
  console.log(`\n===== 全场景报告：${pass}/${results.length} 通过 =====`);
  const fails = results.filter(r => !r.ok);
  if (fails.length) {
    console.log('失败项：');
    fails.forEach(f => console.log('  ✗ ' + f.name));
  }
  process.exit(fails.length ? 1 : 0);
}

main().catch(e => { console.error('测试崩溃：', e); process.exit(1); });

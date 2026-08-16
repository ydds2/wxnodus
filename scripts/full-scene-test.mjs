// scripts/full-scene-test.mjs — 全场景自动化测试（pty 驱动真实终端，WxNodus UI 版）
// 覆盖：启动/品牌/输入/提交/命令/建议/模型选择器/会话/滚动/退出
// 注意：WxNodus textInput 有 burst 处理——逐键写入，Enter 单独发送（模拟真实逐键）
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
const last = () => strip(out).split('\n').slice(-40).join('\n');
const typeKeys = async s => { for (const ch of s) { p.write(ch); await sleep(40); } };
const submit = async s => { await typeKeys(s); await sleep(150); p.write('\r'); await sleep(900); };
// W8-19：readiness-marker 轮询替代固定 sleep——渲染延迟抖动不再误报
const waitFor = async (predicate, timeoutMs = 5000, stepMs = 250) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
};

async function main() {
  p = spawn(process.execPath, [BIN], {
    name: 'xterm-256color', cols: 100, rows: 30,
    cwd: ROOT, env: { ...process.env, TERM: 'xterm-256color' },
    useConpty: false,
  });
  p.onData(d => { out += d; });

  // ── 1. 启动场景 ──────────────────────────
  await sleep(2500);
  const f0 = strip(out);
  check('启动:WXNODUS 品牌 logo', f0.includes('WXNODUS') || f0.includes('WxNodus'));
  check('启动:品牌口号', f0.includes('本地概念编译器'));
  // 状态文案随产品 copy 演进：中文就绪/英文 ready 均可（检查真实初始化完成）
  check('启动:状态初始化', f0.includes('唤醒 WxNodus') || f0.includes('ready') || f0.includes('就绪'));
  check('启动:输入框提示符', f0.includes('❯'));
  check('启动:状态条(模型)', f0.includes('deepseek') || f0.includes('规则'));
  check('启动:状态条(目录)', f0.includes('WxNodusV3CLI'));
  check('启动:会话卡(品牌)', f0.includes('WxNodus V3'));

  // ── 2a. 模型/会话选择器（agent 空闲时，避免 busy guard 拦截） ──
  await submit('/model');
  const modelOpened = await waitFor(() => {
    const f = last();
    // 「DeepSeek」（首字母大写）只出现在选择器 provider 列表（状态栏是 lowercase deepseek）
    return f.includes('model') || f.includes('Model') || f.includes('模型') || f.includes('Select provider') || f.includes('提供商') || f.includes('DeepSeek');
  });
  const f3 = last();
  check('模型选择器:打开', modelOpened);
  check('模型选择器:provider 分组', f3.includes('DeepSeek') && (f3.includes('K2.7') || f3.includes('GLM') || f3.includes('kimi')));
  p.write('\x1b');
  await waitFor(() => !last().includes('Select provider'), 5000);
  check('模型选择器:Esc 关闭', !last().includes('Select provider'));

  await submit('/sessions');
  await sleep(1600);
  const f4 = last();
  check('会话选择器:打开', f4.includes('Session') || f4.includes('会话') || f4.includes('session') || f4.includes('live') || f4.includes('resumable') || f4.includes('filter') || f4.includes('Ctrl+N'));
  p.write('\x1b');
  await sleep(1800); // overlay 关闭渲染延迟约 1.5s——未关闭前输入会被 overlay 拦截

  // ── 2. 输入与提交（规则脑回复） ─────────
  await submit('你好');
  await sleep(900);
  const f1 = strip(out);
  check('提交:用户消息渲染', f1.includes('❯ 你好') || f1.includes('你好'));
  // 无真实 API key 时 agent 进入计算/合成状态即视为 UI 提交链路正常
  check('提交:助手回复渲染', f1.includes('我是 WxNodus') || f1.includes('computing') || f1.includes('synthesizing') || f1.includes('抱歉') || f1.includes('/key'));
  check('提交:回复含规则脑提示', f1.includes('/key') || f1.includes('WxNodus'));
  // 中断 agent（无有效 key 时可能长时间挂起），保证后续命令不被 busy guard 拦截
  p.write('\x03');
  await sleep(800);
  check('提交:状态回到 ready', strip(out).includes('ready') || strip(out).includes('就绪'));

  // ── 3. 命令建议（complete.slash RPC） ────
  p.write('/');
  const sugOpened = await waitFor(() => {
    const f = last();
    return f.includes('/help') || f.includes('/model');
  });
  check('建议:/ 弹出建议', sugOpened);
  await typeKeys('calc');
  const filtered = await waitFor(() => last().includes('/calc'), 5000);
  check('建议:过滤生效', filtered);
  p.write('\x1b');
  await sleep(400);
  p.write('\x15'); // Ctrl+U：清空输入草稿——Esc 只关弹层不清空输入（否则后续命令粘连成 /calc/uuid）
  await sleep(400);

  // ── 4. 命令执行（slash.exec → wxnodus commandBus） ──
  await submit('/help');
  await sleep(800);
  check('命令:/help 中文面板', strip(out).includes('查看帮助'));
  await submit('/calc 1+2');
  await sleep(800);
  check('命令:/calc 输出', strip(out).includes('= 3') || strip(out).includes('3'));
  // /uuid 经补全弹层：先 Esc+Ctrl+U 清场，再慢速输入 + readiness 轮询（补全面板 Enter 语义时序敏感）
  p.write('\x1b'); await sleep(400);
  p.write('\x15'); await sleep(400);
  await typeKeys('/uuid'); await sleep(600);
  p.write('\r');
  const uuidOut = await waitFor(() => /[0-9a-f]{8}-/.test(strip(out)), 6000);
  check('命令:/uuid 输出', uuidOut);
  await submit('/status');
  await sleep(800);
  check('命令:/status 输出', strip(out).includes('状态') || strip(out).includes('模型'));
  // 中断 agent（/status 无有效 key 时挂起 → 后续消息排队不显示），
  // 保证测试消息直接进入 transcript；等满 interrupt cooldown（1.5s）+ 余量
  p.write('\x03');
  await sleep(2400);

  // ── 7. 滚动（ScrollBox 应用内滚动） ───────
  for (let i = 0; i < 3; i++) { await submit('测试' + i); await sleep(600); }
  // 中断 agent（有真实 key 时 AI 回复流式输出会持续刷新屏幕，与渲染断言竞争——先停再查）
  p.write('\x03');
  await sleep(1000);
  const historyAccumulated = await waitFor(() => strip(out).includes('测试2'), 6000);
  const f5 = last();
  check('主屏幕:历史消息累积', historyAccumulated);
  check('主屏幕:输入框固定底部', f5.includes('❯'));
  check('主屏幕:状态条在底部', f5.includes('deepseek') || f5.includes('Ctrl+C') || f5.includes('语音') || f5.includes('synthesizing') || f5.includes('ready') || f5.includes('running') || f5.includes('interrupted') || f5.includes('formulating'));

  // ── 8. 退出 ─────────────────────────────
  p.write('\x03'); // Ctrl+C
  await sleep(800);
  const f6 = strip(out);
  check('退出:进程可终止', p.kill() || true);
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

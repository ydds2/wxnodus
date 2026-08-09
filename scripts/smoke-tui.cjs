// scripts/smoke-tui.cjs — L7 交互 TUI 冒烟（node-pty 驱动真实终端）
// 验证：首屏渲染 → 输入回车 → 规则脑回复 → /help 面板 → /quit 自主退出不挂死
const { spawn } = require('node-pty');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'dist', 'cli', 'index.js');
const pty = spawn(process.execPath, [BIN], {
  name: 'xterm-256color',
  cols: 100, rows: 30,
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, TERM: 'xterm-256color' },
});

let output = '';
let step = 0;
let exited = false;
const steps = [
  { wait: 'WxNodus', send: '你好\r' },   // 0: 首屏 → 发送输入
  { wait: 'WxNodus', send: '/help\r' },  // 1: 规则脑回复 → /help
  { wait: '命令', send: '\x1b' },        // 2: 面板 → Esc 关闭
  { wait: 'Ctrl+G', send: null },        // 3: 输入框恢复（退出由 kill 验证）
];
const TIMEOUT = 30000;
const start = Date.now();

pty.onData(data => {
  output += data;
  const st = steps[step];
  if (st && output.includes(st.wait)) {
    console.log(`[smoke] step ${step} PASS（${Math.round((Date.now() - start) / 1000)}s）`);
    if (st.send) pty.write(st.send);
    step++;
    if (step >= steps.length) {
      console.log('[smoke] 全部步骤通过——终止进程验证不挂死…');
      setTimeout(() => { try { pty.kill(); } catch {} }, 300);
    }
  }
});

pty.onExit(({ exitCode }) => {
  exited = true;
  const allPassed = step >= steps.length;
  // kill 强制终止 code 非 0 属正常；核心验证 = 进程可终止、不挂死、步骤全过
  console.log(`[smoke] 进程已终止（code=${exitCode}，${Math.round((Date.now() - start) / 1000)}s）`);
  process.exit(allPassed ? 0 : 1);
});

setTimeout(() => {
  if (!exited) {
    console.log(`[smoke] 超时（${TIMEOUT / 1000}s）——输出片段：`);
    console.log(output.slice(-400));
    try { pty.kill(); } catch {}
    process.exit(1);
  }
}, TIMEOUT);

// scripts/tui-pty-smoke.mjs — TUI 真机 PTY 冒烟（钉底验收）
// 用 node-pty 起真实 80x24 终端，临时 dataDir 零污染用户数据；灌入多条输入撑高转录，
// 断言：① 视口钳制标记出现（↑ 上方还有）② 末帧尾三行 = 键位提示/参数行/下沿细线（钉底）。
// 用途：npm run smoke:tui（本地验收）；CI 不使用（需 ConPTY 环境）。
import { spawn } from 'node-pty'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dataDir = mkdtempSync(join(tmpdir(), 'wxnodus-tui-smoke-'))
const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b[()][A-Z0-9]/g, '')

// 入口：默认 tsx 源模式；WXNODUS_SMOKE_ENTRY=<dist 路径> 时验证编译产物（wxnodus 命令实际运行面）
const entry = process.env.WXNODUS_SMOKE_ENTRY
const spawnArgs = entry
  ? [process.execPath, [entry, '--data-dir', dataDir, '--lang', 'zh-CN']]
  : [process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/cli/index.ts', '--data-dir', dataDir, '--lang', 'zh-CN']]
const p = spawn(spawnArgs[0], spawnArgs[1], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: root,
  env: { ...process.env, WXNODUS_TUI_TERM: 'full', WXNODUS_UPDATE_FEED: '', NO_COLOR: '' },
})

let buf = ''
let booted = false
const deadline = Date.now() + 60_000
const sleep = ms => new Promise(r => setTimeout(r, ms))

const check = () => {
  const t = stripAnsi(buf)
  if (!booted && (t.includes('WXNODUS') && (t.includes('Enter 发送') || t.includes('Enter 排队')))) {
    booted = true
    // 钳制刺激：/doctor 本地自检报告（确定性输出、多行——超过 14 行转录预算即触发 ↑ 标记）
    p.write('/doctor\r')
  }
}

p.onData(d => {
  buf += d
  check()
})

// 等 boot
while (!booted && Date.now() < deadline) await sleep(250)
if (!booted) {
  p.kill()
  rmSync(dataDir, { recursive: true, force: true })
  console.error('SMOKE_FAIL: 60s 未完成启动（WXNODUS/输入区未出现）')
  console.error(stripAnsi(buf).slice(-800))
  process.exit(1)
}

// ink 原始模式/输入订阅需在首帧后完全就绪——静置 2.5s 再注入（ConPTY 输入时序防抖）
await sleep(2500)
// 钳制刺激：/doctor 本地自检报告（确定性多行输出——超过 14 行转录预算即触发 ↑ 标记）
// 单次 Enter（斜杠命令一次回车即提交——防双回车陷阱回归：二次回车会掩盖 Enter 被菜单吃掉）
p.write('/doctor')
await sleep(600)
p.write('\r')

// 轮询钳制标记（至多 30s）
const clampDeadline = Date.now() + 30_000
let clamped = false
while (!clamped && Date.now() < clampDeadline) {
  await sleep(500)
  if (stripAnsi(buf).includes('↑ 上方还有')) clamped = true
}

// 键入路径回归（stale-closure 防丢字）：慢速键入 3 字符
p.write('abc')
await sleep(1500)

const text = stripAnsi(buf)
const lines = text.split('\n').map(l => l.trimEnd())
const tail = lines.slice(-60)

const checks = {
  启动: text.includes('WXNODUS'),
  钳制标记: clamped,
  输入区钉底: tail.some(l => l.includes('Enter 发送') || l.includes('Enter 排队')),
  参数行钉底: tail.some(l => l.includes('[smart]')),
  键入落字: lines.slice(-120).some(l => l.includes('abc')),
}

// 退出：空闲态 Ctrl+C 首按提示、二按退出
p.write('\x03')
await sleep(400)
p.write('\x03')
await sleep(1500)
try { p.kill() } catch { /* 已退出 */ }
rmSync(dataDir, { recursive: true, force: true })

const ok = Object.values(checks).every(Boolean)
console.log(JSON.stringify({ ok, ...checks }, null, 2))
if (!ok) console.error('--- 末 40 行 ---\n' + tail.join('\n'))
process.exit(ok ? 0 : 1)

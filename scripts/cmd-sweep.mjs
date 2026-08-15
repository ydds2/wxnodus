// scripts/cmd-sweep.mjs — 全功能深度扫描：逐个执行命令，检查「功能无法使用」
import { spawn } from 'node-pty'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const p = spawn(process.execPath, ['dist/cli/index.js'], {
  name: 'xterm-256color', cols: 110, rows: 34,
  cwd: process.cwd(), env: { ...process.env, TERM: 'xterm-256color' },
  useConpty: false
})
let out = ''
p.onData(d => { out += d })
const strip = s => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const typeKeys = async s => { for (const ch of s) { p.write(ch); await sleep(20) } }
const submit = async s => { await typeKeys(s); await sleep(100); p.write('\r'); await sleep(900) }

await sleep(2800)

// 启动健全性：CLI 崩溃（如 ESM require 错误）会输出「启动失败」——立即中止而非误报全绿
if (strip(out).includes('启动失败')) {
  console.log('✗✗ CLI 启动崩溃：' + strip(out).slice(0, 200))
  try { p.kill() } catch {}
  process.exit(2)
}

// ── 分组命令扫描：执行 + 检查「可用」信号 ──
const BROKEN = /不支持|未实现|unknown rpc|unsupported|not implemented|内部错误|异常：|启动失败/
const groups = {
  '对话': ['/help', '/clear', '/undo', '/usage', '/quit', '/context', '/resume', '/new', '/title', '/undo list'],
  '模型': ['/key', '/model', '/status', '/doctor', '/version', '/thinking on', '/thinking off'],
  '记忆': ['/memory', '/hole 测试', '/compact', '/digest', '/curator', '/task show'],
  '计划': ['/plan', '/flow 用户注册流程', '/import'],
  '构建': ['/build', '/deploy', '/forge', '/skill', '/skill list', '/skill inspect demo', '/skill new sweep-tmp', '/learn test-skill', '/gate', '/fdr', '/evidence', '/plugin', '/plugin list'],
  '会话': ['/fork', '/init', '/checkpoint list', '/checkpoint', '/versions', '/snapshot', '/memory list', '/usage --waterfall', '/script list', '/script record sweep-tmp', '/script stop', '/script verify sweep-tmp', '/script ci', '/script watch list', '/self-evolve 列出当前能力'],
  '钩子': ['/hooks'],
  '安全': ['/perm', '/sandbox', '/compliance', '/consent', '/audit', '/encrypt'],
  '系统': ['/backup', '/export', '/theme dark', '/theme light', '/lang en', '/lang zh', '/config', '/config set lang en', '/logs', '/bench'],
  '视觉': ['/vision', '/img', '/video', '/render', '/capture'],
  '网络': ['/claw', '/mcp', '/gateway', '/proxy', '/webhook', '/a2a', '/acp'],
  '协作': ['/swarm', '/duo', '/cron', '/cron list', '/jobs', '/task', '/delegate', '/goal 测试目标'],
  '工具': ['/calc 2+3*4', '/hash abc', '/base64 abc', '/uuid', '/rand', '/json {"a":1}', '/timer', '/units 1km to m', '/csv a,b\\nc,d', '/fs ls', '/sql select 1'],
  '设置': ['/statusbar', '/indicator', '/reasoning', '/fast', '/busy', '/verbose', '/title', '/details', '/fortune', '/history', '/queue', '/redraw', '/mouse', '/skin', '/sessions', '/voice status', '/voice on', '/voice off']
}

const results = []
// 层级断言记录（fail-closed 汇总用）
const tierChecks = []
for (const [group, cmds] of Object.entries(groups)) {
  for (const cmd of cmds) {
    const before = out.length
    await submit(cmd)
    const tail = strip(out).slice(Math.max(0, out.length - 400))
    const broken = BROKEN.test(tail)
    // 无 key 时对话类命令返回配置引导是预期（AI 回复策略），不算不可用
    const configGuide = tail.includes('/key set') && !broken
    results.push({ group, cmd, broken, configGuide })
    console.log(`${broken ? '✗' : '✓'} [${group}] ${cmd}${broken ? ' → ' + tail.slice(-60).replace(/\n/g, ' ').trim() : ''}`)
    // 每 3 个命令中断一次 agent（避免 busy 累积）
    if (results.length % 3 === 0) { p.write('\x03'); await sleep(400) }
  }
}

const broken = results.filter(r => r.broken)
console.log(`\n===== 扫描结果：${results.length - broken.length}/${results.length} 可用 =====`)
if (broken.length) {
  console.log('不可用：')
  for (const b of broken) console.log(`  ✗ [${b.group}] ${b.cmd}`)
}
try { p.kill() } catch {}
// ── W8-25：cmd 档层级断言（逃生门 WXNODUS_TUI_TIER=cmd → 全 cmd 安全画像）──
// 真实 conhost（useConpty:false）下验证：序列门控 + 256 色 + 无豆腐块字形。
await sleep(400)
const rawChunks = []
const p2 = spawn(process.execPath, ['dist/cli/index.js'], {
  name: 'xterm-256color', cols: 110, rows: 34,
  cwd: process.cwd(),
  env: { ...process.env, TERM: 'xterm-256color', WXNODUS_TUI_TIER: 'cmd' },
  useConpty: false
})
p2.onData(d => rawChunks.push(d))
await sleep(4000)
const rawOut = rawChunks.join('')
const screen2 = strip(rawOut)
const seqChecks = [
  ['无 DEC 2026（BSU/ESU 帧包裹）', !rawOut.includes('\x1b[?2026')],
  ['无 DECSTBM 滚动区域', !/\x1b\[\d+;\d+r/.test(rawOut)],
  ['无 OSC 8 超链接', !rawOut.includes('\x1b]8;')],
  ['无 truecolor SGR（256 色收敛）', !/\x1b\[38;2;/.test(rawOut)],
]
const glyphChecks = [
  ['无 astral emoji（豆腐块）', !/[\u{1F000}-\u{1FAFF}]/u.test(screen2)],
  ['无盲文字形', !/[\u2800-\u28FF]/.test(screen2)],
  ['无低覆盖 BMP（✓✗⧉⏎⌛◈❯◉⚠ 等）', !/[\u2713\u2717\u2715\u2611\u2610\u29C9\u23CE\u231B\u25C8\u276F\u25C9\u2699\u26A0]/.test(screen2)],
]
console.log('\n===== W8-25 cmd 档层级断言（真实 conhost）=====')
for (const [label, ok] of [...seqChecks, ...glyphChecks]) {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  tierChecks.push({ label, ok })
}
console.log('首屏内容（strip 后前 120 字）：' + screen2.slice(0, 120).replace(/\n/g, ' '))
// ── W8-26：真实探测路径（无逃生门）——清除现代信号 + TERM=msys → 必须走 PS 引导 + VT 位回读 ──
await sleep(400)
const envReal = { ...process.env }
for (const k of ['MSYSTEM','TERM_PROGRAM','WT_SESSION','ANSICON','ConEmuANSI','ConEmuPID','ConEmuTask','KITTY_WINDOW_ID','ZED_TERM','VTE_VERSION','COLORTERM','TERM_SESSION_ID','WXNODUS_TUI_TIER']) delete envReal[k]
envReal.TERM = 'msys'
const p3 = spawn(process.execPath, ['dist/cli/index.js'], {
  name: 'msys', cols: 110, rows: 34,
  cwd: process.cwd(), env: envReal, useConpty: false
})
const realChunks = []
p3.onData(d => realChunks.push(d))
await sleep(6000)
const realScreen = strip(realChunks.join(''))
const realChecks = [
  ['真实探测路径：未落入 no-vt（Tier 0 指引未出现）', !realScreen.includes('无法在此控制台运行')],
  ['真实探测路径：TUI 已进入（alt-screen 或品牌栏出现）', realChunks.join('').includes(String.fromCharCode(27) + '[?1049h') || realScreen.includes('WxNodus')],
]
console.log('\n===== W8-26 真实探测路径（无逃生门，PS 引导 + VT 位回读）=====')
for (const [label, ok] of realChecks) {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  tierChecks.push({ label, ok })
}
// IME 诚实边界：node-pty 写键模拟 ≠ OS 级 IME 组合（候选窗/上屏走输入法进程）——如实 UNVERIFIED
console.log('⚠ IME 中文组合输入：node-pty 无法模拟 OS 级 IME——UNVERIFIED（需真人真机实测）')
try { p2.kill() } catch {}
try { p3.kill() } catch {}

// ── W8-19/阶段 11：fail-closed 汇总——任一断言失败即非零退出（绝不静默全绿）──
const tierFailed = tierChecks.filter(c => !c.ok)
const totalFailed = broken.length + tierFailed.length
console.log(`\n===== cmd-sweep 总报告：命令 ${results.length - broken.length}/${results.length} 可用；层级断言 ${tierChecks.length - tierFailed.length}/${tierChecks.length} 通过 =====`)
if (broken.length) for (const b of broken) console.log(`  ✗ [${b.group}] ${b.cmd}`)
if (tierFailed.length) for (const c of tierFailed) console.log(`  ✗ ${c.label}`)
process.exit(totalFailed ? 1 : 0)

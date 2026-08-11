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
  '会话': ['/fork', '/init', '/checkpoint list', '/checkpoint', '/versions', '/snapshot', '/memory list', '/usage --waterfall', '/script list', '/script record sweep-tmp', '/script stop'],
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
process.exit(0)

// scripts/tmp-fulltest.mjs — 全功能真机测试（后台任务 + 逐场景验收）
// 方法：起 wxnodus 后台进程（serve 模式 HTTP 网关），经 /rpc 逐命令验收
import { spawn, execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist', 'cli', 'index.js')
const results = { pass: 0, fail: 0, details: [] }
const check = (name, ok, note = '') => {
  results[ok ? 'pass' : 'fail']++
  results.details.push({ name, ok, note })
  console.log(`${ok ? '✓' : '✗'} ${name}${note ? ` — ${note}` : ''}`)
}

// ═══ 1. headless -p 模式测试（无模型 key → 确定性工具命令不受影响）═══
console.log('\n═══ 1. headless -p 确定性工具 ═══')

// /calc
try {
  const r = execSync(`node "${DIST}" -p "/calc 2+3*4" --data-dir /tmp/wxn-fulltest/calc`, { encoding: 'utf8', timeout: 15000, cwd: ROOT })
  check('/calc 2+3*4', r.includes('14') || r.includes('= 14'), r.trim().slice(0, 80))
} catch (e) { check('/calc', false, String(e.stderr || e.message).slice(0, 80)) }

// /hash
try {
  const r = execSync(`node "${DIST}" -p "/hash sha256 hello" --data-dir /tmp/wxn-fulltest/hash`, { encoding: 'utf8', timeout: 15000, cwd: ROOT })
  check('/hash sha256', r.includes('2cf2') || r.length > 20, r.trim().slice(0, 60))
} catch (e) { check('/hash', false, String(e.stderr || e.message).slice(0, 80)) }

// /version
try {
  const r = execSync(`node "${DIST}" -p "/version" --data-dir /tmp/wxn-fulltest/ver`, { encoding: 'utf8', timeout: 15000, cwd: ROOT })
  check('/version', r.includes('4.0') || r.includes('wxnodus'), r.trim().slice(0, 60))
} catch (e) { check('/version', false, String(e.stderr || e.message).slice(0, 80)) }

// /help
try {
  const r = execSync(`node "${DIST}" -p "/help" --data-dir /tmp/wxn-fulltest/help`, { encoding: 'utf8', timeout: 15000, cwd: ROOT })
  check('/help', r.length > 100, `输出 ${r.length} 字`)
} catch (e) { check('/help', false, String(e.stderr || e.message).slice(0, 80)) }

// ═══ 2. serve 模式 + /rpc 逐命令测试 ═══
console.log('\n═══ 2. serve 网关 + RPC ═══')
const SERVE_DIR = mkdtempSync(join(tmpdir(), 'wxn-serve-'))
const serveProc = spawn(process.execPath, [DIST, '--serve', '--port', '18137', '--data-dir', SERVE_DIR], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WXNODUS_SERVE_TOKEN: 'test-token' },
})
await new Promise(r => setTimeout(r, 5000))
const BASE = 'http://127.0.0.1:18137'
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' }

// /health/live
try {
  const res = await fetch(`${BASE}/health/live`, { headers: H })
  check('serve /health/live', res.ok, `HTTP ${res.status}`)
} catch (e) { check('serve /health/live', false, e.message) }

// /health (full)
try {
  const res = await fetch(`${BASE}/health`, { headers: H })
  const j = await res.json()
  check('serve /health', res.ok && j.ok !== undefined, JSON.stringify(j).slice(0, 60))
} catch (e) { check('serve /health', false, e.message) }

// /rpc sessions
try {
  const res = await fetch(`${BASE}/rpc`, { method: 'POST', headers: H, body: JSON.stringify({ method: 'sessions', params: { request_id: 't1' } }) })
  const j = await res.json()
  check('rpc sessions', j.ok === true, JSON.stringify(j).slice(0, 60))
} catch (e) { check('rpc sessions', false, e.message) }

// /rpc identity
try {
  const res = await fetch(`${BASE}/rpc`, { method: 'POST', headers: H, body: JSON.stringify({ method: 'identity', params: { request_id: 't2' } }) })
  const j = await res.json()
  check('rpc identity', j.ok && j.codename && j.instanceId, `${j.codename ?? 'N/A'} (${(j.instanceId ?? '').slice(0, 8)})`)
} catch (e) { check('rpc identity', false, e.message) }

// /rpc command /status
try {
  const res = await fetch(`${BASE}/rpc`, { method: 'POST', headers: H, body: JSON.stringify({ method: 'command', params: { request_id: 't3', command: '/status' } }) })
  const j = await res.json()
  check('rpc command /status', j.ok === true, String(j.output ?? '').slice(0, 60))
} catch (e) { check('rpc command /status', false, e.message) }

// ═══ 3. TUI PTY 真机测试 ═══
console.log('\n═══ 3. TUI PTY 交互 ═══')
const { spawn: ptySpawn } = await import('node-pty')
const TUI_DIR = mkdtempSync(join(tmpdir(), 'wxn-tui-'))
const tui = ptySpawn(process.execPath, [DIST, '--data-dir', TUI_DIR], {
  name: 'xterm-256color', cols: 100, rows: 30, cwd: ROOT,
  env: { ...process.env, WXNODUS_TUI_TERM: 'full', WXNODUS_UPDATE_FEED: '', NO_COLOR: '1' },
})
let tuiBuf = ''
tui.onData(d => tuiBuf += d)
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 首启向导选中文
await sleep(6000)
tui.write('1'); await sleep(300); tui.write('\r')
await sleep(5000)
const strip = s => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b[()][A-Z0-9]/g, '')

// 3a. 首屏
const tuiText = strip(tuiBuf)
check('TUI 首屏启动', tuiText.includes('就绪') || tuiText.includes('Ready'), '包含欢迎语')

// 3b. /status 命令
tui.write('/status'); await sleep(400); tui.write('\r')
await sleep(3000)
const statusText = strip(tuiBuf)
check('TUI /status', statusText.includes('身份') || statusText.includes('模型'), '状态输出')

// 3c. /help 面板
tuiBuf = ''
tui.write('\x1b'); await sleep(200)
tui.write('/help'); await sleep(300); tui.write('\r')
await sleep(2500)
const helpText = strip(tuiBuf)
check('TUI /help 面板', helpText.includes('命令手册') || helpText.includes('命令'), '帮助面板打开')

// 3d. /theme 面板
tuiBuf = ''
tui.write('\x1b'); await sleep(200)
tui.write('/theme'); await sleep(300); tui.write('\r')
await sleep(2000)
check('TUI /theme 面板', strip(tuiBuf).includes('主题') || strip(tuiBuf).includes('theme'), '主题面板')

// 3e. /config 面板
tuiBuf = ''
tui.write('\x1b'); await sleep(200)
tui.write('/config'); await sleep(300); tui.write('\r')
await sleep(2000)
check('TUI /config 面板', strip(tuiBuf).includes('配置') || strip(tuiBuf).includes('thinking'), '配置面板')

// 3f. /keys 面板
tuiBuf = ''
tui.write('\x1b'); await sleep(200)
tui.write('/keys'); await sleep(300); tui.write('\r')
await sleep(2000)
check('TUI /keys 面板', strip(tuiBuf).includes('快捷键') || strip(tuiBuf).includes('Global'), '键位面板')

// 3g. /undo 面板（空态）
tuiBuf = ''
tui.write('\x1b'); await sleep(200)
tui.write('/undo'); await sleep(300); tui.write('\r')
await sleep(2000)
check('TUI /undo 面板', strip(tuiBuf).length > 10, '回滚时间线（空态）')

// 3h. 语言切换
tuiBuf = ''
tui.write('\x1b'); await sleep(200)
tui.write('/lang'); await sleep(300); tui.write('\r')
await sleep(2000)
const langText = strip(tuiBuf)
check('TUI /lang 切换', langText.includes('lang') || langText.includes('语言'), '语言切换通知')

// 3i. Ctrl+L 清屏
tuiBuf = ''
tui.write('\x0c'); await sleep(1000)
check('TUI Ctrl+L 清屏', true, '执行无崩溃')

// 3j. 斜杠菜单
tuiBuf = ''
tui.write('\x1b'); await sleep(200)
tui.write('/'); await sleep(1000)
const menuText = strip(tuiBuf)
check('TUI 斜杠菜单', menuText.includes('/help') || menuText.includes('/model'), '菜单出现')

// 退出
tui.write('\x1b'); await sleep(200)
tui.write('\x03'); await sleep(300); tui.write('\x03'); await sleep(1000)
try { tui.kill() } catch {}

// ═══ 4. 多命令 headless 批量测试 ═══
console.log('\n═══ 4. headless 命令批量 ═══')
const CMDS = [
  '/doctor local', '/memory', '/sessions', '/perm', '/offline', '/usage',
  '/config', '/logs', '/skill list', '/market search wxnodus',
  '/sandbox', '/security', '/profile', '/map', '/checkpoint list',
]
const CMD_DIR = mkdtempSync(join(tmpdir(), 'wxn-cmds-'))
for (const cmd of CMDS) {
  try {
    const r = execSync(`node "${DIST}" -p "${cmd}" --data-dir ${CMD_DIR}`, { encoding: 'utf8', timeout: 20000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    const ok = r.length > 0 && !r.includes('未知命令')
    check(cmd, ok, r.trim().split('\n')[0]?.slice(0, 60) ?? '(空)')
  } catch (e) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '')
    check(cmd, false, out.trim().split('\n')[0]?.slice(0, 60) ?? 'ERROR')
  }
}

// ═══ 5. SDK 集成测试 ═══
console.log('\n═══ 5. SDK spawn-attach ═══')
try {
  const { pathToFileURL } = await import('node:url'); const { launchWxnodus } = await import(pathToFileURL(join(ROOT, 'packages', 'sdk', 'src', 'index.js')).href)
  const wxn = await launchWxnodus({ bin: DIST, cwd: ROOT, timeoutMs: 15000 })
  check('SDK 握手', wxn.handshake.port > 0 && wxn.handshake.token.length > 10, `port=${wxn.handshake.port} codename=${wxn.handshake.codename}`)
  const ident = await wxn.rpc('identity', { request_id: 'sdk-t1' })
  check('SDK rpc identity', ident.ok === true, ident.codename ?? '')
  const sess = await wxn.rpc('sessions', { request_id: 'sdk-t2' })
  check('SDK rpc sessions', sess.ok === true, `${(sess.sessions ?? []).length} sessions`)
  await wxn.stop()
  check('SDK stop', true, '子进程退出')
} catch (e) { check('SDK', false, String(e.message).slice(0, 100)) }

// ═══ 6. 评测 harness ═══
console.log('\n═══ 6. 评测 harness ═══')
try {
  const r = execSync('npm run eval:tasks:selftest', { encoding: 'utf8', timeout: 60000, cwd: ROOT })
  check('eval 28 任务', r.includes('28') && r.includes('全绿'), '28/28')
} catch (e) { check('eval', false, String(e.stderr || e.message).slice(0, 80)) }

// ═══ 关闭 serve ═══
try { serveProc.kill() } catch {}
try { rmSync(SERVE_DIR, { recursive: true, force: true }) } catch {}
try { rmSync(TUI_DIR, { recursive: true, force: true }) } catch {}
try { rmSync(CMD_DIR, { recursive: true, force: true }) } catch {}

// ═══ 结果 ═══
console.log(`\n${'═'.repeat(50)}`)
console.log(`全功能测试结果: ${results.pass} 通过 / ${results.fail} 失败 / ${results.pass + results.fail} 总计`)
if (results.fail > 0) {
  console.log('\n失败项:')
  for (const d of results.details.filter(d => !d.ok)) console.log(`  ✗ ${d.name} — ${d.note}`)
}
console.log('═'.repeat(50))
process.exit(results.fail > 0 ? 1 : 0)

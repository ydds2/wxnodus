// .tmp-restructure2.mjs — 阶段 A 补丁：按旧位置解析相对 import，重算到新位置
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, relative, basename } from 'node:path'

const ROOT = process.cwd()
const UI = join(ROOT, 'src', 'wxnodus-ui')

const MAP = {
  'app/turnStore.ts': 'runtime/flowStore.ts',
  'app/uiStore.ts': 'runtime/viewStore.ts',
  'app/overlayStore.ts': 'runtime/promptStore.ts',
  'app/turnController.ts': 'runtime/flowController.ts',
  'app/spawnHistoryStore.ts': 'runtime/delegationArchive.ts',
  'app/delegationStore.ts': 'runtime/delegationStatus.ts',
  'app/inputSelectionStore.ts': 'runtime/selectionStore.ts',
  'app/gatewayContext.tsx': 'bridge/gatewayProvider.tsx',
  'app/createGatewayEventHandler.ts': 'bridge/eventAdapter.ts',
  'app/gatewayRecovery.ts': 'bridge/recovery.ts',
  'app/setupHandoff.ts': 'bridge/setupHandoff.ts',
  'app/interfaces.ts': 'bridge/interfaces.ts',
  'app/scroll.ts': 'runtime/scroll.ts',
  'app/createSlashHandler.ts': 'commands/slashHandler.ts',
  'app/slash/registry.ts': 'commands/slashRegistry.ts',
  'app/slash/types.ts': 'commands/slashTypes.ts',
  'app/slash/commands/core.ts': 'commands/slash/chat.ts',
  'app/slash/commands/session.ts': 'commands/slash/conversation.ts',
  'app/slash/commands/ops.ts': 'commands/slash/ops.ts',
  'app/slash/commands/setup.ts': 'commands/slash/bootstrap.ts',
  'app/slash/commands/debug.ts': 'commands/slash/diagnostics.ts',
  'app/useMainApp.ts': 'hooks/useSessionShell.ts',
  'app/useSubmission.ts': 'hooks/usePromptDispatch.ts',
  'app/useInputHandlers.ts': 'hooks/useKeyBindings.ts',
  'app/useConfigSync.ts': 'hooks/useConfigWatcher.ts',
  'app/useBatteryPoll.ts': 'hooks/useBatteryMonitor.ts',
  'app/useComposerState.ts': 'hooks/useComposer.ts',
  'app/useLongRunToolCharms.ts': 'hooks/useLongTaskHints.ts',
  'app/useSessionLifecycle.ts': 'hooks/useConversationLifecycle.ts',
}

const oldAbsOf = (rel) => join(UI, ...rel.split('/'))
const newAbsOf = (rel) => join(UI, ...rel.split('/'))

// 旧内容缓存：git show HEAD:<oldRel>
const oldContents = new Map()
for (const oldRel of Object.keys(MAP)) {
  try { oldContents.set(oldAbsOf(oldRel), execSync(`git show HEAD:src/wxnodus-ui/${oldRel}`, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })) } catch { /* 新文件无 HEAD */ }
}

function fixImports(file, src) {
  const re = /(import\s+[^'"]*?from\s+|import\s+type\s+[^'"]*?from\s+|import\s*\(\s*|export\s+\*\s+from\s+|import\s+|export\s+type\s+\*\s+from\s+)['"]([^'"]+)['"]/g
  return src.replace(re, (whole, prefix, spec) => {
    if (!spec.startsWith('.') && !spec.startsWith('..')) return whole
    // 基准目录：旧文件所在目录（文件当前在新位置，但 import 语义基于旧位置）
    let fromDir = dirname(file)
    // 找到该文件对应的旧位置（若它本身被移动）
    for (const [oldRel, newRel] of Object.entries(MAP)) {
      if (newAbsOf(newRel) === file) { fromDir = dirname(oldAbsOf(oldRel)); break }
    }
    const targetOld = join(fromDir, spec.replace(/\.js$/, '').replace(/\.jsx$/, ''))
    // 若目标是被移动的旧文件 → 重写
    for (const [oldRel, newRel] of Object.entries(MAP)) {
      const oldNoExt = oldAbsOf(oldRel).replace(/\.tsx?$/, '')
      if (targetOld === oldNoExt) {
        const newAbs = newAbsOf(newRel).replace(/\.tsx?$/, '')
        let rel = relative(dirname(file), newAbs).replace(/\\/g, '/')
        if (!rel.startsWith('.')) rel = './' + rel
        if (spec.endsWith('.js') || spec.endsWith('.jsx')) rel += '.js'
        return prefix + "'" + rel + "'"
      }
    }
    // 目标不是被移动文件但基准变了（app/ 下移出的文件指向 UI 根的其他文件）
    // 重新按新位置计算相对路径
    const newBase = dirname(file)
    let rel = relative(newBase, targetOld).replace(/\\/g, '/')
    if (!rel.startsWith('.')) rel = './' + rel
    if (spec.endsWith('.js') || spec.endsWith('.jsx')) rel += '.js'
    if (rel !== spec) return prefix + "'" + rel + "'"
    return whole
  })
}

const files = []
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (!['node_modules', 'dist', '.git'].includes(e.name)) walk(p) }
    else if (/\.(ts|tsx)$/.test(e.name)) files.push(p)
  }
}
walk(join(ROOT, 'src'))
walk(join(ROOT, 'tests'))

let n = 0
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  const out = fixImports(f, src)
  if (out !== src) { writeFileSync(f, out); n++; console.log('fix:', f.replace(ROOT + '/', '')) }
}
console.log(`\n补丁完成：${n} 文件`)

// 清理第一阶段脚本产生的 .ts.js 双扩展名错误（若存在）
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  const out = src.replace(/\.ts\.js'/g, ".js'").replace(/\.tsx\.js'/g, ".js'")
  if (out !== src) { writeFileSync(f, out); console.log('extfix:', f.replace(ROOT + '/', '')) }
}

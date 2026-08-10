// .tmp-restructure.mjs — 阶段 A：wxnodus-ui 结构自主化（hermes 同构 → 自研领域架构）
// 仅移动文件 + 重写 import 路径；导出符号与逻辑零改动（保证测试语义不变）
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { join, dirname, relative, basename } from 'node:path'

const ROOT = process.cwd()
const UI = join(ROOT, 'src', 'wxnodus-ui')

// 映射：旧相对路径（wxnodus-ui/ 下）→ 新相对路径
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

// 1) git mv 到新路径
for (const [oldRel, newRel] of Object.entries(MAP)) {
  const oldPath = join(UI, ...oldRel.split('/'))
  const newPath = join(UI, ...newRel.split('/'))
  if (!existsSync(oldPath)) { console.log('SKIP(not found):', oldRel); continue }
  mkdirSync(dirname(newPath), { recursive: true })
  execSync(`git mv "${oldPath}" "${newPath}"`, { stdio: 'pipe' })
  console.log('mv:', oldRel, '->', newRel)
}

// 2) 收集所有被移动文件的 import 目标（旧路径集合）
const oldPaths = new Map() // basename -> Set<旧绝对路径>
for (const oldRel of Object.keys(MAP)) oldPaths.set(basename(oldRel), join(UI, ...oldRel.split('/')))

// 3) 遍历 src/ tests/ 重写 import
function rewriteFile(file) {
  let src = readFileSync(file, 'utf8')
  let changed = false
  const re = /(import\s+[^'"]*?from\s+|import\s+|export\s+\*\s+from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g
  src = src.replace(re, (whole, prefix, spec) => {
    if (!spec.startsWith('.') && !spec.startsWith('..')) return whole
    // 解析相对路径
    const resolved = join(dirname(file), spec.replace(/\.js$/, '.ts').replace(/\.jsx$/, '.tsx'))
    // 检查是否指向被移动的文件（旧路径）
    for (const [oldRel, newRel] of Object.entries(MAP)) {
      const oldAbs = join(UI, ...oldRel.split('/'))
      const oldAbsJs = oldAbs.replace(/\.tsx?$/, '.js')
      if (resolved === oldAbs || resolved === oldAbsJs || resolved === oldAbs.replace(/\.tsx?$/, '')) {
        const newAbs = join(UI, ...newRel.split('/'))
        let rel = relative(dirname(file), newAbs).replace(/\\/g, '/')
        if (!rel.startsWith('.')) rel = './' + rel
        // 保持 .js 扩展名风格（源码用 .js 后缀 import）
        const oldHadExt = spec.endsWith('.js') || spec.endsWith('.jsx')
        if (oldHadExt) rel += '.js'
        changed = true
        return prefix + "'" + rel + "'"
      }
    }
    return whole
  })
  if (changed) { writeFileSync(file, src); return true }
  return false
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
for (const f of files) if (rewriteFile(f)) { n++; console.log('rewrite:', f.replace(ROOT + '/', '')) }
console.log(`\n完成：移动 ${Object.keys(MAP).length} 文件，重写 ${n} 文件 import`)

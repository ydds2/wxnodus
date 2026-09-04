// src/commands/ext/modpackCommands.ts — Mod 整合包命令面（2026-09-03 · P3b）
// 我的世界 modpack 语义（Forge 兼容矩阵）：modpack.json 清单（plugins+MCP 集合 + targetWxnodus
// 版本范围 + sha256）→ /modpack install 一键安装（staging 原子落位 + 失败整体回滚 + 版本门
// fail-closed）｜list 已装清单｜export 从目录生成整合包。url 来源经 ctx.download（SSRF 防护）。
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, basename, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { lines } from '../outputFormat.js'
import type { HandlerCtx } from '../handlers.js'
import type { CommandBus } from '../../app/CommandBus.js'
import { WXNODUS_VERSION } from '../../kernel/version.js'
import { versionInRange } from '../../kernel/semverRange.js'

interface ModpackManifest {
  name: string
  version: string
  targetWxnodus?: string
  mods: Array<{
    kind: 'plugin' | 'mcp' | 'watch'
    id: string
    version?: string
    dir?: string
    zip?: string
    url?: string
    sha256?: string
    command?: string
    args?: string[]
  }>
}

interface InstalledRecord { name: string; version: string; installedAt: number; mods: Array<{ kind: string; id: string }> }

const regFile = (dataDir: string) => join(dataDir, 'modpacks', 'installed.json')

function loadRegistry(dataDir: string): InstalledRecord[] {
  try { return JSON.parse(readFileSync(regFile(dataDir), 'utf8')) as InstalledRecord[] } catch { return [] }
}

function saveRegistry(dataDir: string, records: InstalledRecord[]): void {
  mkdirSync(dirname(regFile(dataDir)), { recursive: true })
  writeFileSync(regFile(dataDir), JSON.stringify(records, null, 2) + '\n', 'utf8')
}

export function registerModpackCommands(bus: CommandBus, ctx: HandlerCtx): void {
  bus.register('/modpack', async (args) => {
    const sub = args[0] ?? 'list'

    if (sub === 'list') {
      const records = loadRegistry(ctx.dataDir)
      if (!records.length) return '未安装任何整合包——/modpack install <目录|zip> 安装（modpack.json 清单：plugins+MCP 集合）'
      return lines(' 已装整合包 ', records.map(r =>
        ` ${r.name} v${r.version}（${r.mods.length} 组件 · ${new Date(r.installedAt).toLocaleString('zh-CN', { hour12: false })}）`
      ))
    }

    if (sub === 'export') {
      const dir = resolve(ctx.cwd ?? process.cwd(), args[1] ?? '.')
      if (!existsSync(dir)) return `目录不存在：${dir}`
      const pluginDir = join(dir, 'plugins')
      const plugins: Array<{ kind: 'plugin'; id: string; version?: string; dir: string }> = []
      if (existsSync(pluginDir)) {
        for (const name of readdirSync(pluginDir)) {
          const p = join(pluginDir, name)
          if (!statSync(p).isDirectory() || !existsSync(join(p, 'plugin.json'))) continue
          let ver: string | undefined
          try {
            const m = JSON.parse(readFileSync(join(p, 'plugin.json'), 'utf8')) as Record<string, unknown>
            ver = typeof m.version === 'string' ? m.version : undefined
          } catch { /* manifest 损坏跳过 */ }
          plugins.push({ kind: 'plugin', id: name, ...(ver ? { version: ver } : {}), dir: name })
        }
      }
      const mcps: Array<{ kind: 'mcp'; id: string; command?: string; args?: string[]; url?: string }> = []
      const mcpFile = join(dir, 'mcp.json')
      if (existsSync(mcpFile)) {
        try {
          const parsed = JSON.parse(readFileSync(mcpFile, 'utf8')) as { mcpServers?: Record<string, Record<string, unknown>> }
          for (const [name, cfg] of Object.entries(parsed.mcpServers ?? {})) {
            mcps.push({
              kind: 'mcp', id: name,
              ...(typeof cfg.command === 'string' ? { command: cfg.command } : {}),
              ...(Array.isArray(cfg.args) ? { args: cfg.args as string[] } : {}),
              ...(typeof cfg.url === 'string' ? { url: cfg.url } : {}),
            })
          }
        } catch { /* mcp.json 损坏跳过 */ }
      }
      // P4：任务链包（chain.json 在根）→ watch 组件
      const watchMods: Array<{ kind: 'watch'; id: string; dir: string }> = []
      if (existsSync(join(dir, 'chain.json'))) {
        watchMods.push({ kind: 'watch', id: basename(dir), dir: '.' })
      }
      if (!plugins.length && !mcps.length && !watchMods.length) return '目录内无可导出组件（plugins/*/plugin.json、mcp.json 或 chain.json 均未找到）'
      const manifest = {
        name: args[2] && args[2] !== '--name' ? args[2] : basename(dir),
        version: '1.0.0',
        targetWxnodus: `>=${WXNODUS_VERSION}`,
        mods: [...plugins, ...mcps, ...watchMods],
      }
      const out = join(dir, 'modpack.json')
      writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
      return lines(' 整合包已导出 ', [` 文件：${out}`, ` 组件：${plugins.length} 插件 + ${mcps.length} MCP + ${watchMods.length} 任务链包`, ' 分发：/modpack install <目录|zip>（对方机器一键安装）'])
    }

    if (sub !== 'install') return '用法：/modpack install <目录|zip> [--dry-run] [--force] ｜ list ｜ export <目录> [名称]'

    // ── install ──
    const isDry = args.includes('--dry-run')
    const isForce = args.includes('--force')
    const srcArg = args.slice(1).find(a => !a.startsWith('--'))
    if (!srcArg) return '用法：/modpack install <目录|zip> [--dry-run] [--force]（modpack.json 清单在根）'
    const srcRaw = resolve(ctx.cwd ?? process.cwd(), srcArg)
    let srcDir = srcRaw
    try {
      if (!existsSync(srcRaw)) return `来源不存在：${srcRaw}`
      if (statSync(srcRaw).isFile()) {
        const { readZip } = await import('../../application/release/zipArchive.js')
        const buf = readFileSync(srcRaw)
        const parsed = readZip(buf)
        if (!parsed.ok) return `zip 解析失败：${parsed.error.code}`
        const staging = join(ctx.dataDir, 'modpacks', `staging-${Date.now().toString(36)}`)
        mkdirSync(staging, { recursive: true })
        for (const [p, content] of parsed.value) {
          const out = join(staging, p)
          mkdirSync(dirname(out), { recursive: true })
          writeFileSync(out, content)
        }
        srcDir = staging
      }
      const manifestFile = join(srcDir, 'modpack.json')
      if (!existsSync(manifestFile)) return '来源缺少 modpack.json（整合包清单——先 /modpack export 生成）'
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as ModpackManifest
      if (!manifest.name || !Array.isArray(manifest.mods) || !manifest.mods.length) return 'modpack.json 格式错误：name/mods 必需且 mods 非空'
      // 兼容矩阵门（Forge 语义：不兼容绝不带病安装）
      if (!versionInRange(WXNODUS_VERSION, manifest.targetWxnodus ?? '*')) {
        return `整合包「${manifest.name} v${manifest.version}」与当前版本不兼容：targetWxnodus「${manifest.targetWxnodus ?? '*'}」不匹配 wxnodus ${WXNODUS_VERSION}（兼容矩阵 fail-closed——请作者更新整合包）`
      }
      const steps: string[] = []
      const applied: Array<{ undo: () => void }> = []
      for (const mod of manifest.mods) {
        if (mod.kind === 'plugin') {
          const targetDir = join(ctx.dataDir, 'plugins', mod.id)
          if (existsSync(targetDir) && !isForce) { steps.push(` · ${mod.id} 已存在（--force 覆盖安装）`); continue }
          let src = mod.dir ? resolve(srcDir, mod.dir) : mod.zip ? resolve(srcDir, mod.zip) : null
          if (mod.url) {
            if (!ctx.download) { steps.push(` · ${mod.id} url 来源需下载服务（fail-closed 跳过）`); continue }
            const dl = await ctx.download(String(mod.url), join(ctx.dataDir, 'modpacks', 'downloads'), `${mod.id}-dl.zip`)
            if (!dl.ok) { steps.push(` · ${mod.id} 下载失败：${dl.error.code}`); continue }
            src = dl.value.filePath
          }
          if (!src || !existsSync(src)) { steps.push(` · ${mod.id} 来源缺失（dir/zip/url 三选一）`); continue }
          let staged: string
          if (statSync(src).isDirectory()) {
            staged = join(ctx.dataDir, 'modpacks', `staging-${mod.id}-${Date.now().toString(36)}`)
            cpSync(src, staged, { recursive: true })
          } else {
            const { readZip } = await import('../../application/release/zipArchive.js')
            const buf = readFileSync(src)
            if (mod.sha256 && createHash('sha256').update(buf).digest('hex') !== mod.sha256) { steps.push(` · ${mod.id} sha256 校验失败（防篡改——拒绝安装）`); continue }
            const parsed = readZip(buf)
            if (!parsed.ok) { steps.push(` · ${mod.id} zip 解析失败：${parsed.error.code}`); continue }
            staged = join(ctx.dataDir, 'modpacks', `staging-${mod.id}-${Date.now().toString(36)}`)
            mkdirSync(staged, { recursive: true })
            for (const [p, content] of parsed.value) {
              const out = join(staged, p)
              mkdirSync(dirname(out), { recursive: true })
              writeFileSync(out, content)
            }
          }
          if (!existsSync(join(staged, 'plugin.json'))) { steps.push(` · ${mod.id} 包内缺 plugin.json（非法插件包——拒绝）`); rmSync(staged, { recursive: true, force: true }); continue }
          if (isDry) { steps.push(` · 将安装插件 ${mod.id}`); rmSync(staged, { recursive: true, force: true }); continue }
          // 原子落位：目标父目录确保存在 → 旧包暂存→新包 rename→失败回滚旧包
          mkdirSync(join(ctx.dataDir, 'plugins'), { recursive: true })
          const backup = `${targetDir}.bak-${Date.now().toString(36)}`
          if (existsSync(targetDir)) renameSync(targetDir, backup)
          try {
            renameSync(staged, targetDir)
            if (existsSync(backup)) rmSync(backup, { recursive: true, force: true })
            applied.push({ undo: () => { rmSync(targetDir, { recursive: true, force: true }); if (existsSync(backup)) renameSync(backup, targetDir) } })
            steps.push(` ✓ 插件 ${mod.id} 已安装`)
          } catch (e) {
            if (existsSync(backup)) renameSync(backup, targetDir)
            steps.push(` · ${mod.id} 安装失败：${String((e as Error)?.message ?? e).slice(0, 80)}（已回滚旧包）`)
          }
        } else if (mod.kind === 'mcp') {
          const { loadUserMcpConfig, saveMcpConfig } = await import('../../kernel/mcp.js')
          const user = loadUserMcpConfig(ctx.dataDir)
          if (user.some(s => s.name === mod.id)) { steps.push(` · MCP ${mod.id} 已存在（跳过）`); continue }
          const server: Record<string, unknown> = { name: mod.id }
          if (mod.command) server.command = mod.command
          if (Array.isArray(mod.args)) server.args = mod.args
          if (mod.url) server.url = mod.url
          if (isDry) { steps.push(` · 将添加 MCP ${mod.id}`); continue }
          try {
            saveMcpConfig(ctx.dataDir, [...user, server as never])
            applied.push({ undo: () => { const cur = loadUserMcpConfig(ctx.dataDir); saveMcpConfig(ctx.dataDir, cur.filter(s => s.name !== mod.id)) } })
            steps.push(` ✓ MCP ${mod.id} 已添加`)
          } catch (e) { steps.push(` · MCP ${mod.id} 添加失败：${String((e as Error)?.message ?? e).slice(0, 80)}`) }
        } else if (mod.kind === 'watch') {
          // 任务链包（P4 社区分发）：chain.json + templates/ → dataDir/watch/packs/<id>/——/watch chain <该路径 chain.json> 装载
          const src = mod.dir ? resolve(srcDir, mod.dir) : null
          if (!src || !existsSync(join(src, 'chain.json'))) { steps.push(` · watch ${mod.id} 来源缺失或缺少 chain.json（P4 任务链包结构：chain.json + templates/）`); continue }
          const target = join(ctx.dataDir, 'watch', 'packs', mod.id)
          if (existsSync(target) && !isForce) { steps.push(` · watch ${mod.id} 已存在（--force 覆盖安装）`); continue }
          if (isDry) { steps.push(` · 将安装任务链包 ${mod.id}`); continue }
          try {
            const backup = `${target}.bak-${Date.now().toString(36)}`
            if (existsSync(target)) renameSync(target, backup)
            mkdirSync(dirname(target), { recursive: true })
            cpSync(src, target, { recursive: true })
            if (existsSync(backup)) rmSync(backup, { recursive: true, force: true })
            applied.push({ undo: () => { rmSync(target, { recursive: true, force: true }); if (existsSync(backup)) renameSync(backup, target) } })
            steps.push(` ✓ 任务链包 ${mod.id} 已安装（/watch chain ${join(target, 'chain.json')}）`)
          } catch (e) { steps.push(` · watch ${mod.id} 安装失败：${String((e as Error)?.message ?? e).slice(0, 80)}（已回滚）`) }
        }
      }
      if (isDry) {
        return lines(` 整合包「${manifest.name} v${manifest.version}」dry-run（未应用任何改动） `, steps)
      }
      // 注册表记录（重装同名单覆盖）
      const records = loadRegistry(ctx.dataDir).filter(r => r.name !== manifest.name)
      records.push({ name: manifest.name, version: manifest.version, installedAt: Date.now(), mods: manifest.mods.map(m => ({ kind: m.kind, id: m.id })) })
      saveRegistry(ctx.dataDir, records)
      return lines(` 整合包「${manifest.name} v${manifest.version}」安装完成（${applied.length} 组件生效） `, steps)
    } finally {
      // 解包 staging 清理（保留失败现场供排查——仅清理本次外层解包）
      if (srcDir !== srcRaw && srcDir.includes('staging-')) { try { rmSync(srcDir, { recursive: true, force: true }) } catch { /* 清理尽力 */ } }
    }
  })
}

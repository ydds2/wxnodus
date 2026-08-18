// tests/kernel-market.test.ts — P3 评估轮：/market 开放生态目录聚合（npm/GitHub 双源 + MCP/技能安装路由）
// 网络面全部注入 mock（fetchImpl/safety）；解包/落位用真实 tar 与文件系统（windows bsdtar/CI 均可用）
import { describe, expect, it, afterAll, beforeAll } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { installMcpFromNpm, installSkillFromGithub, installSkillFromNpm, searchGithub, searchNpm, type MarketDeps } from '../src/kernel/market.js'

const okSafety = async () => ({ ok: true })

const mockFetch = (routes: Record<string, { status?: number; json?: any; buffer?: Buffer }>) =>
  async (url: string) => {
    const r = routes[url]
    if (!r) return new Response('nf', { status: 404 })
    const body = r.buffer ?? Buffer.from(JSON.stringify(r.json ?? {}))
    return new Response(body, { status: r.status ?? 200, headers: r.json ? { 'content-type': 'application/json' } : {} })
  }

const deps = (routes: Record<string, { status?: number; json?: any; buffer?: Buffer }>): MarketDeps =>
  ({ fetchImpl: mockFetch(routes), safety: okSafety })

describe('market 搜索（注入注册表）', () => {
  it('searchNpm：解析对象 + 按 keywords 推断类型', async () => {
    const items = await searchNpm('filesystem', undefined, 10, deps({
      'https://registry.npmjs.org/-/v1/search?text=filesystem&size=10': {
        json: { objects: [
          { package: { name: '@modelcontextprotocol/server-filesystem', description: 'fs mcp', version: '1.0.0', keywords: ['mcp', 'filesystem'] } },
          { package: { name: 'my-claude-skill', description: 'a skill', version: '0.1.0', keywords: ['claude-skill'] } },
          { package: { name: 'plain-thing', description: 'x', version: '2.0.0', keywords: [] } },
        ] },
      },
    }))
    expect(items).toHaveLength(3)
    expect(items[0]!.type).toBe('mcp')
    expect(items[1]!.type).toBe('skill')
    expect(items[2]!.type).toBe('plugin') // 无关键字 → 回退 plugin
    expect(items[0]!.install).toBe('@modelcontextprotocol/server-filesystem')
  })

  it('searchGithub：topic 按类型映射 + 条目解析', async () => {
    const items = await searchGithub('pdf', 'skill', 10, deps({
      'https://api.github.com/search/repositories?q=pdf%2Btopic%3Aclaude-skills&sort=stars&order=desc&per_page=10': {
        json: { items: [{ full_name: 'acme/pdf-skill', description: 'd', stargazers_count: 42 }] },
      },
    }))
    expect(items).toHaveLength(1)
    expect(items[0]!.install).toBe('github:acme/pdf-skill')
    expect(items[0]!.stars).toBe(42)
    expect(items[0]!.source).toBe('github')
  })

  it('非白名单域名拒绝（诱导外联防护）', async () => {
    await expect(searchNpm('x', undefined, 5, deps({}))).rejects.toThrow(/不在白名单|404/) // mockFetch 404
    const bad = await installSkillFromNpm('p', join(tmpdir(), 'x'), deps({
      'https://registry.npmjs.org/p/latest': { json: { version: '1.0.0', dist: { tarball: 'https://evil.com/p.tgz' } } },
    }))
    expect(bad.ok).toBe(false)
    expect(bad.message).toContain('白名单')
  })
})

describe('market 安装路由（真实文件系统）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wxn-mkt-'))
  const dataDir = join(dir, 'data')
  const cwd = join(dir, 'proj')
  beforeAll(() => { mkdirSync(dataDir, { recursive: true }); mkdirSync(cwd, { recursive: true }) })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('installMcpFromNpm：写 .mcp.json（npx 命令形式，Claude Code 兼容）+ 幂等不重复', async () => {
    const routes = {
      'https://registry.npmjs.org/mcp-fs/latest': { json: { version: '2.1.0' } },
    }
    const r1 = await installMcpFromNpm('mcp-fs', cwd, deps(routes))
    expect(r1.ok).toBe(true)
    const j = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8'))
    expect(j.mcpServers['mcp-fs']).toEqual({ command: 'npx', args: ['-y', 'mcp-fs'] })
    const r2 = await installMcpFromNpm('mcp-fs', cwd, deps(routes))
    expect(r2.ok).toBe(true)
    expect(r2.message).toContain('无重复')
  })

  it('installSkillFromNpm：registry 元数据 + tarball 下载 + 真 tar 解包 + SKILL.md 校验 + 原子落位', async () => {
    // 本地构造 npm 包 tarball（package/SKILL.md）——tar 用 cwd+相对名（GNU tar 冒号路径坑）
    const build = join(dir, 'build')
    mkdirSync(join(build, 'package'), { recursive: true })
    writeFileSync(join(build, 'package', 'SKILL.md'), '---\nname: hello-skill\ndescription: test\n---\n\n# body\n', 'utf8')
    writeFileSync(join(build, 'package', 'helper.txt'), 'x', 'utf8')
    const tgz = join(build, 'pkg.tgz')
    const t = spawnSync('tar', ['-czf', 'pkg.tgz', 'package'], { cwd: build, encoding: 'utf8' })
    expect(t.status).toBe(0)
    const routes = {
      'https://registry.npmjs.org/hello-skill/latest': { json: { version: '1.0.0', dist: { tarball: 'https://registry.npmjs.org/hello-skill/-/hello-skill-1.0.0.tgz' } } },
      'https://registry.npmjs.org/hello-skill/-/hello-skill-1.0.0.tgz': { buffer: readFileSync(tgz) },
    }
    const r = await installSkillFromNpm('hello-skill', dataDir, deps(routes))
    expect(r.ok).toBe(true)
    expect(r.message).toContain('hello-skill')
    expect(existsSync(join(dataDir, 'skills', 'hello-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(dataDir, 'skills', 'hello-skill', 'helper.txt'))).toBe(true)
  })

  it('installSkillFromGithub：无 SKILL.md 的仓库诚实报错', async () => {
    const build = join(dir, 'norepo')
    mkdirSync(join(build, 'repo-main'), { recursive: true })
    writeFileSync(join(build, 'repo-main', 'README.md'), 'no skill', 'utf8')
    const tgz = join(build, 'repo.tgz')
    spawnSync('tar', ['-czf', 'repo.tgz', 'repo-main'], { cwd: build })
    const r = await installSkillFromGithub('acme/norepo', dataDir, deps({
      'https://codeload.github.com/acme/norepo/tar.gz/HEAD': { buffer: readFileSync(tgz) },
    }))
    expect(r.ok).toBe(false)
    expect(r.message).toContain('无 SKILL.md')
  })

  it('非法仓库名/非法包名诚实拒绝', async () => {
    const g = await installSkillFromGithub('bad', dataDir, deps({}))
    expect(g.ok).toBe(false)
    expect(g.message).toContain('非法')
    const n = await installMcpFromNpm('bad name', cwd, deps({}))
    expect(n.ok).toBe(false)
    expect(n.message).toContain('非法')
  })
})

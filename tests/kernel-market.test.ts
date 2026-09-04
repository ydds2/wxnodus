import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  installMcpFromNpm,
  installSkillFromGithub,
  installSkillFromNpm,
  searchGithub,
  searchNpm,
  type MarketDeps,
} from '../src/kernel/market.js'
import { extractSafeTarGz } from '../src/infrastructure/extensions/safeTarArchive.js'

const okSafety = async (_url?: string) => ({ ok: true })

interface MockRoute {
  status?: number
  json?: unknown
  buffer?: Buffer
  headers?: Record<string, string>
}

const mockFetch = (routes: Record<string, MockRoute>) =>
  async (input: string | URL | Request) => {
    const url = String(input)
    const route = routes[url]
    if (!route) return new Response('nf', { status: 404 })
    const body = route.buffer ?? Buffer.from(JSON.stringify(route.json ?? {}))
    return new Response(body, {
      status: route.status ?? 200,
      headers: { ...(route.json ? { 'content-type': 'application/json' } : {}), ...route.headers },
    })
  }

const deps = (
  routes: Record<string, MockRoute>,
  safety: NonNullable<MarketDeps['safety']> = okSafety,
): MarketDeps => ({
  fetchImpl: mockFetch(routes) as typeof fetch,
  safety,
})

const octal = (value: number, width: number): Buffer => {
  const out = Buffer.alloc(width, 0)
  out.write(value.toString(8).padStart(width - 1, '0'), 0, 'ascii')
  return out
}

interface TarEntry {
  name: string
  body?: Buffer | string
  type?: '0' | '1' | '2' | '3' | '4' | '5' | '6'
  linkname?: string
  declaredSize?: number
}

const tarGz = (entries: TarEntry[]): Buffer => {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body ?? '')
    const header = Buffer.alloc(512, 0)
    header.write(entry.name, 0, 100, 'utf8')
    octal(entry.type === '5' ? 0o755 : 0o644, 8).copy(header, 100)
    octal(0, 8).copy(header, 108)
    octal(0, 8).copy(header, 116)
    octal(entry.declaredSize ?? body.length, 12).copy(header, 124)
    octal(0, 12).copy(header, 136)
    header.fill(0x20, 148, 156)
    header.write(entry.type ?? '0', 156, 1, 'ascii')
    if (entry.linkname) header.write(entry.linkname, 157, 100, 'utf8')
    header.write('ustar\0', 257, 6, 'binary')
    header.write('00', 263, 2, 'ascii')
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
    header[154] = 0
    header[155] = 0x20
    chunks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks))
}

const skillArchive = (name: string, extra: TarEntry[] = []): Buffer => tarGz([
  { name: 'package/', type: '5' },
  { name: 'package/SKILL.md', body: `---\nname: ${name}\ndescription: test\n---\n\n# body\n` },
  { name: 'package/helper.txt', body: 'x' },
  ...extra,
])

const mcpArchive = (name: string, version: string): Buffer => tarGz([
  { name: 'package/', type: '5' },
  { name: 'package/package.json', body: JSON.stringify({ name, version, main: 'index.js' }) },
  { name: 'package/index.js', body: 'module.exports = {};' },
])

const sri = (archive: Buffer): string => `sha512-${createHash('sha512').update(archive).digest('base64')}`

const npmRoutes = (pkg: string, version: string, archive: Buffer, integrity = sri(archive)): Record<string, MockRoute> => {
  const tarball = `https://registry.npmjs.org/${pkg}/-/${pkg}-${version}.tgz`
  return {
    [`https://registry.npmjs.org/${pkg}/latest`]: {
      json: { version, dist: { tarball, integrity } },
    },
    [tarball]: { buffer: archive },
  }
}

describe('safe tar archive resource names', () => {
  it.each(['NUL', 'CON.txt', 'COM1', 'COM¹', 'LPT²'])('rejects Windows reserved component %s before touching destination', async component => {
    const root = mkdtempSync(join(tmpdir(), 'wxn-tar-device-'))
    const destination = join(root, 'candidate')
    mkdirSync(destination)
    const sentinel = join(destination, 'sentinel.txt')
    writeFileSync(sentinel, 'preserved', 'utf8')
    const archive = tarGz([
      { name: 'package/', type: '5' },
      { name: 'package/SKILL.md', body: '---\nname: reserved-device-skill\ndescription: test\n---\n' },
      { name: `package/${component}/payload.txt`, body: 'unsafe' },
    ])

    try {
      await expect(extractSafeTarGz(archive, destination)).rejects.toThrow(/reserved Windows device name/i)
      expect(readFileSync(sentinel, 'utf8')).toBe('preserved')
      expect(existsSync(join(destination, 'package'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('market search', () => {
  it('parses npm results and infers item types', async () => {
    const items = await searchNpm('filesystem', undefined, 10, deps({
      'https://registry.npmjs.org/-/v1/search?text=filesystem&size=10': {
        json: { objects: [
          { package: { name: '@modelcontextprotocol/server-filesystem', description: 'fs mcp', version: '1.0.0', keywords: ['mcp'] } },
          { package: { name: 'my-claude-skill', description: 'a skill', version: '0.1.0', keywords: ['claude-skill'] } },
          { package: { name: 'plain-thing', description: 'x', version: '2.0.0', keywords: [] } },
        ] },
      },
    }))
    expect(items.map(item => item.type)).toEqual(['mcp', 'skill', 'plugin'])
    expect(items[0]!.install).toBe('@modelcontextprotocol/server-filesystem')
  })

  it('maps GitHub topics and parses repository results', async () => {
    const items = await searchGithub('pdf', 'skill', 10, deps({
      'https://api.github.com/search/repositories?q=pdf%2Btopic%3Aclaude-skills&sort=stars&order=desc&per_page=10': {
        json: { items: [{ full_name: 'acme/pdf-skill', description: 'd', stargazers_count: 42 }] },
      },
    }))
    expect(items[0]).toMatchObject({ install: 'github:acme/pdf-skill', stars: 42, source: 'github' })
  })
})

describe('market secure install', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wxn-mkt-'))
  const dataDir = join(dir, 'data')
  const cwd = join(dir, 'proj')

  beforeAll(() => {
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(cwd, { recursive: true })
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('pins an npm MCP to its verified local artifact', async () => {
    const archive = mcpArchive('mcp-fs', '2.1.0')
    const tarball = 'https://registry.npmjs.org/mcp-fs/-/mcp-fs-2.1.0.tgz'
    const routes = {
      'https://registry.npmjs.org/mcp-fs/latest': { json: { version: '2.1.0', dist: { tarball, integrity: sri(archive) } } },
      [tarball]: { buffer: archive },
    }
    const first = await installMcpFromNpm('mcp-fs', cwd, deps(routes))
    expect(first.ok).toBe(true)
    const config = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8'))
    expect(config.mcpServers['mcp-fs'].command).toBe(process.execPath)
    expect(config.mcpServers['mcp-fs'].args[0]).toMatch(/mcp-fs@2\.1\.0[\\/]index\.js$/)
    expect((await installMcpFromNpm('mcp-fs', cwd, deps(routes))).message).toContain('无重复')
  })

  it('N-E2 回归：带依赖的 MCP artifact 真实解析运行时依赖（npm install）——不再假成功', async () => {
    const withDeps = tarGz([
      { name: 'package/', type: '5' },
      { name: 'package/package.json', body: JSON.stringify({ name: 'mcp-deps', version: '1.0.0', main: 'index.js', dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } }) },
      { name: 'package/index.js', body: 'module.exports = {};' },
    ])
    const tarball = 'https://registry.npmjs.org/mcp-deps/-/mcp-deps-1.0.0.tgz'
    const routes = {
      'https://registry.npmjs.org/mcp-deps/latest': { json: { version: '1.0.0', dist: { tarball, integrity: sri(withDeps) } } },
      [tarball]: { buffer: withDeps },
    }
    let installCwd = ''
    const r = await installMcpFromNpm('mcp-deps', cwd, {
      ...deps(routes),
      npmInstall: (dir) => { installCwd = dir; return { ok: true } },
    })
    expect(r.ok).toBe(true)
    expect(r.message).toContain('运行时依赖已解析')
    expect(installCwd).toMatch(/extract-[0-9a-f-]+[\\/]package$/) // 在 rename 前的提取目录解析（依赖随目录一并落位）
  })

  it('N-E2 回归：依赖解析失败 → 整体失败（半成品不落 .mcp.json）', async () => {
    const withDeps = tarGz([
      { name: 'package/', type: '5' },
      { name: 'package/package.json', body: JSON.stringify({ name: 'mcp-bad', version: '1.0.0', main: 'index.js', dependencies: { 'some-pkg': '^9' } }) },
      { name: 'package/index.js', body: 'module.exports = {};' },
    ])
    const tarball = 'https://registry.npmjs.org/mcp-bad/-/mcp-bad-1.0.0.tgz'
    const routes = {
      'https://registry.npmjs.org/mcp-bad/latest': { json: { version: '1.0.0', dist: { tarball, integrity: sri(withDeps) } } },
      [tarball]: { buffer: withDeps },
    }
    const r = await installMcpFromNpm('mcp-bad', cwd, {
      ...deps(routes),
      npmInstall: () => ({ ok: false, error: 'npm ERR! network' }),
    })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('运行时依赖解析失败')
    expect(r.message).toContain('some-pkg')
    // 半成品不落盘：.mcp.json 未写入 mcp-bad
    if (existsSync(join(cwd, '.mcp.json'))) {
      const config = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8'))
      expect(config.mcpServers['mcp-bad']).toBeUndefined()
    }
  })

  it('installs verified npm bytes and records provenance', async () => {
    const archive = skillArchive('hello-skill')
    const result = await installSkillFromNpm('hello-skill', dataDir, deps(npmRoutes('hello-skill', '1.2.3', archive)))
    expect(result.ok).toBe(true)
    const installed = join(dataDir, 'skills', 'hello-skill')
    expect(readFileSync(join(installed, 'helper.txt'), 'utf8')).toBe('x')
    const receipt = JSON.parse(readFileSync(join(installed, '.wxnodus-provenance.json'), 'utf8'))
    expect(receipt).toMatchObject({
      source: 'npm:hello-skill',
      resolvedIdentity: 'hello-skill@1.2.3',
      expectedDigest: sri(archive),
    })
    expect(receipt.observedDigest).toMatch(/^sha512-/)
    expect(Number.isNaN(Date.parse(receipt.timestamp))).toBe(false)
  })

  it('rejects a tar path traversal without writing outside the candidate', async () => {
    const archive = skillArchive('traversal-skill', [{ name: '../escaped.txt', body: 'owned' }])
    const result = await installSkillFromNpm('traversal-skill', dataDir, deps(npmRoutes('traversal-skill', '1.0.0', archive)))
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/路径|穿越|unsafe|traversal/i)
    expect(existsSync(join(dataDir, 'escaped.txt'))).toBe(false)
    expect(existsSync(join(dataDir, 'skills', 'traversal-skill'))).toBe(false)
  })

  it.each([
    ['symlink', '2' as const],
    ['hard link', '1' as const],
    ['device', '3' as const],
  ])('rejects a %s archive entry', async (_label, type) => {
    const pkg = `bad-link-${type}`
    const archive = skillArchive(pkg, [{ name: 'package/escape', type, linkname: '../outside' }])
    const result = await installSkillFromNpm(pkg, dataDir, deps(npmRoutes(pkg, '1.0.0', archive)))
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/链接|设备|类型|link|device/i)
  })

  it('rejects a declared per-file oversize before extraction', async () => {
    const archive = skillArchive('oversize-skill', [{ name: 'package/huge.bin', declaredSize: 100_000_000 }])
    const result = await installSkillFromNpm('oversize-skill', dataDir, deps(npmRoutes('oversize-skill', '1.0.0', archive)))
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/过大|上限|size|limit/i)
  })

  it('rejects duplicate archive paths', async () => {
    const archive = skillArchive('duplicate-skill', [
      { name: 'package/duplicate.txt', body: 'one' },
      { name: 'package/duplicate.txt', body: 'two' },
    ])
    const result = await installSkillFromNpm('duplicate-skill', dataDir, deps(npmRoutes('duplicate-skill', '1.0.0', archive)))
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/重复|duplicate/i)
  })

  it('preserves the current install on hash mismatch', async () => {
    const current = join(dataDir, 'skills', 'rollback-skill')
    mkdirSync(current, { recursive: true })
    writeFileSync(join(current, 'old.txt'), 'keep', 'utf8')
    const archive = skillArchive('rollback-skill')
    const routes = npmRoutes('rollback-skill', '2.0.0', archive, `sha512-${Buffer.alloc(64).toString('base64')}`)
    const result = await installSkillFromNpm('rollback-skill', dataDir, deps(routes))
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/完整性|哈希|integrity|digest/i)
    expect(readFileSync(join(current, 'old.txt'), 'utf8')).toBe('keep')
    expect(existsSync(join(current, 'helper.txt'))).toBe(false)
  })

  it('preserves the current install when its install lock is held', async () => {
    const current = join(dataDir, 'skills', 'locked-skill')
    const lock = join(dataDir, 'skills', '.locked-skill.install.lock')
    mkdirSync(current, { recursive: true })
    writeFileSync(join(current, 'old.txt'), 'keep', 'utf8')
    mkdirSync(lock, { recursive: true })
    const archive = skillArchive('locked-skill')
    const result = await installSkillFromNpm('locked-skill', dataDir, deps(npmRoutes('locked-skill', '2.0.0', archive)))
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/锁|lock/i)
    expect(readFileSync(join(current, 'old.txt'), 'utf8')).toBe('keep')
    rmSync(lock, { recursive: true, force: true })
  })

  it('manually re-authorizes every redirect before fetching it', async () => {
    const archive = skillArchive('redirect-skill')
    const original = 'https://registry.npmjs.org/redirect-skill/-/redirect-skill-1.0.0.tgz'
    const redirected = 'https://objects.githubusercontent.com/release/redirect-skill.tgz'
    const seen: string[] = []
    const routes = npmRoutes('redirect-skill', '1.0.0', archive)
    routes[original] = { status: 302, headers: { location: redirected } }
    routes[redirected] = { buffer: archive }
    const safety = async (url: string) => {
      seen.push(url)
      return url === redirected ? { ok: false, reason: 'blocked redirect' } : { ok: true }
    }
    const result = await installSkillFromNpm('redirect-skill', dataDir, deps(routes, safety))
    expect(result.ok).toBe(false)
    expect(result.message).toContain('blocked redirect')
    expect(seen).toContain(original)
    expect(seen).toContain(redirected)
  })

  it('resolves GitHub HEAD to a commit and downloads only that immutable archive', async () => {
    const commit = '0123456789abcdef0123456789abcdef01234567'
    const archive = tarGz([
      { name: `repo-${commit}/`, type: '5' },
      { name: `repo-${commit}/SKILL.md`, body: '---\nname: github-skill\ndescription: test\n---\n\n# body\n' },
    ])
    const result = await installSkillFromGithub('acme/repo', dataDir, deps({
      'https://api.github.com/repos/acme/repo/commits/HEAD': { json: { sha: commit } },
      [`https://codeload.github.com/acme/repo/tar.gz/${commit}`]: { buffer: archive },
    }))
    expect(result.ok).toBe(true)
    const receipt = JSON.parse(readFileSync(join(dataDir, 'skills', 'github-skill', '.wxnodus-provenance.json'), 'utf8'))
    expect(receipt.source).toBe('github:acme/repo')
    expect(receipt.resolvedIdentity).toBe(`acme/repo@${commit}`)
    expect(receipt.expectedDigest).toContain(`git:${commit.slice(0, 16)}`)
    expect(receipt.observedDigest).toBe(`sha256:${createHash('sha256').update(archive).digest('hex')}`)
  })

  it('rejects untrusted hosts and malformed package or repository names', async () => {
    const badHost = await installSkillFromNpm('p', dataDir, deps({
      'https://registry.npmjs.org/p/latest': {
        json: { version: '1.0.0', dist: { tarball: 'https://evil.example/p.tgz', integrity: `sha512-${Buffer.alloc(64).toString('base64')}` } },
      },
    }))
    expect(badHost.message).toContain('白名单')
    expect((await installSkillFromGithub('bad', dataDir, deps({}))).ok).toBe(false)
    expect((await installMcpFromNpm('bad name', cwd, deps({}))).ok).toBe(false)
  })
})

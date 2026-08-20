# WxNodus V4 Wave 0 验收基线实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务执行；使用复选框跟踪步骤。
>
> 日期：2026-08-13  
> 前置：已批准 V4 设计规范  
> Channel：internal baseline  
> Required Gates：A、B（基线范围）、C（备份/恢复）、F（Policy Manifest）

## Goal

建立可机器检查、可恢复且不会把缺失测试或已知失败误报为产品绿色的 V3 基线。Wave 0 不迁移生产内核；它冻结兼容面、规范性政策面、R01-R20 验收面，并为后续 config/DB/schema 变更提供备份、history、checksum、stable failure ID 和恢复语义。

## Architecture

Wave 0 新增的 `compat`、`policy`、`migrations`、`release` 模块只描述、验证和演练现有系统，不替换 Runtime。所有 manifest 都由 TypeScript descriptor 和生成器驱动，禁止手工维护两个事实源。普通 Vitest 绿色套件、故意失败 oracle、Gate evidence 和 migration drill 分离运行，任何一类结果都不能冒充另一类完成状态。

## Tech Stack

TypeScript、Node.js 22 `fs/crypto/child_process`、better-sqlite3、Vitest、JSON Schema 风格运行时验证、PowerShell。

## Global Constraints

- 先修测试发现，再相信任何绿色汇总。
- Compatibility Manifest 必须枚举全量 surface，而不是“主要命令”。
- 已批准的兼容破坏例外必须显式标记；不能把旧 false-success 固化为正确行为。
- config/DB 迁移失败不得提升版本、不得静默创建空状态。
- 每个 migration descriptor 必须是 `rollbackable` 或 `forward-only` 判别联合成员，并满足本 Wave 的演练合同。
- Policy Manifest 必须覆盖规范性 hard-redline category catalog，不能仅冻结当前 regex 数组。
- 故意失败 case 必须位于普通 Vitest include 之外；machine registry 对 `KF-001`…`KF-030` 每个 ID 必须恰有一个 `open` 或 `resolved-with-green-regression` 状态。独立绿色 wrapper 只对 `open` case 验证非零退出/stable failure ID/failure code，对 `resolved-with-green-regression` 运行普通绿色 regression；修复任务必须原子迁移 case、registry 与普通 regression，不能永久要求已修缺陷继续退出 1。
- 测试发现闭包必须调用 Vitest 官方 machine-readable `vitest list --filesOnly --json` 得到实际 resolved 文件，禁止读取配置文本搜索 glob 字符串；resolved 集合必须与磁盘 required 集合精确相等，并单独证明被 exclude 的 required 负例会失败。
- Gate evidence 必须先经严格运行时判别联合验证后才能写 `passed`：验证 gate/status/waveScope/N/A 字段、passed command 全部 exit 0、附件存在并按原始字节重算完整 SHA-256，以及 environment → policy manifest → artifact binding；禁止类型断言或 cast 把未验证对象伪装成 `passed`。
- migration drill 必须绑定运行当下 registry 导出的 descriptor ID/checksum 及 registry artifact 完整 SHA-256；旧 drill 或旧 descriptor binding 不能通过 Gate C。
- Wave 0 不启用 Voice/Computer/Forge/新 Extension runtime。
- 本计划中的 `Files` 仅列精确文件；不得在执行时使用无法落地的测试泛称、目录泛称或 fixture 二选一。

## npm Script Registry

所有新增或在本 Wave Gate 中直接使用的 npm script 都由 `package.json` 注册；任务的 `Files` 块必须同时列出 `Modify: package.json` 和对应映射。

| Script | Runner | Owner task | 语义 |
|---|---|---|---|
| `test` | `npm run test:all` | W0-01 | 普通产品绿色套件入口 |
| `test:all` | `vitest run --config vitest.config.ts` | W0-01 | 只运行 `*.test.ts(x)`；明确排除 `tests/known-failures/**` |
| `typecheck:tests` | `tsc --noEmit -p tsconfig.tests.json` | W0-01 | tests/src co-located/package tests 类型检查 |
| `check:test-discovery` | `node scripts/check-test-discovery.mjs` | W0-01 | required test roots 闭包检查 |
| `check:requirement-coverage` | `node scripts/check-requirement-coverage.mjs` | W0-04 | R01-R20/S1-S13 覆盖检查；全文唯一 requirement script 名称 |
| `test:known-failures` | `vitest run --config vitest.known-failures.config.ts` | W0-07 | 绿色 wrapper 验证 30-ID machine registry 闭包；仅对子状态 `open` 执行故意失败 case |
| `drill:wave0-recovery` | `npm exec -- tsx scripts/drill-wave0-recovery.ts` | W0-08 | 执行本 Wave rollbackable/forward-only 演练合同 |
| `gate:wave0` | `node scripts/run-wave-gates.mjs --wave 0` | W0-08 | 生成 A-I Wave 0 evidence |
| `build` | `npm run clean && tsc` | 已存在；W0-08 Gate A 使用 | Gate A build runner |
| `typecheck` | `tsc --noEmit` | 已存在；W0-08 Gate A 使用 | Gate A typecheck runner |

`test:all` 与 `test:known-failures` 不矛盾：前者证明当前应通过的产品测试和已修复 KF regression 通过；后者证明 `KF-001`…`KF-030` machine registry 状态闭包完整。registry 中 `open` 项必须由 oracle 稳定复现非零退出/stable failure ID/code；`resolved-with-green-regression` 项必须指向且实际运行普通绿色 regression，并且不得再保留 active `.case.ts`。任何 ID 缺失/重复、同时 open/resolved、open case 意外退出 0、resolved regression 不绿或附件漂移都会使 wrapper 失败。

---

## Task W0-01：测试发现与类型检查闭包

**Requirements/Subprojects:** R10、R18；S12；Gate A/B

**Files**

- Modify: `vitest.config.ts`
- Modify: `package.json`
- Create: `tsconfig.tests.json`
- Create: `scripts/check-test-discovery.mjs`
- Create: `tests/meta/test-discovery.test.ts`
- Verify without modification: `packages/wxnodus-ink/package.json`

**Script → runner**

- `test` → `npm run test:all`
- `test:all` → `vitest run --config vitest.config.ts`
- `typecheck:tests` → `tsc --noEmit -p tsconfig.tests.json`
- `check:test-discovery` → `node scripts/check-test-discovery.mjs`

**Interfaces**

```ts
export interface TestDiscoveryRoot {
  path: 'tests' | 'src' | 'packages';
  required: true;
}

export interface TestDiscoveryManifest {
  roots: TestDiscoveryRoot[];
  diskRequiredFiles: string[];
  vitestResolvedFiles: string[];
  missingFiles: string[];
  unexpectedFiles: string[];
  excludedRequiredFiles: string[];
  missingRequiredRoots: string[];
  errorCode: null | 'TEST_DISCOVERY_COMMAND_FAILED' | 'TEST_DISCOVERY_SET_MISMATCH';
}
```

- [ ] **Step 1: 写入完整红测**

`tests/meta/test-discovery.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = resolve(repoRoot, 'scripts/check-test-discovery.mjs');

function run(...args: string[]) {
  return spawnSync(process.execPath, [script, '--json', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('workspace test discovery', () => {
  it('exactly matches every disk-required test to Vitest resolved files', () => {
    const fixture = run();
    expect(fixture.status, fixture.stderr || fixture.stdout).toBe(0);
    const report = JSON.parse(fixture.stdout) as {
      roots: Array<{ path: string }>;
      diskRequiredFiles: string[];
      vitestResolvedFiles: string[];
      missingFiles: string[];
      unexpectedFiles: string[];
      excludedRequiredFiles: string[];
      missingRequiredRoots: string[];
      errorCode: string | null;
    };

    expect(report.roots.map(root => root.path)).toEqual(['tests', 'src', 'packages']);
    expect(report.vitestResolvedFiles).toEqual(report.diskRequiredFiles);
    expect(report.missingFiles).toEqual([]);
    expect(report.unexpectedFiles).toEqual([]);
    expect(report.excludedRequiredFiles).toEqual([]);
    expect(report.missingRequiredRoots).toEqual([]);
    expect(report.errorCode).toBeNull();
  });

  it('fails when an otherwise-required test is excluded by Vitest', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'wxn-discovery-excluded-'));
    try {
      mkdirSync(resolve(fixtureRoot, 'tests/excluded'), { recursive: true });
      mkdirSync(resolve(fixtureRoot, 'src'), { recursive: true });
      mkdirSync(resolve(fixtureRoot, 'packages'), { recursive: true });
      writeFileSync(resolve(fixtureRoot, 'tests/included.test.ts'), 'export {};\n');
      writeFileSync(resolve(fixtureRoot, 'tests/excluded/required.test.ts'), 'export {};\n');
      writeFileSync(resolve(fixtureRoot, 'src/co-located.test.ts'), 'export {};\n');
      writeFileSync(resolve(fixtureRoot, 'packages/package.test.ts'), 'export {};\n');
      writeFileSync(resolve(fixtureRoot, 'vitest.config.ts'), [
        "export default { test: { include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'packages/**/*.test.ts'], exclude: ['tests/excluded/**'] } };",
      ].join('\n'));

      const fixture = run('--repo-root', fixtureRoot);
      expect(fixture.status).toBe(1);
      const report = JSON.parse(fixture.stdout) as {
        excludedRequiredFiles: string[];
        errorCode: string | null;
      };
      expect(report.excludedRequiredFiles).toEqual(['tests/excluded/required.test.ts']);
      expect(report.errorCode).toBe('TEST_DISCOVERY_SET_MISMATCH');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 运行红命令并确认明确失败码**

```powershell
npm.cmd exec -- vitest run tests/meta/test-discovery.test.ts
node scripts/check-test-discovery.mjs --json
```

预期：在脚本创建前退出 1，stderr 含 `ERR_MODULE_NOT_FOUND`；脚本创建但 `vitest.config.ts` 尚未补齐时退出 1，JSON `errorCode` 为 `TEST_DISCOVERY_SET_MISMATCH`，并以 Vitest 实际 resolved files 与 disk required files 的集合差列出 `missingFiles`/`unexpectedFiles`/`excludedRequiredFiles`，不读取配置文本、不搜索 glob 字符串、不硬编码数量。

- [ ] **Step 3: 写入可粘贴最小 discovery runner**

`scripts/check-test-discovery.mjs` 必须调用仓库安装的 Vitest 2.1 官方 machine-readable list 命令 `vitest list --config <absolute-config> --filesOnly --json`，以返回对象的 `file` 字段作为唯一 discovery 事实源：

```js
import { existsSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const rootArg = process.argv.indexOf('--repo-root');
const repoRoot = rootArg === -1 ? workspaceRoot : resolve(process.argv[rootArg + 1]);
const roots = [
  { path: 'tests', required: true },
  { path: 'src', required: true },
  { path: 'packages', required: true },
];

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(name => {
    if (name === 'node_modules' || name === 'dist' || name === 'coverage') return [];
    const path = resolve(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function normalized(path) {
  return relative(repoRoot, path).replaceAll('\\', '/');
}

const diskRequiredFiles = [...new Set(roots.flatMap(entry =>
  walk(resolve(repoRoot, entry.path))
    .map(normalized)
    .filter(path => /\.test\.(ts|tsx)$/.test(path))
    .filter(path => !path.startsWith('tests/known-failures/')),
))].sort();
const vitestCli = resolve(workspaceRoot, 'node_modules/vitest/vitest.mjs');
const listed = spawnSync(process.execPath, [
  vitestCli,
  'list',
  '--config', resolve(repoRoot, 'vitest.config.ts'),
  '--filesOnly',
  '--json',
], { cwd: repoRoot, encoding: 'utf8' });

let vitestResolvedFiles = [];
let commandFailed = listed.status !== 0 || listed.error;
if (!commandFailed) {
  try {
    const machineList = JSON.parse(listed.stdout);
    if (!Array.isArray(machineList) || machineList.some(row => typeof row?.file !== 'string')) {
      commandFailed = true;
    } else {
      vitestResolvedFiles = [...new Set(machineList.map(row => normalized(resolve(row.file))))].sort();
    }
  } catch {
    commandFailed = true;
  }
}

const required = new Set(diskRequiredFiles);
const resolved = new Set(vitestResolvedFiles);
const missingFiles = diskRequiredFiles.filter(path => !resolved.has(path));
const unexpectedFiles = vitestResolvedFiles.filter(path => !required.has(path));
const excludedRequiredFiles = [...missingFiles];
const missingRequiredRoots = roots
  .filter(entry => entry.required && !diskRequiredFiles.some(path => path.startsWith(`${entry.path}/`)))
  .map(entry => entry.path);
const setMismatch = missingFiles.length > 0 || unexpectedFiles.length > 0 || missingRequiredRoots.length > 0;
const report = {
  roots,
  diskRequiredFiles,
  vitestResolvedFiles,
  missingFiles,
  unexpectedFiles,
  excludedRequiredFiles,
  missingRequiredRoots,
  vitestStderr: commandFailed ? listed.stderr : '',
  errorCode: commandFailed
    ? 'TEST_DISCOVERY_COMMAND_FAILED'
    : setMismatch ? 'TEST_DISCOVERY_SET_MISMATCH' : null,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.errorCode === null ? 0 : 1;
```

脚本不得 `readFileSync(vitest.config.ts)`、不得搜索 include/exclude glob 文本、不得根据“配置里出现了某字符串”推断已发现。集合比较在路径规范化、去重、排序后执行，且要求双向精确相等：`diskRequiredFiles - vitestResolvedFiles` 与 `vitestResolvedFiles - diskRequiredFiles` 都必须为空。专用 `tests/known-failures/**` 是唯一不属于普通套件 disk-required 集合的测试目录；其闭包由 W0-07 machine registry 单独验证。

同时将 `vitest.config.ts` 的 test 配置改为：

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: [
      'tests/**/*.test.{ts,tsx}',
      'src/**/*.test.{ts,tsx}',
      'packages/**/*.test.{ts,tsx}',
    ],
    exclude: [
      'tests/known-failures/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
    ],
    testTimeout: 15000,
  },
});
```

- [ ] **Step 4: 完成测试 TSConfig 与 package scripts**

`tsconfig.tests.json` 必须 `extends` 根配置，设置 `noEmit: true`、`rootDir: "."`，并精确 include `tests/**/*.ts(x)`、`src/**/*.ts(x)`、`packages/**/*.ts(x)`；`package.json` 按本任务 script mapping 注册命令。

- [ ] **Step 5: 运行绿色命令**

```powershell
npm.cmd run check:test-discovery
npm.cmd run typecheck:tests
npm.cmd run test:all
```

预期：全部退出 0；`test:all` 不发现 `tests/known-failures/cases/*.case.ts`，也不运行 W0-07 专用 wrapper。

**Commit message（仅实施阶段使用，本次计划修订不提交）**

```text
test: close workspace test discovery gaps
```

---

## Task W0-02：Runtime Compatibility Descriptors 与 V3 Manifest

**Requirements/Subprojects:** R10、R12、R18；S1/S3/S12；Gate C。此任务只产出后续 Gate D 使用的 compatibility fixture，不运行 Gate D、不生成 Gate D passed evidence，也不把 Wave 0 描述为 functional gate 通过。

**Files**

- Create: `src/compat/descriptors.ts`
- Create: `src/compat/commandSurface.ts`
- Create: `src/compat/protocolSurface.ts`
- Create: `src/compat/configSurface.ts`
- Create: `src/compat/schemaSurface.ts`
- Create: `src/compat/schema.ts`
- Create: `src/compat/generateV3.ts`
- Create: `scripts/generate-v3-compatibility.mjs`
- Create: `docs/superpowers/manifests/v3-compatibility.json`
- Create: `tests/fixtures/db/v3-schema.sql`
- Create: `tests/fixtures/gates/gate-d-v3-compatibility.json`
- Create: `tests/compat-v3-manifest.test.ts`
- Verify without modification: `src/cli/args.ts`
- Verify without modification: `src/commands/registry.ts`
- Verify without modification: `src/kernel/commandLevels.ts`
- Verify without modification: `src/wxnodus-ui/gatewayTypes.ts`
- Verify without modification: `src/kernel/mcp.ts`
- Verify without modification: `src/kernel/skills.ts`
- Verify without modification: `src/kernel/plugins.ts`
- Verify without modification: `src/store/config.ts`
- Verify without modification: `src/store/db.ts`

**Interfaces**

```ts
export type CompatibilityDisposition = 'preserve' | 'deprecate' | 'intentional_break';

export interface CompatibilityEntry {
  id: string;
  kind: 'cli' | 'slash' | 'config' | 'schema' | 'gateway' | 'wire' | 'extension';
  name: string;
  descriptor: Record<string, unknown>;
  disposition: CompatibilityDisposition;
  replacement?: string;
  reasonCode?:
    | 'false_success'
    | 'fail_open_security'
    | 'permission_bypass'
    | 'memory_scope_leak'
    | 'unknown_flag_ignored'
    | 'unsafe_http_default'
    | 'weak_evidence_fingerprint'
    | 'cancel_without_effect_stop';
}

export interface CompatibilityManifest {
  schemaVersion: 1;
  generatedFromCommit: string;
  entries: CompatibilityEntry[];
  checksum: string;
}
```

- [ ] **Step 1: 写入完整红测**

`tests/compat-v3-manifest.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SLASH } from '../src/commands/registry.js';
import { ALIASES } from '../src/kernel/commandLevels.js';
import {
  buildV3CompatibilityManifest,
  verifyCompatibilityChecksum,
} from '../src/compat/generateV3.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('V3 compatibility manifest', () => {
  it('covers the runtime surface without protecting known false-success behavior', () => {
    const fixture = buildV3CompatibilityManifest({ generatedFromCommit: 'test-fixture' });
    const names = new Set(fixture.entries.map(entry => `${entry.kind}:${entry.name}`));

    for (const command of SLASH) {
      expect(names.has(`slash:${command}`), `COMPAT_SURFACE_MISSING:slash:${command}`).toBe(true);
    }
    for (const alias of Object.keys(ALIASES)) {
      expect(names.has(`slash:alias:${alias}`), `COMPAT_SURFACE_MISSING:slash:alias:${alias}`).toBe(true);
    }

    const invalidPreserves = fixture.entries.filter(entry =>
      entry.disposition === 'preserve' &&
      ['false_success', 'fail_open_security', 'unknown_flag_ignored'].includes(entry.reasonCode ?? ''),
    );
    expect(invalidPreserves).toEqual([]);
    expect(verifyCompatibilityChecksum(fixture)).toEqual({ ok: true });
  });

  it('produces a Gate D input fixture, not Gate D evidence', () => {
    const path = resolve(repoRoot, 'tests/fixtures/gates/gate-d-v3-compatibility.json');
    const gateFixture = JSON.parse(readFileSync(path, 'utf8')) as {
      purpose: string;
      evidenceStatus?: string;
      manifestPath: string;
    };

    expect(gateFixture.purpose).toBe('gate_d_input_fixture_only');
    expect(gateFixture.evidenceStatus).toBeUndefined();
    expect(gateFixture.manifestPath).toBe('docs/superpowers/manifests/v3-compatibility.json');
  });
});
```

- [ ] **Step 2: 运行红命令并确认明确失败码**

```powershell
npm.cmd exec -- vitest run tests/compat-v3-manifest.test.ts
```

预期：退出 1，首个失败为 `ERR_MODULE_NOT_FOUND`（`src/compat/generateV3.js`）；若模块已创建但 surface 不完整，断言输出必须标明 `COMPAT_SURFACE_MISSING:<kind>:<name>`，而不是仅报告数量。

- [ ] **Step 3: 写入可粘贴最小 manifest builder**

`src/compat/generateV3.ts`：

```ts
import { createHash } from 'node:crypto';
import type { CompatibilityEntry, CompatibilityManifest } from './schema.js';
import { commandSurface } from './commandSurface.js';
import { protocolSurface } from './protocolSurface.js';
import { configSurface } from './configSurface.js';
import { schemaSurface } from './schemaSurface.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function checksum(entries: CompatibilityEntry[]): string {
  return createHash('sha256').update(canonical(entries)).digest('hex');
}

export function buildV3CompatibilityManifest(input: {
  generatedFromCommit: string;
}): CompatibilityManifest {
  const entries = [
    ...commandSurface(),
    ...protocolSurface(),
    ...configSurface(),
    ...schemaSurface(),
  ].sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`COMPAT_DUPLICATE_ID:${entry.id}`);
    ids.add(entry.id);
    if (entry.disposition === 'intentional_break' && !entry.reasonCode) {
      throw new Error(`COMPAT_BREAK_REASON_MISSING:${entry.id}`);
    }
  }
  return {
    schemaVersion: 1,
    generatedFromCommit: input.generatedFromCommit,
    entries,
    checksum: checksum(entries),
  };
}

export function verifyCompatibilityChecksum(
  manifest: CompatibilityManifest,
): { ok: true } | { ok: false; code: 'COMPAT_CHECKSUM_MISMATCH' } {
  return checksum(manifest.entries) === manifest.checksum
    ? { ok: true }
    : { ok: false, code: 'COMPAT_CHECKSUM_MISMATCH' };
}
```

- [ ] **Step 4: 完成全量 descriptor sources 和 fixture**

`commandSurface.ts` 必须从 `SLASH`、`ALIASES`、CLI `SPEC`/defaults/exit behavior 导出 descriptor；alias descriptor 使用 `kind: 'slash'` 与 `name: 'alias:<原别名>'`；`protocolSurface.ts` 必须覆盖 Gateway/Wire/JSONL/HTTP/MCP/Skill/Plugin 字段；`configSurface.ts` 必须覆盖 settings keys、优先级和密钥引用；`schemaSurface.ts` 必须从 `src/store/db.ts` 与 `tests/fixtures/db/v3-schema.sql` 枚举 sessions/messages/audit/tasks/usage schema。禁止在测试中复制这些清单。

`tests/fixtures/gates/gate-d-v3-compatibility.json` 固定为：

```json
{
  "schemaVersion": 1,
  "purpose": "gate_d_input_fixture_only",
  "manifestPath": "docs/superpowers/manifests/v3-compatibility.json",
  "requiredScenarioKinds": ["cli", "headless", "gateway", "wire", "extension"],
  "generatedBy": "scripts/generate-v3-compatibility.mjs"
}
```

- [ ] **Step 5: 运行绿色命令**

```powershell
node scripts/generate-v3-compatibility.mjs --check
npm.cmd exec -- vitest run tests/compat-v3-manifest.test.ts tests/commands.test.ts tests/kernel-gateway.test.ts tests/kernel-mcp.test.ts tests/kernel-skills.test.ts tests/kernel-plugins.test.ts
```

预期：全部退出 0；只证明 compatibility manifest 和 Gate D input fixture 可用，不运行或通过 Gate D。

**Commit message（仅实施阶段使用，本次计划修订不提交）**

```text
compat: freeze the V3 public surface
```

---

## Task W0-03：版本化 Policy Manifest 与规范性 Redline Catalog

**Requirements/Subprojects:** R10、R15、R16；可信内核前置；Gate F

**Files**

- Create: `src/policy/schema.ts`
- Create: `src/policy/catalog.ts`
- Create: `src/policy/snapshot.ts`
- Modify: `src/kernel/permissions.ts`
- Create: `scripts/generate-policy-manifest.mjs`
- Create: `docs/superpowers/manifests/v3-policy.json`
- Create: `tests/policy-manifest.test.ts`
- Modify: `tests/kernel-permissions.test.ts`
- Create: `tests/fixtures/policy/v3-policy-corrupt.json`
- Create: `tests/fixtures/policy/v3-policy-truncated.json`
- Create: `tests/fixtures/policy/v3-policy-checksum-drift.json`

**Interfaces**

```ts
export type NormativeRedlineCategory =
  | 'root_home_recursive_destruction'
  | 'disk_format_partition_raw_write'
  | 'shutdown_restart_fork_bomb'
  | 'system_registry_destruction'
  | 'interpreter_pipe_injection'
  | 'credential_secret_persistence_leak'
  | 'unmediated_privilege_key_security_mode_change'
  | 'remote_history_force_push';

export type PolicyMatcher =
  | { type: 'regex'; value: string; flags: string }
  | { type: 'path'; value: string }
  | { type: 'command'; value: string };

export interface PolicyRuleDescriptor {
  id: string;
  version: number;
  kind: 'hard_redline' | 'sensitive_write' | 'command_redline';
  category: NormativeRedlineCategory;
  descriptionKey: string;
  source: string;
  overrideable: false;
  requiresUserPresence: boolean;
  matcher: PolicyMatcher;
}

export interface PolicyManifest {
  schemaVersion: 1;
  catalogVersion: 1;
  categories: Array<{
    id: NormativeRedlineCategory;
    normative: true;
    descriptionKey: string;
  }>;
  rules: PolicyRuleDescriptor[];
  checksum: string;
}
```

- [ ] **Step 1: 写入完整红测**

`tests/policy-manifest.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { NORMATIVE_REDLINE_CATALOG } from '../src/policy/catalog.js';
import {
  buildPolicyManifest,
  verifyPolicyManifestBytes,
} from '../src/policy/snapshot.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'root_home_recursive_destruction',
  'disk_format_partition_raw_write',
  'shutdown_restart_fork_bomb',
  'system_registry_destruction',
  'interpreter_pipe_injection',
  'credential_secret_persistence_leak',
  'unmediated_privilege_key_security_mode_change',
  'remote_history_force_push',
];

describe('Policy Manifest', () => {
  it('covers the normative catalog instead of only snapshotting current regexes', () => {
    const fixture = buildPolicyManifest();
    expect(NORMATIVE_REDLINE_CATALOG.map(category => category.id).sort()).toEqual([...required].sort());
    expect(fixture.categories.every(category => category.normative)).toBe(true);
    for (const category of required) {
      expect(fixture.rules.some(rule => rule.category === category), `POLICY_CATEGORY_MISSING:${category}`).toBe(true);
    }
    expect(fixture.rules.every(rule => rule.overrideable === false)).toBe(true);
    expect(
      fixture.rules.some(rule =>
        rule.category === 'unmediated_privilege_key_security_mode_change' &&
        rule.requiresUserPresence,
      ),
    ).toBe(true);
  });

  it.each([
    ['v3-policy-corrupt.json', 'POLICY_SCHEMA_INVALID'],
    ['v3-policy-truncated.json', 'POLICY_PARSE_FAILED'],
    ['v3-policy-checksum-drift.json', 'POLICY_CHECKSUM_MISMATCH'],
  ])('keeps %s as a later fail-closed consumer fixture', (name, code) => {
    const fixture = readFileSync(resolve(repoRoot, `tests/fixtures/policy/${name}`));
    const result = verifyPolicyManifestBytes(fixture);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error(`EXPECTED_POLICY_FIXTURE_FAILURE:${name}`);
    expect(result.code).toBe(code);
  });
});
```

- [ ] **Step 2: 运行红命令并确认明确失败码**

```powershell
npm.cmd exec -- vitest run tests/policy-manifest.test.ts tests/kernel-permissions.test.ts
```

预期：退出 1；创建模块前为 `ERR_MODULE_NOT_FOUND`，仅冻结当前 `HARD_REDLINES` 后必须因 `POLICY_CATEGORY_MISSING:credential_secret_persistence_leak` 或 `POLICY_CATEGORY_MISSING:unmediated_privilege_key_security_mode_change` 失败。

- [ ] **Step 3: 写入可粘贴规范性 catalog**

`src/policy/catalog.ts`：

```ts
import type { NormativeRedlineCategory } from './schema.js';

export interface NormativeRedlineCategoryDescriptor {
  id: NormativeRedlineCategory;
  normative: true;
  descriptionKey: string;
}

export const NORMATIVE_REDLINE_CATALOG: readonly NormativeRedlineCategoryDescriptor[] = [
  { id: 'root_home_recursive_destruction', normative: true, descriptionKey: 'policy.redline.root_home_recursive_destruction' },
  { id: 'disk_format_partition_raw_write', normative: true, descriptionKey: 'policy.redline.disk_format_partition_raw_write' },
  { id: 'shutdown_restart_fork_bomb', normative: true, descriptionKey: 'policy.redline.shutdown_restart_fork_bomb' },
  { id: 'system_registry_destruction', normative: true, descriptionKey: 'policy.redline.system_registry_destruction' },
  { id: 'interpreter_pipe_injection', normative: true, descriptionKey: 'policy.redline.interpreter_pipe_injection' },
  { id: 'credential_secret_persistence_leak', normative: true, descriptionKey: 'policy.redline.credential_secret_persistence_leak' },
  { id: 'unmediated_privilege_key_security_mode_change', normative: true, descriptionKey: 'policy.redline.unmediated_privilege_key_security_mode_change' },
  { id: 'remote_history_force_push', normative: true, descriptionKey: 'policy.redline.remote_history_force_push' },
] as const;
```

- [ ] **Step 4: 扩展 rule descriptors 并生成 fail-closed fixtures**

`src/kernel/permissions.ts` 中每条 hard redline、敏感路径规则和 command redline 都必须有稳定 `id/version/category`。除现有破坏/注入/force-push regex 外，必须新增：

- `credential_secret_persistence_leak`：阻止明文凭证、token、私钥或 secret 被持久化到普通 config/event/evidence/crash-log 路径。
- `unmediated_privilege_key_security_mode_change`：阻止 Agent、MCP、Plugin、Sub-agent 或自动化路径代替用户执行权限提升、密钥变更、`/perm`、`/yolo`、`/security` 等安全模式变更；这些动作必须由用户亲自操作并具有 user-presence evidence。

三个 fixture 的后续消费合同固定为：

| Fixture | 验证器错误码 | Wave 1+ consumer 行为 |
|---|---|---|
| `v3-policy-corrupt.json` | `POLICY_SCHEMA_INVALID` | PDP/启动 fail-closed |
| `v3-policy-truncated.json` | `POLICY_PARSE_FAILED` | PDP/启动 fail-closed |
| `v3-policy-checksum-drift.json` | `POLICY_CHECKSUM_MISMATCH` | PDP/启动 fail-closed |

Wave 0 只生成并验证这些 fixture；不得声称生产 PDP 已完成 fail-closed 接线。

- [ ] **Step 5: 运行绿色命令**

```powershell
node scripts/generate-policy-manifest.mjs --check
npm.cmd exec -- vitest run tests/policy-manifest.test.ts tests/kernel-permissions.test.ts
```

预期：退出 0；manifest checksum 为完整 SHA-256，alias 在分类前 canonicalize，控制流依赖 rule ID/category 而不是中英文描述或数组位置。

**Commit message（仅实施阶段使用，本次计划修订不提交）**

```text
security: version the normative V3 policy baseline
```

---

## Task W0-04：R01-R20 Prompt-to-Artifact Coverage Checker

**Requirements/Subprojects:** R01-R20、S1-S13；Gate G 前置 fixture，不运行 Gate G

**Files**

- Create: `docs/superpowers/requirements/2026-08-13-wxnodus-production-cli-requirements.json`
- Create: `src/release/requirementSchema.ts`
- Create: `scripts/check-requirement-coverage.mjs`
- Create: `tests/requirement-coverage.test.ts`
- Modify: `package.json`

**Script → runner**

- `check:requirement-coverage` → `node scripts/check-requirement-coverage.mjs`

**Interfaces**

```ts
export interface RequirementCoverage {
  id: `R${string}`;
  subprojects: string[];
  artifacts: string[];
  profiles: Array<'core' | 'standard' | 'full-local-ai'>;
  platforms: Array<'windows' | 'linux' | 'macos'>;
  positiveScenarios: string[];
  negativeScenarios: string[];
  gates: Array<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I'>;
  evidenceRequirements: string[];
  evidenceIds: string[];
  status: 'planned' | 'implemented' | 'verified' | 'blocked';
}
```

- [ ] **Step 1: 写入完整红测**

`tests/requirement-coverage.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { checkRequirementCoverage } from '../src/release/requirementSchema.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(
  repoRoot,
  'docs/superpowers/requirements/2026-08-13-wxnodus-production-cli-requirements.json',
);

describe('R01-R20 requirement coverage', () => {
  it('closes requirements, subprojects, scenarios, profiles, platforms, gates and evidence', () => {
    const fixture = JSON.parse(readFileSync(sourcePath, 'utf8')) as unknown;
    const result = checkRequirementCoverage(fixture);

    expect(result.ok, result.issues.join('\n')).toBe(true);
    expect(result.requirementIds).toEqual(
      Array.from({ length: 20 }, (_, index) => `R${String(index + 1).padStart(2, '0')}`),
    );
    expect(result.subprojectIds).toEqual(
      Array.from({ length: 13 }, (_, index) => `S${index + 1}`),
    );
  });
});
```

- [ ] **Step 2: 运行红命令并确认明确失败码**

```powershell
npm.cmd exec -- vitest run tests/requirement-coverage.test.ts
npm.cmd run check:requirement-coverage
```

预期：JSON 创建前测试退出 1 并含 `ENOENT`；script 尚未注册时 npm 退出 1 并含 `Missing script: "check:requirement-coverage"`。requirement coverage 命令只允许使用本任务声明的名称。

- [ ] **Step 3: 写入可粘贴最小 coverage checker**

`src/release/requirementSchema.ts`：

```ts
export interface RequirementCoverage {
  id: `R${string}`;
  subprojects: string[];
  artifacts: string[];
  profiles: Array<'core' | 'standard' | 'full-local-ai'>;
  platforms: Array<'windows' | 'linux' | 'macos'>;
  positiveScenarios: string[];
  negativeScenarios: string[];
  gates: Array<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I'>;
  evidenceRequirements: string[];
  evidenceIds: string[];
  status: 'planned' | 'implemented' | 'verified' | 'blocked';
}

const REQUIREMENTS = Array.from(
  { length: 20 },
  (_, index) => `R${String(index + 1).padStart(2, '0')}`,
);
const SUBPROJECTS = Array.from({ length: 13 }, (_, index) => `S${index + 1}`);

export interface RequirementCoverageResult {
  ok: boolean;
  issues: string[];
  requirementIds: string[];
  subprojectIds: string[];
}

export function checkRequirementCoverage(value: unknown): RequirementCoverageResult {
  const rows = Array.isArray(value) ? value as RequirementCoverage[] : [];
  const issues: string[] = [];
  const ids = rows.map(row => row.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify(REQUIREMENTS)) issues.push('REQUIREMENT_ID_SET_MISMATCH');

  const referencedSubprojects = [...new Set(rows.flatMap(row => row.subprojects))].sort((a, b) =>
    Number(a.slice(1)) - Number(b.slice(1)),
  );
  for (const id of SUBPROJECTS) {
    if (!referencedSubprojects.includes(id)) issues.push(`SUBPROJECT_UNREFERENCED:${id}`);
  }

  for (const row of rows) {
    const requiredArrays: Array<[string, unknown[]]> = [
      ['artifacts', row.artifacts],
      ['profiles', row.profiles],
      ['platforms', row.platforms],
      ['positiveScenarios', row.positiveScenarios],
      ['negativeScenarios', row.negativeScenarios],
      ['gates', row.gates],
      ['evidenceRequirements', row.evidenceRequirements],
    ];
    for (const [field, entries] of requiredArrays) {
      if (!Array.isArray(entries) || entries.length === 0) issues.push(`REQUIREMENT_FIELD_EMPTY:${row.id}:${field}`);
    }
    if (row.status === 'verified' && (!Array.isArray(row.evidenceIds) || row.evidenceIds.length === 0)) {
      issues.push(`VERIFIED_WITHOUT_EVIDENCE:${row.id}`);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    requirementIds: ids,
    subprojectIds: referencedSubprojects,
  };
}
```

该文件同时作为唯一 `RequirementCoverage` 类型定义和唯一 checker 导出；不得建立第二份 schema 文件。

- [ ] **Step 4: 生成唯一 requirements source 并注册 script**

将设计规范第 28 节逐项转换为 JSON。Wave 0 尚无真实 Gate G completion evidence，因此未验证项只能是 `planned`/`implemented`/`blocked`；`verified` 必须有实际 evidence IDs，禁止用计划文件路径充当证据。

- [ ] **Step 5: 运行绿色命令**

```powershell
npm.cmd run check:requirement-coverage
npm.cmd exec -- vitest run tests/requirement-coverage.test.ts
```

预期：退出 0；R01-R20 精确闭包，S1-S13 均被引用，planned 不被计为完成。

**Commit message（仅实施阶段使用，本次计划修订不提交）**

```text
quality: make requirement coverage executable
```

---

## Task W0-05：Config Backup、Version 与 Migration Registry

**Requirements/Subprojects:** R13、R14、R18；S2 前置；Gate C

**Files**

- Create: `src/migrations/types.ts`
- Create: `src/migrations/backup.ts`
- Create: `src/migrations/config/registry.ts`
- Create: `src/migrations/config/runner.ts`
- Modify: `src/store/config.ts`
- Create: `tests/config-migrations.test.ts`
- Create: `tests/config-corruption.test.ts`
- Create: `tests/fixtures/config/v3-valid.json`
- Create: `tests/fixtures/config/v3-corrupt.json`
- Create: `tests/fixtures/config/v3-migration-failure.json`

**Interfaces — 判别联合、descriptor checksum 与当波演练合同**

```ts
export interface MigrationBase<TState> {
  id: string;
  fromVersion: number;
  toVersion: number;
  checksum: string;
  validate(state: TState): void;
}

export interface RollbackableMigrationDescriptor<TState, TConfirmedWrite>
  extends MigrationBase<TState> {
  strategy: 'rollbackable';
  upgrade(state: TState): void;
  downgrade(state: TState): void;
  verifyConfirmedWrites(before: TConfirmedWrite[], after: TConfirmedWrite[]): void;
  maxRtoMs: number;
}

export interface ForwardOnlyMigrationDescriptor<TState, TConfirmedWrite, TReconcile, TRecovery>
  extends MigrationBase<TState> {
  strategy: 'forward-only';
  expand(state: TState): void;
  contract(state: TState): void;
  nMinusOneWindow: {
    minReaderVersion: string;
    minWriterVersion: string;
    closeCondition: string;
  };
  reconcile(state: TState): TReconcile;
  recovery(state: TState, cause: Error): TRecovery;
  maxRtoMs: number;
}

export type MigrationDescriptor<
  TState,
  TConfirmedWrite = unknown,
  TReconcile = unknown,
  TRecovery = unknown,
> =
  | RollbackableMigrationDescriptor<TState, TConfirmedWrite>
  | ForwardOnlyMigrationDescriptor<TState, TConfirmedWrite, TReconcile, TRecovery>;

export type WaveMigrationDrillContract =
  | {
      strategy: 'rollbackable';
      steps: readonly [
        'backup',
        'upgrade',
        'confirmed-write',
        'downgrade',
        'verify-confirmed-writes',
        're-upgrade',
      ];
    }
  | {
      strategy: 'forward-only';
      steps: readonly [
        'backup',
        'expand',
        'n-minus-one-read-write-window',
        'confirmed-write',
        'reconcile',
        'contract',
        'recovery',
        'verify-confirmed-writes',
      ];
    };

export interface MigrationDescriptorIdentity {
  id: string;
  strategy: 'rollbackable' | 'forward-only';
  fromVersion: number;
  toVersion: number;
  checksum: string;
  maxRtoMs: number;
}

export function migrationDescriptorIdentity(
  descriptor: MigrationDescriptor<unknown>,
): MigrationDescriptorIdentity;
export function verifyMigrationDescriptorChecksum(
  descriptor: MigrationDescriptor<unknown>,
): boolean;
```

Wave 0 config migration `config-v0-to-v1` 声明为 `rollbackable`：`downgrade` 只移除版本包装，不删除升级后确认写入；演练必须在 `maxRtoMs` 内执行“升级 → 新版本写入 → 降级 → 写入读回/对账 → 再升级”。descriptor `checksum` 必须是排除 `checksum` 字段后对 `migrationDescriptorIdentity` 与行为版本标识 canonicalize 所得的完整 SHA-256；registry 导出 descriptor 本身与 `migrationDescriptorIdentity()`，drill 禁止手写第二份 ID/checksum/strategy/versions/maxRto。

- [ ] **Step 1: 写入完整红测**

`tests/config-corruption.test.ts`：

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfig } from '../src/store/config.js';

const fixture = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  'fixtures/config/v3-corrupt.json',
);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('config corruption', () => {
  it('returns CONFIG_CORRUPT instead of silently manufacturing empty state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-config-corrupt-'));
    dirs.push(dir);
    copyFileSync(fixture, join(dir, 'settings.json'));
    const config = createConfig(dir);

    let errorCode: string | undefined;
    try {
      config.get('settings');
    } catch (error) {
      errorCode = (error as { code?: string }).code;
    }

    expect(errorCode, 'CONFIG_CORRUPT').toBe('CONFIG_CORRUPT');
  });
});
```

`tests/fixtures/config/v3-corrupt.json` 必须是确定性截断 JSON：

```json
{"configVersion":0,"locale":"zh-CN"
```

- [ ] **Step 2: 运行红命令并确认明确失败码**

```powershell
npm.cmd exec -- vitest run tests/config-corruption.test.ts tests/config-migrations.test.ts
```

预期：退出 1；当前 `src/store/config.ts` 吞掉 parse failure，红测以断言消息 `CONFIG_CORRUPT` 失败。迁移失败 fixture 必须进一步证明原 config 字节不变、版本未提升、run record 为 `failed`。

- [ ] **Step 3: 写入可粘贴 MigrationDescriptor 判别联合**

`src/migrations/types.ts`：

```ts
export interface MigrationBase<TState> {
  id: string;
  fromVersion: number;
  toVersion: number;
  checksum: string;
  validate(state: TState): void;
}

export interface RollbackableMigrationDescriptor<TState, TConfirmedWrite>
  extends MigrationBase<TState> {
  strategy: 'rollbackable';
  upgrade(state: TState): void;
  downgrade(state: TState): void;
  verifyConfirmedWrites(before: TConfirmedWrite[], after: TConfirmedWrite[]): void;
  maxRtoMs: number;
}

export interface ForwardOnlyMigrationDescriptor<TState, TConfirmedWrite, TReconcile, TRecovery>
  extends MigrationBase<TState> {
  strategy: 'forward-only';
  expand(state: TState): void;
  contract(state: TState): void;
  nMinusOneWindow: {
    minReaderVersion: string;
    minWriterVersion: string;
    closeCondition: string;
  };
  reconcile(state: TState): TReconcile;
  recovery(state: TState, cause: Error): TRecovery;
  maxRtoMs: number;
}

export type MigrationDescriptor<TState, TConfirmedWrite = unknown, TReconcile = unknown, TRecovery = unknown> =
  | RollbackableMigrationDescriptor<TState, TConfirmedWrite>
  | ForwardOnlyMigrationDescriptor<TState, TConfirmedWrite, TReconcile, TRecovery>;

export type WaveMigrationDrillContract =
  | {
      strategy: 'rollbackable';
      steps: readonly ['backup', 'upgrade', 'confirmed-write', 'downgrade', 'verify-confirmed-writes', 're-upgrade'];
    }
  | {
      strategy: 'forward-only';
      steps: readonly ['backup', 'expand', 'n-minus-one-read-write-window', 'confirmed-write', 'reconcile', 'contract', 'recovery', 'verify-confirmed-writes'];
    };

export interface MigrationRunRecord {
  id: string;
  strategy: MigrationDescriptor<unknown>['strategy'];
  status: 'started' | 'applied' | 'failed' | 'recovered';
  sourceHash: string;
  targetHash?: string;
  backupPath: string;
  startedAt: string;
  finishedAt?: string;
  errorCode?: string;
}
```

- [ ] **Step 4: 写入最小 fail-loud config read**

在 `src/store/config.ts` 中以以下代码替换吞错 `read()` 控制流，并保留原 `Config` façade：

```ts
export class ConfigStoreError extends Error {
  constructor(
    readonly code: 'CONFIG_CORRUPT' | 'CONFIG_IO_FAILED',
    readonly path: string,
    cause?: unknown,
  ) {
    super(`${code}:${path}`, { cause });
    this.name = 'ConfigStoreError';
  }
}

function read(dataDir: string, partition: Partition): Record<string, any> {
  const path = pathOf(dataDir, partition);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    if (error instanceof SyntaxError) throw new ConfigStoreError('CONFIG_CORRUPT', path, error);
    throw new ConfigStoreError('CONFIG_IO_FAILED', path, error);
  }
}
```

随后实现唯一 temp 文件名、file/parent fsync、Windows bounded rename retry、backup SHA-256 和 `config-v0-to-v1` rollbackable descriptor。任何迁移异常都恢复原字节并写 `failed` record。

- [ ] **Step 5: 运行绿色命令**

```powershell
npm.cmd exec -- vitest run tests/config-migrations.test.ts tests/config-corruption.test.ts tests/store-config.test.ts
npm.cmd exec -- tsc --noEmit
```

预期：退出 0；损坏 JSON 稳定返回 `CONFIG_CORRUPT`，migration failure 不提升版本，rollbackable drill 保留确认写入且满足 `maxRtoMs`。

**Commit message（仅实施阶段使用，本次计划修订不提交）**

```text
migration: add recoverable config migrations
```

---

## Task W0-06：SQLite Migration History、SQL Fixture、Backup 与 Recovery

**Requirements/Subprojects:** R09、R10、R18；S5/S12 前置；Gate C

**Files**

- Create: `src/migrations/db/registry.ts`
- Create: `src/migrations/db/runner.ts`
- Create: `src/migrations/db/history.ts`
- Create: `src/migrations/db/backup.ts`
- Modify: `src/store/db.ts`
- Create: `tests/db-migrations.test.ts`
- Create: `tests/db-backup-recovery.test.ts`
- Use as test fixture: `tests/fixtures/db/v3-schema.sql`
- Create: `tests/fixtures/db/v3-wal-write.sql`
- Create: `tests/fixtures/db/v3-migration-failure.sql`

只使用精确指定的文本 SQL fixture；不得替换为未声明生成流程的 `.sqlite` 二进制。

**Interfaces**

```ts
import type { Db } from '../../store/db.js';
import type { MigrationDescriptor } from '../types.js';

export interface ConfirmedDbWrite {
  table: string;
  primaryKey: string;
  payloadHash: string;
}

export type DbMigration = MigrationDescriptor<
  Db,
  ConfirmedDbWrite,
  { reconciledRows: number; mismatches: number },
  { mode: 'restore-backup' | 'forward-fix'; recoveredRows: number }
>;

export interface DbMigrationHistory {
  id: string;
  fromVersion: number;
  toVersion: number;
  checksum: string;
  strategy: DbMigration['strategy'];
  status: 'started' | 'applied' | 'failed' | 'recovered';
  startedAt: string;
  appliedAt?: string;
  errorCode?: string;
}
```

Wave 0 DB baseline descriptor 声明为 `forward-only`：先 expand 出 migration history/version contract，保持 N-1 reader/writer 窗口，对确认写入做 reconcile，再关闭 contract；故障恢复只能使用已声明 `recovery`/forward-fix 或验证通过的 backup restore，不能称为 operational rollback。

- [ ] **Step 1: 写入完整红测**

`tests/db-migrations.test.ts`：

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { closeDB, openDB } from '../src/store/db.js';

const fixturePath = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  'fixtures/db/v3-schema.sql',
);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('database schema history', () => {
  it('aligns schema_version with the extracted V2/V3/V4 migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-db-migration-'));
    dirs.push(dir);
    const seed = new Database(join(dir, 'nodus.db'));
    seed.exec(readFileSync(fixturePath, 'utf8'));
    seed.close();

    const db = openDB(dir);
    const fixture = db.prepare("SELECT value FROM settings WHERE key='schema_version'").get() as { value: string };
    const history = db.prepare(
      "SELECT COUNT(*) AS count FROM migration_history WHERE status='applied'",
    ).get() as { count: number };

    expect(Number(fixture.value), 'DB_SCHEMA_VERSION_DRIFT').toBe(4);
    expect(history.count).toBeGreaterThanOrEqual(3);
    closeDB(db);
  });
});
```

- [ ] **Step 2: 运行红命令并确认明确失败码**

```powershell
npm.cmd exec -- vitest run tests/db-migrations.test.ts tests/db-backup-recovery.test.ts
```

预期：退出 1；当前实现没有 `migration_history`，错误为 `SQLITE_ERROR: no such table: migration_history`；若只建 history 而不修正版本，则以 `DB_SCHEMA_VERSION_DRIFT` 失败。

- [ ] **Step 3: 写入可粘贴最小 DB runner**

`src/migrations/db/runner.ts`：

```ts
import type { Db } from '../../store/db.js';
import type { DbMigration } from './registry.js';
import { createDbBackup } from './backup.js';
import { ensureMigrationHistory, recordMigrationFinished, recordMigrationStarted } from './history.js';

function setSchemaVersion(db: Db, version: number): void {
  db.prepare(
    "INSERT INTO settings(key,value) VALUES('schema_version', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(String(version));
}

export function runDbMigration(db: Db, dbPath: string, migration: DbMigration): void {
  ensureMigrationHistory(db);
  const backup = createDbBackup(db, dbPath, migration.id);
  recordMigrationStarted(db, migration, backup.path);

  try {
    db.transaction(() => {
      if (migration.strategy === 'rollbackable') migration.upgrade(db);
      else migration.expand(db);
      migration.validate(db);
      setSchemaVersion(db, migration.toVersion);
      recordMigrationFinished(db, migration.id, 'applied');
    })();
  } catch (error) {
    recordMigrationFinished(db, migration.id, 'failed', 'DB_MIGRATION_FAILED');
    throw Object.assign(new Error(`DB_MIGRATION_FAILED:${migration.id}`, { cause: error }), {
      code: 'DB_MIGRATION_FAILED',
    });
  }
}
```

- [ ] **Step 4: 完成 forward-only contract 与 backup/recovery**

`src/store/db.ts` 不再内联吞掉 ALTER 错误，而是按 registry 顺序运行 V2 `salience`、V3 `run_no`、V4 `parts` descriptor。每次迁移先创建 SQLite 一致 snapshot（backup API 或 `VACUUM INTO`），WAL 场景不得复制打开中的 data directory。checksum drift 返回 `DB_MIGRATION_CHECKSUM_MISMATCH` 并阻断启动；backup hash mismatch 返回 `DB_BACKUP_CHECKSUM_MISMATCH` 并拒绝覆盖原 DB。DB registry 与 config registry 共用 W0-05 的 `migrationDescriptorIdentity()`/`verifyMigrationDescriptorChecksum()`；每个 DB descriptor checksum 必须从当前 descriptor canonical identity + behavior version 重算，Gate C drill 只能导入 registry 当前导出，禁止复制 ID/checksum 到 fixture 或脚本常量。

forward-only drill 必须执行：backup → expand → N-1 read/write window → 新旧写入 → reconcile → contract → 注入故障 → recovery/forward-fix → 确认写入读回，并记录总耗时不超过 descriptor `maxRtoMs`。

- [ ] **Step 5: 运行绿色命令**

```powershell
npm.cmd exec -- vitest run tests/db-migrations.test.ts tests/db-backup-recovery.test.ts tests/store-db.test.ts
npm.cmd exec -- tsc --noEmit
```

预期：退出 0；migration 异常事务回滚且 history=`failed`，版本不提升，WAL backup 可读，重复 open 幂等，checksum drift fail-closed。

**Commit message（仅实施阶段使用，本次计划修订不提交）**

```text
migration: make database upgrades auditable
```

---

## Task W0-07：Known-failure 与 False-success 基线

**Requirements/Subprojects:** R07-R10、R15-R16；S1/S5-S9/S13 前置；Gate B/F baseline

**Files**

- Create: `src/release/knownFailures.ts`
- Create: `vitest.known-failures.config.ts`
- Create: `tests/known-failures/caseHarness.ts`
- Create: `tests/known-failures/known-failures-wrapper.test.ts`
- Create: `tests/known-failures/cases/kf-001-offline-no-key.case.ts`
- Create: `tests/known-failures/cases/kf-002-config-full.case.ts`
- Create: `tests/known-failures/cases/kf-003-setup-wizard.case.ts`
- Create: `tests/known-failures/cases/kf-004-personality-persistence.case.ts`
- Create: `tests/known-failures/cases/kf-005-wav-header.case.ts`
- Create: `tests/known-failures/cases/kf-006-whisper-nonblocking.case.ts`
- Create: `tests/known-failures/cases/kf-007-screenshot-dimensions.case.ts`
- Create: `tests/known-failures/cases/kf-008-robotjs-arguments.case.ts`
- Create: `tests/known-failures/cases/kf-009-uia-false-success.case.ts`
- Create: `tests/known-failures/cases/kf-010-permission-bypass.case.ts`
- Create: `tests/known-failures/cases/kf-011-ssrf-redirect.case.ts`
- Create: `tests/known-failures/cases/kf-012-browser-session-isolation.case.ts`
- Create: `tests/known-failures/cases/kf-013-memory-scope.case.ts`
- Create: `tests/known-failures/cases/kf-014-memory-index-consistency.case.ts`
- Create: `tests/known-failures/cases/kf-015-reload-scope-overwrite.case.ts`
- Create: `tests/known-failures/cases/kf-016-forge-path-normalization.case.ts`
- Create: `tests/known-failures/cases/kf-017-forge-placeholder-verification.case.ts`
- Create: `tests/known-failures/cases/kf-018-build-static-frontend.case.ts`
- Create: `tests/known-failures/cases/kf-019-build-restart-readback.case.ts`
- Create: `tests/known-failures/cases/kf-020-evidence-full-sha256.case.ts`
- Create: `tests/known-failures/cases/kf-021-gate-exit-code.case.ts`
- Create: `tests/known-failures/cases/kf-022-scaffold-build-pipeline.case.ts`
- Create: `tests/known-failures/cases/kf-023-goal-verifier-fail-open.case.ts`
- Create: `tests/known-failures/cases/kf-024-agent-text-success.case.ts`
- Create: `tests/known-failures/cases/kf-025-task-kill-effect-fence.case.ts`
- Create: `tests/known-failures/cases/kf-026-hook-fail-closed.case.ts`
- Create: `tests/known-failures/cases/kf-027-wire-readiness.case.ts`
- Create: `tests/known-failures/cases/kf-028-session-restore-gateway.case.ts`
- Create: `tests/known-failures/cases/kf-029-english-system-prompt.case.ts`
- Create: `tests/known-failures/cases/kf-030-schema-version.case.ts`
- Modify: `package.json`

**Script → runner**

- `test:known-failures` → `vitest run --config vitest.known-failures.config.ts`

`vitest.config.ts` 的普通 include 只匹配 `*.test.ts(x)`，并排除 `tests/known-failures/**`；上述 `*.case.ts` 不能被 `test:all` 命中。已修复 KF 必须在对应后续修复计划的 `Files` 中以精确路径声明并创建 `tests/regressions/known-failures/kf-NNN-*.regression.test.ts`，由普通 `test:all` 命中；W0-07 初始 30 项全为 open，不创建空目录或占位 regression。`vitest.known-failures.config.ts` 只 include `tests/known-failures/known-failures-wrapper.test.ts`，wrapper 根据 machine registry：对子状态 `open` 用 child process 执行 `.case.ts`，对子状态 `resolved-with-green-regression` 用 Vitest `run` 精确执行登记的普通 regression。

**Stable machine registry 初始 catalog（W0-07 建立时 30 项均为 `open`；表中 Case/Expected failure code 只属于 `open` 分支）**

| ID | Case | Expected failure code |
|---|---|---|
| KF-001 | offline no-key | `OFFLINE_PROVIDER_KEY_PRECHECK` |
| KF-002 | `config.get full` | `CONFIG_FULL_UNREACHABLE` |
| KF-003 | setup wizard | `SETUP_WIZARD_NOT_ENTERED` |
| KF-004 | personality persistence | `PERSONALITY_FALSE_SUCCESS` |
| KF-005 | WAV header | `VOICE_WAV_HEADER_CORRUPT` |
| KF-006 | synchronous Whisper | `WHISPER_EVENT_LOOP_BLOCKED` |
| KF-007 | screenshot dimensions | `SCREENSHOT_DIMENSION_API_MISMATCH` |
| KF-008 | robotjs arguments | `ROBOTJS_ARGUMENT_MISMATCH` |
| KF-009 | UIA false success | `UIA_ACTION_FALSE_SUCCESS` |
| KF-010 | permission bypass | `MANUAL_PATH_PERMISSION_BYPASS` |
| KF-011 | SSRF redirect | `SSRF_REDIRECT_UNCHECKED` |
| KF-012 | browser isolation | `BROWSER_CONTEXT_SHARED` |
| KF-013 | memory scope | `MEMORY_SCOPE_LEAK` |
| KF-014 | memory index | `MEMORY_INDEX_STALE` |
| KF-015 | reload overwrite | `REGISTRATION_SCOPE_OVERWRITE` |
| KF-016 | Forge path | `FORGE_PATH_DOUBLE_JOIN` |
| KF-017 | Forge placeholder | `FORGE_PLACEHOLDER_VERIFIED` |
| KF-018 | static frontend | `BUILD_STATIC_FRONTEND_MISSING` |
| KF-019 | restart readback | `BUILD_RESTART_READBACK_MISSING` |
| KF-020 | weak evidence | `EVIDENCE_WEAK_FINGERPRINT` |
| KF-021 | exit code | `GATE_EXIT_CODE_NOT_PROPAGATED` |
| KF-022 | scaffold bypass | `SCAFFOLD_PIPELINE_BYPASS` |
| KF-023 | goal fail-open | `GOAL_VERIFIER_FAIL_OPEN` |
| KF-024 | Agent text success | `AGENT_TEXT_FALSE_SUCCESS` |
| KF-025 | task kill | `TASK_KILL_EFFECT_CONTINUES` |
| KF-026 | hook fail-open | `SECURITY_HOOK_FAIL_OPEN` |
| KF-027 | Wire readiness | `WIRE_REGISTERED_BEFORE_READY` |
| KF-028 | session restore | `SESSION_RESTORE_DEFAULTED` |
| KF-029 | English prompt | `ENGLISH_PROMPT_CHINESE_CONTROL_TEXT` |
| KF-030 | schema version | `DB_SCHEMA_VERSION_DRIFT` |

- [ ] **Step 1: 写入一个完整故意失败 case**

`tests/known-failures/cases/kf-024-agent-text-success.case.ts`：

```ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, closeDB } from '../../../src/store/db.js';
import { createEventBus } from '../../../src/kernel/events.js';
import { createMemory } from '../../../src/kernel/memory.js';
import { createAgent, type ModelCall } from '../../../src/kernel/agent.js';
import { runKnownFailureCase } from '../caseHarness.js';

await runKnownFailureCase({
  failureId: 'KF-024',
  expectedFailureCode: 'AGENT_TEXT_FALSE_SUCCESS',
  assertionMessage: 'AGENT_TEXT_FALSE_SUCCESS',
  run: async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'wxn-kf-024-'));
    const db = openDB(fixtureDir);
    try {
      const bus = createEventBus(fixtureDir);
      const mem = createMemory(db);
      const agent = createAgent({
        db,
        bus,
        mem,
        sessionId: 'kf-024',
        config: { settings: { apiKeyEnc: 'fixture', baseURL: 'https://mock', model: 'mock' } },
        callModel: async (): Promise<ModelCall> => ({ type: 'text', content: '完成了' }),
      });
      const result = await agent.run('执行一个不可验证的真实副作用');

      assert.equal(result.ok, false, 'AGENT_TEXT_FALSE_SUCCESS');
    } finally {
      closeDB(db);
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  },
});
```

此 oracle 走现有 `createAgent`、`openDB`、`createEventBus`、`createMemory` 生产路径；若生产签名后续有意变更，fixture 只能做对应机械更新，不得把断言改成恒失败。其他 29 个文件必须采用同一 harness，真实调用对应旧路径，并用各自 stable failure code 做断言；不得用 `.skip`、`todo`、恒失败 `expect(false)` 或只验证 mock proxy。

- [ ] **Step 2: 运行 case 红命令与 wrapper 红命令**

```powershell
npm.cmd exec -- tsx tests/known-failures/cases/kf-024-agent-text-success.case.ts
npm.cmd run test:known-failures
```

预期：单 case 在初始 `open` 状态下退出码严格为 1，stderr 最后一行 JSON 含 `{"failureId":"KF-024","failureCode":"AGENT_TEXT_FALSE_SUCCESS"}`。wrapper/script 创建前第二条退出 1 并含 `Missing script: "test:known-failures"`。case 退出 0 表示缺陷候选已修复，但在完成同一原子变更前仍必须使 wrapper 红；修复任务必须同时删除该 active case、把 registry 唯一条目迁为 `resolved-with-green-regression`、写入普通绿色 regression 并使 `test:all` 与 `test:known-failures` 都绿，不能永久要求已修缺陷继续退出 1。

- [ ] **Step 3: 写入可粘贴 case harness**

`tests/known-failures/caseHarness.ts`：

```ts
import { AssertionError } from 'node:assert';

export async function runKnownFailureCase(input: {
  failureId: string;
  expectedFailureCode: string;
  assertionMessage: string;
  run: () => Promise<void>;
}): Promise<void> {
  try {
    await input.run();
    process.stdout.write(`${JSON.stringify({
      failureId: input.failureId,
      outcome: 'unexpected-pass',
    })}\n`);
    process.exitCode = 0;
  } catch (error) {
    if (error instanceof AssertionError && error.message.includes(input.assertionMessage)) {
      process.stderr.write(`${JSON.stringify({
        failureId: input.failureId,
        failureCode: input.expectedFailureCode,
        outcome: 'known-failure-observed',
      })}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${JSON.stringify({
      failureId: input.failureId,
      failureCode: 'KNOWN_FAILURE_ORACLE_CRASHED',
      outcome: 'harness-error',
      message: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 2;
  }
}
```

- [ ] **Step 4: 写入 machine registry 判别联合、30-ID 闭包验证与绿色 wrapper**

`src/release/knownFailures.ts` 的公开接口固定为：

```ts
export type KnownFailureId = `KF-${string}`;

export type KnownFailureEntry =
  | {
      id: KnownFailureId;
      status: 'open';
      caseFile: `tests/known-failures/cases/${string}.case.ts`;
      expectedFailureCode: string;
      timeoutMs: number;
    }
  | {
      id: KnownFailureId;
      status: 'resolved-with-green-regression';
      regressionFile: `tests/regressions/known-failures/${string}.regression.test.ts`;
      resolvedBy: string;
      timeoutMs: number;
    };

export const REQUIRED_KNOWN_FAILURE_IDS = Array.from(
  { length: 30 },
  (_, index) => `KF-${String(index + 1).padStart(3, '0')}`,
) as KnownFailureId[];

export const KNOWN_FAILURES: readonly KnownFailureEntry[] = [
  { id: 'KF-001', status: 'open', caseFile: 'tests/known-failures/cases/kf-001-offline-no-key.case.ts', expectedFailureCode: 'OFFLINE_PROVIDER_KEY_PRECHECK', timeoutMs: 15000 },
  { id: 'KF-002', status: 'open', caseFile: 'tests/known-failures/cases/kf-002-config-full.case.ts', expectedFailureCode: 'CONFIG_FULL_UNREACHABLE', timeoutMs: 15000 },
  { id: 'KF-003', status: 'open', caseFile: 'tests/known-failures/cases/kf-003-setup-wizard.case.ts', expectedFailureCode: 'SETUP_WIZARD_NOT_ENTERED', timeoutMs: 15000 },
  { id: 'KF-004', status: 'open', caseFile: 'tests/known-failures/cases/kf-004-personality-persistence.case.ts', expectedFailureCode: 'PERSONALITY_FALSE_SUCCESS', timeoutMs: 15000 },
  { id: 'KF-005', status: 'open', caseFile: 'tests/known-failures/cases/kf-005-wav-header.case.ts', expectedFailureCode: 'VOICE_WAV_HEADER_CORRUPT', timeoutMs: 15000 },
  { id: 'KF-006', status: 'open', caseFile: 'tests/known-failures/cases/kf-006-whisper-nonblocking.case.ts', expectedFailureCode: 'WHISPER_EVENT_LOOP_BLOCKED', timeoutMs: 15000 },
  { id: 'KF-007', status: 'open', caseFile: 'tests/known-failures/cases/kf-007-screenshot-dimensions.case.ts', expectedFailureCode: 'SCREENSHOT_DIMENSION_API_MISMATCH', timeoutMs: 15000 },
  { id: 'KF-008', status: 'open', caseFile: 'tests/known-failures/cases/kf-008-robotjs-arguments.case.ts', expectedFailureCode: 'ROBOTJS_ARGUMENT_MISMATCH', timeoutMs: 15000 },
  { id: 'KF-009', status: 'open', caseFile: 'tests/known-failures/cases/kf-009-uia-false-success.case.ts', expectedFailureCode: 'UIA_ACTION_FALSE_SUCCESS', timeoutMs: 15000 },
  { id: 'KF-010', status: 'open', caseFile: 'tests/known-failures/cases/kf-010-permission-bypass.case.ts', expectedFailureCode: 'MANUAL_PATH_PERMISSION_BYPASS', timeoutMs: 15000 },
  { id: 'KF-011', status: 'open', caseFile: 'tests/known-failures/cases/kf-011-ssrf-redirect.case.ts', expectedFailureCode: 'SSRF_REDIRECT_UNCHECKED', timeoutMs: 15000 },
  { id: 'KF-012', status: 'open', caseFile: 'tests/known-failures/cases/kf-012-browser-session-isolation.case.ts', expectedFailureCode: 'BROWSER_CONTEXT_SHARED', timeoutMs: 15000 },
  { id: 'KF-013', status: 'open', caseFile: 'tests/known-failures/cases/kf-013-memory-scope.case.ts', expectedFailureCode: 'MEMORY_SCOPE_LEAK', timeoutMs: 15000 },
  { id: 'KF-014', status: 'open', caseFile: 'tests/known-failures/cases/kf-014-memory-index-consistency.case.ts', expectedFailureCode: 'MEMORY_INDEX_STALE', timeoutMs: 15000 },
  { id: 'KF-015', status: 'open', caseFile: 'tests/known-failures/cases/kf-015-reload-scope-overwrite.case.ts', expectedFailureCode: 'REGISTRATION_SCOPE_OVERWRITE', timeoutMs: 15000 },
  { id: 'KF-016', status: 'open', caseFile: 'tests/known-failures/cases/kf-016-forge-path-normalization.case.ts', expectedFailureCode: 'FORGE_PATH_DOUBLE_JOIN', timeoutMs: 15000 },
  { id: 'KF-017', status: 'open', caseFile: 'tests/known-failures/cases/kf-017-forge-placeholder-verification.case.ts', expectedFailureCode: 'FORGE_PLACEHOLDER_VERIFIED', timeoutMs: 15000 },
  { id: 'KF-018', status: 'open', caseFile: 'tests/known-failures/cases/kf-018-build-static-frontend.case.ts', expectedFailureCode: 'BUILD_STATIC_FRONTEND_MISSING', timeoutMs: 15000 },
  { id: 'KF-019', status: 'open', caseFile: 'tests/known-failures/cases/kf-019-build-restart-readback.case.ts', expectedFailureCode: 'BUILD_RESTART_READBACK_MISSING', timeoutMs: 15000 },
  { id: 'KF-020', status: 'open', caseFile: 'tests/known-failures/cases/kf-020-evidence-full-sha256.case.ts', expectedFailureCode: 'EVIDENCE_WEAK_FINGERPRINT', timeoutMs: 15000 },
  { id: 'KF-021', status: 'open', caseFile: 'tests/known-failures/cases/kf-021-gate-exit-code.case.ts', expectedFailureCode: 'GATE_EXIT_CODE_NOT_PROPAGATED', timeoutMs: 15000 },
  { id: 'KF-022', status: 'open', caseFile: 'tests/known-failures/cases/kf-022-scaffold-build-pipeline.case.ts', expectedFailureCode: 'SCAFFOLD_PIPELINE_BYPASS', timeoutMs: 15000 },
  { id: 'KF-023', status: 'open', caseFile: 'tests/known-failures/cases/kf-023-goal-verifier-fail-open.case.ts', expectedFailureCode: 'GOAL_VERIFIER_FAIL_OPEN', timeoutMs: 15000 },
  { id: 'KF-024', status: 'open', caseFile: 'tests/known-failures/cases/kf-024-agent-text-success.case.ts', expectedFailureCode: 'AGENT_TEXT_FALSE_SUCCESS', timeoutMs: 15000 },
  { id: 'KF-025', status: 'open', caseFile: 'tests/known-failures/cases/kf-025-task-kill-effect-fence.case.ts', expectedFailureCode: 'TASK_KILL_EFFECT_CONTINUES', timeoutMs: 15000 },
  { id: 'KF-026', status: 'open', caseFile: 'tests/known-failures/cases/kf-026-hook-fail-closed.case.ts', expectedFailureCode: 'SECURITY_HOOK_FAIL_OPEN', timeoutMs: 15000 },
  { id: 'KF-027', status: 'open', caseFile: 'tests/known-failures/cases/kf-027-wire-readiness.case.ts', expectedFailureCode: 'WIRE_REGISTERED_BEFORE_READY', timeoutMs: 15000 },
  { id: 'KF-028', status: 'open', caseFile: 'tests/known-failures/cases/kf-028-session-restore-gateway.case.ts', expectedFailureCode: 'SESSION_RESTORE_DEFAULTED', timeoutMs: 15000 },
  { id: 'KF-029', status: 'open', caseFile: 'tests/known-failures/cases/kf-029-english-system-prompt.case.ts', expectedFailureCode: 'ENGLISH_PROMPT_CHINESE_CONTROL_TEXT', timeoutMs: 15000 },
  { id: 'KF-030', status: 'open', caseFile: 'tests/known-failures/cases/kf-030-schema-version.case.ts', expectedFailureCode: 'DB_SCHEMA_VERSION_DRIFT', timeoutMs: 15000 },
] as const;

export function validateKnownFailureRegistry(
  value: unknown,
): { ok: true; entries: KnownFailureEntry[] } | { ok: false; issues: string[] } {
  const rows = Array.isArray(value) ? value : [];
  const issues: string[] = [];
  const counts = new Map<string, number>();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') {
      issues.push('KF_ENTRY_INVALID');
      continue;
    }
    const row = raw as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id : '<missing>';
    counts.set(id, (counts.get(id) ?? 0) + 1);
    if (row.status === 'open') {
      if (typeof row.caseFile !== 'string' || !row.caseFile.startsWith('tests/known-failures/cases/') ||
          !row.caseFile.endsWith('.case.ts') || typeof row.expectedFailureCode !== 'string' ||
          typeof row.timeoutMs !== 'number' || 'regressionFile' in row || 'resolvedBy' in row) {
        issues.push(`KF_OPEN_SHAPE_INVALID:${id}`);
      }
    } else if (row.status === 'resolved-with-green-regression') {
      if (typeof row.regressionFile !== 'string' ||
          !/^tests\/regressions\/known-failures\/kf-\d{3}-.+\.regression\.test\.ts$/.test(row.regressionFile) ||
          typeof row.resolvedBy !== 'string' || row.resolvedBy.length === 0 ||
          typeof row.timeoutMs !== 'number' || 'caseFile' in row || 'expectedFailureCode' in row) {
        issues.push(`KF_RESOLVED_SHAPE_INVALID:${id}`);
      }
    } else {
      issues.push(`KF_STATUS_INVALID:${id}`);
    }
  }
  for (const id of REQUIRED_KNOWN_FAILURE_IDS) {
    const count = counts.get(id) ?? 0;
    if (count === 0) issues.push(`KF_ID_MISSING:${id}`);
    if (count > 1) issues.push(`KF_ID_DUPLICATE:${id}`);
  }
  for (const id of counts.keys()) {
    if (!REQUIRED_KNOWN_FAILURE_IDS.includes(id as KnownFailureId)) issues.push(`KF_ID_UNEXPECTED:${id}`);
  }
  return issues.length === 0
    ? { ok: true, entries: rows as KnownFailureEntry[] }
    : { ok: false, issues };
}
```

`KNOWN_FAILURES` 实际实现不得保留注释占位，必须逐项填满 Stable machine registry 表的 30 项。`tests/known-failures/known-failures-wrapper.test.ts` 必须实现以下完整合同：

```ts
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  KNOWN_FAILURES,
  validateKnownFailureRegistry,
} from '../../src/release/knownFailures.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tsxCli = resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs');
const vitestCli = resolve(repoRoot, 'node_modules/vitest/vitest.mjs');

const registry = validateKnownFailureRegistry(KNOWN_FAILURES);
if (!registry.ok) throw new Error(registry.issues.join('\n'));
const entries = registry.entries;

describe('known V3 failure registry', () => {
  it('has exact disk closure: every active case belongs to exactly one open ID', () => {
    const diskCases = readdirSync(resolve(repoRoot, 'tests/known-failures/cases'))
      .filter(name => name.endsWith('.case.ts'))
      .map(name => `tests/known-failures/cases/${name}`)
      .sort();
    const registeredCases = entries
      .filter(entry => entry.status === 'open')
      .map(entry => entry.caseFile)
      .sort();
    expect(diskCases).toEqual(registeredCases);
  });

  for (const failure of entries) {
    if (failure.status === 'open') {
      it(`${failure.id} open oracle emits its stable failure code`, () => {
        const fixture = spawnSync(process.execPath, [tsxCli, resolve(repoRoot, failure.caseFile)], {
          cwd: repoRoot,
          encoding: 'utf8',
          timeout: failure.timeoutMs,
        });
        expect(fixture.status, `${failure.id} unexpectedly passed\n${fixture.stdout}`).toBe(1);
        const line = fixture.stderr.trim().split(/\r?\n/).at(-1) ?? '';
        const report = JSON.parse(line) as { failureId: string; failureCode: string };
        expect(report.failureId).toBe(failure.id);
        expect(report.failureCode).toBe(failure.expectedFailureCode);
      });
    } else {
      it(`${failure.id} resolved regression is an ordinary green test`, () => {
        expect(existsSync(resolve(repoRoot, failure.regressionFile))).toBe(true);
        const fixture = spawnSync(process.execPath, [
          vitestCli, 'run', '--config', resolve(repoRoot, 'vitest.config.ts'), failure.regressionFile,
        ], { cwd: repoRoot, encoding: 'utf8', timeout: failure.timeoutMs });
        expect(fixture.status, fixture.stderr || fixture.stdout).toBe(0);
        const retiredCasePrefix = `${failure.id.toLowerCase()}-`;
        expect(readdirSync(resolve(repoRoot, 'tests/known-failures/cases'))
          .some(name => name.startsWith(retiredCasePrefix) && name.endsWith('.case.ts'))).toBe(false);
      });
    }
  }
});
```

`src/release/knownFailures.ts` 必须显式登记上表 30 项且通过严格判别联合：每个 `KF-001`…`KF-030` 恰有一项，状态只能是 `open` 或 `resolved-with-green-regression`。wrapper 不通过 glob 猜 ID；glob/目录枚举只用于对 registry 与磁盘做反向闭包检查，保证 active `.case.ts` 无漏登、无孤儿。

- [ ] **Step 5: 注册独立 config/script，并定义后续 KF 原子迁移合同**

`vitest.known-failures.config.ts` 只 include wrapper，普通 `vitest.config.ts` 继续排除整个 `tests/known-failures/**`。`package.json` 注册 `test:known-failures`，不得把该命令串进 `test:all` 后再把故意失败解释成产品通过。

任一后续缺陷修复任务必须在同一原子变更中完成且验证以下四项，不允许只把 `open` case 删掉或永久保留退出 1 期望：

1. 修改生产代码修复 `KF-NNN`；
2. 将该 registry 唯一条目从 `{ status: 'open', caseFile, expectedFailureCode }` 替换为 `{ status: 'resolved-with-green-regression', regressionFile, resolvedBy, timeoutMs }`，不能并存两条；
3. 将原 oracle 的生产路径与断言迁移到登记的 `tests/regressions/known-failures/kf-NNN-*.regression.test.ts`，断言正确行为并退出 0，同时删除对应 active `.case.ts`；
4. 同时运行 `npm.cmd run test:all` 与 `npm.cmd run test:known-failures`，两者必须退出 0；wrapper 必须证明 30-ID 总闭包仍恰好 30 项、无缺失、无重复、无孤儿 case。

- [ ] **Step 6: 运行绿色命令**

```powershell
npm.cmd run test:known-failures
npm.cmd run test:all
```

预期：两条都退出 0，但含义不同：第一条验证 `KF-001`…`KF-030` 每个 ID 恰有一个 `open` 或 `resolved-with-green-regression` 状态；对初始 30 个 `open` 项确认 stable failure ID/code，对后续 resolved 项确认登记的普通 regression 退出 0。第二条确认普通产品绿色套件以及所有 resolved KF regression 通过。ID 缺失/重复/越界、状态 shape 混用、active case 孤儿、open case 意外通过/超时/退出 2/ID-code 漂移，或 resolved regression 缺失/非绿/仍残留 active case，都会使 `test:known-failures` 失败。

**Commit message（仅实施阶段使用，本次计划修订不提交）**

```text
test: capture V3 known failure oracles
```

---

## Task W0-08：Wave 0 Gate Runner 与恢复演练

**Requirements/Subprojects:** R15、R17-R20；S12；Gate A/B/C/F，D/E/G/H/I 严格 N/A

**Files**

- Create: `src/release/evidenceSchema.ts`
- Create: `src/release/artifactBinding.ts`
- Create: `src/release/gateDefinitions.ts`
- Create: `src/release/gateRunner.ts`
- Create: `scripts/run-wave-gates.mjs`
- Create: `scripts/drill-wave0-recovery.ts`
- Create: `tests/release-gate-runner.test.ts`
- Create: `tests/release-evidence-integrity.test.ts`
- Create: `tests/fixtures/gates/wave0-unreachable-capabilities.json`
- Generate: `docs/superpowers/evidence/wave0/candidate-artifact.json`
- Generate: `docs/superpowers/evidence/wave0/environment.json`
- Generate: `docs/superpowers/evidence/wave0/migration-drill-contract.json`
- Generate: `docs/superpowers/evidence/wave0/gate-a.json`
- Generate: `docs/superpowers/evidence/wave0/gate-b.json`
- Generate: `docs/superpowers/evidence/wave0/gate-c.json`
- Generate: `docs/superpowers/evidence/wave0/gate-d.json`
- Generate: `docs/superpowers/evidence/wave0/gate-e.json`
- Generate: `docs/superpowers/evidence/wave0/gate-f.json`
- Generate: `docs/superpowers/evidence/wave0/gate-g.json`
- Generate: `docs/superpowers/evidence/wave0/gate-h.json`
- Generate: `docs/superpowers/evidence/wave0/gate-i.json`
- Generate: `docs/superpowers/evidence/wave0/recovery-drill.json`
- Modify: `package.json`

**Script → runner**

- `build` → `npm run clean && tsc`（已存在；Gate A command 1）
- `typecheck` → `tsc --noEmit`（已存在；Gate A command 2）
- `drill:wave0-recovery` → `npm exec -- tsx scripts/drill-wave0-recovery.ts`
- `gate:wave0` → `node scripts/run-wave-gates.mjs --wave 0`

**GateEvidence 严格运行时判别联合**

```ts
export type GateId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I';
export type Sha256 = string; // runtime 必须匹配 /^[a-f0-9]{64}$/
export type ProfileId = 'core' | 'standard' | 'full-local-ai';
export type PlatformId = 'windows' | 'linux' | 'macos';

export interface EvidenceAttachment {
  path: string; // repo-relative，禁止绝对路径与 ..
  sha256: Sha256; // 原始文件字节的完整 SHA-256
  kind: 'stdout' | 'stderr' | 'artifact' | 'environment' | 'policy-manifest' | 'migration-drill' | 'unreachable-capability';
}

export interface EvidenceBinding {
  environment: EvidenceAttachment;
  policyManifest: EvidenceAttachment & { manifestChecksum: Sha256 };
  artifact: EvidenceAttachment & { artifactSha256: Sha256; commit: string };
  bindingSha256: Sha256;
}

export interface CommandEvidence {
  executable: string;
  args: string[];
  exitCode: number | null;
  stdoutAttachment: string;
  stderrAttachment: string;
}

interface CommonGateEvidence {
  schemaVersion: 1;
  waveScope: 'wave0';
  gate: GateId;
  requirementIds: Array<`R${string}`>;
  profiles: ProfileId[];
  platforms: PlatformId[];
  capabilityIds: string[];
  attachments: EvidenceAttachment[];
  binding: EvidenceBinding;
}

export type ExecutedGateEvidence = CommonGateEvidence & (
  | { status: 'passed'; commands: CommandEvidence[] }
  | { status: 'failed'; commands: CommandEvidence[]; reasonCode: string }
  | { status: 'blocked'; commands: CommandEvidence[]; reasonCode: string }
);

export interface NotApplicableGateEvidence extends CommonGateEvidence {
  status: 'not_applicable';
  unreachableEvidenceIds: string[];
  reasonCode: 'CAPABILITY_NOT_DELIVERED_IN_WAVE_SCOPE';
}

export type GateEvidence = ExecutedGateEvidence | NotApplicableGateEvidence;
```

`not_applicable` 分支的 `requirementIds`、`profiles`、`platforms`、`capabilityIds`、`unreachableEvidenceIds` 全部必填、非空且无重复；它必须无 `commands`，`attachments` 中必须有 `unreachable-capability` 文件与每个 unreachable ID 对应。`passed` 必须无 `reasonCode` 且每条 command 的 `exitCode === 0`；`failed` 必须至少一条 command 非零；`blocked` 必须有 `reasonCode`，且可用 `null` 表示未能启动。所有分支都必须绑定本次 environment、Policy Manifest 和 candidate artifact，不能通过可选字段、空数组或额外字段绕过。

**Wave 0 `waveScope`**

| Gate | Scope | Runner/证据 |
|---|---|---|
| A | Required | **仅** `build` + `typecheck` |
| B | Required baseline | `check:test-discovery` + `test:all` + `test:known-failures` |
| C | Required | `drill:wave0-recovery`，覆盖 config rollbackable 与 DB forward-only 当波合同 |
| D | N/A | W0-02 仅产 `gate-d-v3-compatibility.json` input fixture；functional capability 尚不可达 |
| E | N/A | Wave 0 不启用真实 Windows Voice/Computer capability |
| F | Required | **仅本 Wave policy scope**：Policy Manifest/checksum/catalog/fixture validation |
| G | N/A | CompletionGate/evidence completion decision 尚未交付；本任务只建立 evidence envelope |
| H | N/A | Distribution/profile installer 尚未交付 |
| I | N/A | Secondary-platform release matrix 尚未交付 |

- [ ] **Step 1: 写入完整红测**

`tests/release-gate-runner.test.ts` 与 `tests/release-evidence-integrity.test.ts` 必须覆盖下列红测矩阵（每行均构造最小 fixture 并断言精确错误码，不能只测 interface 可赋值）：

| 破坏方式 | 精确错误码 |
|---|---|
| `gate: 'Z'`、未知 `status`、`waveScope: 'wave1'` 或未知额外字段 | `GATE_EVIDENCE_INVALID` |
| `not_applicable` 缺/空 requirement/profile/platform/capability/unreachable 任一数组，或携带 `commands` | `GATE_NA_SCOPE_MISSING` / `GATE_STATUS_SHAPE_INVALID` |
| `passed` 的任一 command `exitCode` 为 `null`/非零或携带 `reasonCode` | `GATE_PASSED_COMMAND_NONZERO` / `GATE_STATUS_SHAPE_INVALID` |
| `failed` 没有非零 command，或 `blocked` 无 reasonCode | `GATE_STATUS_SHAPE_INVALID` |
| attachment 路径不存在、逃逸 repo、重复路径或 command 未引用 stdout/stderr attachment | `GATE_ATTACHMENT_MISSING` / `GATE_ATTACHMENT_PATH_INVALID` / `GATE_ATTACHMENT_DUPLICATE` / `GATE_COMMAND_ATTACHMENT_MISSING` |
| attachment 声明 hash 不是 64 位小写 hex，或对原始 bytes 重算不一致 | `GATE_HASH_FORMAT_INVALID` / `GATE_ATTACHMENT_HASH_MISMATCH` |
| environment/policy/artifact binding 缺失，Policy Manifest 内部 checksum 失配，或 binding SHA-256 不是 canonical binding 重算值 | `GATE_BINDING_MISSING` / `GATE_POLICY_MANIFEST_INVALID` / `GATE_BINDING_HASH_MISMATCH` |
| 用 `as GateEvidence`/`as ExecutedGateEvidence` 构造伪 passed 后直接交 writer | writer 仍返回上述 runtime 错误且不产生 evidence 文件 |
| Gate C recovery drill 的 artifact、compatibility、descriptor 或 registry hash 与当前 binding 不同 | `GATE_C_CURRENT_ARTIFACT_MISMATCH` |

保留 scope 正测：A 只含 build/typecheck，F 只含 policy，D/E/G/H/I 均为 N/A。原 N/A 空数组 fixture 继续断言 `GATE_NA_SCOPE_MISSING`。测试 helper 必须在临时目录写真实 attachment 字节，再调用 validator；禁止用不存在的假路径让更早错误掩盖目标错误。

- [ ] **Step 2: 运行红命令并确认明确失败码**

```powershell
npm.cmd exec -- vitest run tests/release-gate-runner.test.ts tests/release-evidence-integrity.test.ts
```

预期：退出 1，创建 release modules 前为 `ERR_MODULE_NOT_FOUND`；若 validator 仅做 TypeScript interface/cast 或字段存在性检查，则至少分别以 `GATE_EVIDENCE_INVALID`、`GATE_NA_SCOPE_MISSING`、`GATE_PASSED_COMMAND_NONZERO`、`GATE_ATTACHMENT_HASH_MISMATCH`、`GATE_BINDING_HASH_MISMATCH` 或 `GATE_C_CURRENT_ARTIFACT_MISMATCH` 红。

- [ ] **Step 3: 写入严格 GateEvidence runtime validator 与 artifact binding**

```ts
export interface MigrationDrillBinding {
  waveScope: 'wave0';
  registryPath: 'src/migrations/config/registry.ts' | 'src/migrations/db/registry.ts';
  descriptorId: string;
  descriptorChecksum: Sha256;
  registryArtifactPath: string;
  registryArtifactSha256: Sha256;
  compatibilityManifestPath: 'docs/superpowers/manifests/v3-compatibility.json';
  compatibilityManifestSha256: Sha256;
  candidateArtifactSha256: Sha256;
  environmentSha256: Sha256;
  policyManifestSha256: Sha256;
  bindingSha256: Sha256;
}
```

`src/release/evidenceSchema.ts` 必须实现真正的运行时解析；类型接口不能充当验证器。前述 `GateEvidence`、`GateId`、`Sha256`、`EvidenceBinding` 与 `MigrationDrillBinding` 均在该文件定义；固定验证接口为：

```ts
export type GateEvidenceErrorCode =
  | 'GATE_EVIDENCE_INVALID'
  | 'GATE_NA_SCOPE_MISSING'
  | 'GATE_EXECUTION_SCOPE_MISSING'
  | 'GATE_STATUS_SHAPE_INVALID'
  | 'GATE_PASSED_COMMAND_NONZERO'
  | 'GATE_ATTACHMENT_PATH_INVALID'
  | 'GATE_ATTACHMENT_DUPLICATE'
  | 'GATE_ATTACHMENT_MISSING'
  | 'GATE_COMMAND_ATTACHMENT_MISSING'
  | 'GATE_HASH_FORMAT_INVALID'
  | 'GATE_ATTACHMENT_HASH_MISMATCH'
  | 'GATE_BINDING_MISSING'
  | 'GATE_POLICY_MANIFEST_INVALID'
  | 'GATE_BINDING_HASH_MISMATCH'
  | 'GATE_C_CURRENT_ARTIFACT_MISMATCH';

export function validateGateEvidence(
  value: unknown,
  context: {
    repoRoot: string;
    expectedGate: GateId;
    currentArtifact: EvidenceBinding['artifact'];
    currentEnvironment: EvidenceBinding['environment'];
    currentPolicyManifest: EvidenceBinding['policyManifest'];
    currentMigrationBinding?: MigrationDrillBinding;
  },
): { ok: true; evidence: GateEvidence } | { ok: false; code: GateEvidenceErrorCode };

export function writeValidatedGateEvidence(
  outputPath: string,
  value: unknown,
  context: Parameters<typeof validateGateEvidence>[1],
): { ok: true; sha256: Sha256 } | { ok: false; code: GateEvidenceErrorCode };
```

同一文件或拆出的 `src/release/evidenceTypes.ts`（若拆出则必须同步加入本任务 `Files`；本计划选择不拆）按前述 GateEvidence 判别联合定义类型。实现必须逐字段检查 primitive/array/enum/必需字段/禁用额外字段和数组去重；不得出现 `value as Partial<GateEvidence>` 后直接返回、`as ExecutedGateEvidence`、`as NotApplicableGateEvidence`、`satisfies` 代替 runtime parse，或由 caller 传入“已经验证”的布尔值。

`src/release/artifactBinding.ts` 必须导出：

```ts
export function sha256File(path: string): Sha256;
export function canonicalJson(value: unknown): string;
export function computeEvidenceBindingSha256(input: {
  environmentSha256: Sha256;
  policyManifestSha256: Sha256;
  policyManifestChecksum: Sha256;
  artifactSha256: Sha256;
  commit: string;
}): Sha256;
export function verifyEvidenceAttachments(
  repoRoot: string,
  attachments: EvidenceAttachment[],
): { ok: true } | { ok: false; code: GateEvidenceErrorCode };
```

完整性顺序固定：先验证 shape 与 `expectedGate`，再将 attachment 路径 resolve 后确认仍位于 `repoRoot`、文件存在/是普通文件/路径不重复，按原始 bytes 重算每个完整 SHA-256，然后解析并验证 Policy Manifest 内部 canonical checksum，最后将 environment file SHA-256、policy file SHA-256 + manifest checksum、candidate artifact SHA-256 + commit canonicalize 后重算 `bindingSha256`。任何一步失败都不能返回 `evidence`，`writeValidatedGateEvidence` 也不得创建/覆盖输出。只有 runtime validator 返回 `ok: true` 的窄化对象才能写盘；调用方的 cast 永远不能绕过该流程。

- [ ] **Step 4: 写入可粘贴 Wave 0 scope**

`src/release/gateDefinitions.ts`：

```ts
export const WAVE_0_SCOPE = {
  A: { mode: 'required', runnerIds: ['build', 'typecheck'] },
  B: { mode: 'required', runnerIds: ['test-discovery', 'test-all', 'known-failures'] },
  C: { mode: 'required', runnerIds: ['wave0-recovery'] },
  D: {
    mode: 'not_applicable',
    capabilityIds: ['functional-cli-headless-mcp-build-extension'],
    unreachableEvidenceIds: ['W0-UNREACHABLE-D-001'],
  },
  E: {
    mode: 'not_applicable',
    capabilityIds: ['windows-real-platform-voice-computer'],
    unreachableEvidenceIds: ['W0-UNREACHABLE-E-001'],
  },
  F: { mode: 'required', runnerIds: ['policy'] },
  G: {
    mode: 'not_applicable',
    capabilityIds: ['completion-gate-final-decision'],
    unreachableEvidenceIds: ['W0-UNREACHABLE-G-001'],
  },
  H: {
    mode: 'not_applicable',
    capabilityIds: ['distribution-profile-installer'],
    unreachableEvidenceIds: ['W0-UNREACHABLE-H-001'],
  },
  I: {
    mode: 'not_applicable',
    capabilityIds: ['secondary-platform-release-matrix'],
    unreachableEvidenceIds: ['W0-UNREACHABLE-I-001'],
  },
} as const;
```

- [ ] **Step 5: 实现 runner、完整性与当前 artifact-bound 恢复演练**

`gateRunner.ts` 必须用 `executable + argv` 启动 child process，不拼 shell 字符串；将每条 command 的原始 stdout/stderr 分别写为 attachment，按原始 bytes 计算完整 SHA-256，并把 path+hash 放入 `attachments`。runner 必须先生成一次并冻结 `candidate-artifact.json`、`environment.json` 与当期 `v3-policy.json` binding，A-I 每份 evidence 都引用同一组 binding。required command 非零只能生成 `failed` 并令总 runner 退出 1；缺 runner/无法启动/attachment 缺失只能生成 `blocked` 或 `failed`，不能 `passed`。N/A evidence 从 `tests/fixtures/gates/wave0-unreachable-capabilities.json` 读取对应 ID，并填入非空 requirement/profile/platform/capability arrays 和真实 unreachable attachment。

每个候选对象都必须先调用 `writeValidatedGateEvidence()`；不得将 child-process “启动成功”、stdout 文本、TypeScript cast、默认 `exitCode ?? 0` 或 `status = condition ? 'passed' : ...` 直接写盘。尤其 `passed` 的所有 commands 必须有数值 `0`，且 stdout/stderr attachment 都存在并重算匹配；validator 失败时保留旧 evidence 不变，并令 runner 非零退出。

`docs/superpowers/evidence/wave0/migration-drill-contract.json` 不是手写 fixture，而是 `scripts/drill-wave0-recovery.ts` 在每次运行开始时从 `src/migrations/config/registry.ts` 与 `src/migrations/db/registry.ts` 当前导出生成：

- config `config-v0-to-v1`：`rollbackable` 六步合同、descriptor identity/checksum/maxRtoMs、registry source path/full SHA-256。
- DB 当前 Wave 0 descriptor 集：每个 `forward-only` 八步合同、N-1 窗口、reconcile/recovery、descriptor identity/checksum/maxRtoMs、registry source path/full SHA-256。
- 共用 binding：当前 candidate artifact full SHA-256 + commit、`v3-compatibility.json` 文件 full SHA-256 + 内部 checksum、environment full SHA-256、Policy Manifest file full SHA-256 + 内部 checksum。

`scripts/drill-wave0-recovery.ts` 必须直接 import 两个 registry 当前 descriptor，先运行 `verifyMigrationDescriptorChecksum()`，再验证 source hash、backup hash、升级后确认写入、config downgrade 后读回、config re-upgrade、DB N-1 写入对账、DB recovery/forward-fix 后读回，并生成 `recovery-drill.json`。`recovery-drill.json` 必须逐 descriptor 保存 `MigrationDrillBinding`、执行步骤/耗时/结果和附件 full SHA-256；Gate C validator 当场重读 registry source、当前 descriptors、compatibility、artifact、environment、policy 并重算全部 binding。前一运行、另一 commit、descriptor 改动后未重跑、registry hash 漂移、只复制旧 JSON 或只检查文件存在都必须返回 `GATE_C_CURRENT_ARTIFACT_MISMATCH`，不得复用旧 passed drill。

- [ ] **Step 6: 注册 scripts 并运行绿色命令**

```powershell
npm.cmd run drill:wave0-recovery
npm.cmd run gate:wave0
npm.cmd exec -- vitest run tests/release-gate-runner.test.ts tests/release-evidence-integrity.test.ts
```

预期：退出 0；A evidence 只含 build/typecheck，F evidence 只含 policy scope，B/C 为本 Wave required evidence，D/E/G/H/I 是满足严格 runtime 判别联合的 N/A。所有 evidence 的 gate/status/waveScope/分支字段均经运行时逐字段验证；所有 passed command 均 exit 0；所有 attachment 存在且 full SHA-256 重算一致；A-I 绑定同一 current artifact/environment/Policy Manifest；Gate C recovery drill 绑定当前 compatibility、registry artifacts 与 descriptor identities。任何 evidence/附件字节修改返回 `GATE_ATTACHMENT_HASH_MISMATCH`，任何 binding 或当前 descriptor/registry 漂移分别返回 `GATE_BINDING_HASH_MISMATCH` 或 `GATE_C_CURRENT_ARTIFACT_MISMATCH`。

**Commit message（仅实施阶段使用，本次计划修订不提交）**

```text
release: add auditable Wave 0 gates
```

---

## Wave 0 Exit Audit

执行并保存输出：

```powershell
npm.cmd run check:test-discovery
npm.cmd run check:requirement-coverage
node scripts/generate-v3-compatibility.mjs --check
node scripts/generate-policy-manifest.mjs --check
npm.cmd run typecheck
npm.cmd run typecheck:tests
npm.cmd run build
npm.cmd run test:all
npm.cmd run test:known-failures
npm.cmd run drill:wave0-recovery
npm.cmd run gate:wave0
```

通过条件：

- 根 `tests`、`src` co-located、`packages` 的 disk-required `*.test.ts(x)` 集合与 Vitest 官方 `list --filesOnly --json` 返回的 resolved 文件集合双向精确相等；被 config exclude 的 required fixture 负例稳定返回 `TEST_DISCOVERY_SET_MISMATCH`，checker 不读取/搜索 glob 字符串。
- `tests/known-failures/cases/*.case.ts` 不被普通 include 命中；machine registry 对 `KF-001`…`KF-030` 恰一闭包：`open` 以 stable failure ID/code 复现，`resolved-with-green-regression` 指向普通绿色 regression 且无残留 active case；修复迁移保持总数 30，无缺失/重复。
- Compatibility/Policy/Requirement manifest checksum 可重算且无缺项；requirement checker 全文只使用 `check:requirement-coverage`。
- Policy Manifest 覆盖完整 normative redline catalog，包括凭证/密钥持久化泄漏和未经用户亲自操作的权限、密钥、安全模式变更。
- policy corrupt/truncated/checksum drift 三类 fixture 分别稳定返回 `POLICY_SCHEMA_INVALID`、`POLICY_PARSE_FAILED`、`POLICY_CHECKSUM_MISMATCH`，并被明确保留给后续 PDP/启动 fail-closed 接线。
- config rollbackable drill 和 DB forward-only drill 均从当前 registry descriptor 生成合同，验证 descriptor checksum、registry artifact full SHA-256、当前 candidate artifact/commit、Compatibility Manifest、environment 与 Policy Manifest binding，并在 `maxRtoMs` 内保留/对账确认写入；旧 drill 不可复用。
- Gate A 仅为 build+typecheck；Gate B/C 为 Wave 0 baseline；Gate F 仅为 Policy Manifest scope；D/E/G/H/I 为带非空 requirementIds/profiles/platforms/capabilityIds/unreachableEvidenceIds 且无 commands 的严格 N/A。
- GateEvidence writer 只接受 runtime validator 窄化结果：严格检查 gate/status/waveScope 判别联合、禁止额外字段、passed command 全 exit 0、附件存在/full SHA-256 重算，以及 environment → policy manifest → current artifact binding；cast 不能生成伪 passed。
- W0-02 只产 Gate D compatibility fixture，不产生 Gate D passed evidence。
- 此时仅可称为“Wave 0 验收基线完成”，不得称 V4 产品完成或 GA ready。

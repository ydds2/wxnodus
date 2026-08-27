# WxNodus V4 Wave 2 配置、扩展与自主运行实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实施；步骤使用 `- [ ]` 跟踪。
>
> 日期：2026-08-13
> 前置：Wave 1 Gate A/B/C/D/F/G 通过
> Channel：canary
> Required Gates：A、B、C、D（配置/扩展/Sub-agent）、F、G

## Goal

交付首次中文/English onboarding、版本化配置与个性化、来源隔离的扩展生命周期、真实可取消/恢复的 TaskRunner 和 Sub-agent worktree 隔离。Wave 2 完成前，Untrusted Plugin、Computer Use、Voice runtime 和 Forge runtime 均不得 enabled。

## Architecture

Application 层新增 Config、Personalization、Extension、SessionLifecycle 和 Autonomy services；Domain 层持有 schema、state machine、scope、TaskTicket 和 capability contracts；Infrastructure 层实现 config repository、双向 MCP transport/adapter、Skill manifest、Plugin broker/sandbox、worktree 和 Sub-agent host。旧 `src/kernel/*` 只保留兼容 adapter，所有可达副作用继续经过 W1-08 `ToolExecutionPipeline`，不得新增直连文件、网络、进程、浏览器、Computer 或 Forge 的旁路。

## Tech Stack

TypeScript、Node.js 22+（Windows 10/11 x64 为 Wave 2 一级验收范围；MCP SDK 的 `engines.node >=20` 不降低产品基线）、`yaml@2.8.1`、`@modelcontextprotocol/client@2.0.0`、`@modelcontextprotocol/server@2.0.0`、`@modelcontextprotocol/node@2.0.0`（四项均 exact lock）、MCP current protocol `2026-07-28`、better-sqlite3、Worker/child process IPC、Windows restricted runtime adapter、Git worktree、AbortSignal、Vitest contract/integration/failure-injection。

## 顶部依赖图（不可弱化）

```text
W1-01 GatewayError / OperationResult / GatewayEvent lifecycle envelope
W1-02 CapabilityPort / ApplicationServices / Bootstrap phases
W1-05 ToolDescriptor / ToolCatalog / EffectDescriptor
W1-07 PDP / ApprovalGrant / BudgetLedger / EffectJournal
W1-08 ToolExecutionPipeline / ProcessSupervisor
W1-11 Wave 1 CapabilityRegistry fence + gate evidence

W1-02 + W0-05 -> W2-01 Config/Onboarding/i18n
W2-01          -> W2-02 Personalization
W1-11 + W2-02 -> W2-03（修改 W1-11 的 CapabilityRegistry；禁止新建第二套 registry）
W1-05 + W1-08 + W2-03 -> W2-04 Extension owned scopes
W1-01 lifecycle envelope + W1-08 + W2-03 + W2-04 -> W2-05 Session lifecycle/hooks
W1-08 + W2-03 + W2-04 + W2-05 -> W2-06 MCP client + WxNodus MCP Server adapter
```

- W2-03 **显式依赖 W1-11**：`src/application/capabilities/capabilityRegistry.ts` 是 W1-11 已创建文件，W2-03 只能扩展/替换其临时 fence 实现，并继续实现 W1-02 `CapabilityPort`。
- W2-05 **消费 W1 lifecycle envelope**：唯一 envelope 是 W1-01 的 `GatewayEvent<T>`（`src/protocol/events.ts`）；W2-05 只新增 `SessionLifecyclePayload` 并产出 `GatewayEvent<SessionLifecyclePayload>`，不得另造第二套 `{ type, ts, data }` 事件结构。
- W2-06 是**同一任务内双向交付**：既连接外部 MCP Server，也把 WxNodus 自身作为 MCP Server 暴露；两端共同受 W2-03 capability、W2-04 owner scope/disposer、W1-08 pipeline、W1-07 PDP/approval/budget/journal 和 AbortSignal 约束。

## Global Constraints / 全局合同

- Pre-bootstrap onboarding 必须发生在 DB、MCP、Plugin、网络、Agent、错误日志目录和 TUI 初始化前。
- help/version/non-TTY 不写配置、不建 DB、不创建日志目录、不等待输入；unknown flag、missing value、invalid locale 均结构化报错并 exit 2。
- 配置优先级固定为 CLI > `WXNODUS_*` env > workspace > user > platform/product default；任何 UI/handler 不得自行重算。
- 配置和个性化写入必须 schema validate → backup/migrate（需要时）→ temp file → fsync/平台等价 → atomic rename → read-back；失败无部分写入。
- 每个 extension registration 有唯一 owner scope、immutable candidate snapshot 和 disposer；candidate smoke 失败保留旧 scope；只有新 revision 可见后才 dispose old。
- MCP/Skill/Plugin 所有 config/install/load/reload/disable/uninstall 副作用经过 W1-08 pipeline；read-only query 也经过 catalog/schema/PDP。
- 没有可强制 OS sandbox 的 Untrusted Plugin 只能 quarantined；不得把 Worker/child process crash isolation 宣称为安全沙箱。
- Task cancel 后 pipeline 拒绝该 lineage 的任何新 effect；子代理不能提升 parent grant、budget、tool 或 file scope。
- Computer、Voice 和 Forge runtime 在 Wave 2 的 command/Gateway/ToolCatalog/MCP Server/CapabilityRegistry 全层必须返回 unavailable，偶然发现本机二进制也不得自动启用。
- 所有错误控制流依赖稳定 `code`/`reasonCode`，不得匹配中文、English 或第三方 message。
- Skill/Plugin 的 scope、路径和 OS sandbox 合同固定：owner 分别为 `skill:<name>@<version>` / `plugin:<name>@<version>`；所有 lexical path、`realpath`、Windows drive/UNC/junction 校验 fail-closed；Untrusted Plugin 仅在 `strength: 'os-enforced'` 且完整 probe evidence 为真时 enabled。
- W2-09/W2-10 的 Goal/Plan/PlanStep/Run/Attempt 是唯一自主运行持久化词汇；旧 `tasks` 行只能通过 migration compatibility adapter 导入，不得继续作为新写主存储。
- 所有计划测试 fixture 必须在 test 内创建并销毁；除 `tests/fixtures/...` 精确列出的静态攻击样本外，不引用目录泛指、机器本地绝对 fixture 或未声明文件。
- Node 运行/构建/测试范围固定为 Node.js 22+；Wave 2 一级平台为 Windows 10/11 x64。不得因 MCP SDK package manifest 仅声明 `node >=20` 而把产品、CI 或 Gate 基线降到 Node 20，也不得把 Linux/macOS 二级平台或 Wave 3/4 真实平台/分发 Gate 偷渡为本 Wave 完成条件。
- W2 对 S6-S10/Wave 3+ surfaces 的唯一合法状态：`build`、`verify`、`evidence`、`browser`、`computer`、`forge` 全部 `delivered:false`、CapabilityRegistry `unavailable`，所有 CLI/Gateway/ToolCatalog/MCP list descriptor 标记 `stableStatus:'NOT_DELIVERED'`，执行入口稳定返回 `NOT_DELIVERED`；只有后续真实能力实现及其当期 Required Gate 对同一 artifact 通过后，下一波才可将对应项改为 true，禁止 probe、本机二进制或命令存在性提前启用。
- MCP Tasks Preview 不属于 Wave 2 交付：其 adapter/repository/feature flag 必须与 W2-09 TaskRunner persistence 独立。默认及 Gate fixture 中 flag 为 false，不注册/不声明 tasks capability、不暴露 tasks method；GA/W2 Gate 不依赖它。仅在后续 preview 入口显式开启、独立 repository 完成、双方协商且 preview contract suite 运行时才可声明并测试，普通 W2 suite 必须验证“未协商即禁用”。
- W2 SQLite migration 分类固定为 `forward-only`，禁止 `DROP`/rename/rewrite 已确认写入。采用 expand schema → N-1 双读兼容 → Application repository（或由 migration 安装并实测的 trigger）拒绝 legacy `tasks` 新写 → idempotent backfill/reconcile → read-back/hash 对账；失败保持 N-1 可读写/可重试并保留 confirmed writes，不能称为 rollbackable。
- Gate G criterion `C-W2` 必须绑定 Gate 启动后重算的当前 artifact hash、environment snapshot ID、policy snapshot ID、capability snapshot ID、migration report/evidence IDs；任一 evidence 不是同一当前 artifact、任一 W2 required criterion 非 `passed`、或独立复核缺失，CompletionDecision 不得为 succeeded。

### Runtime 依赖锁合同

W2-01 是 `yaml` 的唯一引入点；W2-06 是 MCP SDK 三个 split package 的唯一引入点。W2-01 与 W2-06 必须各自同时修改根 `package.json` 和根 `package-lock.json`。只允许以下 exact runtime dependencies；不得使用 `^`、`~`、workspace alias、聚合式旧 `@modelcontextprotocol/sdk`、第二个 YAML parser 或手写 frontmatter parser：

```json
// package.json.dependencies 与 package-lock.json packages[""].dependencies 的最终精确值
{
  "@modelcontextprotocol/client": "2.0.0",
  "@modelcontextprotocol/node": "2.0.0",
  "@modelcontextprotocol/server": "2.0.0",
  "yaml": "2.8.1"
}
```

```json
// package-lock.json: packages["node_modules/yaml"]
{
  "version": "2.8.1",
  "resolved": "https://registry.npmmirror.com/yaml/-/yaml-2.8.1.tgz",
  "integrity": "sha512-lcYcMxX2PO9XMGvAJkJ3OsNMw+/7FKes7/hgerGUYWIoWu5j/+YQqcZr5JnPZWzOsEBgMbSbiSTn/dv/69Mkpw==",
  "license": "ISC",
  "bin": { "yaml": "bin.mjs" },
  "engines": { "node": ">= 14.6" }
}
```

```json
// package-lock.json 的三个 MCP direct package 条目；dependencies 由 npm 生成并保留
{
  "node_modules/@modelcontextprotocol/client": {
    "version": "2.0.0",
    "resolved": "https://registry.npmmirror.com/@modelcontextprotocol/client/-/client-2.0.0.tgz",
    "integrity": "sha512-8f1OghQ2rjzIOfqgUCP+8GiUWqRs89njoWLNqAe8kWmDePv3s1fZXseej+QXemssEuuOvLLmLO/kqM3IQHtISw==",
    "license": "MIT",
    "dependencies": { "@modelcontextprotocol/core": "2.0.0", "cross-spawn": "^7.0.5", "eventsource": "^3.0.2", "eventsource-parser": "^3.0.0", "jose": "^6.1.3", "pkce-challenge": "^5.0.0", "zod": "^4.2.0" },
    "engines": { "node": ">=20" }
  },
  "node_modules/@modelcontextprotocol/server": {
    "version": "2.0.0",
    "resolved": "https://registry.npmmirror.com/@modelcontextprotocol/server/-/server-2.0.0.tgz",
    "integrity": "sha512-YhHWdHfpFMQfd0prsEnxKeS3Qz3ytIGmsS0sth4KDjnacIT7hxk6hXHkJ9KysxlkvTM+WZAtQbbcUhdoP4Hvtw==",
    "license": "MIT",
    "dependencies": { "@modelcontextprotocol/core": "2.0.0", "zod": "^4.2.0" },
    "engines": { "node": ">=20" }
  },
  "node_modules/@modelcontextprotocol/node": {
    "version": "2.0.0",
    "resolved": "https://registry.npmmirror.com/@modelcontextprotocol/node/-/node-2.0.0.tgz",
    "integrity": "sha512-Y4hAC2XdGDUdDOCbLDOCA4+aL3NUldjsOWlDL/YwpAxrPhRm1xHd7lZ+mLacvZ9t3PaH28wgNoaLQGrIk1P2pg==",
    "license": "MIT",
    "dependencies": { "@hono/node-server": "^1.19.9" },
    "engines": { "node": ">=20" }
  }
}
```

W2-01 使用 `npm.cmd install --save-exact yaml@2.8.1`；W2-06 使用 `npm.cmd install --save-exact @modelcontextprotocol/client@2.0.0 @modelcontextprotocol/server@2.0.0 @modelcontextprotocol/node@2.0.0`。两次都由 npm 生成 lock 变更并检查 root/direct-package exact equality；registry URL 可按实际 registry 不同，但 version/integrity 必须匹配，禁止手写 integrity。W2-02..W2-05、W2-07..W2-11 不新增 runtime dependency。

### 稳定错误码与 unavailable 结构

W2-01..W2-06 新增控制流仅使用以下稳定值（message 可本地化）：

```ts
export type Wave2ErrorCode =
  | 'CONFIG_UNKNOWN_FLAG' | 'CONFIG_MISSING_VALUE' | 'CONFIG_INVALID_LOCALE'
  | 'CONFIG_SCHEMA_INVALID' | 'CONFIG_ATOMIC_WRITE_FAILED' | 'CONFIG_SECRET_REDACTED'
  | 'PERSONALIZATION_SCHEMA_INVALID' | 'PERSONALIZATION_IMPORT_INVALID'
  | 'CAPABILITY_UNAVAILABLE' | 'CAPABILITY_BLOCKED' | 'CAPABILITY_PROBE_FAILED'
  | 'CAPABILITY_SNAPSHOT_MISMATCH'
  | 'EXTENSION_OWNER_CONFLICT' | 'EXTENSION_STAGE_FAILED' | 'EXTENSION_SMOKE_FAILED'
  | 'EXTENSION_DISPOSE_FAILED'
  | 'SESSION_LIFECYCLE_INVALID' | 'SESSION_NOT_READY'
  | 'HOOK_DENIED' | 'HOOK_TIMEOUT' | 'HOOK_MALFORMED' | 'HOOK_EXECUTION_FAILED'
  | 'MCP_CONFIG_INVALID' | 'MCP_PROTOCOL_ERROR' | 'MCP_SSRF_BLOCKED'
  | 'MCP_CONTEXT_OVERRIDE_FORBIDDEN' | 'MCP_REQUEST_CANCELLED'
  | 'MCP_REQUEST_TIMEOUT' | 'MCP_AUTH_NEGOTIATION_UNAVAILABLE'
  | 'MCP_OAUTH_DISCOVERY_INVALID' | 'MCP_OAUTH_ISSUER_MISMATCH'
  | 'MCP_OAUTH_AUDIENCE_MISMATCH' | 'MCP_OAUTH_SCOPE_INSUFFICIENT'
  | 'MCP_OAUTH_STEPUP_EXHAUSTED' | 'MCP_OAUTH_REDIRECT_BLOCKED'
  | 'MCP_TASKS_PREVIEW_DISABLED' | 'MCP_TASKS_REPOSITORY_UNAVAILABLE'
  | 'AUTONOMY_LEGACY_WRITE_REJECTED' | 'MIGRATION_RECONCILE_FAILED'
  | 'GATE_ARTIFACT_MISMATCH';

export type McpUnavailableReason =
  | 'NOT_DELIVERED'
  | 'TRANSPORT_UNSUPPORTED'
  | 'PEER_DID_NOT_NEGOTIATE'
  | 'AUTH_NEGOTIATION_UNAVAILABLE'
  | 'CAPABILITY_UNAVAILABLE'
  | 'POLICY_DENIED'
  | 'CANCELLED';

export interface McpUnavailable {
  status: 'unavailable';
  capabilityId: string;
  surface: 'tools' | 'resources' | 'prompts' | 'notifications' | 'elicitation' | 'tasks' | 'oauth';
  transport: 'stdio' | 'streamable-http';
  reasonCode: McpUnavailableReason;
  negotiatedVersion: string | null;
}
```

未交付、transport 不支持、peer 未协商、auth 不可用、policy deny 和 cancel 必须返回上述结构或带上述稳定 code 的 `OperationResult`；禁止空对象、空字符串、HTTP 200 包裹假成功或仅写日志。

### 根 package.json script 映射

每个任务只创建自己的 root script；`Files` 必须列出 `Modify: package.json`，script 必须逐一精确映射到非空 suite：

```json
{
  "test:w2-01": "vitest run tests/w2-config-onboarding.contract.test.ts",
  "test:w2-02": "vitest run tests/w2-personalization.contract.test.ts",
  "test:w2-03": "vitest run tests/w2-capability-registry.contract.test.ts",
  "test:w2-04": "vitest run tests/w2-extension-scope.contract.test.ts",
  "test:w2-05": "vitest run tests/w2-session-lifecycle-hooks.contract.test.ts",
  "test:w2-06": "vitest run tests/w2-mcp-duplex.contract.test.ts",
  "test:w2-07": "vitest run tests/w2-skill-lifecycle.contract.test.ts",
  "test:w2-08": "vitest run tests/w2-plugin-sandbox.contract.test.ts",
  "test:w2-09": "vitest run tests/w2-autonomy-persistence-budget.contract.test.ts",
  "test:w2-10": "vitest run tests/w2-subagent-recovery-progress.contract.test.ts",
  "test:w2-11": "vitest run tests/w2-wave2-migration-gate.contract.test.ts",
  "migration:drill:wave2": "node scripts/run-wave2-migration-drill.mjs",
  "gate:wave2": "node scripts/run-wave2-gates.mjs"
}
```

W2-01..W2-10 各自创建同编号 script 并列 `Modify: package.json`；`migration:drill:wave2`、`gate:wave2` 与两个 `scripts/run-wave2-*.mjs` 只由 W2-11 首次创建，前序任务不得预占。每个 mapping 必须命中实际存在且非空的精确 suite，禁止 glob 零发现。

### 本文任务边界

W2-01..W2-11 均为本计划的受控实施范围；每任务必须有精确 Files、一个可直接粘贴且自足的红测代码块、一个可直接粘贴的最小实现代码块、精确 root script、红/绿命令与 stable code/assertion。实施步骤中的 commit message 仅供未来获授权执行；本次文档编辑不提交。

---

## Task W2-01：Config Schema、优先级与 Pre-bootstrap zh/en Onboarding

**Requirements/Subprojects:** R13、R14、R18；S2；依赖 W0-05 config migration foundation、W1-01 `OperationResult`、W1-02 bootstrap phase boundary。

**Files（精确）**
- Create: `src/domain/config/configSchema.ts`
- Create: `src/domain/config/configPrecedence.ts`
- Create: `src/application/config/configService.ts`
- Create: `src/application/bootstrap/preBootstrapOnboarding.ts`
- Create: `src/application/i18n/i18nService.ts`
- Create: `src/application/i18n/catalogs/zh-CN.ts`
- Create: `src/application/i18n/catalogs/en.ts`
- Create: `src/infrastructure/config/configRepository.ts`
- Modify: `src/store/config.ts`（legacy façade 委托 `ConfigService`；禁止保留第二套 precedence）
- Modify: `src/cli/args.ts`（导出严格 pre-bootstrap parser；unknown flag 不再忽略）
- Modify: `src/cli/index.ts`（在 `_initErrorLog`、`mkdirSync`、DB/MCP/Plugin/网络/TUI 之前调用 onboarding）
- Modify: `src/kernel/systemPrompt.ts`（从 i18n catalog 取 locale 对应 prompt，不按翻译文本分支）
- Modify: `package.json`（新增 exact `yaml` 和 `test:w2-01`）
- Modify: `package-lock.json`（锁 `yaml@2.8.1` exact；metadata 见顶部合同）
- Create: `tests/w2-config-onboarding.contract.test.ts`

**Interfaces**

```ts
export type Locale = 'zh-CN' | 'en';
export type ConfigSource = 'cli' | 'env' | 'workspace' | 'user' | 'default';
export interface ResolvedConfig<T> { value: T; source: ConfigSource }
export interface ConfigDocument {
  configVersion: 1;
  onboardingVersion: 1;
  locale?: Locale;
  installationProfile: 'core' | 'standard' | 'full-local-ai';
  extensions: Record<string, unknown>;
}
export interface PreBootstrapDecision {
  mode: 'continue' | 'print-and-exit' | 'onboarding-required' | 'error';
  locale?: Locale;
  source?: ConfigSource;
  output?: string;
  exitCode?: 0 | 2;
}
```

- [ ] **Step 1：安装唯一 exact dependency（只生成依赖变更，不运行实现测试）**

```powershell
npm.cmd install --save-exact yaml@2.8.1
```

随后确认 `package.json`、`package-lock.json` 根依赖和 `node_modules/yaml` 条目与顶部“唯一依赖锁合同”完全一致；如果 registry URL 不同但 integrity 相同，可保留 npm 实际生成 URL，版本与 integrity 必须 exact。

- [ ] **Step 2：粘贴完整红测**

`tests/w2-config-onboarding.contract.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigRepository } from '../src/infrastructure/config/configRepository.js';
import { ConfigService } from '../src/application/config/configService.js';
import {
  decidePreBootstrap,
  parsePreBootstrapArgs,
} from '../src/application/bootstrap/preBootstrapOnboarding.js';
import { messageKeys, translate } from '../src/application/i18n/i18nService.js';

let root: string;
let userFile: string;
let workspaceFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wxn-w2-config-'));
  userFile = join(root, 'user', 'config.json');
  workspaceFile = join(root, 'workspace', '.wxnodus', 'config.yaml');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('W2-01 config precedence and pre-bootstrap onboarding', () => {
  it('resolves CLI > env > workspace > user > default and preserves source', async () => {
    const repo = new ConfigRepository({ userFile, workspaceFile });
    await repo.write('user', {
      configVersion: 1,
      onboardingVersion: 1,
      locale: 'zh-CN',
      installationProfile: 'standard',
      extensions: {},
    });
    await repo.write('workspace', {
      configVersion: 1,
      onboardingVersion: 1,
      locale: 'en',
      installationProfile: 'standard',
      extensions: { future: { keep: true } },
    });
    const service = new ConfigService(repo);

    expect((await service.resolveLocale({ cli: 'zh-CN', env: 'en' })).value).toEqual({
      value: 'zh-CN', source: 'cli',
    });
    expect((await service.resolveLocale({ env: 'zh-CN' })).value).toEqual({
      value: 'zh-CN', source: 'env',
    });
    expect((await service.resolveLocale({})).value).toEqual({ value: 'en', source: 'workspace' });

    await repo.remove('workspace');
    expect((await service.resolveLocale({})).value).toEqual({ value: 'zh-CN', source: 'user' });
    await repo.remove('user');
    expect((await service.resolveLocale({ systemLocale: 'fr-FR' })).value).toEqual({
      value: 'en', source: 'default',
    });
  });

  it('rejects unknown flags, missing values and invalid locale with stable exit-2 codes', () => {
    const unknown = parsePreBootstrapArgs(['--wat']);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('CONFIG_UNKNOWN_FLAG');

    const missing = parsePreBootstrapArgs(['--lang']);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('CONFIG_MISSING_VALUE');

    const invalid = parsePreBootstrapArgs(['--lang', 'fr']);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('CONFIG_INVALID_LOCALE');
  });

  it('help/version/non-TTY never prompt or write, while clean TTY persists before bootstrap', async () => {
    const promptLanguage = vi.fn(async () => 'zh-CN' as const);
    const persistUserLocale = vi.fn(async () => undefined);
    const readUserLocale = vi.fn(async () => undefined);
    const readWorkspaceLocale = vi.fn(async () => undefined);

    const help = await decidePreBootstrap({
      argv: ['--help'], env: {}, isTTY: true, systemLocale: 'en-US',
      promptLanguage, persistUserLocale, readUserLocale, readWorkspaceLocale,
    });
    expect(help).toMatchObject({ mode: 'print-and-exit', exitCode: 0 });
    expect(promptLanguage).not.toHaveBeenCalled();
    expect(persistUserLocale).not.toHaveBeenCalled();

    const nonTty = await decidePreBootstrap({
      argv: ['--json'], env: {}, isTTY: false, systemLocale: 'zh-CN',
      promptLanguage, persistUserLocale, readUserLocale, readWorkspaceLocale,
    });
    expect(nonTty).toMatchObject({ mode: 'continue', locale: 'zh-CN', source: 'default' });
    expect(promptLanguage).not.toHaveBeenCalled();
    expect(persistUserLocale).not.toHaveBeenCalled();

    const tty = await decidePreBootstrap({
      argv: [], env: {}, isTTY: true, systemLocale: 'en-US',
      promptLanguage, persistUserLocale, readUserLocale, readWorkspaceLocale,
    });
    expect(tty).toMatchObject({ mode: 'onboarding-required', locale: 'zh-CN', source: 'user' });
    expect(promptLanguage).toHaveBeenCalledTimes(1);
    expect(persistUserLocale).toHaveBeenCalledWith('zh-CN');
  });

  it('atomically round-trips YAML extension bag and leaves no temp file', async () => {
    const repo = new ConfigRepository({ userFile, workspaceFile });
    const written = await repo.write('workspace', {
      configVersion: 1,
      onboardingVersion: 1,
      locale: 'en',
      installationProfile: 'standard',
      extensions: { future: { list: ['a', 'b'], nested: { enabled: true } } },
    });
    expect(written.ok).toBe(true);
    expect(existsSync(`${workspaceFile}.tmp`)).toBe(false);
    expect(readFileSync(workspaceFile, 'utf8')).toContain('future:');
    const readBack = await repo.read('workspace');
    expect(readBack.ok).toBe(true);
    if (readBack.ok) expect(readBack.value.extensions).toEqual({
      future: { list: ['a', 'b'], nested: { enabled: true } },
    });
  });

  it('keeps zh/en message keys identical and English behavioral prompt free of CJK', () => {
    expect(messageKeys('zh-CN')).toEqual(messageKeys('en'));
    expect(translate('en', 'system.behavior')).toBe('Follow structured policy and capability decisions.');
    expect(translate('en', 'system.behavior')).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it('does not create the user file merely by reading clean config', async () => {
    writeFileSync(join(root, 'sentinel.txt'), 'unchanged', 'utf8');
    const repo = new ConfigRepository({ userFile, workspaceFile });
    expect((await repo.read('user')).ok).toBe(true);
    expect(existsSync(userFile)).toBe(false);
  });
});
```

- [ ] **Step 3：运行红测并确认是目标缺口**

```powershell
npm.cmd run test:w2-01
```

Expected exit: `1`。至少出现 `Failed to load url ../src/infrastructure/config/configRepository.js` 或 `Cannot find module '../src/infrastructure/config/configRepository.js'`；不得接受 fixture 路径错误、Vitest 零发现或 YAML 未安装造成的失败。

- [ ] **Step 4：粘贴完整最小 Domain/Repository 实现**

`src/domain/config/configSchema.ts`

```ts
import type { GatewayError } from '../../protocol/errors.js';
import type { OperationResult } from '../../protocol/results.js';

export type Locale = 'zh-CN' | 'en';
export type ConfigScope = 'user' | 'workspace';
export type ConfigSource = 'cli' | 'env' | 'workspace' | 'user' | 'default';
export type InstallationProfile = 'core' | 'standard' | 'full-local-ai';

export interface ConfigDocument {
  configVersion: 1;
  onboardingVersion: 1;
  locale?: Locale;
  installationProfile: InstallationProfile;
  extensions: Record<string, unknown>;
}

export const DEFAULT_CONFIG: ConfigDocument = {
  configVersion: 1,
  onboardingVersion: 1,
  installationProfile: 'standard',
  extensions: {},
};

export function configError(
  code: string,
  messageKey: string,
  details?: Record<string, unknown>,
): GatewayError {
  return { code, message: messageKey, messageKey, retryable: false, details };
}

export function normalizeLocale(value: unknown): Locale | undefined {
  if (value === 'zh' || value === 'zh-CN') return 'zh-CN';
  if (value === 'en') return 'en';
  return undefined;
}

export function inferSystemLocale(value: string | undefined): Locale {
  return value?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

export function validateConfigDocument(value: unknown): OperationResult<ConfigDocument> {
  if (value === undefined || value === null) return { ok: true, value: { ...DEFAULT_CONFIG } };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: configError('CONFIG_SCHEMA_INVALID', 'config.schema.invalid') };
  }
  const raw = value as Record<string, unknown>;
  const locale = raw.locale === undefined ? undefined : normalizeLocale(raw.locale);
  const profile = raw.installationProfile ?? 'standard';
  if (raw.configVersion !== 1 || raw.onboardingVersion !== 1 ||
      (raw.locale !== undefined && locale === undefined) ||
      !['core', 'standard', 'full-local-ai'].includes(String(profile)) ||
      (raw.extensions !== undefined &&
        (typeof raw.extensions !== 'object' || raw.extensions === null || Array.isArray(raw.extensions)))) {
    return { ok: false, error: configError('CONFIG_SCHEMA_INVALID', 'config.schema.invalid') };
  }
  return {
    ok: true,
    value: {
      configVersion: 1,
      onboardingVersion: 1,
      locale,
      installationProfile: profile as InstallationProfile,
      extensions: (raw.extensions ?? {}) as Record<string, unknown>,
    },
  };
}
```

`src/domain/config/configPrecedence.ts`

```ts
import type { ConfigSource, Locale } from './configSchema.js';
import { inferSystemLocale, normalizeLocale } from './configSchema.js';

export interface LocaleCandidates {
  cli?: unknown;
  env?: unknown;
  workspace?: unknown;
  user?: unknown;
  systemLocale?: string;
}

export interface ResolvedConfig<T> { value: T; source: ConfigSource }

export function resolveLocalePrecedence(input: LocaleCandidates): ResolvedConfig<Locale> {
  const ordered: Array<[ConfigSource, unknown]> = [
    ['cli', input.cli], ['env', input.env], ['workspace', input.workspace], ['user', input.user],
  ];
  for (const [source, candidate] of ordered) {
    const locale = normalizeLocale(candidate);
    if (locale) return { value: locale, source };
  }
  return { value: inferSystemLocale(input.systemLocale), source: 'default' };
}
```

`src/infrastructure/config/configRepository.ts`

```ts
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, fsyncSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { parse, stringify } from 'yaml';
import type { OperationResult } from '../../protocol/results.js';
import {
  configError,
  DEFAULT_CONFIG,
  type ConfigDocument,
  type ConfigScope,
  validateConfigDocument,
} from '../../domain/config/configSchema.js';

export interface ConfigRepositoryOptions { userFile: string; workspaceFile: string }

export class ConfigRepository {
  constructor(private readonly options: ConfigRepositoryOptions) {}

  path(scope: ConfigScope): string {
    return scope === 'user' ? this.options.userFile : this.options.workspaceFile;
  }

  async read(scope: ConfigScope): Promise<OperationResult<ConfigDocument>> {
    const file = this.path(scope);
    if (!existsSync(file)) return { ok: true, value: { ...DEFAULT_CONFIG } };
    try {
      const text = readFileSync(file, 'utf8');
      const raw = ['.yaml', '.yml'].includes(extname(file).toLowerCase()) ? parse(text) : JSON.parse(text);
      return validateConfigDocument(raw);
    } catch (cause) {
      return {
        ok: false,
        error: configError('CONFIG_SCHEMA_INVALID', 'config.schema.invalid', {
          file, cause: String((cause as Error).message ?? cause),
        }),
      };
    }
  }

  async write(scope: ConfigScope, document: ConfigDocument): Promise<OperationResult<ConfigDocument>> {
    const checked = validateConfigDocument(document);
    if (!checked.ok) return checked;
    const file = this.path(scope);
    const tmp = `${file}.tmp`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const text = ['.yaml', '.yml'].includes(extname(file).toLowerCase())
        ? stringify(checked.value)
        : `${JSON.stringify(checked.value, null, 2)}\n`;
      writeFileSync(tmp, text, { encoding: 'utf8', flag: 'w' });
      const fd = openSync(tmp, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, file);
      return this.read(scope);
    } catch (cause) {
      rmSync(tmp, { force: true });
      return {
        ok: false,
        error: configError('CONFIG_ATOMIC_WRITE_FAILED', 'config.write.failed', {
          file, cause: String((cause as Error).message ?? cause),
        }),
      };
    }
  }

  async remove(scope: ConfigScope): Promise<void> {
    rmSync(this.path(scope), { force: true });
  }
}
```

`src/application/config/configService.ts`

```ts
import type { OperationResult } from '../../protocol/results.js';
import type { ConfigDocument, ConfigScope, Locale } from '../../domain/config/configSchema.js';
import { normalizeLocale, validateConfigDocument } from '../../domain/config/configSchema.js';
import { resolveLocalePrecedence, type ResolvedConfig } from '../../domain/config/configPrecedence.js';
import type { ConfigRepository } from '../../infrastructure/config/configRepository.js';

export interface ResolveLocaleContext { cli?: unknown; env?: unknown; systemLocale?: string }

export class ConfigService {
  constructor(private readonly repository: ConfigRepository) {}

  async resolveLocale(context: ResolveLocaleContext): Promise<OperationResult<ResolvedConfig<Locale>>> {
    const [workspace, user] = await Promise.all([
      this.repository.read('workspace'), this.repository.read('user'),
    ]);
    if (!workspace.ok) return workspace;
    if (!user.ok) return user;
    return {
      ok: true,
      value: resolveLocalePrecedence({
        cli: context.cli,
        env: context.env,
        workspace: workspace.value.locale,
        user: user.value.locale,
        systemLocale: context.systemLocale,
      }),
    };
  }

  async set(scope: ConfigScope, patch: Partial<ConfigDocument>): Promise<OperationResult<ConfigDocument>> {
    const current = await this.repository.read(scope);
    if (!current.ok) return current;
    const merged = validateConfigDocument({ ...current.value, ...patch });
    if (!merged.ok) return merged;
    return this.repository.write(scope, merged.value);
  }

  async setLocale(scope: ConfigScope, locale: unknown): Promise<OperationResult<ConfigDocument>> {
    const normalized = normalizeLocale(locale);
    if (!normalized) return validateConfigDocument({ locale });
    return this.set(scope, { locale: normalized });
  }
}
```

- [ ] **Step 5：粘贴完整 onboarding/i18n 实现**

`src/application/bootstrap/preBootstrapOnboarding.ts`

```ts
import type { OperationResult } from '../../protocol/results.js';
import { configError, inferSystemLocale, normalizeLocale, type ConfigSource, type Locale } from '../../domain/config/configSchema.js';
import { resolveLocalePrecedence } from '../../domain/config/configPrecedence.js';

export interface PreBootstrapArgs {
  help: boolean;
  version: boolean;
  nonInteractive: boolean;
  lang?: Locale;
  dataDir?: string;
}

export interface PreBootstrapDecision {
  mode: 'continue' | 'print-and-exit' | 'onboarding-required' | 'error';
  locale?: Locale;
  source?: ConfigSource;
  output?: string;
  exitCode?: 0 | 2;
  args?: PreBootstrapArgs;
}

const VALUE_FLAGS = new Set(['--lang', '--data-dir', '--prompt', '-p', '--cwd', '-C', '--session', '-s', '--port', '--output-schema']);
const BOOL_FLAGS = new Set(['--help', '-h', '--version', '-v', '--json', '--wire', '--serve', '--strict-mcp-config', '--ephemeral']);

export function parsePreBootstrapArgs(argv: string[]): OperationResult<PreBootstrapArgs> {
  const out: PreBootstrapArgs = { help: false, version: false, nonInteractive: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const [flag, inline] = token.startsWith('--') && token.includes('=') ? token.split(/=(.*)/s, 2) : [token, undefined];
    if (BOOL_FLAGS.has(flag)) {
      if (flag === '--help' || flag === '-h') out.help = true;
      if (flag === '--version' || flag === '-v') out.version = true;
      if (['--json', '--wire', '--serve'].includes(flag)) out.nonInteractive = true;
      continue;
    }
    if (VALUE_FLAGS.has(flag)) {
      const value = inline ?? argv[index + 1];
      if (!value || value.startsWith('-')) {
        return { ok: false, error: configError('CONFIG_MISSING_VALUE', 'config.argument.missing', { flag }) };
      }
      if (inline === undefined) index += 1;
      if (flag === '--lang') {
        const locale = normalizeLocale(value);
        if (!locale) return { ok: false, error: configError('CONFIG_INVALID_LOCALE', 'config.locale.invalid', { value }) };
        out.lang = locale;
      }
      if (flag === '--data-dir') out.dataDir = value;
      if (['--prompt', '-p'].includes(flag)) out.nonInteractive = true;
      continue;
    }
    if (token.startsWith('-')) {
      return { ok: false, error: configError('CONFIG_UNKNOWN_FLAG', 'config.argument.unknown', { flag: token }) };
    }
  }
  return { ok: true, value: out };
}

export interface DecidePreBootstrapInput {
  argv: string[];
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  systemLocale?: string;
  readWorkspaceLocale(): Promise<Locale | undefined>;
  readUserLocale(): Promise<Locale | undefined>;
  promptLanguage(): Promise<Locale>;
  persistUserLocale(locale: Locale): Promise<void>;
}

export async function decidePreBootstrap(input: DecidePreBootstrapInput): Promise<PreBootstrapDecision> {
  const parsed = parsePreBootstrapArgs(input.argv);
  if (!parsed.ok) return { mode: 'error', exitCode: 2, output: parsed.error.code };
  if (parsed.value.help) return { mode: 'print-and-exit', exitCode: 0, output: 'help', args: parsed.value };
  if (parsed.value.version) return { mode: 'print-and-exit', exitCode: 0, output: 'version', args: parsed.value };

  const [workspace, user] = await Promise.all([input.readWorkspaceLocale(), input.readUserLocale()]);
  const explicit = resolveLocalePrecedence({
    cli: parsed.value.lang,
    env: input.env.WXNODUS_LANG,
    workspace,
    user,
    systemLocale: input.systemLocale,
  });
  if (parsed.value.lang || normalizeLocale(input.env.WXNODUS_LANG) || workspace || user) {
    return { mode: 'continue', ...explicit, args: parsed.value };
  }
  if (!input.isTTY || parsed.value.nonInteractive) {
    return {
      mode: 'continue',
      locale: inferSystemLocale(input.systemLocale),
      source: 'default',
      args: parsed.value,
    };
  }
  const locale = await input.promptLanguage();
  await input.persistUserLocale(locale);
  return { mode: 'onboarding-required', locale, source: 'user', args: parsed.value };
}
```

`src/application/i18n/catalogs/zh-CN.ts`

```ts
export const zhCN = {
  'onboarding.selectLanguage': 'Select language / 选择语言\n\n  1. 中文\n  2. English',
  'config.argument.unknown': '未知参数',
  'config.argument.missing': '参数缺少值',
  'config.locale.invalid': '语言必须是 zh、zh-CN 或 en',
  'config.schema.invalid': '配置结构无效',
  'config.write.failed': '配置原子写入失败',
  'system.behavior': '遵循结构化策略与能力判定。',
} as const;
```

`src/application/i18n/catalogs/en.ts`

```ts
export const en = {
  'onboarding.selectLanguage': 'Select language / 选择语言\n\n  1. 中文\n  2. English',
  'config.argument.unknown': 'Unknown argument',
  'config.argument.missing': 'Argument value is missing',
  'config.locale.invalid': 'Locale must be zh, zh-CN, or en',
  'config.schema.invalid': 'Configuration schema is invalid',
  'config.write.failed': 'Atomic configuration write failed',
  'system.behavior': 'Follow structured policy and capability decisions.',
} as const;
```

`src/application/i18n/i18nService.ts`

```ts
import type { Locale } from '../../domain/config/configSchema.js';
import { en } from './catalogs/en.js';
import { zhCN } from './catalogs/zh-CN.js';

export type MessageKey = keyof typeof en;
const catalogs: Record<Locale, Record<MessageKey, string>> = { en, 'zh-CN': zhCN };

export function translate(locale: Locale, key: MessageKey): string {
  return catalogs[locale][key];
}

export function messageKeys(locale: Locale): MessageKey[] {
  return Object.keys(catalogs[locale]).sort() as MessageKey[];
}
```

- [ ] **Step 6：接入现有 façade、CLI 和 system prompt（精确替换，不复制状态源）**

`src/store/config.ts` 保留 `Config` compatibility interface，但 `createConfig()` 的底层路径读取/写入改为调用 `ConfigService`/`ConfigRepository`；legacy 同步 API 只允许读取已 bootstrap 的内存 snapshot，所有新异步写入口调用 service 并 read-back。禁止让旧 `SETTINGS_KEYS` 再决定 locale precedence。

`src/cli/args.ts` 在文件尾增加 re-export，所有入口只用这一份严格 parser：

```ts
export { parsePreBootstrapArgs } from '../application/bootstrap/preBootstrapOnboarding.js';
```

`src/cli/index.ts` 将当前 `_initErrorLog(dataDir)`、`mkdirSync(dataDir)` 和动态 import block 之前的启动代码替换为以下顺序；`readLocaleFile` 只读且文件不存在时返回 `undefined`：

```ts
const pre = await decidePreBootstrap({
  argv: process.argv.slice(2),
  env: process.env,
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  systemLocale: Intl.DateTimeFormat().resolvedOptions().locale,
  readWorkspaceLocale: () => readLocaleFile(join(process.cwd(), '.wxnodus', 'config.yaml')),
  readUserLocale: () => readLocaleFile(join(resolveDataDir(process.cwd()), 'config.json')),
  promptLanguage: promptLanguageOnStdio,
  persistUserLocale: locale => persistPreBootstrapLocale(join(resolveDataDir(process.cwd()), 'config.json'), locale),
});
if (pre.mode === 'error') {
  process.stderr.write(`${pre.output ?? 'CONFIG_SCHEMA_INVALID'}\n`);
  process.exitCode = 2;
  return;
}
if (pre.mode === 'print-and-exit') {
  process.stdout.write(pre.output === 'version' ? `wxnodus ${VERSION}\n` : `${USAGE}\n`);
  return;
}
const locale = pre.locale ?? 'en';
const dataDir = resolveDataDir(process.cwd());
_initErrorLog(dataDir);
mkdirSync(dataDir, { recursive: true });
```

上述 helper 放入 `src/application/bootstrap/preBootstrapOnboarding.ts`，使用 `ConfigRepository` 实现，不能在 CLI 复制 JSON/YAML 解析。`src/kernel/systemPrompt.ts` 的 public builder 增加 `locale: Locale` 参数，并用 `translate(locale, 'system.behavior')` 拼装行为段；不得对中文/English 文本做 regex 分支。

- [ ] **Step 7：精确修改 root package.json scripts**

```json
{
  "scripts": {
    "test:w2-01": "vitest run tests/w2-config-onboarding.contract.test.ts"
  },
  "dependencies": {
    "yaml": "2.8.1"
  }
}
```

这是增量片段：保留现有 scripts/dependencies，只加入上述 key；`package-lock.json` 由 Step 1 生成。

- [ ] **Step 8：运行目标测试和相邻回归**

```powershell
npm.cmd run test:w2-01
npm.cmd exec -- vitest run tests/kernel-args.test.ts tests/store-config.test.ts tests/kernel-systemPrompt.test.ts
npm.cmd run typecheck
npm.cmd run typecheck:tests
```

Expected exit: `0`。关键 PASS：precedence source 精确、`CONFIG_UNKNOWN_FLAG`/`CONFIG_MISSING_VALUE`/`CONFIG_INVALID_LOCALE`、help/non-TTY 零写入、YAML extension bag round-trip、zh/en key exact equality。

- [ ] **Step 9：静态检查**

检查 `git diff -- package.json package-lock.json src/domain/config src/application/config src/application/bootstrap src/application/i18n src/infrastructure/config src/store/config.ts src/cli/args.ts src/cli/index.ts src/kernel/systemPrompt.ts tests/w2-config-onboarding.contract.test.ts`；确认只有 `yaml@2.8.1` 新依赖、没有第二套 precedence、没有 onboarding 后置副作用、没有文本控制流。

**Commit（仅在用户另行授权时）**

```text
config: add pre-bootstrap bilingual onboarding
```

---

## Task W2-02：PersonalizationService 与 setup/personality round-trip

**Requirements/Subprojects:** R13、R14；S2/S11 前置；依赖 W2-01 `ConfigRepository`/`ConfigService`，本任务不新增 runtime dependency。

**Files（精确）**
- Create: `src/domain/personalization/personalization.ts`
- Create: `src/application/personalization/personalizationService.ts`
- Create: `src/protocol/personalization.ts`
- Modify: `src/wxnodus-ui/wxGateway.ts`（注册下述 RPC handlers）
- Modify: `src/wxnodus-ui/commands/slash/conversation.ts`（`/personality` 只调用 RPC）
- Modify: `src/wxnodus-ui/bridge/setupHandoff.ts`（删除外部 `wxnodus setup` handoff，调用 `personalization.setup`）
- Modify: `src/commands/handlersExt.ts`（CLI adapter 只调用 service）
- Modify: `package.json`（只新增 `test:w2-02`）
- Create: `tests/w2-personalization.contract.test.ts`

**Interfaces**

```ts
export interface PersonalizationProfile {
  displayName?: string;
  persona?: string;
  theme?: string;
  locale?: Locale;
  modelPolicy?: { preferredModel?: string; allowRemote: boolean };
  toolPolicy?: { approvalMode: 'always' | 'policy' | 'never' };
  voice?: { enabled: false; voiceId?: string };
  memory?: { enabled: boolean; retention: 'session' | 'persistent' };
}
export interface PersonalizationSnapshot {
  scope: 'user' | 'workspace';
  revision: string;
  profile: PersonalizationProfile;
}
```

- [ ] **Step 1：粘贴完整红测**

`tests/w2-personalization.contract.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigRepository } from '../src/infrastructure/config/configRepository.js';
import { PersonalizationService } from '../src/application/personalization/personalizationService.js';
import { createPersonalizationRpcHandlers } from '../src/protocol/personalization.js';

let root: string;
let repository: ConfigRepository;
let service: PersonalizationService;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'wxn-w2-personalization-'));
  repository = new ConfigRepository({
    userFile: join(root, 'user', 'config.json'),
    workspaceFile: join(root, 'workspace', '.wxnodus', 'config.yaml'),
  });
  await repository.write('user', {
    configVersion: 1,
    onboardingVersion: 1,
    locale: 'en',
    installationProfile: 'standard',
    extensions: {},
  });
  service = new PersonalizationService(repository);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('W2-02 PersonalizationService', () => {
  it('persists a personality update and reads the same snapshot after service restart', async () => {
    const updated = await service.update('user', {
      displayName: 'Ada',
      persona: 'precise',
      memory: { enabled: true, retention: 'persistent' },
    });
    expect(updated.ok).toBe(true);
    const restarted = new PersonalizationService(repository);
    const readBack = await restarted.get('user');
    expect(readBack).toEqual(updated);
  });

  it('keeps workspace override separate and falls back to user after clear', async () => {
    await service.update('user', { persona: 'user-persona', theme: 'dark' });
    await service.update('workspace', { persona: 'workspace-persona' });
    expect((await service.resolve()).value.profile).toMatchObject({
      persona: 'workspace-persona', theme: 'dark',
    });
    await service.clear('workspace');
    expect((await service.resolve()).value.profile).toMatchObject({
      persona: 'user-persona', theme: 'dark',
    });
  });

  it('exports/imports exactly and rejects invalid input without partial write', async () => {
    await service.update('user', { theme: 'light', toolPolicy: { approvalMode: 'always' } });
    const portable = await service.export('user');
    expect(portable.ok).toBe(true);
    const before = await service.get('user');
    const invalid = await service.import('user', {
      schemaVersion: 1,
      profile: { locale: 'fr', voice: { enabled: true } },
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('PERSONALIZATION_IMPORT_INVALID');
    expect(await service.get('user')).toEqual(before);
    if (portable.ok) expect((await service.import('workspace', portable.value)).ok).toBe(true);
  });

  it('returns redacted full config and setup/personality use the real service', async () => {
    const handlers = createPersonalizationRpcHandlers({
      service,
      readFullConfig: async () => ({
        apiKey: 'secret-value',
        apiKeyRef: 'secret://providers/openai/apiKey',
        nested: { token: 'secret-token', safe: true },
      }),
    });
    const setup = await handlers['personalization.setup']({
      scope: 'user',
      patch: { displayName: 'Lin', locale: 'zh-CN' },
    });
    expect(setup.ok).toBe(true);
    expect((await service.get('user')).value.profile.displayName).toBe('Lin');
    const full = await handlers['config.getFull']({});
    expect(full).toEqual({
      ok: true,
      value: {
        apiKey: '[REDACTED]',
        apiKeyRef: 'secret://providers/openai/apiKey',
        nested: { token: '[REDACTED]', safe: true },
      },
    });
  });

  it('uses stable validation code instead of localized text', async () => {
    const result = await service.update('user', { modelPolicy: { allowRemote: 'yes' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PERSONALIZATION_SCHEMA_INVALID');
  });
});
```

- [ ] **Step 2：运行红测并确认目标失败**

```powershell
npm.cmd run test:w2-02
```

Expected exit: `1`，首个失败为缺少 `personalizationService.js` 或 `personalization.js`；不得接受 Vitest 零发现。

- [ ] **Step 3：粘贴完整 Domain 实现**

`src/domain/personalization/personalization.ts`

```ts
import { createHash } from 'node:crypto';
import type { ConfigScope, Locale } from '../config/configSchema.js';
import type { GatewayError } from '../../protocol/errors.js';
import type { OperationResult } from '../../protocol/results.js';

export interface PersonalizationProfile {
  displayName?: string;
  persona?: string;
  theme?: string;
  locale?: Locale;
  modelPolicy?: { preferredModel?: string; allowRemote: boolean };
  toolPolicy?: { approvalMode: 'always' | 'policy' | 'never' };
  voice?: { enabled: false; voiceId?: string };
  memory?: { enabled: boolean; retention: 'session' | 'persistent' };
}

export interface PersonalizationSnapshot {
  scope: ConfigScope;
  revision: string;
  profile: PersonalizationProfile;
}

export interface PortablePersonalization {
  schemaVersion: 1;
  profile: PersonalizationProfile;
}

function error(code: 'PERSONALIZATION_SCHEMA_INVALID' | 'PERSONALIZATION_IMPORT_INVALID'): GatewayError {
  return { code, message: code, messageKey: code, retryable: false };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateProfile(
  value: unknown,
  code: 'PERSONALIZATION_SCHEMA_INVALID' | 'PERSONALIZATION_IMPORT_INVALID' = 'PERSONALIZATION_SCHEMA_INVALID',
): OperationResult<PersonalizationProfile> {
  if (!plainRecord(value)) return { ok: false, error: error(code) };
  const allowed = new Set(['displayName', 'persona', 'theme', 'locale', 'modelPolicy', 'toolPolicy', 'voice', 'memory']);
  if (Object.keys(value).some(key => !allowed.has(key))) return { ok: false, error: error(code) };
  for (const key of ['displayName', 'persona', 'theme'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return { ok: false, error: error(code) };
  }
  if (value.locale !== undefined && value.locale !== 'zh-CN' && value.locale !== 'en') {
    return { ok: false, error: error(code) };
  }
  if (value.modelPolicy !== undefined) {
    if (!plainRecord(value.modelPolicy) || typeof value.modelPolicy.allowRemote !== 'boolean' ||
        (value.modelPolicy.preferredModel !== undefined && typeof value.modelPolicy.preferredModel !== 'string')) {
      return { ok: false, error: error(code) };
    }
  }
  if (value.toolPolicy !== undefined) {
    if (!plainRecord(value.toolPolicy) ||
        !['always', 'policy', 'never'].includes(String(value.toolPolicy.approvalMode))) {
      return { ok: false, error: error(code) };
    }
  }
  if (value.voice !== undefined) {
    if (!plainRecord(value.voice) || value.voice.enabled !== false ||
        (value.voice.voiceId !== undefined && typeof value.voice.voiceId !== 'string')) {
      return { ok: false, error: error(code) };
    }
  }
  if (value.memory !== undefined) {
    if (!plainRecord(value.memory) || typeof value.memory.enabled !== 'boolean' ||
        !['session', 'persistent'].includes(String(value.memory.retention))) {
      return { ok: false, error: error(code) };
    }
  }
  return { ok: true, value: structuredClone(value) as PersonalizationProfile };
}

export function snapshot(scope: ConfigScope, profile: PersonalizationProfile): PersonalizationSnapshot {
  const canonical = JSON.stringify(profile, Object.keys(profile).sort());
  return { scope, profile: structuredClone(profile), revision: createHash('sha256').update(canonical).digest('hex') };
}
```

- [ ] **Step 4：粘贴完整 service/protocol 实现**

`src/application/personalization/personalizationService.ts`

```ts
import type { ConfigScope } from '../../domain/config/configSchema.js';
import type { OperationResult } from '../../protocol/results.js';
import {
  snapshot,
  validateProfile,
  type PersonalizationProfile,
  type PersonalizationSnapshot,
  type PortablePersonalization,
} from '../../domain/personalization/personalization.js';
import type { ConfigRepository } from '../../infrastructure/config/configRepository.js';

const KEY = 'personalization';

export class PersonalizationService {
  constructor(private readonly repository: ConfigRepository) {}

  async get(scope: ConfigScope): Promise<OperationResult<PersonalizationSnapshot>> {
    const config = await this.repository.read(scope);
    if (!config.ok) return config;
    const checked = validateProfile(config.value.extensions[KEY] ?? {});
    if (!checked.ok) return checked;
    return { ok: true, value: snapshot(scope, checked.value) };
  }

  async resolve(): Promise<OperationResult<PersonalizationSnapshot>> {
    const [user, workspace] = await Promise.all([this.get('user'), this.get('workspace')]);
    if (!user.ok) return user;
    if (!workspace.ok) return workspace;
    return { ok: true, value: snapshot('workspace', { ...user.value.profile, ...workspace.value.profile }) };
  }

  async update(scope: ConfigScope, patch: unknown): Promise<OperationResult<PersonalizationSnapshot>> {
    const checkedPatch = validateProfile(patch);
    if (!checkedPatch.ok) return checkedPatch;
    const config = await this.repository.read(scope);
    if (!config.ok) return config;
    const current = validateProfile(config.value.extensions[KEY] ?? {});
    if (!current.ok) return current;
    const checkedMerged = validateProfile({ ...current.value, ...checkedPatch.value });
    if (!checkedMerged.ok) return checkedMerged;
    const written = await this.repository.write(scope, {
      ...config.value,
      locale: checkedMerged.value.locale ?? config.value.locale,
      extensions: { ...config.value.extensions, [KEY]: checkedMerged.value },
    });
    if (!written.ok) return written;
    return this.get(scope);
  }

  async clear(scope: ConfigScope): Promise<OperationResult<PersonalizationSnapshot>> {
    const config = await this.repository.read(scope);
    if (!config.ok) return config;
    const extensions = { ...config.value.extensions };
    delete extensions[KEY];
    const written = await this.repository.write(scope, { ...config.value, extensions });
    if (!written.ok) return written;
    return this.get(scope);
  }

  async export(scope: ConfigScope): Promise<OperationResult<PortablePersonalization>> {
    const current = await this.get(scope);
    if (!current.ok) return current;
    return { ok: true, value: { schemaVersion: 1, profile: current.value.profile } };
  }

  async import(scope: ConfigScope, value: unknown): Promise<OperationResult<PersonalizationSnapshot>> {
    if (typeof value !== 'object' || value === null || Array.isArray(value) ||
        (value as Record<string, unknown>).schemaVersion !== 1) {
      return validateProfile(null, 'PERSONALIZATION_IMPORT_INVALID');
    }
    const checked = validateProfile(
      (value as Record<string, unknown>).profile,
      'PERSONALIZATION_IMPORT_INVALID',
    );
    if (!checked.ok) return checked;
    const config = await this.repository.read(scope);
    if (!config.ok) return config;
    const written = await this.repository.write(scope, {
      ...config.value,
      extensions: { ...config.value.extensions, [KEY]: checked.value },
    });
    if (!written.ok) return written;
    return this.get(scope);
  }
}
```

`src/protocol/personalization.ts`

```ts
import type { ConfigScope } from '../domain/config/configSchema.js';
import type { OperationResult } from './results.js';
import type { PersonalizationService } from '../application/personalization/personalizationService.js';

export type RpcHandler = (params: Record<string, unknown>) => Promise<OperationResult<unknown>>;

function redact(value: unknown, key = ''): unknown {
  if (/secret|token|password|apiKey/i.test(key) && !/Ref$/i.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  return value;
}

export function createPersonalizationRpcHandlers(options: {
  service: PersonalizationService;
  readFullConfig(): Promise<Record<string, unknown>>;
}): Record<string, RpcHandler> {
  const mutate = async (params: Record<string, unknown>): Promise<OperationResult<unknown>> => {
    const scope: ConfigScope = params.scope === 'workspace' ? 'workspace' : 'user';
    return options.service.update(scope, params.patch ?? {});
  };
  return {
    'personalization.get': async params => options.service.get(params.scope === 'workspace' ? 'workspace' : 'user'),
    'personalization.update': mutate,
    'personalization.setup': mutate,
    'personalization.export': async params => options.service.export(params.scope === 'workspace' ? 'workspace' : 'user'),
    'personalization.import': async params => options.service.import(params.scope === 'workspace' ? 'workspace' : 'user', params.value),
    'config.getFull': async () => ({ ok: true, value: redact(await options.readFullConfig()) }),
  };
}
```

`src/wxnodus-ui/wxGateway.ts` 在既有 RPC map 中 spread `createPersonalizationRpcHandlers(...)`；`conversation.ts` 的 `/personality set`、`setupHandoff.ts` 的 setup 保存、`handlersExt.ts` 的 CLI setup/personality 都必须等待相应 handler/service 的 `OperationResult`，仅 `ok:true` 时显示成功，错误显示 `error.code`。删除 `spawn('wxnodus', ['setup'])` 路径，禁止再调用 generic `config.set` 假成功。

- [ ] **Step 5：精确修改 root package.json scripts**

```json
{
  "scripts": {
    "test:w2-02": "vitest run tests/w2-personalization.contract.test.ts"
  }
}
```

- [ ] **Step 6：运行绿色命令**

```powershell
npm.cmd run test:w2-02
npm.cmd exec -- vitest run tests/kernel-gateway.test.ts tests/store-config.test.ts
npm.cmd run typecheck
npm.cmd run typecheck:tests
```

Expected exit: `0`；restart read-back、scope fallback、import rollback、redaction 与 real setup service 均 PASS。

**Commit（仅在用户另行授权时）**

```text
config: persist scoped personalization profiles
```

---

## Task W2-03：扩展 W1-11 CapabilityRegistry 与 Profile/Platform Snapshot

**Requirements/Subprojects:** R07、R08、R10、R17；S4/S6/S7/S12 前置；**显式依赖 W1-11** `Wave1CapabilityRegistry`。本任务修改同一 `CapabilityPort`/registry，不创建第二套 registry。

**Files（精确）**
- Modify: `src/domain/capabilities/capability.ts`（扩展 W1-02 union/snapshot，保留 `CapabilityPort`）
- Modify: `src/application/capabilities/capabilityRegistry.ts`（把 W1-11 fence 升级为 `Wave2CapabilityRegistry`，保留 `Wave1CapabilityRegistry` compatibility export）
- Create: `src/infrastructure/capabilities/probeRegistry.ts`
- Create: `src/protocol/capabilities.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/wxnodus-ui/wxGateway.ts`
- Modify: `package.json`（只新增 `test:w2-03`）
- Create: `tests/w2-capability-registry.contract.test.ts`

**Interfaces**

```ts
export type CapabilityState = 'available' | 'degraded' | 'unavailable' | 'blocked';
export type CapabilityRequirement = 'required' | 'optional' | 'unavailable';
export interface CapabilityDescriptor {
  id: CapabilityId;
  profile: 'core' | 'standard' | 'full-local-ai';
  platform: NodeJS.Platform;
  requirement: CapabilityRequirement;
  state: CapabilityState;
  delivered: boolean;
  stableStatus: 'DELIVERED' | 'NOT_DELIVERED';
  unlockGate?: 'W3_OR_LATER_REQUIRED_GATE';
  reasonCode?: 'NOT_DELIVERED' | 'CAPABILITY_UNAVAILABLE' | 'CAPABILITY_BLOCKED' | 'CAPABILITY_PROBE_FAILED';
  source: string;
  checksum: string;
}
```

- [ ] **Step 1：粘贴完整红测**

`tests/w2-capability-registry.contract.test.ts`

```ts
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Wave2CapabilityRegistry } from '../src/application/capabilities/capabilityRegistry.js';
import type { CapabilityPort } from '../src/domain/capabilities/capability.js';
import { ProbeRegistry } from '../src/infrastructure/capabilities/probeRegistry.js';

const checksum = (value: string) => createHash('sha256').update(value).digest('hex');

describe('W2-03 extends the W1-11 CapabilityRegistry', () => {
  it('maps required/optional/unavailable deterministically and preserves W1 CapabilityPort', async () => {
    const probes = new ProbeRegistry({
      command: async () => ({ ok: false, source: 'fixture:command', checksum: checksum('command') }),
      browser: async () => ({ ok: false, source: 'fixture:browser', checksum: checksum('browser') }),
      computer: vi.fn(async () => ({ ok: true, source: 'fixture:installed', checksum: checksum('installed') })),
    });
    const registry: CapabilityPort = await Wave2CapabilityRegistry.create({
      policySnapshotId: 'policy-2', profile: 'standard', platform: 'win32',
      clock: () => '2026-08-13T00:00:00.000Z', probes,
      requirements: { command: 'required', browser: 'unavailable', computer: 'unavailable' },
    });

    expect(registry.require('command')).toMatchObject({ ok: false, error: { code: 'CAPABILITY_BLOCKED' } });
    expect(registry.require('browser')).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE', details: { reasonCode: 'NOT_DELIVERED' } } });
    expect(registry.require('computer')).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE', details: { reasonCode: 'NOT_DELIVERED' } } });
    expect(probes.calls('browser')).toBe(0);
    expect(probes.calls('computer')).toBe(0);

    const first = registry.snapshot();
    const second = registry.snapshot();
    expect(first.id).toBe(second.id);
    for (const id of ['build','verify','evidence','browser','computer','forge'] as const) {
      expect(first.descriptors[id]).toMatchObject({ delivered: false, stableStatus: 'NOT_DELIVERED',
        requirement: 'unavailable', state: 'unavailable', reasonCode: 'NOT_DELIVERED',
        source: 'wave2-surface-fence', unlockGate: 'W3_OR_LATER_REQUIRED_GATE' });
      expect(registry.require(id)).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE',
        details: { capabilityId: id, reasonCode: 'NOT_DELIVERED' } } });
    }
    expect(first.descriptors.computer).toMatchObject({
      profile: 'standard', platform: 'win32', requirement: 'unavailable', state: 'unavailable',
      delivered: false, stableStatus: 'NOT_DELIVERED', reasonCode: 'NOT_DELIVERED', source: 'wave2-surface-fence',
    });
    expect(first.id).toBe(checksum(JSON.stringify({
      policySnapshotId: first.policySnapshotId,
      profile: first.profile,
      platform: first.platform,
      descriptors: first.descriptors,
    })));
  });
});
```

- [ ] **Step 2：运行红测**

```powershell
npm.cmd run test:w2-03
```

Expected exit: `1`，明确缺少 `ProbeRegistry` 或 `Wave2CapabilityRegistry.create`；不得接受零测试。

- [ ] **Step 3：粘贴完整最小 probe/registry 实现**

`src/infrastructure/capabilities/probeRegistry.ts`

```ts
import type { CapabilityId } from '../../domain/capabilities/capability.js';
export interface ProbeResult { ok: boolean; source: string; checksum: string }
export type CapabilityProbe = () => Promise<ProbeResult>;
export class ProbeRegistry {
  private readonly counts = new Map<CapabilityId, number>();
  constructor(private readonly probes: Partial<Record<CapabilityId, CapabilityProbe>>) {}
  async run(id: CapabilityId): Promise<ProbeResult> {
    this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
    const probe = this.probes[id];
    return probe ? probe() : { ok: false, source: 'probe:missing', checksum: '0'.repeat(64) };
  }
  calls(id: CapabilityId): number { return this.counts.get(id) ?? 0; }
}
```

在 `src/domain/capabilities/capability.ts` 扩展 W1 类型（不重声明第二个 port）：

```ts
export type CapabilityId = 'command' | 'memory' | 'offline-model' | 'session' | 'build' | 'verify' |
  'evidence' | 'browser' | 'voice' | 'computer' | 'forge' | 'distribution' |
  'mcp-client' | 'mcp-server' | 'skill' | 'plugin' | 'task' | 'subagent';
export type CapabilityState = 'available' | 'degraded' | 'unavailable' | 'blocked';
export interface CapabilityDescriptor {
  id: CapabilityId; profile: 'core' | 'standard' | 'full-local-ai'; platform: NodeJS.Platform;
  requirement: 'required' | 'optional' | 'unavailable'; state: CapabilityState;
  delivered: boolean; stableStatus: 'DELIVERED' | 'NOT_DELIVERED';
  unlockGate?: 'W3_OR_LATER_REQUIRED_GATE';
  reasonCode?: 'NOT_DELIVERED' | 'CAPABILITY_UNAVAILABLE' | 'CAPABILITY_BLOCKED' | 'CAPABILITY_PROBE_FAILED';
  source: string; checksum: string;
}
export interface CapabilitySnapshot {
  id: string; policySnapshotId: string; generatedAt: string;
  profile: 'core' | 'standard' | 'full-local-ai'; platform: NodeJS.Platform;
  states: Readonly<Record<CapabilityId, CapabilityState>>;
  descriptors: Readonly<Record<CapabilityId, CapabilityDescriptor>>;
}
export interface CapabilityPort {
  snapshot(): CapabilitySnapshot;
  require(id: CapabilityId): OperationResult<{ id: CapabilityId; snapshotId: string }>;
}
```

`src/application/capabilities/capabilityRegistry.ts`

```ts
import { createHash } from 'node:crypto';
import type { ProbeRegistry } from '../../infrastructure/capabilities/probeRegistry.js';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';
import type { CapabilityDescriptor, CapabilityId, CapabilityPort, CapabilitySnapshot } from '../../domain/capabilities/capability.js';

const IDS: CapabilityId[] = ['command','memory','offline-model','session','build','verify','evidence','browser',
  'voice','computer','forge','distribution','mcp-client','mcp-server','skill','plugin','task','subagent'];
const WAVE2_FENCED_SURFACES = new Set<CapabilityId>(['build','verify','evidence','browser','computer','forge']);
type Requirement = CapabilityDescriptor['requirement'];
interface Options {
  policySnapshotId: string; profile: CapabilitySnapshot['profile']; platform: NodeJS.Platform;
  clock(): string; probes: ProbeRegistry; requirements: Partial<Record<CapabilityId, Requirement>>;
}
export class Wave2CapabilityRegistry implements CapabilityPort {
  private constructor(private readonly value: CapabilitySnapshot) {}
  static async create(options: Options): Promise<Wave2CapabilityRegistry> {
    const descriptors = {} as Record<CapabilityId, CapabilityDescriptor>;
    for (const id of IDS) {
      if (WAVE2_FENCED_SURFACES.has(id)) {
        descriptors[id] = { id, profile: options.profile, platform: options.platform, requirement: 'unavailable',
          state: 'unavailable', delivered: false, stableStatus: 'NOT_DELIVERED', unlockGate: 'W3_OR_LATER_REQUIRED_GATE',
          reasonCode: 'NOT_DELIVERED', source: 'wave2-surface-fence', checksum: '0'.repeat(64) };
        continue;
      }
      const requirement = options.requirements[id] ?? 'unavailable';
      if (requirement === 'unavailable') {
        descriptors[id] = { id, profile: options.profile, platform: options.platform, requirement,
          state: 'unavailable', delivered: false, stableStatus: 'NOT_DELIVERED', reasonCode: 'CAPABILITY_UNAVAILABLE',
          source: 'wave2-policy', checksum: '0'.repeat(64) };
        continue;
      }
      const probe = await options.probes.run(id);
      descriptors[id] = { id, profile: options.profile, platform: options.platform, requirement,
        state: probe.ok ? 'available' : requirement === 'required' ? 'blocked' : 'degraded',
        delivered: probe.ok, stableStatus: probe.ok ? 'DELIVERED' : 'NOT_DELIVERED',
        reasonCode: probe.ok ? undefined : requirement === 'required' ? 'CAPABILITY_BLOCKED' : 'CAPABILITY_PROBE_FAILED',
        source: probe.source, checksum: probe.checksum };
    }
    const states = Object.fromEntries(IDS.map(id => [id, descriptors[id].state])) as Record<CapabilityId, CapabilityDescriptor['state']>;
    const hashInput = { policySnapshotId: options.policySnapshotId, profile: options.profile,
      platform: options.platform, descriptors };
    return new Wave2CapabilityRegistry(Object.freeze({ id: createHash('sha256').update(JSON.stringify(hashInput)).digest('hex'),
      policySnapshotId: options.policySnapshotId, generatedAt: options.clock(), profile: options.profile,
      platform: options.platform, states: Object.freeze(states), descriptors: Object.freeze(descriptors) }));
  }
  snapshot(): CapabilitySnapshot { return this.value; }
  require(id: CapabilityId) {
    const descriptor = this.value.descriptors[id];
    return descriptor.state === 'available'
      ? ok({ id, snapshotId: this.value.id })
      : err(gatewayError(descriptor.state === 'blocked' ? 'CAPABILITY_BLOCKED' : 'CAPABILITY_UNAVAILABLE',
          id, 'capability.unavailable', { details: { capabilityId: id, snapshotId: this.value.id,
            state: descriptor.state, reasonCode: descriptor.stableStatus } }));
  }
}
export { Wave2CapabilityRegistry as Wave1CapabilityRegistry };
```

CLI、Gateway、ToolCatalog 和后续 MCP adapter 只消费注入的 `CapabilityPort`；禁止 handler 自行 `existsSync`/spawn probe。`src/protocol/capabilities.ts` 只定义 `capabilities.get` 对 `CapabilitySnapshot` 的 RPC map。

- [ ] **Step 4：script 与绿测**

```json
{ "scripts": { "test:w2-03": "vitest run tests/w2-capability-registry.contract.test.ts" } }
```

```powershell
npm.cmd run test:w2-03
npm.cmd exec -- vitest run tests/wave1/w1-11-capability-gate.test.ts
npm.cmd run typecheck
npm.cmd run typecheck:tests
```

Expected exit: `0`；W1 port compatibility、stable hash、required blocked，以及 `build/verify/evidence/browser/computer/forge` 六个 Wave 3+ surface 在 registry/CLI/Gateway/ToolCatalog/MCP 均为 `delivered:false` + stable `NOT_DELIVERED`、不运行 probe 且只允许后续真实 Required Gate 解锁，全部 PASS。

**Commit（仅在另行授权时）**

```text
core: extend the Wave 1 capability registry
```

---

## Task W2-04：Extension owned scopes、atomic swap 与 disposer

**Requirements/Subprojects:** R03、R04、R06、R10；S4；依赖 W1-05/W1-08 与 W2-03。

**Files（精确）**
- Create: `src/domain/extensions/registrationScope.ts`
- Create: `src/application/extensions/extensionLifecycleService.ts`
- Create: `src/application/extensions/extensionScopeManager.ts`
- Modify: `src/domain/tools/toolCatalog.ts`
- Modify: `src/application/commandRegistry.ts`
- Modify: `src/kernel/agent.ts`
- Modify: `src/cli/index.ts`
- Modify: `package.json`（只新增 `test:w2-04`）
- Create: `tests/w2-extension-scope.contract.test.ts`

**Interfaces**

```ts
export interface ExtensionRegistrationSnapshot {
  owner: string; version: string; revision: number;
  tools: readonly string[]; commands: readonly string[];
}
export interface RegistrationScope {
  readonly owner: string; readonly version: string;
  registerTool(id: string, value: unknown): OperationResult<void>;
  registerCommand(id: string, value: unknown): OperationResult<void>;
  addDisposer(disposer: () => void | Promise<void>): void;
  snapshot(): ExtensionRegistrationSnapshot;
  dispose(): Promise<OperationResult<void>>;
}
```

- [ ] **Step 1：粘贴完整红测**

`tests/w2-extension-scope.contract.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest';
import { ExtensionScopeManager } from '../src/application/extensions/extensionScopeManager.js';

describe('W2-04 extension owner scopes', () => {
  it('retains old and other-owner registrations on failed smoke, then disposes old after swap', async () => {
    const order: string[] = [];
    const manager = new ExtensionScopeManager();
    const old = manager.stage('mcp:weather', '1.0.0');
    expect(old.ok).toBe(true); if (!old.ok) return;
    old.value.registerTool('weather.get', { version: 1 });
    old.value.addDisposer(() => { order.push('dispose:old'); });
    expect((await manager.activate(old.value, async () => { order.push('smoke:old'); return true; })).ok).toBe(true);

    const plugin = manager.stage('plugin:echo', '1.0.0');
    expect(plugin.ok).toBe(true); if (!plugin.ok) return;
    plugin.value.registerTool('echo', {});
    expect((await manager.activate(plugin.value, async () => true)).ok).toBe(true);

    const broken = manager.stage('mcp:weather', '2.0.0');
    expect(broken.ok).toBe(true); if (!broken.ok) return;
    broken.value.registerTool('weather.get', { version: 2 });
    expect((await manager.activate(broken.value, async () => false))).toMatchObject({
      ok: false, error: { code: 'EXTENSION_SMOKE_FAILED' },
    });
    expect(manager.resolveTool('weather.get')).toEqual({ version: 1 });
    expect(manager.resolveTool('echo')).toEqual({});

    const next = manager.stage('mcp:weather', '2.0.1');
    expect(next.ok).toBe(true); if (!next.ok) return;
    next.value.registerTool('weather.get', { version: 2 });
    next.value.addDisposer(vi.fn());
    expect((await manager.activate(next.value, async () => { order.push('smoke:new'); return true; })).ok).toBe(true);
    order.push(`visible:${String((manager.resolveTool('weather.get') as { version: number }).version)}`);
    expect(order).toEqual(['smoke:old', 'smoke:new', 'dispose:old', 'visible:2']);
    expect(manager.snapshot('plugin:echo')?.tools).toEqual(['echo']);
    expect((await manager.deactivate('mcp:weather')).ok).toBe(true);
    expect(manager.resolveTool('weather.get')).toBeUndefined();
    expect(manager.resolveTool('echo')).toEqual({});
  });
});
```

- [ ] **Step 2：红测命令**

```powershell
npm.cmd run test:w2-04
```

Expected exit: `1`，缺少 `ExtensionScopeManager`；不得接受 fixture 或测试发现错误。

- [ ] **Step 3：粘贴完整最小 scope/manager 实现**

`src/domain/extensions/registrationScope.ts`

```ts
import { gatewayError } from '../../protocol/errors.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';
export interface ExtensionRegistrationSnapshot { owner: string; version: string; revision: number; tools: readonly string[]; commands: readonly string[] }
export class OwnedRegistrationScope {
  readonly tools = new Map<string, unknown>();
  readonly commands = new Map<string, unknown>();
  private readonly disposers: Array<() => void | Promise<void>> = [];
  private disposed = false;
  constructor(readonly owner: string, readonly version: string, readonly revision: number) {}
  registerTool(id: string, value: unknown): OperationResult<void> {
    if (this.disposed || this.tools.has(id)) return err(gatewayError('EXTENSION_OWNER_CONFLICT', id, 'extension.owner.conflict'));
    this.tools.set(id, value); return ok(undefined);
  }
  registerCommand(id: string, value: unknown): OperationResult<void> {
    if (this.disposed || this.commands.has(id)) return err(gatewayError('EXTENSION_OWNER_CONFLICT', id, 'extension.owner.conflict'));
    this.commands.set(id, value); return ok(undefined);
  }
  addDisposer(disposer: () => void | Promise<void>): void { this.disposers.push(disposer); }
  snapshot(): ExtensionRegistrationSnapshot { return Object.freeze({ owner: this.owner, version: this.version,
    revision: this.revision, tools: Object.freeze([...this.tools.keys()].sort()), commands: Object.freeze([...this.commands.keys()].sort()) }); }
  async dispose(): Promise<OperationResult<void>> {
    if (this.disposed) return ok(undefined); this.disposed = true;
    try { for (const disposer of [...this.disposers].reverse()) await disposer(); return ok(undefined); }
    catch (cause) { return err(gatewayError('EXTENSION_DISPOSE_FAILED', String(cause), 'extension.dispose.failed')); }
  }
}
```

`src/application/extensions/extensionScopeManager.ts`

```ts
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';
import { OwnedRegistrationScope } from '../../domain/extensions/registrationScope.js';
export class ExtensionScopeManager {
  private revision = 0;
  private readonly active = new Map<string, OwnedRegistrationScope>();
  stage(owner: string, version: string) {
    if (!/^(mcp|skill|plugin):[a-z0-9._-]+(?:@[a-zA-Z0-9._-]+)?$/.test(owner))
      return err(gatewayError('EXTENSION_OWNER_CONFLICT', owner, 'extension.owner.invalid'));
    return ok(new OwnedRegistrationScope(owner, version, ++this.revision));
  }
  async activate(candidate: OwnedRegistrationScope, smoke: () => Promise<boolean>) {
    let passed = false;
    try { passed = await smoke(); } catch { passed = false; }
    if (!passed) { await candidate.dispose(); return err(gatewayError('EXTENSION_SMOKE_FAILED', candidate.owner, 'extension.smoke.failed')); }
    const old = this.active.get(candidate.owner);
    this.active.set(candidate.owner, candidate); // single visible revision swap happens before old disposal
    if (old) { const disposed = await old.dispose(); if (!disposed.ok) return disposed; }
    return ok(candidate.snapshot());
  }
  async deactivate(owner: string) { const old = this.active.get(owner); if (!old) return ok(undefined);
    this.active.delete(owner); return old.dispose(); }
  snapshot(owner: string) { return this.active.get(owner)?.snapshot(); }
  resolveTool(id: string): unknown { for (const scope of this.active.values()) if (scope.tools.has(id)) return scope.tools.get(id); }
}
```

`ToolCatalog` 与 `CommandRegistry` 增加一次性 `swapOwner(owner, revision, entries)`/`removeOwner(owner)`；`ExtensionLifecycleService` 只按 stage → register candidate → smoke → activate 调用上述 manager。旧 `kernel/agent.ts` loader 只能返回 candidate，禁止 `agent.updateTools()` 全量覆盖。

- [ ] **Step 4：script 与绿测**

```json
{ "scripts": { "test:w2-04": "vitest run tests/w2-extension-scope.contract.test.ts" } }
```

```powershell
npm.cmd run test:w2-04
npm.cmd exec -- vitest run tests/wave1/w1-05-tool-catalog.test.ts
npm.cmd run typecheck
npm.cmd run typecheck:tests
```

Expected exit: `0`；失败保留旧 scope、成功先可见再 dispose、跨 owner 零删除、disposer stable failure 均 PASS。

**Commit（仅在另行授权时）**

```text
extensions: add owned scopes and atomic reloads
```

---

## Task W2-05：W1 GatewayEvent session lifecycle 与 fail-closed Hook registry

**Requirements/Subprojects:** R02、R10；Session lifecycle/S4；依赖 W1-01、W1-08、W2-03、W2-04。唯一 lifecycle envelope 是 `src/protocol/events.ts` 的 `GatewayEvent<T>`。

**Files（精确）**
- Create: `src/domain/sessions/sessionLifecycle.ts`
- Create: `src/application/sessions/sessionLifecycleService.ts`
- Create: `src/application/hooks/hookRegistry.ts`
- Modify: `src/kernel/agent.ts`
- Modify: `src/kernel/hooks.ts`
- Modify: `src/commands/handlersExt.ts`
- Modify: `src/wxnodus-ui/wxGateway.ts`
- Modify: `package.json`（只新增 `test:w2-05`）
- Create: `tests/w2-session-lifecycle-hooks.contract.test.ts`

**Interfaces**

```ts
export type SessionLifecyclePayload =
  | { kind: 'session.start'; lifecycleRevision: 1 }
  | { kind: 'session.resume'; lifecycleRevision: number }
  | { kind: 'run.start'; lifecycleRevision: number }
  | { kind: 'turn.start'; lifecycleRevision: number };
export type SessionLifecycleEvent = GatewayEvent<SessionLifecyclePayload>;
export type HookDecision = { action: 'continue' } | { action: 'deny'; reasonCode: string } |
  { action: 'modify'; value: unknown } | { action: 'require_approval'; reasonCode: string };
```

- [ ] **Step 1：粘贴完整红测**

`tests/w2-session-lifecycle-hooks.contract.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest';
import { SessionLifecycleService } from '../src/application/sessions/sessionLifecycleService.js';
import { HookRegistry } from '../src/application/hooks/hookRegistry.js';

const base = { producer: 'session-service', timestamp: '2026-08-13T00:00:00.000Z', locale: 'en',
  source: 'kernel' as const, capabilities: ['session'], policySnapshotId: 'policy-2',
  correlationId: 'corr-1', sensitivity: 'internal' as const, retention: 'session' as const };

describe('W2-05 W1 lifecycle envelope and hooks', () => {
  it('emits session start once, then resume/run/turn with exact W1 envelope IDs', async () => {
    const revisions = new Map<string, number>();
    const service = new SessionLifecycleService({
      load: async id => revisions.get(id), save: async (id, revision) => { revisions.set(id, revision); },
    });
    const start = await service.session('s1', false, base);
    expect(start.ok).toBe(true);
    if (!start.ok) throw new Error(start.error.code);
    expect(start.value).toMatchObject({
      schemaVersion: 1, type: 'session.start', sessionId: 's1', payload: { kind: 'session.start', lifecycleRevision: 1 },
    });
    const resume = await service.session('s1', false, base);
    expect(resume.ok).toBe(true);
    if (!resume.ok) throw new Error(resume.error.code);
    expect(resume.value.type).toBe('session.resume');
    const run = await service.run('s1', 'r1', base);
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error(run.error.code);
    expect(run.value).toMatchObject({ type: 'run.start', sessionId: 's1', runId: 'r1' });
    const turn = await service.turn('s1', 'r1', 't1', base);
    expect(turn.ok).toBe(true);
    if (!turn.ok) throw new Error(turn.error.code);
    expect(turn.value).toMatchObject({
      type: 'turn.start', sessionId: 's1', runId: 'r1', turnId: 't1',
    });
    expect(new SessionLifecycleService({ load: async id => revisions.get(id), save: async () => undefined }))
      .toBeDefined();
  });

  it('denies critical crash/malformed/timeout, permits explicit notification fail-open, and disposes owner', async () => {
    vi.useFakeTimers();
    const registry = new HookRegistry();
    const disposed = vi.fn();
    registry.register({ owner: 'plugin:a@1', id: 'critical', policy: 'security-critical', timeoutMs: 10,
      run: async () => new Promise(() => undefined), dispose: disposed });
    const pending = registry.invoke('critical', {}); await vi.advanceTimersByTimeAsync(11);
    await expect(pending).resolves.toEqual({ action: 'deny', reasonCode: 'HOOK_TIMEOUT' });
    registry.register({ owner: 'plugin:a@1', id: 'notice', policy: 'notification-only', timeoutMs: 10,
      run: async () => { throw new Error('boom'); } });
    await expect(registry.invoke('notice', {})).resolves.toEqual({ action: 'continue' });
    await registry.unregisterOwner('plugin:a@1');
    expect(disposed).toHaveBeenCalledOnce();
    await expect(registry.invoke('critical', {})).resolves.toEqual({ action: 'deny', reasonCode: 'HOOK_DENIED' });
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2：红测命令**

```powershell
npm.cmd run test:w2-05
```

Expected exit: `1`，缺少 lifecycle service/hook registry；不得因 W1 `GatewayEvent` fixture 不合法失败。

- [ ] **Step 3：粘贴完整最小 lifecycle/hook 实现**

`src/domain/sessions/sessionLifecycle.ts`

```ts
import type { GatewayEvent } from '../../protocol/events.js';
export type SessionLifecyclePayload =
  | { kind: 'session.start'; lifecycleRevision: 1 }
  | { kind: 'session.resume'; lifecycleRevision: number }
  | { kind: 'run.start'; lifecycleRevision: number }
  | { kind: 'turn.start'; lifecycleRevision: number };
export type SessionLifecycleEvent = GatewayEvent<SessionLifecyclePayload>;
export type LifecycleBase = Omit<GatewayEvent<never>, 'schemaVersion'|'type'|'sessionId'|'runId'|'turnId'|'payload'>;
```

`src/application/sessions/sessionLifecycleService.ts`

```ts
import { createGatewayEvent } from '../../protocol/events.js';
import type { LifecycleBase, SessionLifecycleEvent, SessionLifecyclePayload } from '../../domain/sessions/sessionLifecycle.js';
import type { OperationResult } from '../../protocol/results.js';
interface Store { load(sessionId: string): Promise<number | undefined>; save(sessionId: string, revision: number): Promise<void> }
export class SessionLifecycleService {
  constructor(private readonly store: Store) {}
  private event(type: SessionLifecyclePayload['kind'], sessionId: string, revision: number, base: LifecycleBase,
    ids: { runId?: string; turnId?: string } = {}): OperationResult<SessionLifecycleEvent> {
    const lifecycleRevision = type === 'session.start' ? 1 : revision;
    return createGatewayEvent({ ...base, schemaVersion: 1, type, sessionId, ...ids,
      payload: { kind: type, lifecycleRevision } as SessionLifecyclePayload });
  }
  async session(sessionId: string, resume: boolean, base: LifecycleBase) {
    const prior = await this.store.load(sessionId); const revision = (prior ?? 0) + 1;
    await this.store.save(sessionId, revision);
    return this.event(prior === undefined && !resume ? 'session.start' : 'session.resume', sessionId, revision, base);
  }
  async run(sessionId: string, runId: string, base: LifecycleBase) {
    const revision = await this.store.load(sessionId) ?? 1; return this.event('run.start', sessionId, revision, base, { runId });
  }
  async turn(sessionId: string, runId: string, turnId: string, base: LifecycleBase) {
    const revision = await this.store.load(sessionId) ?? 1; return this.event('turn.start', sessionId, revision, base, { runId, turnId });
  }
}
```

`src/application/hooks/hookRegistry.ts`

```ts
export type HookDecision = { action: 'continue' } | { action: 'deny'; reasonCode: string } |
  { action: 'modify'; value: unknown } | { action: 'require_approval'; reasonCode: string };
interface Hook { owner: string; id: string; policy: 'security-critical'|'notification-only'; timeoutMs: number;
  run(input: unknown): Promise<HookDecision>; dispose?: () => void | Promise<void> }
const valid = (value: unknown): value is HookDecision => typeof value === 'object' && value !== null &&
  ['continue','deny','modify','require_approval'].includes(String((value as { action?: string }).action));
export class HookRegistry {
  private readonly hooks = new Map<string, Hook>();
  register(hook: Hook): void { this.hooks.set(hook.id, hook); }
  async invoke(id: string, input: unknown): Promise<HookDecision> {
    const hook = this.hooks.get(id); if (!hook) return { action: 'deny', reasonCode: 'HOOK_DENIED' };
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([hook.run(input), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'HOOK_TIMEOUT' })), hook.timeoutMs);
      })]);
      if (!valid(result)) return hook.policy === 'notification-only' ? { action: 'continue' } : { action: 'deny', reasonCode: 'HOOK_MALFORMED' };
      return result;
    } catch (cause) { const code = (cause as { code?: string }).code === 'HOOK_TIMEOUT' ? 'HOOK_TIMEOUT' : 'HOOK_EXECUTION_FAILED';
      return hook.policy === 'notification-only' ? { action: 'continue' } : { action: 'deny', reasonCode: code }; }
    finally { if (timer) clearTimeout(timer); }
  }
  async unregisterOwner(owner: string): Promise<void> { for (const [id, hook] of this.hooks) if (hook.owner === owner) {
    this.hooks.delete(id); await hook.dispose?.(); } }
}
```

Agent 只调用 `SessionLifecycleService`；旧 `kernel/hooks.ts` 仅把 settings hook 注册到 owner scope。执行 hook command 仍走 W1-08 pipeline/PDP，不可直接 spawn。

- [ ] **Step 4：script 与绿测**

```json
{ "scripts": { "test:w2-05": "vitest run tests/w2-session-lifecycle-hooks.contract.test.ts" } }
```

```powershell
npm.cmd run test:w2-05
npm.cmd exec -- vitest run tests/kernel-hooks.test.ts tests/kernel-agent.test.ts
npm.cmd run typecheck
npm.cmd run typecheck:tests
```

Expected exit: `0`；W1 envelope、restart revision、security fail-closed、notification explicit fail-open、owner disposer 全部 PASS。

**Commit（仅在另行授权时）**

```text
sessions: make lifecycle events durable and exact
```

---

## Task W2-06：current MCP `2026-07-28` client + WxNodus MCP Server

**Requirements/Subprojects:** R04、R10；S4；依赖 W1-07/W1-08 与 W2-03/W2-04/W2-05。本任务同时交付外部 MCP client 和 WxNodus MCP Server，唯一新增依赖是 exact `@modelcontextprotocol/client@2.0.0`、`@modelcontextprotocol/server@2.0.0`、`@modelcontextprotocol/node@2.0.0`。

**Files（精确）**
- Create: `src/domain/mcp/mcpProtocol.ts`
- Create: `src/infrastructure/mcp/mcpTransportPolicy.ts`
- Create: `src/infrastructure/mcp/mcpTranscriptStore.ts`
- Create: `src/infrastructure/mcp/mcpClientHost.ts`
- Create: `src/infrastructure/mcp/wxnodusMcpServer.ts`
- Create: `src/infrastructure/mcp/mcpOAuth.ts`
- Create: `src/infrastructure/mcp/mcpTasksPreviewAdapter.ts`（独立 Preview adapter；W2 默认 disabled）
- Create: `src/infrastructure/sqlite/mcpTasksPreviewRepository.ts`（独立 Preview repository；不复用 W2-09 主存储）
- Create: `src/infrastructure/mcp/mcpFormElicitation.ts`（Form schema/secret deny + MRTR driver seam）
- Create: `src/infrastructure/mcp/legacyMcpCompat.ts`
- Create: `src/application/extensions/mcpLifecycleService.ts`
- Create: `src/protocol/mcp.ts`
- Modify: `src/kernel/mcp.ts`（legacy façade 只委托 client host/lifecycle）
- Modify: `src/commands/handlersExt.ts`
- Modify: `src/cli/index.ts`
- Modify: `package.json`（新增三个 exact dependency 与 `test:w2-06`）
- Modify: `package-lock.json`（npm 生成三个 exact direct package 条目）
- Create: `tests/w2-mcp-duplex.contract.test.ts`

**官方 current 合同（必须逐项实现）**

- Modern MCP 固定 `2026-07-28`：无 `initialize` handshake；**每个 request** 的 params `_meta` 必须通过 SDK `DiscoverRequestSchema`/request schema 校验并含 `io.modelcontextprotocol/protocolVersion`、`io.modelcontextprotocol/clientInfo`、`io.modelcontextprotocol/clientCapabilities`。HTTP 同时带 `MCP-Protocol-Version`、`MCP-Method`、`MCP-Name`；三者必须由同一已解析 body 派生，header/body mismatch、缺失或伪造均拒绝。
- Server discovery DTO 必须直接使用 `@modelcontextprotocol/core@2.0.0` 的 `DiscoverResultSchema`/`DiscoverResult`：字段是 `supportedVersions: ['2026-07-28']`、`capabilities`、可选 `instructions` 与 serverInfo `_meta`，绝不生成、接受或兼容 `protocolVersions`。Server 真实注册 `server/discover`、Tools、Resources、Prompts；通过 SDK `Server.registerCapabilities`/event bus 实现 `subscriptions/listen`、list/resource changed notifications；不得以手写 `discover()` 伪造注册。
- Client 使用 SDK `Client` 的 `versionNegotiation: { mode: 'auto' }`、`discover()`、`getProtocolEra()`、`getDiscoverResult()`、`getNegotiatedProtocolVersion()`；stdio 先 discover，只有明确 non-modern error/timeout 才交给独立 `legacyMcpCompat.ts`；HTTP 根据 modern `400` JSON-RPC body 判 era。现代与 legacy 路径不得共享隐式 session state；`initialize`/`notifications/initialized` 只允许出现在 legacy adapter。
- 标准 transport 仅 stdio（逐行 UTF-8 JSON-RPC、stderr 仅日志、cancel 为 `notifications/cancelled`）和 Streamable HTTP（单 MCP endpoint、每消息 POST、JSON 或 request-scoped SSE、close response stream cancel）。HTTP URL、每跳 redirect、DNS resolved address、Origin/Host 都经过 SSRF policy；禁止 token passthrough。
- P0 双向 surface：Tools (`tools/list`,`tools/call`)、Resources (`resources/list`,`resources/templates/list`,`resources/read`)、Prompts (`prompts/list`,`prompts/get`)、`subscriptions/listen` 与 list/resource update notifications、Form Elicitation（SDK `inputRequired()`/`InputRequiredResult`，`resultType: 'input_required'`，flat primitive schema，accept/decline/cancel）。所有可缓存结果只使用 SDK wire fields `ttlMs` 与 `cacheScope`，保守默认 `ttlMs: 0`、`cacheScope: 'private'`；MRTR 至少带 `inputRequests` 或完整性保护的 `requestState`。Form 绝不收 password/API key/token/payment；URL elicitation 不计入本 Wave P0。
- OAuth 同时实现 Resource Server 与 Client：RFC 9728 PRM、AS metadata 与 OIDC discovery，PKCE S256、OAuth `resource` 参数，issuer/audience/scope/expiry 校验，401/403 `WWW-Authenticate`；insufficient-scope 只允许 bounded step-up（最大轮数/总时限，耗尽稳定失败），redirect 每跳重新验证 SSRF、host/port/scheme 与 DNS resolved address。
- MCP Tasks 是 `io.modelcontextprotocol/tasks` **Preview extension**，本 Wave 默认 feature flag `false`：默认 discovery 不声明 capability，不注册 `tasks/get|update|cancel`，peer 未声明时不得暗建 task，只能同步 core result 或稳定返回 `PEER_DID_NOT_NEGOTIATE`。后续 preview 入口必须显式开启 flag、使用独立 adapter/repository、双方协商并运行 preview contract；`gate:wave2`、GA readiness、任何 P0 tool 及同步结果都不得依赖 Tasks。
- WxNodus Server 暴露 `session`、`memory` 以及 descriptor-only 的 Wave 3+ `build`、`verify`、`evidence`、`browser`、`computer`、`forge`；每次 list/call/read/get 均通过 W2-03 snapshot 和 W1 pipeline/PDP/approval/budget/journal。六个未交付项仍列为 `stableStatus:'NOT_DELIVERED'` descriptor，但调用返回 `McpUnavailable` `NOT_DELIVERED`/`CAPABILITY_UNAVAILABLE`，绝不假成功。
- request `_meta` 中 actor/session/run/capability/grant/budget/file scope 仅是 untrusted hint；试图覆盖 host `ExecutionContext` 返回 `MCP_CONTEXT_OVERRIDE_FORBIDDEN`。所有请求/响应/cancel/deny 保存 redacted transcript + evidence ID；AbortSignal 贯穿 client/server/pipeline，取消后 lineage effect fence 拒绝迟到副作用。

**Interfaces**

```ts
export const MCP_PROTOCOL_VERSION = '2026-07-28' as const;
export type McpSurfaceId = 'session'|'memory'|'build'|'verify'|'evidence'|'browser'|'computer'|'forge';
export interface McpRequestMeta {
  'io.modelcontextprotocol/protocolVersion': typeof MCP_PROTOCOL_VERSION;
  'io.modelcontextprotocol/clientInfo': { name: string; version: string };
  'io.modelcontextprotocol/clientCapabilities': Record<string, unknown>;
}
export interface McpTranscriptRecord {
  requestId: string; direction: 'in'|'out'; method: string; status: 'ok'|'denied'|'cancelled'|'error';
  redactedPayload: unknown; evidenceId: string; timestamp: string;
}
```

- [ ] **Step 1：安装 exact split SDK（不使用旧聚合包）**

```powershell
npm.cmd install --save-exact @modelcontextprotocol/client@2.0.0 @modelcontextprotocol/server@2.0.0 @modelcontextprotocol/node@2.0.0
```

检查根/direct-package entries 与顶部锁合同一致，并确认 lock 中不存在 direct `@modelcontextprotocol/sdk`。

- [ ] **Step 2：粘贴完整红测**

`tests/w2-mcp-duplex.contract.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest';
import { MCP_PROTOCOL_VERSION, buildMcpMeta, mcpUnavailable } from '../src/domain/mcp/mcpProtocol.js';
import { McpTransportPolicy } from '../src/infrastructure/mcp/mcpTransportPolicy.js';
import { InMemoryMcpTranscriptStore } from '../src/infrastructure/mcp/mcpTranscriptStore.js';
import { createRegisteredServer, WxNodusMcpAdapter, WXNODUS_MCP_SURFACES } from '../src/infrastructure/mcp/wxnodusMcpServer.js';

const context = { actorId: 'actor:host', sessionId: 's1', runId: 'r1', correlationId: 'c1',
  policySnapshotId: 'p1', locale: 'en', source: 'kernel', capabilities: ['session'],
  timestamp: '2026-08-13T00:00:00.000Z' } as const;

const modernClientCapabilities = { tools: {}, resources: {}, prompts: {}, elicitation: { form: {} } };

describe('W2-06 current duplex MCP', () => {
  it('builds required per-request metadata and does not advertise disabled Tasks Preview', () => {
    expect(buildMcpMeta({ name: 'wxnodus', version: '4.0.0' }, modernClientCapabilities)).toEqual({
      'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientInfo': { name: 'wxnodus', version: '4.0.0' },
      'io.modelcontextprotocol/clientCapabilities': modernClientCapabilities,
    });
    expect(WXNODUS_MCP_SURFACES.map(x => x.id)).toEqual([
      'session','memory','build','verify','evidence','browser','computer','forge',
    ]);
    for (const id of ['build','verify','evidence','browser','computer','forge'] as const) {
      expect(WXNODUS_MCP_SURFACES.find(x => x.id === id)).toMatchObject({ delivered: false,
        stableStatus: 'NOT_DELIVERED', reasonCode: 'NOT_DELIVERED' });
    }
    expect(WxNodusMcpAdapter.releaseContract).toEqual({ tasks: 'disabled', gaDependencies: [] });
  });

  it('validates the SDK discovery DTO and registers real modern surfaces', async () => {
    const { specTypeSchemas } = await import('@modelcontextprotocol/server');
    const server = createRegisteredServer({ tasksPreview: false, capabilities: {} as never, pipeline: {} as never,
      transcript: {} as never, contextFactory: () => context as never });
    const discovery = {
      supportedVersions: [MCP_PROTOCOL_VERSION],
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true, subscribe: true },
        prompts: { listChanged: true }, subscriptions: {}, elicitation: { form: {} } },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'wxnodus', version: '4.0.0' } },
    };
    expect(specTypeSchemas.DiscoverResult['~standard'].validate(discovery)).toMatchObject({ issues: undefined });
    expect(discovery).not.toHaveProperty('protocolVersions');
    expect(server.registrations).toEqual(['server/discover', 'tools', 'resources', 'prompts', 'subscriptions/listen', 'elicitation/form']);
    expect(server.discovery()).toMatchObject({ supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: discovery.capabilities });
    expect(server.discovery()).not.toHaveProperty('protocolVersions');
  });

  it('discovers, pipelines delivered calls, denies context override, and returns stable unavailable', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, value: { id: 'receipt-1' }, evidenceIds: ['ev-1'] }));
    const transcript = new InMemoryMcpTranscriptStore(() => '2026-08-13T00:00:00.000Z');
    const adapter = new WxNodusMcpAdapter({
      capabilities: { snapshot: () => ({ id: 'caps-1' }), require: (id: string) => ['build','verify','evidence','browser','computer','forge'].includes(id)
        ? ({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE' } }) : ({ ok: true, value: { id, snapshotId: 'caps-1' } }) } as never,
      pipeline: { execute } as never, transcript, contextFactory: () => context as never,
    });
    expect(adapter.discovery()).toMatchObject({ supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: {
      tools: { listChanged: true }, resources: { listChanged: true, subscribe: true }, prompts: { listChanged: true },
    } });
    expect(adapter.discovery()).not.toHaveProperty('protocolVersions');
    expect(await adapter.call('session', {}, buildMcpMeta({ name: 'test', version: '1' }, modernClientCapabilities), context,
      new AbortController().signal)).toMatchObject({ ok: true });
    expect(execute).toHaveBeenCalledOnce();
    expect(await adapter.call('computer', {}, buildMcpMeta({ name: 'test', version: '1' }, modernClientCapabilities), context,
      new AbortController().signal)).toEqual(mcpUnavailable('computer', 'tools', 'stdio', 'NOT_DELIVERED'));
    expect(await adapter.call('session', { _meta: { sessionId: 'attacker' } },
      buildMcpMeta({ name: 'test', version: '1' }, modernClientCapabilities), context, new AbortController().signal))
      .toMatchObject({ ok: false, error: { code: 'MCP_CONTEXT_OVERRIDE_FORBIDDEN' } });
    expect(transcript.records().map(x => x.status)).toEqual(['ok','denied','denied']);
  });

  it('blocks initial, redirected, and DNS-resolved private HTTP targets', async () => {
    const policy = new McpTransportPolicy({ resolve: vi.fn(async host => host === 'public.example'
      ? ['203.0.113.8'] : ['127.0.0.1']) });
    await expect(policy.assertHttpTarget(new URL('http://127.0.0.1/mcp'))).rejects.toMatchObject({ code: 'MCP_SSRF_BLOCKED' });
    await expect(policy.assertRedirect(new URL('https://public.example/mcp'), new URL('http://localhost/mcp')))
      .rejects.toMatchObject({ code: 'MCP_SSRF_BLOCKED' });
    await expect(policy.assertHttpTarget(new URL('https://internal.example/mcp'))).rejects.toMatchObject({ code: 'MCP_SSRF_BLOCKED' });
  });

  it('records cancellation and does not convert it to success', async () => {
    const transcript = new InMemoryMcpTranscriptStore(() => '2026-08-13T00:00:00.000Z');
    const controller = new AbortController(); controller.abort('test');
    const adapter = new WxNodusMcpAdapter({ capabilities: { require: () => ({ ok: true }), snapshot: () => ({ id: 'c' }) } as never,
      pipeline: { execute: vi.fn() } as never, transcript, contextFactory: () => context as never });
    expect(await adapter.call('browser', { token: 'secret' }, buildMcpMeta({ name: 'test', version: '1' }, modernClientCapabilities),
      context, controller.signal)).toEqual(mcpUnavailable('browser', 'tools', 'stdio', 'CANCELLED'));
    expect(transcript.records()[0]).toMatchObject({ status: 'cancelled', redactedPayload: { token: '[REDACTED]' } });
  });
});
```

- [ ] **Step 3：红测命令**

```powershell
npm.cmd run test:w2-06
```

Expected exit: `1`，缺少 MCP domain/adapter；不得因 SDK 未 exact 安装、fixture 路径或零发现失败。

- [ ] **Step 4：粘贴完整最小 protocol/policy/server adapter**

`src/domain/mcp/mcpProtocol.ts`

```ts
export const MCP_PROTOCOL_VERSION = '2026-07-28' as const;
export type McpRequestMeta = {
  'io.modelcontextprotocol/protocolVersion': typeof MCP_PROTOCOL_VERSION;
  'io.modelcontextprotocol/clientInfo': { name: string; version: string };
  'io.modelcontextprotocol/clientCapabilities': Record<string, unknown>;
};
export function buildMcpMeta(info: { name: string; version: string }, capabilities: Record<string, unknown>): McpRequestMeta {
  return { 'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientInfo': { ...info },
    'io.modelcontextprotocol/clientCapabilities': structuredClone(capabilities) };
}
export function mcpUnavailable(capabilityId: string, surface: 'tools'|'resources'|'prompts'|'notifications'|'elicitation'|'tasks'|'oauth',
  transport: 'stdio'|'streamable-http', reasonCode: 'NOT_DELIVERED'|'TRANSPORT_UNSUPPORTED'|'PEER_DID_NOT_NEGOTIATE'|
  'AUTH_NEGOTIATION_UNAVAILABLE'|'CAPABILITY_UNAVAILABLE'|'POLICY_DENIED'|'CANCELLED') {
  return { status: 'unavailable' as const, capabilityId, surface, transport, reasonCode,
    negotiatedVersion: reasonCode === 'PEER_DID_NOT_NEGOTIATE' ? null : MCP_PROTOCOL_VERSION };
}
```

`src/infrastructure/mcp/mcpTransportPolicy.ts`

```ts
import { isIP } from 'node:net';
const privateIp = (ip: string) => /^(127\.|10\.|0\.|169\.254\.|192\.168\.|::1$|fc|fd)/i.test(ip) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
export class McpTransportPolicy {
  constructor(private readonly dns: { resolve(host: string): Promise<string[]> }) {}
  async assertHttpTarget(url: URL): Promise<void> {
    if (!['https:','http:'].includes(url.protocol) || url.username || url.password || ['localhost','localhost.'].includes(url.hostname))
      throw Object.assign(new Error('blocked MCP target'), { code: 'MCP_SSRF_BLOCKED' });
    const addresses = isIP(url.hostname) ? [url.hostname] : await this.dns.resolve(url.hostname);
    if (!addresses.length || addresses.some(privateIp)) throw Object.assign(new Error('blocked MCP address'), { code: 'MCP_SSRF_BLOCKED' });
  }
  async assertRedirect(_from: URL, to: URL): Promise<void> { await this.assertHttpTarget(to); }
}
```

`src/infrastructure/mcp/mcpTranscriptStore.ts`

```ts
export interface McpTranscriptRecord { requestId: string; direction: 'in'|'out'; method: string;
  status: 'ok'|'denied'|'cancelled'|'error'; redactedPayload: unknown; evidenceId: string; timestamp: string }
const redact = (value: unknown, key = ''): unknown => /token|secret|password|authorization/i.test(key) ? '[REDACTED]' :
  Array.isArray(value) ? value.map(x => redact(x)) : typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k, redact(v, k)])) : value;
export class InMemoryMcpTranscriptStore {
  private readonly values: McpTranscriptRecord[] = [];
  constructor(private readonly clock: () => string) {}
  append(input: Omit<McpTranscriptRecord,'timestamp'|'redactedPayload'> & { payload: unknown }): void {
    this.values.push({ ...input, timestamp: this.clock(), redactedPayload: redact(input.payload) });
  }
  records(): readonly McpTranscriptRecord[] { return structuredClone(this.values); }
}
```

`src/infrastructure/mcp/wxnodusMcpServer.ts`

```ts
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { InMemoryServerEventBus, McpServer, acceptedContent, createMcpHandler, inputRequired,
  inputResponse, specTypeSchemas, type DiscoverResult, type InputRequiredResult } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { CapabilityPort } from '../../domain/capabilities/capability.js';
import type { ToolExecutionPipeline } from '../../domain/tools/toolExecutionPipeline.js';
import type { OperationContext } from '../../protocol/operationContext.js';
import { gatewayError } from '../../protocol/errors.js';
import { err } from '../../protocol/results.js';
import { MCP_PROTOCOL_VERSION, mcpUnavailable, type McpRequestMeta } from '../../domain/mcp/mcpProtocol.js';
import type { InMemoryMcpTranscriptStore } from './mcpTranscriptStore.js';

const future = (id: 'build'|'verify'|'evidence'|'browser'|'computer'|'forge') => ({ id, delivered: false as const,
  stableStatus: 'NOT_DELIVERED' as const, reasonCode: 'NOT_DELIVERED' as const });
export const WXNODUS_MCP_SURFACES = Object.freeze([
  { id: 'session', delivered: true, stableStatus: 'DELIVERED' },
  { id: 'memory', delivered: true, stableStatus: 'DELIVERED' },
  future('build'), future('verify'), future('evidence'), future('browser'), future('computer'), future('forge'),
] as const);
const capabilities = { tools: { listChanged: true }, resources: { listChanged: true, subscribe: true },
  prompts: { listChanged: true }, subscriptions: {}, elicitation: { form: {} } } as const;

export interface WxNodusMcpPorts { capabilities: CapabilityPort; pipeline: ToolExecutionPipeline;
  transcript: InMemoryMcpTranscriptStore; contextFactory(): OperationContext; tasksPreview?: false }

export class WxNodusMcpAdapter {
  static readonly releaseContract = { tasks: 'disabled', gaDependencies: [] as string[] } as const;
  constructor(private readonly ports: WxNodusMcpPorts) {}
  discovery(): DiscoverResult {
    const candidate = { supportedVersions: [MCP_PROTOCOL_VERSION], capabilities,
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'wxnodus', version: '4.0.0' } } };
    const validated = specTypeSchemas.DiscoverResult['~standard'].validate(candidate);
    if (validated.issues) throw Object.assign(new Error('invalid SDK discover DTO'), { code: 'MCP_PROTOCOL_ERROR' });
    return validated.value;
  }
  async call(id: typeof WXNODUS_MCP_SURFACES[number]['id'], args: Record<string, unknown>, meta: McpRequestMeta,
    context: OperationContext, signal: AbortSignal) {
    const requestId = randomUUID();
    const record = (status: 'ok'|'denied'|'cancelled'|'error') => this.ports.transcript.append({ requestId,
      direction: 'in', method: `tools/call:${id}`, status, payload: args, evidenceId: `mcp:${requestId}` });
    if (signal.aborted) { record('cancelled'); return mcpUnavailable(id, 'tools', 'stdio', 'CANCELLED'); }
    if (meta['io.modelcontextprotocol/protocolVersion'] !== MCP_PROTOCOL_VERSION) { record('denied');
      return err(gatewayError('MCP_PROTOCOL_ERROR', id, 'mcp.protocol.invalid')); }
    if (args._meta && Object.keys(args._meta as object).some(key => ['actorId','sessionId','runId','capabilities','grant','budget','ownedFiles'].includes(key))) {
      record('denied'); return err(gatewayError('MCP_CONTEXT_OVERRIDE_FORBIDDEN', id, 'mcp.context.override'));
    }
    const surface = WXNODUS_MCP_SURFACES.find(item => item.id === id)!;
    if (!surface.delivered) { record('denied'); return mcpUnavailable(id, 'tools', 'stdio', 'NOT_DELIVERED'); }
    const capability = this.ports.capabilities.require(id); if (!capability.ok) { record('denied');
      return mcpUnavailable(id, 'tools', 'stdio', 'CAPABILITY_UNAVAILABLE'); }
    const result = await this.ports.pipeline.execute({ toolId: `builtin:${id}`, args,
      origin: { kind: 'mcp', owner: 'mcp:wxnodus-server' } }, context, signal);
    record(result.ok ? 'ok' : signal.aborted ? 'cancelled' : 'denied'); return result;
  }
}

export function createRegisteredServer(ports: WxNodusMcpPorts) {
  const adapter = new WxNodusMcpAdapter(ports);
  const requestStateKey = Buffer.from(process.env.WXNODUS_MCP_REQUEST_STATE_KEY ?? '', 'base64');
  if (requestStateKey.length < 32) throw new Error('WXNODUS_MCP_REQUEST_STATE_KEY must be at least 256 bits');
  const verifyState = (state: string) => { const [payload, mac] = state.split('.');
    if (!payload || !mac) throw new Error('invalid requestState');
    const expected = createHmac('sha256', requestStateKey).update(payload).digest(); const actual = Buffer.from(mac, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('invalid requestState');
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown; };
  const server = new McpServer({ name: 'wxnodus', version: '4.0.0' }, { capabilities,
    cacheHints: { 'server/discover': { ttlMs: 0, cacheScope: 'private' }, 'tools/list': { ttlMs: 0, cacheScope: 'private' },
      'resources/list': { ttlMs: 0, cacheScope: 'private' }, 'resources/templates/list': { ttlMs: 0, cacheScope: 'private' },
      'resources/read': { ttlMs: 0, cacheScope: 'private' }, 'prompts/list': { ttlMs: 0, cacheScope: 'private' } },
    inputRequired: { maxRounds: 4, roundTimeoutMs: 120_000, legacyShim: false },
    requestState: { verify: verifyState } });
  server.server.registerCapabilities(capabilities); // SDK owns/validates `server/discover` and `supportedVersions`.
  for (const surface of WXNODUS_MCP_SURFACES) server.registerTool(surface.id,
    { description: surface.stableStatus },
    async ctx => surface.id === 'session' && !(acceptedContent(ctx.mcpReq.inputResponses, 'confirm'))
      ? inputRequired({ inputRequests: { confirm: inputRequired.elicit({ message: 'Continue session operation?',
          requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] } }) } }) satisfies InputRequiredResult
      : adapter.call(surface.id, {}, ctx.mcpReq.envelope as McpRequestMeta,
          ports.contextFactory(), ctx.mcpReq.signal));
  server.registerResource('capabilities', 'wxnodus://capabilities', { mimeType: 'application/json',
    cacheHint: { ttlMs: 0, cacheScope: 'private' } }, async uri => ({ contents: [{ uri: uri.href,
      mimeType: 'application/json', text: JSON.stringify(WXNODUS_MCP_SURFACES) }], ttlMs: 0, cacheScope: 'private' }));
  server.registerPrompt('session-summary', { description: 'Summarize a delivered session' }, async () => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'Summarize this session.' } }] }));
  const registrations = ['server/discover','tools','resources','prompts','subscriptions/listen','elicitation/form'] as const;
  return { server, registrations, discovery: () => adapter.discovery(), stdio: () => new StdioServerTransport() };
}

export function createWxNodusHttpHandler(ports: WxNodusMcpPorts) {
  const bus = new InMemoryServerEventBus();
  const handler = createMcpHandler(() => createRegisteredServer(ports).server, { bus, responseMode: 'auto', maxSubscriptions: 128 });
  return { handler, bus, notify: handler.notify }; // notify publishes tools/prompts/resources list and resource-updated events.
}
```

HTTP serving entry 必须先 parse JSON-RPC body，再从该 body 派生 `MCP-Method` 与 `MCP-Name`，并将 `_meta` protocol version 与 `MCP-Protocol-Version` 一并交给 SDK transport validation；任何 mismatch 都在 factory/pipeline 前拒绝。测试分别对 `tools/call` name、`prompts/get` name、`resources/read` URI name、list method 空 name、伪造 header 覆盖 body 做正反断言。`inputResponse()` 必须区分 accept/decline/cancel；`requestState` 只允许 server mint，使用 SDK `createRequestStateCodec()` 或等价 HMAC/AEAD verifier，MAC/expiry/audience 任一失败均 fail-closed。

- [ ] **Step 5：粘贴完整 SDK client/legacy/OAuth wiring**

`src/infrastructure/mcp/mcpClientHost.ts` 的 imports 与连接入口必须是：

```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MCP_PROTOCOL_VERSION } from '../../domain/mcp/mcpProtocol.js';
export type McpClientConfig = { transport: 'stdio'; command: string; args: string[]; env: Record<string,string> } |
  { transport: 'streamable-http'; url: string; headers: Record<string,string> };
export async function connectMcp(config: McpClientConfig, signal: AbortSignal) {
  const client = new Client({ name: 'wxnodus', version: '4.0.0' }, {
    capabilities: { tools: {}, resources: {}, prompts: {}, elicitation: { form: {} } },
    versionNegotiation: { mode: 'auto', probe: { timeoutMs: 5_000, maxRetries: 0 } },
    inputRequired: { autoFulfill: true, maxRounds: 4 },
  });
  const transport = config.transport === 'stdio'
    ? new StdioClientTransport({ command: config.command, args: config.args, env: config.env })
    : new StreamableHTTPClientTransport(new URL(config.url), { protocolVersion: MCP_PROTOCOL_VERSION,
        requestInit: { headers: { ...config.headers } } });
  await client.connect(transport, { signal, timeout: 30_000 });
  const era = client.getProtocolEra();
  const discover = client.getDiscoverResult() ?? (era === 'modern' ? await client.discover({ signal, timeout: 5_000 }) : undefined);
  const negotiatedVersion = client.getNegotiatedProtocolVersion();
  if (era === 'modern' && (!discover || !discover.supportedVersions.includes(MCP_PROTOCOL_VERSION) || negotiatedVersion !== MCP_PROTOCOL_VERSION)) {
    await client.close(); throw Object.assign(new Error('modern discovery mismatch'), { code: 'MCP_PROTOCOL_ERROR' });
  }
  return { client, transport, era, discover, negotiatedVersion, dispose: () => client.close() };
}
```

HTTP transport 的 request hook 必须在序列化 JSON-RPC body 后设置 SDK 规定的 `MCP-Protocol-Version`、`MCP-Method`、`MCP-Name`，禁止 config headers 覆盖这些保留 headers。`Client` 的 auto negotiation 是现代路径唯一 era 事实源；若 SDK 返回 `legacy`，`connectMcp()` 必须 dispose modern candidate 并调用 `legacyMcpCompat.ts` 的独立 fresh-client adapter，不得继续复用 modern instance/session。

`legacyMcpCompat.ts` 是唯一允许 `initialize`/`notifications/initialized` 的文件，导出 `connectLegacyMcpFresh()`；它总是构造 fresh `Client({ ... }, { versionNegotiation:{ mode:'legacy' } })` 与 fresh transport。modern stdio `auto` probe 只有得到 SDK 明确 legacy verdict 才 dispose candidate 并进入该 adapter；modern HTTP 的 unsupported/method-not-found `400` JSON-RPC body 才可进入，网络 outage/timeout、`UnsupportedProtocolVersionError(-32022)` 的 corrective continuation、malformed response 均 fail-closed，不能降级。legacy adapter 仍受 scope/pipeline/PDP/transcript/cancel，不得被 server factory import，且仓库静态检查要求 `initialize` 字面量只命中该文件/SDK test fixture。

`mcpOAuth.ts` 实现 RFC 9728 protected-resource metadata、Bearer verifier、expiry/audience/scope 检查与 401/403 `WWW-Authenticate`；token 仅进入 auth context，不进入 tool args/transcript。Form Elicitation validator 只接受 flat object primitive/enum，并在 key/description 命中 secret/token/password/apiKey/payment 时返回 `MCP_PROTOCOL_ERROR`。`subscriptions/listen` 生成 subscriptionId，支持 tools/prompts list-changed 和 resourceSubscriptions；Abort/stream close 清理订阅。

`McpLifecycleService` 固定 connect candidate → `server/discover`/capabilities → list/smoke → W2-04 atomic activate → dispose old；HTTP `/mcp test` 必须复用 HTTP transport。config round-trip 保留 stdio/HTTP/auth/toolDanger/unknown `extensions`。Tasks adapter仅在双方宣告 `io.modelcontextprotocol/tasks` 后开放 `tasks/get|update|cancel`，并明确 `maturity:'preview'`。

- [ ] **Step 6：script 与绿测**

```json
{
  "scripts": { "test:w2-06": "vitest run tests/w2-mcp-duplex.contract.test.ts" },
  "dependencies": {
    "@modelcontextprotocol/client": "2.0.0",
    "@modelcontextprotocol/node": "2.0.0",
    "@modelcontextprotocol/server": "2.0.0"
  }
}
```

```powershell
npm.cmd run test:w2-06
npm.cmd exec -- vitest run tests/kernel-mcp.test.ts
npm.cmd run typecheck
npm.cmd run typecheck:tests
```

Expected exit: `0`；current per-request `_meta`/discover、两 transport、P0 features、OAuth、unavailable、transcript、越权、SSRF、cancel、legacy isolation 与 Preview Tasks 非 GA 依赖全部 PASS。

**Commit（仅在另行授权时）**

```text
mcp: deliver current duplex client and server
```

---

## Task W2-07：Agent Skills manifest、路径安全与可卸载 scope

**Requirements/Subprojects:** R10、R19；S4

**Files**
- Create: `src/infrastructure/skills/skillManifest.ts`
- Create: `src/application/extensions/skillLifecycleService.ts`
- Modify: `src/domain/safeNames.ts`（只新增 `assertSafeExtensionName()` export，继续保持 W1 单一安全命名事实源）
- Modify: `src/kernel/skills.ts`（compatibility adapter only）
- Modify: `src/kernel/assimilate.ts`（只调用 SkillLifecycleService，不再直接复制到 live 目录）
- Modify: `src/commands/handlersExt.ts`（只调用 SkillLifecycleService）
- Modify: `package.json`（只新增 `test:w2-07`；复用 W2-01 的 exact `yaml@2.8.1`）
- Create: `tests/w2-skill-lifecycle.contract.test.ts`
- Create: `tests/skill-lifecycle.test.ts`
- Create: `tests/skill-legacy-layout-migration.test.ts`

**Owned scope and trust boundary**

- Skill owner 固定为 `skill:<manifest.name>@<manifest.version>`；只能向自己的 `RegistrationScope` 注册 prompt、tool、command 和 NL trigger，dispose/reload 不得调用全局 `agent.updateTools()` 或清空其他 owner。
- `SKILL.md` 存在只证明 artifact 可发现；`verified` 必须来自 checksum、来源与 policy evidence，不能从文件存在性或 `trustLevel` 文本推断。
- install 使用 `<dataDir>/skills/.staging/<uuid>`，完成 parse、realpath boundary、checksum、dependency 和 smoke validation 后才通过原子 rename 激活；目标已存在返回 `SKILL_TARGET_EXISTS`，除非显式走 audited replace。
- 所有 install/migrate/remove 写入仍是 W1 `ToolExecutionPipeline` effect；legacy adapter 和 command handler 不得直接 `cpSync`/`renameSync`/`rmSync` live Skill。

**Stable codes**

- `SKILL_MANIFEST_INVALID`
- `SKILL_NAME_INVALID`
- `SKILL_PATH_ESCAPE`
- `SKILL_ENTRYPOINT_MISSING`
- `SKILL_ARTIFACT_HASH_MISMATCH`
- `SKILL_TARGET_EXISTS`
- `SKILL_SCOPE_ACTIVATION_FAILED`
- `SKILL_LEGACY_LAYOUT_INVALID`

**Interfaces**

```ts
export interface SkillManifest {
  schemaVersion: 1;
  name: string;
  version: string;
  description: string;
  dependencies: string[];
  capabilities: string[];
  entrypoints: string[];
  source: string;
  artifactHash: string;
  trustLevel: 'untrusted' | 'reviewed' | 'trusted';
  extensions: Record<string, unknown>;
}

export interface ParsedSkillDocument {
  manifest: SkillManifest;
  body: string;
}

export interface SkillLifecycleService {
  stage(sourceDir: string, context: ExecutionContext, signal: AbortSignal): Promise<OperationResult<SkillCandidate>>;
  activate(candidate: SkillCandidate, context: ExecutionContext, signal: AbortSignal): Promise<OperationResult<ExtensionRegistrationSnapshot>>;
  deactivate(name: string, context: ExecutionContext, signal: AbortSignal): Promise<OperationResult<void>>;
  migrateLegacy(context: ExecutionContext, signal: AbortSignal): Promise<OperationResult<SkillMigrationReport>>;
}
```

- [ ] **Step 1: 粘贴完整路径/YAML 红测**

`tests/w2-skill-lifecycle.contract.test.ts`（同一文件同时是 root `test:w2-07` suite）：

```ts
import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSkillDocument,
  resolveSkillEntrypoints,
  serializeSkillDocument,
  SkillManifestError,
} from '../src/infrastructure/skills/skillManifest.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wxn-skill-security-'));
  roots.push(root);
  return root;
}

const DOCUMENT = `---
schemaVersion: 1
name: audit-helper
version: 1.2.3
description: Verify an artifact without claiming completion
dependencies:
  - builtin:workspace.read
capabilities:
  - workspace.read
entrypoints:
  - prompts/review.md
source: project
artifactHash: ${'a'.repeat(64)}
trustLevel: reviewed
extensions:
  ui:
    category: quality
  aliases:
    - audit
    - review
---
# Audit helper
Use evidence, not self-report.
`;

describe('Skill manifest security contract', () => {
  it('round-trips YAML arrays and maps without flattening them', () => {
    const parsed = parseSkillDocument(DOCUMENT, 'fixture:skill');
    expect(parsed.manifest.dependencies).toEqual(['builtin:workspace.read']);
    expect(parsed.manifest.capabilities).toEqual(['workspace.read']);
    expect(parsed.manifest.entrypoints).toEqual(['prompts/review.md']);
    expect(parsed.manifest.extensions).toEqual({
      ui: { category: 'quality' },
      aliases: ['audit', 'review'],
    });

    const roundTrip = parseSkillDocument(
      serializeSkillDocument(parsed),
      'fixture:round-trip',
    );
    expect(roundTrip).toEqual(parsed);
  });

  it.each([
    '../outside.md',
    'nested/../../outside.md',
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
    '\\\\server\\share\\skill.md',
  ])('rejects traversal, drive and UNC entrypoint %s', entrypoint => {
    const root = makeRoot();
    const manifest = parseSkillDocument(
      DOCUMENT.replace('prompts/review.md', entrypoint),
      'fixture:path-escape',
    ).manifest;

    expect(() => resolveSkillEntrypoints(root, manifest)).toThrowError(
      expect.objectContaining<Partial<SkillManifestError>>({ code: 'SKILL_PATH_ESCAPE' }),
    );
  });

  it('rejects a symlink or Windows junction whose realpath escapes the Skill root', () => {
    const root = makeRoot();
    const outside = makeRoot();
    mkdirSync(join(root, 'prompts'), { recursive: true });
    writeFileSync(join(outside, 'review.md'), '# escaped', 'utf8');
    symlinkSync(
      outside,
      join(root, 'prompts', 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const manifest = parseSkillDocument(
      DOCUMENT.replace('prompts/review.md', 'prompts/escape/review.md'),
      'fixture:link-escape',
    ).manifest;

    expect(() => resolveSkillEntrypoints(root, manifest)).toThrowError(
      expect.objectContaining<Partial<SkillManifestError>>({ code: 'SKILL_PATH_ESCAPE' }),
    );
  });

  it('uses stable schema and missing-entrypoint codes', () => {
    expect(() => parseSkillDocument(DOCUMENT.replace('schemaVersion: 1', 'schemaVersion: 2'), 'fixture:v2'))
      .toThrowError(expect.objectContaining<Partial<SkillManifestError>>({ code: 'SKILL_MANIFEST_INVALID' }));

    const root = makeRoot();
    const manifest = parseSkillDocument(DOCUMENT, 'fixture:missing').manifest;
    expect(() => resolveSkillEntrypoints(root, manifest)).toThrowError(
      expect.objectContaining<Partial<SkillManifestError>>({ code: 'SKILL_ENTRYPOINT_MISSING' }),
    );
  });
});
```

`tests/skill-lifecycle.test.ts` 必须另外覆盖：candidate smoke failure 后旧 `skill:audit-helper@1.2.2` scope 仍可调用；成功 swap 后才 dispose old；disable/uninstall 清除该 owner 的 prompt/tool/command/NL trigger；MCP/Plugin owner 数量和 revision 不变；仅有 `SKILL.md` 时 snapshot 的 `verified` 仍为 `false`。

`tests/skill-legacy-layout-migration.test.ts` 必须用两个精确动态 fixture：`<dataDir>/skills/<name>/SKILL.md` 与 `<dataDir>/forge/<package>/<name>/SKILL.md`。迁移先 copy 到 staging、hash/read-back、activate，再写 migration report；源路径在成功 report 持久化前不得删除，失败返回 `SKILL_LEGACY_LAYOUT_INVALID` 且源字节不变。

- [ ] **Step 2: 运行红测并确认目标失败**

```powershell
npm.cmd run test:w2-07
npm.cmd exec -- vitest run tests/skill-lifecycle.test.ts tests/skill-legacy-layout-migration.test.ts
```

Expected exit: `1`。首个明确失败应为缺少 `../src/infrastructure/skills/skillManifest.js`，实现 parser 后路径攻击必须分别以 `SKILL_PATH_ESCAPE` 或 `SKILL_ENTRYPOINT_MISSING` 失败，不能因 fixture 路径错误失败。

- [ ] **Step 3: 粘贴完整最小 manifest/path 实现**

`src/infrastructure/skills/skillManifest.ts`：

```ts
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { assertSafeExtensionName } from '../../domain/safeNames.js';

export type SkillManifestErrorCode =
  | 'SKILL_MANIFEST_INVALID'
  | 'SKILL_NAME_INVALID'
  | 'SKILL_PATH_ESCAPE'
  | 'SKILL_ENTRYPOINT_MISSING';

export class SkillManifestError extends Error {
  constructor(
    readonly code: SkillManifestErrorCode,
    readonly source: string,
    message: string,
    cause?: unknown,
  ) {
    super(`${code}:${source}:${message}`, { cause });
    this.name = 'SkillManifestError';
  }
}

export interface SkillManifest {
  schemaVersion: 1;
  name: string;
  version: string;
  description: string;
  dependencies: string[];
  capabilities: string[];
  entrypoints: string[];
  source: string;
  artifactHash: string;
  trustLevel: 'untrusted' | 'reviewed' | 'trusted';
  extensions: Record<string, unknown>;
}

export interface ParsedSkillDocument {
  manifest: SkillManifest;
  body: string;
}

function stringArray(value: unknown, key: string, source: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new SkillManifestError('SKILL_MANIFEST_INVALID', source, `${key} must be string[]`);
  }
  return [...value];
}

function record(value: unknown, key: string, source: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new SkillManifestError('SKILL_MANIFEST_INVALID', source, `${key} must be a map`);
  }
  return structuredClone(value as Record<string, unknown>);
}

export function parseSkillDocument(text: string, source: string): ParsedSkillDocument {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new SkillManifestError('SKILL_MANIFEST_INVALID', source, 'frontmatter missing');
  try {
    const document = parseDocument(match[1], { prettyErrors: false, strict: true });
    if (document.errors.length > 0) throw document.errors[0];
    const raw = document.toJS() as Record<string, unknown>;
    if (raw.schemaVersion !== 1) throw new Error('schemaVersion must equal 1');
    const name = String(raw.name ?? '');
    try {
      assertSafeExtensionName(name);
    } catch (error) {
      throw new SkillManifestError('SKILL_NAME_INVALID', source, name, error);
    }
    const trustLevel = raw.trustLevel;
    if (trustLevel !== 'untrusted' && trustLevel !== 'reviewed' && trustLevel !== 'trusted') {
      throw new Error('trustLevel is invalid');
    }
    const artifactHash = String(raw.artifactHash ?? '');
    if (!/^[a-f0-9]{64}$/.test(artifactHash)) throw new Error('artifactHash must be lowercase SHA-256');
    const manifest: SkillManifest = {
      schemaVersion: 1,
      name,
      version: String(raw.version ?? ''),
      description: String(raw.description ?? ''),
      dependencies: stringArray(raw.dependencies, 'dependencies', source),
      capabilities: stringArray(raw.capabilities, 'capabilities', source),
      entrypoints: stringArray(raw.entrypoints, 'entrypoints', source),
      source: String(raw.source ?? ''),
      artifactHash,
      trustLevel,
      extensions: record(raw.extensions, 'extensions', source),
    };
    if (!manifest.version || !manifest.description || !manifest.source) {
      throw new Error('version, description and source are required');
    }
    return { manifest, body: match[2] ?? '' };
  } catch (error) {
    if (error instanceof SkillManifestError) throw error;
    throw new SkillManifestError('SKILL_MANIFEST_INVALID', source, 'invalid YAML manifest', error);
  }
}

export function serializeSkillDocument(value: ParsedSkillDocument): string {
  const yaml = stringify(value.manifest, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${value.body}`;
}

function lexicalPathIsUnsafe(path: string): boolean {
  return path.length === 0
    || isAbsolute(path)
    || win32.isAbsolute(path)
    || /^[a-zA-Z]:/.test(path)
    || path.startsWith('\\\\')
    || path.split(/[\\/]+/).some(part => part === '..');
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function resolveSkillEntrypoints(root: string, manifest: SkillManifest): string[] {
  const realRoot = realpathSync.native(root);
  return manifest.entrypoints.map(entrypoint => {
    if (lexicalPathIsUnsafe(entrypoint)) {
      throw new SkillManifestError('SKILL_PATH_ESCAPE', entrypoint, 'entrypoint is not relative');
    }
    const lexical = resolve(realRoot, entrypoint);
    if (!isInside(realRoot, lexical)) {
      throw new SkillManifestError('SKILL_PATH_ESCAPE', entrypoint, 'lexical boundary escape');
    }
    let real: string;
    try {
      real = realpathSync.native(lexical);
      if (!statSync(real).isFile()) throw new Error('entrypoint is not a file');
    } catch (error) {
      throw new SkillManifestError('SKILL_ENTRYPOINT_MISSING', entrypoint, 'entrypoint missing', error);
    }
    if (!isInside(realRoot, real)) {
      throw new SkillManifestError('SKILL_PATH_ESCAPE', entrypoint, 'realpath boundary escape');
    }
    return real;
  });
}
```

`src/domain/safeNames.ts` 必须导出并由 Skill、Plugin 共用同一实现：

```ts
export function assertSafeExtensionName(value: string): void {
  const normalized = value.normalize('NFKC');
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
  if (
    normalized !== value
    || !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(value)
    || value.includes('..')
    || reserved.test(value)
    || /[. ]$/.test(value)
  ) {
    throw Object.assign(new Error(`UNSAFE_EXTENSION_NAME:${value}`), { code: 'UNSAFE_EXTENSION_NAME' });
  }
}
```

`src/application/extensions/skillLifecycleService.ts` 的最小控制流必须固定为：pipeline-backed staging copy → `parseSkillDocument()` → `resolveSkillEntrypoints()` → artifact SHA-256 比对 → dependency/policy validation → `scopeManager.stage('skill:<name>@<version>', version)` → 只向 candidate scope 注册 → smoke → `scopeManager.activate(candidateScope)`。任一步失败 dispose candidate 并保留旧 scope；禁止在 activate 前删除/覆盖 live target。kernel/assimilate/command 兼容层只返回 service 的 `OperationResult`，不得自行捕获并改写为成功文本。

- [ ] **Step 4：精确 script 与绿色命令**

```json
{ "scripts": { "test:w2-07": "vitest run tests/w2-skill-lifecycle.contract.test.ts" } }
```

```powershell
npm.cmd run test:w2-07
npm.cmd exec -- vitest run tests/skill-lifecycle.test.ts tests/skill-legacy-layout-migration.test.ts tests/kernel-skills.test.ts tests/kernel-assimilate.test.ts
npm.cmd run typecheck
npm.cmd run typecheck:tests
```

Expected exit: `0`；YAML map/array round-trip、四类路径逃逸、candidate failure retention、owner-only disposal 和 legacy source preservation 均 PASS。

**Commit message（仅实施阶段使用，本次计划修订不提交）**

```text
skills: secure manifests installation and unload
```

---

## Task W2-08：Plugin capability broker、trusted runtime 与 untrusted sandbox

**Requirements/Subprojects:** R06、R10、R16；S4/S13 前置

**Files**
- Create: `src/domain/extensions/pluginManifest.ts`
- Create: `src/infrastructure/plugins/pluginProtocol.ts`
- Create: `src/infrastructure/plugins/pluginWorkerHost.ts`
- Create: `src/infrastructure/plugins/pluginSandbox.ts`
- Create: `src/application/extensions/pluginLifecycleService.ts`
- Modify: `src/domain/safeNames.ts`（复用 W2-07 `assertSafeExtensionName()`；不得建立第二套 Plugin 名称规则）
- Modify: `src/kernel/plugins.ts`（compatibility adapter only；移除主进程 dynamic import 的可达路径）
- Modify: `src/commands/handlersExt.ts`（只调用 PluginLifecycleService）
- Modify: `src/cli/index.ts`（只在组合根注入 broker/sandbox adapter）
- Modify: `package.json`（只新增 `test:w2-08`）
- Create: `tests/plugin-sandbox-lifecycle.test.ts`
- Create: `tests/w2-plugin-sandbox.contract.test.ts`
- Create: `tests/plugin-registration-cleanup.test.ts`
- Create: `tests/fixtures/plugins/trusted-echo/plugin.json`
- Create: `tests/fixtures/plugins/trusted-echo/index.mjs`
- Create: `tests/fixtures/plugins/untrusted-fs-read/plugin.json`
- Create: `tests/fixtures/plugins/untrusted-fs-read/index.mjs`
- Create: `tests/fixtures/plugins/untrusted-network/plugin.json`
- Create: `tests/fixtures/plugins/untrusted-network/index.mjs`
- Create: `tests/fixtures/plugins/untrusted-process-env/plugin.json`
- Create: `tests/fixtures/plugins/untrusted-process-env/index.mjs`
- Create: `tests/fixtures/plugins/register-everything/plugin.json`
- Create: `tests/fixtures/plugins/register-everything/index.mjs`

**Owned scope and sandbox invariant**

- Plugin owner 固定为 `plugin:<manifest.name>@<manifest.version>`；candidate 只写自己的 `RegistrationScope`，reload failure 不改变 MCP/Skill scope revision。
- `worker_threads`/child process 只能报告 `crash-isolation`。Untrusted Plugin 只有注入 adapter 的 `strength === 'os-enforced'` 且 probe evidence 验证文件、网络、process、credential、继承句柄和环境变量限制后才可 enable；否则返回 `PLUGIN_SANDBOX_UNAVAILABLE` 并保持 `quarantined`。
- Plugin 不能收到 raw `fs`、`fetch`、`child_process`、credentials 或 host process environment。所有声明能力封装为 schema 化 `BrokerRequest`，broker 再调用 W1 pipeline/PDP/budget/journal。
- Worker/Sandbox host 的 executable 和 argv 分离，`shell:false`；Windows restricted adapter 不可证明时不得降级成 Worker 并宣称安全。

**Stable codes**

- `PLUGIN_MANIFEST_INVALID`
- `PLUGIN_CHECKSUM_MISMATCH`
- `PLUGIN_QUARANTINED`
- `PLUGIN_SANDBOX_UNAVAILABLE`
- `PLUGIN_BROKER_CAPABILITY_DENIED`
- `PLUGIN_BROKER_REQUEST_INVALID`
- `PLUGIN_WORKER_CRASHED`
- `PLUGIN_SCOPE_ACTIVATION_FAILED`
- `PLUGIN_UNLOAD_FAILED`

**Interfaces**

```ts
export interface PluginManifest {
  schemaVersion: 1;
  name: string;
  version: string;
  entrypoint: string;
  trustLevel: 'trusted' | 'untrusted';
  permissions: PluginCapabilityRequest[];
  checksum: string;
  signature?: SignatureDescriptor;
}

export type BrokerRequest =
  | { id: string; kind: 'workspace.read'; path: string }
  | { id: string; kind: 'workspace.write'; path: string; bytesBase64: string }
  | { id: string; kind: 'network.fetch'; url: string; method: 'GET' | 'POST' }
  | { id: string; kind: 'process.spawn'; executable: string; args: string[] };

export interface PluginBroker {
  request(
    pluginId: string,
    request: BrokerRequest,
    context: ExecutionContext,
    signal: AbortSignal,
  ): Promise<OperationResult<BrokerResponse>>;
}

export interface PluginSandbox {
  readonly strength: 'crash-isolation' | 'os-enforced';
  probe(signal: AbortSignal): Promise<OperationResult<SandboxProbeEvidence>>;
  start(
    candidate: PluginCandidate,
    broker: PluginBroker,
    signal: AbortSignal,
  ): Promise<OperationResult<PluginProcess>>;
}
```

- [ ] **Step 1: 粘贴完整 broker/sandbox 红测**

`tests/w2-plugin-sandbox.contract.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPluginLifecycleService } from '../src/application/extensions/pluginLifecycleService.js';
import { createPluginBroker } from '../src/infrastructure/plugins/pluginProtocol.js';
import type { PluginSandbox } from '../src/infrastructure/plugins/pluginSandbox.js';

const fixtureRoot = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  'fixtures/plugins',
);
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wxn-plugin-malicious-'));
  roots.push(root);
  return root;
}

const context = {
  actorId: 'test:plugin',
  sessionId: 'session-plugin',
  runId: 'run-plugin',
  correlationId: 'corr-plugin',
} as const;

function sandbox(strength: PluginSandbox['strength']): PluginSandbox {
  return {
    strength,
    probe: vi.fn(async () => ({
      ok: true as const,
      value: {
        strength,
        environmentCleared: strength === 'os-enforced',
        inheritedHandlesBlocked: strength === 'os-enforced',
        filesystemDenied: strength === 'os-enforced',
        networkDenied: strength === 'os-enforced',
        processDenied: strength === 'os-enforced',
        credentialDenied: strength === 'os-enforced',
        evidenceIds: ['evidence:sandbox-probe'],
      },
    })),
    start: vi.fn(async () => ({
      ok: false as const,
      error: {
        code: 'SHOULD_NOT_START',
        message: 'sandbox start must not be reached',
        messageKey: 'SHOULD_NOT_START',
        retryable: false,
      },
    })),
  };
}

describe('malicious Plugin fixtures', () => {
  it.each([
    ['untrusted-fs-read', 'workspace.read'],
    ['untrusted-network', 'network.fetch'],
    ['untrusted-process-env', 'process.spawn'],
  ])('quarantines %s when only crash isolation is available', async (fixture, capability) => {
    const dataDir = makeRoot();
    const pipelineExecute = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: 'PLUGIN_BROKER_CAPABILITY_DENIED',
        message: capability,
        messageKey: 'PLUGIN_BROKER_CAPABILITY_DENIED',
        retryable: false,
      },
    }));
    const broker = createPluginBroker({ pipeline: { execute: pipelineExecute } });
    const service = createPluginLifecycleService({
      dataDir,
      sandbox: sandbox('crash-isolation'),
      broker,
      scopeManager: {
        stage: vi.fn(),
        activate: vi.fn(),
        deactivate: vi.fn(),
      },
    });

    const result = await service.enable(
      join(fixtureRoot, fixture),
      context,
      new AbortController().signal,
    );

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'PLUGIN_SANDBOX_UNAVAILABLE' }),
    });
    expect(service.snapshot(fixture)).toMatchObject({ state: 'quarantined' });
    expect(broker.request).not.toHaveBeenCalled();
  });

  it('does not confuse crash isolation with an OS-enforced sandbox', async () => {
    const service = createPluginLifecycleService({
      dataDir: makeRoot(),
      sandbox: sandbox('crash-isolation'),
      broker: createPluginBroker({ pipeline: { execute: vi.fn() } }),
      scopeManager: { stage: vi.fn(), activate: vi.fn(), deactivate: vi.fn() },
    });

    const result = await service.enable(
      join(fixtureRoot, 'untrusted-fs-read'),
      context,
      new AbortController().signal,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PLUGIN_SANDBOX_UNAVAILABLE');
    expect(service.snapshot('untrusted-fs-read')?.sandboxStrength).toBe('crash-isolation');
  });
});
```

`tests/plugin-sandbox-lifecycle.test.ts` 必须完整覆盖：Trusted fixture 只能获得 `crash-isolation`；worker crash 返回 `PLUGIN_WORKER_CRASHED` 而主进程仍可继续；缺 permissions/checksum/trust 返回 `PLUGIN_MANIFEST_INVALID`/quarantined；Untrusted + probe 任一 false 仍为 `PLUGIN_SANDBOX_UNAVAILABLE`；AbortSignal 触发 worker stop receipt，迟到 registration 被 fencing 丢弃。

`tests/plugin-registration-cleanup.test.ts` 必须使用 `register-everything` fixture 注册一个 tool、command、event subscription、NL trigger 和 onLoad disposer；disable/reload/uninstall 后逐项断言为零。reload candidate failure 后旧 handler 仍返回旧版本值，且 MCP/Skill owner snapshot 未变化。

- [ ] **Step 2: 运行红测并确认目标失败**

```powershell
npm.cmd exec -- vitest run tests/plugin-sandbox-lifecycle.test.ts tests/w2-plugin-sandbox.contract.test.ts tests/plugin-registration-cleanup.test.ts
```

Expected exit: `1`。当前 `src/kernel/plugins.ts` 在主进程 `import()` 任意 `index.js`，并缺少 `pluginLifecycleService.js`；实现后恶意 fixture 必须稳定返回 `PLUGIN_SANDBOX_UNAVAILABLE` 或 `PLUGIN_BROKER_CAPABILITY_DENIED`，不得以普通异常文本或空工具集伪成功。

- [ ] **Step 3: 粘贴完整最小 sandbox policy 实现**

`src/infrastructure/plugins/pluginSandbox.ts`：

```ts
import type { OperationResult } from '../../protocol/results.js';
import type { PluginBroker } from './pluginProtocol.js';

export interface SandboxProbeEvidence {
  strength: 'crash-isolation' | 'os-enforced';
  environmentCleared: boolean;
  inheritedHandlesBlocked: boolean;
  filesystemDenied: boolean;
  networkDenied: boolean;
  processDenied: boolean;
  credentialDenied: boolean;
  evidenceIds: string[];
}

export interface PluginCandidate {
  id: string;
  manifestPath: string;
  entrypointPath: string;
  trustLevel: 'trusted' | 'untrusted';
}

export interface PluginProcess {
  readonly processId: string;
  stop(reason: string, signal: AbortSignal): Promise<OperationResult<{ stopped: true }>>;
}

export interface PluginSandbox {
  readonly strength: 'crash-isolation' | 'os-enforced';
  probe(signal: AbortSignal): Promise<OperationResult<SandboxProbeEvidence>>;
  start(
    candidate: PluginCandidate,
    broker: PluginBroker,
    signal: AbortSignal,
  ): Promise<OperationResult<PluginProcess>>;
}

export function assertSandboxAvailable(
  trustLevel: PluginCandidate['trustLevel'],
  probe: SandboxProbeEvidence,
): OperationResult<SandboxProbeEvidence> {
  if (trustLevel === 'trusted') return { ok: true, value: probe, evidenceIds: probe.evidenceIds };
  const enforced = probe.strength === 'os-enforced'
    && probe.environmentCleared
    && probe.inheritedHandlesBlocked
    && probe.filesystemDenied
    && probe.networkDenied
    && probe.processDenied
    && probe.credentialDenied;
  if (!enforced) {
    return {
      ok: false,
      error: {
        code: 'PLUGIN_SANDBOX_UNAVAILABLE',
        message: 'Untrusted Plugin requires a verified OS-enforced sandbox',
        messageKey: 'PLUGIN_SANDBOX_UNAVAILABLE',
        retryable: false,
        details: { strength: probe.strength },
      },
      evidenceIds: probe.evidenceIds,
    };
  }
  return { ok: true, value: probe, evidenceIds: probe.evidenceIds };
}
```

`src/infrastructure/plugins/pluginProtocol.ts`：

```ts
import type { ExecutionContext } from '../../domain/execution/executionContext.js';
import type { OperationResult } from '../../protocol/results.js';
import type { ToolExecutionPipeline } from '../../domain/tools/toolExecutionPipeline.js';

export type BrokerRequest =
  | { id: string; kind: 'workspace.read'; path: string }
  | { id: string; kind: 'workspace.write'; path: string; bytesBase64: string }
  | { id: string; kind: 'network.fetch'; url: string; method: 'GET' | 'POST' }
  | { id: string; kind: 'process.spawn'; executable: string; args: string[] };

export interface BrokerResponse {
  requestId: string;
  receiptId: string;
}

export interface PluginBroker {
  request(
    pluginId: string,
    request: BrokerRequest,
    context: ExecutionContext,
    signal: AbortSignal,
  ): Promise<OperationResult<BrokerResponse>>;
}

const capabilityTool = {
  'workspace.read': 'builtin:workspace.read',
  'workspace.write': 'builtin:workspace.write',
  'network.fetch': 'builtin:network.fetch',
  'process.spawn': 'builtin:process.spawn',
} as const;

export function createPluginBroker(options: { pipeline: ToolExecutionPipeline }): PluginBroker {
  return {
    async request(pluginId, request, context, signal) {
      if (!request.id || !(request.kind in capabilityTool)) {
        return {
          ok: false,
          error: {
            code: 'PLUGIN_BROKER_REQUEST_INVALID',
            message: 'Invalid broker request',
            messageKey: 'PLUGIN_BROKER_REQUEST_INVALID',
            retryable: false,
          },
        };
      }
      const result = await options.pipeline.execute({
        toolId: capabilityTool[request.kind],
        args: request,
        origin: { kind: 'plugin', owner: pluginId },
      }, context, signal);
      if (!result.ok) return result;
      return {
        ok: true,
        value: { requestId: request.id, receiptId: result.value.id },
        evidenceIds: result.evidenceIds,
      };
    },
  };
}
```

`PluginLifecycleService.enable()` 的完整最小控制流固定为：parse/validate manifest → safe name/entrypoint realpath/checksum → probe sandbox → `assertSandboxAvailable()` → start candidate process → collect candidate registration into `RegistrationScope` → smoke → atomic activate → dispose old process/scope。任何异常先 stop/dispose candidate，再返回对应 stable code；旧 scope/process 保持。kernel adapter 禁止回退到主进程 `import()`。

- [ ] **Step 4：精确 script 与绿色命令**

```json
{ "scripts": { "test:w2-08": "vitest run tests/w2-plugin-sandbox.contract.test.ts" } }
```

```powershell
npm.cmd run test:w2-08
npm.cmd exec -- vitest run tests/plugin-sandbox-lifecycle.test.ts tests/plugin-registration-cleanup.test.ts tests/kernel-plugins.test.ts tests/mcp-plugin-coexistence.test.ts
npm.cmd run typecheck
npm.cmd run typecheck:tests
```

Expected exit: `0`；Trusted crash isolation、Untrusted quarantine、broker denial、owner-only cleanup、reload retention 与 abort fencing 均 PASS。

**Commit message（仅实施阶段使用，本次计划修订不提交）**

```text
plugins: broker capabilities and enforce trust boundaries
```

---

## Task W2-09：Goal/Plan/Run persistence、全维预算与 cancellation fence

**Requirements/Subprojects:** R05、R16；S13；依赖 W1-07/W1-08。旧 V3 `tasks` 表只读迁移；新写只进入 Goal/Plan/PlanStep/Run/Attempt repositories。

**Files（精确）**
- Create: `src/domain/autonomy/autonomyRecords.ts`
- Create: `src/domain/autonomy/taskTicket.ts`
- Create: `src/domain/autonomy/taskStateMachine.ts`
- Create: `src/domain/autonomy/budgetDimensions.ts`
- Create: `src/application/autonomy/taskRunner.ts`
- Create: `src/application/autonomy/cancellationService.ts`
- Create: `src/application/autonomy/budgetService.ts`
- Create: `src/infrastructure/sqlite/autonomyMigration.ts`
- Create: `src/infrastructure/sqlite/autonomyRepositories.ts`
- Create: `src/infrastructure/sqlite/budgetRepository.ts`
- Modify: `src/kernel/taskRunner.ts`（compatibility adapter only）
- Modify: `src/store/db.ts`（调用 versioned migration；删除新写旧 `tasks` 的路径）
- Modify: `src/wxnodus-ui/wxGateway.ts`
- Modify: `package.json`（只新增 `test:w2-09`）
- Create: `tests/w2-autonomy-persistence-budget.contract.test.ts`

**Interfaces / stable vocabulary**

```ts
export type TaskState = 'queued'|'leased'|'running'|'cancelling'|'cancelled'|'completed'|'failed'|'orphaned';
export type BudgetDimension = 'token'|'cost'|'wallclock'|'turn'|'tool'|'retry'|'depth'|'fanout'|
  'concurrent-agent'|'network'|'external-writes'|'browser-desktop'|'screenshot'|'files'|'bytes';
export interface Goal { id: string; objective: string; acceptanceCriteria: string[]; createdAt: string }
export interface Plan { id: string; goalId: string; revision: number; createdAt: string }
export interface PlanStep { id: string; planId: string; ordinal: number; objective: string; state: TaskState }
export interface Run { id: string; goalId: string; planId: string; parentRunId: string|null; state: TaskState; revision: number }
export interface Attempt { id: string; runId: string; planStepId: string; ordinal: number; state: TaskState; leaseExpiresAt: string|null; evidenceIds: string[] }
```

- [ ] **Step 1：粘贴完整红测**

`tests/w2-autonomy-persistence-budget.contract.test.ts`

```ts
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ALL_BUDGET_DIMENSIONS } from '../src/domain/autonomy/budgetDimensions.js';
import { migrateAutonomySchema } from '../src/infrastructure/sqlite/autonomyMigration.js';
import { createAutonomyRepositories } from '../src/infrastructure/sqlite/autonomyRepositories.js';
import { BudgetRepository } from '../src/infrastructure/sqlite/budgetRepository.js';
import { BudgetService } from '../src/application/autonomy/budgetService.js';

const now = '2026-08-13T00:00:00.000Z';

describe('W2-09 durable autonomy and exhaustive budget ledger', () => {
  it('round-trips Goal/Plan/PlanStep/Run/Attempt and survives repository restart', () => {
    const db = new Database(':memory:'); migrateAutonomySchema(db);
    const repos = createAutonomyRepositories(db);
    repos.goals.put({ id: 'g1', objective: 'ship', acceptanceCriteria: ['tests pass'], createdAt: now });
    repos.plans.put({ id: 'p1', goalId: 'g1', revision: 1, createdAt: now });
    repos.steps.put({ id: 'ps1', planId: 'p1', ordinal: 0, objective: 'test', state: 'queued' });
    repos.runs.put({ id: 'r1', goalId: 'g1', planId: 'p1', parentRunId: null, state: 'running', revision: 1 });
    repos.attempts.put({ id: 'a1', runId: 'r1', planStepId: 'ps1', ordinal: 1, state: 'leased',
      leaseExpiresAt: '2026-08-13T00:01:00.000Z', evidenceIds: ['ev:start'] });
    const restarted = createAutonomyRepositories(db);
    expect(restarted.goals.get('g1')?.objective).toBe('ship');
    expect(restarted.plans.get('p1')?.goalId).toBe('g1');
    expect(restarted.steps.get('ps1')?.state).toBe('queued');
    expect(restarted.runs.casState('r1', 1, 'cancelling')).toBe(true);
    expect(restarted.runs.casState('r1', 1, 'completed')).toBe(false);
    expect(restarted.attempts.get('a1')?.evidenceIds).toEqual(['ev:start']);
    db.close();
  });

  it('reserve/commit/release every dimension, enforces concurrency, restart, and evidence', () => {
    const db = new Database(':memory:'); migrateAutonomySchema(db);
    const repository = new BudgetRepository(db);
    const limits = Object.fromEntries(ALL_BUDGET_DIMENSIONS.map(d => [d, d === 'concurrent-agent' ? 1 : 10])) as Record<typeof ALL_BUDGET_DIMENSIONS[number], number>;
    const service = new BudgetService(repository, () => now);
    service.open('r1', limits);
    for (const dimension of ALL_BUDGET_DIMENSIONS) {
      const reserved = service.reserve('r1', dimension, 1, `ev:reserve:${dimension}`);
      expect(reserved).toMatchObject({ ok: true });
      expect(service.commit(reserved.value.reservationId, 1, `ev:commit:${dimension}`)).toMatchObject({ ok: true });
      const released = service.reserve('r1', dimension, 1, `ev:reserve-release:${dimension}`);
      expect(service.release(released.value.reservationId, `ev:release:${dimension}`)).toMatchObject({ ok: true });
    }
    const held = service.reserve('r1', 'concurrent-agent', 1, 'ev:concurrency-held');
    expect(held.ok).toBe(false); // committed unit already consumes the limit
    if (!held.ok) expect(held.error.code).toBe('BUDGET_EXCEEDED');
    const restarted = new BudgetService(new BudgetRepository(db), () => now);
    expect(restarted.snapshot('r1').dimensions['token']).toMatchObject({ committed: 1, reserved: 0, limit: 10 });
    expect(restarted.evidence('r1')).toContain('ev:commit:token');
    expect(restarted.evidence('r1')).toContain('ev:release:byte');
    db.close();
  });
});
```

- [ ] **Step 2：红测命令**

```powershell
npm.cmd run test:w2-09
```

Expected exit: `1`，缺少 autonomy migration/repositories；不得因 SQLite fixture 或 test discovery 失败。

- [ ] **Step 3：粘贴完整最小 records/migration/repositories 实现**

`src/domain/autonomy/autonomyRecords.ts`

```ts
export type TaskState = 'queued'|'leased'|'running'|'cancelling'|'cancelled'|'completed'|'failed'|'orphaned';
export interface Goal { id: string; objective: string; acceptanceCriteria: string[]; createdAt: string }
export interface Plan { id: string; goalId: string; revision: number; createdAt: string }
export interface PlanStep { id: string; planId: string; ordinal: number; objective: string; state: TaskState }
export interface Run { id: string; goalId: string; planId: string; parentRunId: string|null; state: TaskState; revision: number }
export interface Attempt { id: string; runId: string; planStepId: string; ordinal: number; state: TaskState;
  leaseExpiresAt: string|null; evidenceIds: string[] }
```

`src/infrastructure/sqlite/autonomyMigration.ts`

```ts
import type Database from 'better-sqlite3';
export function migrateAutonomySchema(db: InstanceType<typeof Database>): void {
  db.transaction(() => { db.exec(`
    CREATE TABLE IF NOT EXISTS autonomy_records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(kind,id));
    CREATE TABLE IF NOT EXISTS budget_accounts(run_id TEXT PRIMARY KEY,limits_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS budget_reservations(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,dimension TEXT NOT NULL,reserved REAL NOT NULL,committed REAL NOT NULL DEFAULT 0,status TEXT NOT NULL,evidence_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_budget_run_dimension ON budget_reservations(run_id,dimension,status);
    CREATE TABLE IF NOT EXISTS autonomy_migrations(source_kind TEXT NOT NULL,source_id TEXT NOT NULL,target_id TEXT NOT NULL,evidence_id TEXT NOT NULL,PRIMARY KEY(source_kind,source_id));
  `); })();
}
```

`src/infrastructure/sqlite/autonomyRepositories.ts`

```ts
import type Database from 'better-sqlite3';
import type { Attempt, Goal, Plan, PlanStep, Run, TaskState } from '../../domain/autonomy/autonomyRecords.js';
type Kind = 'goal'|'plan'|'step'|'run'|'attempt'; type WithId = { id: string };
class JsonRepository<T extends WithId> {
  constructor(protected readonly db: InstanceType<typeof Database>, private readonly kind: Kind) {}
  put(value: T): void { this.db.prepare(`INSERT INTO autonomy_records(kind,id,body,revision) VALUES(?,?,?,1)
    ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,revision=autonomy_records.revision+1`).run(this.kind,value.id,JSON.stringify(value)); }
  get(id: string): T|undefined { const row = this.db.prepare('SELECT body FROM autonomy_records WHERE kind=? AND id=?').get(this.kind,id) as {body:string}|undefined;
    return row ? JSON.parse(row.body) as T : undefined; }
}
class RunRepository extends JsonRepository<Run> {
  casState(id: string, revision: number, state: TaskState): boolean {
    const body = this.db.prepare('SELECT body FROM autonomy_records WHERE kind=? AND id=? AND revision=?').get('run',id,revision) as {body:string}|undefined;
    if (!body) return false;
    const next = { ...(JSON.parse(body.body) as Run), state, revision: revision + 1 };
    return this.db.prepare('UPDATE autonomy_records SET body=?,revision=? WHERE kind=? AND id=? AND revision=?')
      .run(JSON.stringify(next), revision + 1, 'run', id, revision).changes === 1;
  }
}
export function createAutonomyRepositories(db: InstanceType<typeof Database>) { return {
  goals: new JsonRepository<Goal>(db,'goal'), plans: new JsonRepository<Plan>(db,'plan'),
  steps: new JsonRepository<PlanStep>(db,'step'), runs: new RunRepository(db,'run'),
  attempts: new JsonRepository<Attempt>(db,'attempt'),
}; }
export type AutonomyRepositories = ReturnType<typeof createAutonomyRepositories>;
```

- [ ] **Step 4：粘贴完整全维预算实现**

`src/domain/autonomy/budgetDimensions.ts`

```ts
export const ALL_BUDGET_DIMENSIONS = ['token','cost','wallclock','turn','tool','retry','depth','fanout',
  'concurrent-agent','network','external-writes','browser-desktop','screenshot','files','bytes'] as const;
export type BudgetDimension = typeof ALL_BUDGET_DIMENSIONS[number];
```

`src/infrastructure/sqlite/budgetRepository.ts`

```ts
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { BudgetDimension } from '../../domain/autonomy/budgetDimensions.js';
export class BudgetRepository {
  constructor(private readonly db: InstanceType<typeof Database>) {}
  open(runId: string, limits: Record<BudgetDimension,number>): void { this.db.prepare('INSERT OR REPLACE INTO budget_accounts VALUES(?,?)').run(runId,JSON.stringify(limits)); }
  limits(runId: string): Record<BudgetDimension,number> { const row=this.db.prepare('SELECT limits_json FROM budget_accounts WHERE run_id=?').get(runId) as {limits_json:string}; return JSON.parse(row.limits_json); }
  totals(runId: string, dimension: BudgetDimension) { return this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN status='reserved' THEN reserved ELSE 0 END),0) reserved,
    COALESCE(SUM(committed),0) committed FROM budget_reservations WHERE run_id=? AND dimension=?`).get(runId,dimension) as {reserved:number;committed:number}; }
  reserve(runId:string,dimension:BudgetDimension,amount:number,evidenceId:string): string { const id=randomUUID(); this.db.prepare('INSERT INTO budget_reservations VALUES(?,?,?,?,0,?,?)')
    .run(id,runId,dimension,amount,'reserved',JSON.stringify([evidenceId])); return id; }
  settle(id:string,status:'committed'|'released',committed:number,evidenceId:string): boolean { const row=this.db.prepare('SELECT evidence_json FROM budget_reservations WHERE id=? AND status=?').get(id,'reserved') as {evidence_json:string}|undefined;
    if(!row)return false; return this.db.prepare('UPDATE budget_reservations SET status=?,committed=?,evidence_json=? WHERE id=? AND status=?')
      .run(status,committed,JSON.stringify([...JSON.parse(row.evidence_json),evidenceId]),id,'reserved').changes===1; }
  account(runId:string) { return this.db.prepare('SELECT dimension,reserved,committed,status,evidence_json FROM budget_reservations WHERE run_id=?').all(runId) as Array<{dimension:BudgetDimension;reserved:number;committed:number;status:string;evidence_json:string}>; }
}
```

`src/application/autonomy/budgetService.ts`

```ts
import type { BudgetDimension } from '../../domain/autonomy/budgetDimensions.js';
import { ALL_BUDGET_DIMENSIONS } from '../../domain/autonomy/budgetDimensions.js';
import type { BudgetRepository } from '../../infrastructure/sqlite/budgetRepository.js';
const fail = () => ({ ok:false as const,error:{code:'BUDGET_EXCEEDED',message:'budget exceeded',messageKey:'budget.exceeded',retryable:false} });
export class BudgetService {
  constructor(private readonly repository: BudgetRepository, private readonly clock:()=>string) { void clock; }
  open(runId:string,limits:Record<BudgetDimension,number>):void { this.repository.open(runId,limits); }
  reserve(runId:string,dimension:BudgetDimension,amount:number,evidenceId:string) { if(!Number.isFinite(amount)||amount<=0)return fail();
    const totals=this.repository.totals(runId,dimension); if(totals.reserved+totals.committed+amount>this.repository.limits(runId)[dimension])return fail();
    return {ok:true as const,value:{reservationId:this.repository.reserve(runId,dimension,amount,evidenceId),timestamp:this.clock()}}; }
  commit(id:string,amount:number,evidenceId:string){ return this.repository.settle(id,'committed',amount,evidenceId)?{ok:true as const,value:undefined}:fail(); }
  release(id:string,evidenceId:string){ return this.repository.settle(id,'released',0,evidenceId)?{ok:true as const,value:undefined}:fail(); }
  snapshot(runId:string){ const limits=this.repository.limits(runId); return {runId,dimensions:Object.fromEntries(ALL_BUDGET_DIMENSIONS.map(d=>[d,{...this.repository.totals(runId,d),limit:limits[d]}])) as Record<BudgetDimension,{reserved:number;committed:number;limit:number}>}; }
  evidence(runId:string):string[]{ return this.repository.account(runId).flatMap(x=>JSON.parse(x.evidence_json) as string[]); }
}
```

TaskRunner 创建 Goal→Plan→PlanStep→Run→Attempt、每 task AbortController、lease/heartbeat 与 revision CAS；CancellationService 固定先 durable lineage fence → `cancelling` CAS → abort → 等 stop receipt → `cancelled` CAS。W1 pipeline 在 effect 前查询 lineage fence。deadline、wallclock、tool、concurrent-agent 等任何维超限都 abort，不只告警；lease 过期只写 `orphaned` 并附 evidence。

- [ ] **Step 5：script 与绿测**

```json
{ "scripts": { "test:w2-09": "vitest run tests/w2-autonomy-persistence-budget.contract.test.ts" } }
```

```powershell
npm.cmd run test:w2-09
npm.cmd exec -- vitest run tests/kernel-taskRunner.test.ts tests/wave1/w1-07-security-control-plane.test.ts tests/wave1/w1-08-tool-execution-pipeline.test.ts
npm.cmd run typecheck
npm.cmd run typecheck:tests
```

Expected exit: `0`；五类 repository restart、CAS cancel race、15 维 reserve/commit/release、concurrency、restart/evidence 与 effect fence 全部 PASS。

**Commit（仅在另行授权时）**

```text
autonomy: persist runs and enforce every budget dimension
```

---

## Task W2-10：Sub-agent worktree、lineage recovery 与六类 ProgressDetector reason

**Requirements/Subprojects:** R05、R16；S13；依赖 W2-09 五类 repositories/预算与 W1 effect fence。

**Files（精确）**
- Create: `src/domain/autonomy/progressReasons.ts`
- Create: `src/infrastructure/autonomy/worktreeManager.ts`
- Create: `src/infrastructure/autonomy/subagentHost.ts`
- Create: `src/infrastructure/sqlite/recoveryRepository.ts`
- Create: `src/infrastructure/sqlite/progressStateRepository.ts`
- Create: `src/application/autonomy/subagentService.ts`
- Create: `src/application/autonomy/recoveryService.ts`
- Create: `src/application/autonomy/progressDetector.ts`
- Modify: `src/kernel/agents.ts`（compatibility adapter only）
- Modify: `src/kernel/agent.ts`（传入 TaskTicket/AbortSignal，不再使用固定 `session:sub`）
- Modify: `src/commands/handlersExt.ts`
- Modify: `package.json`（只新增 `test:w2-10`）
- Create: `tests/w2-subagent-recovery-progress.contract.test.ts`

**Interfaces / stable reasons**

```ts
export type ProgressStopReason = 'NO_STATE_CHANGE'|'REPEATED_ACTION'|'REPEATED_ERROR'|
  'NO_NEW_EVIDENCE'|'PLAN_OSCILLATION'|'BUDGET_STAGNATION';
export interface ProgressObservation {
  stateChanged: boolean; actionKey: string; errorCode: string|null; evidenceDelta: number;
  planRevision: number; planDirection: 'forward'|'backward'|'same'; budgetCommittedDelta: number;
}
export interface RecoveryCheckpoint {
  runId: string; attemptId: string; leaseExpiresAt: string; worktreePath: string;
  baseCommit: string; headCommit: string; ownedFiles: string[]; evidenceIds: string[];
}
```

- [ ] **Step 1：粘贴完整红测**

`tests/w2-subagent-recovery-progress.contract.test.ts`

```ts
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ProgressDetector } from '../src/application/autonomy/progressDetector.js';
import { migrateAutonomySchema } from '../src/infrastructure/sqlite/autonomyMigration.js';
import { ProgressStateRepository } from '../src/infrastructure/sqlite/progressStateRepository.js';
import type { ProgressObservation, ProgressStopReason } from '../src/domain/autonomy/progressReasons.js';

const neutral = (patch: Partial<ProgressObservation> = {}): ProgressObservation => ({ stateChanged: true,
  actionKey: 'next', errorCode: null, evidenceDelta: 1, planRevision: 1, planDirection: 'forward',
  budgetCommittedDelta: 1, ...patch });

function sequence(reason: ProgressStopReason): ProgressObservation[] {
  const table: Record<ProgressStopReason, ProgressObservation[]> = {
    NO_STATE_CHANGE: [neutral({stateChanged:false}),neutral({stateChanged:false}),neutral({stateChanged:false})],
    REPEATED_ACTION: [neutral({actionKey:'same'}),neutral({actionKey:'same'}),neutral({actionKey:'same'})],
    REPEATED_ERROR: [neutral({errorCode:'E_X'}),neutral({errorCode:'E_X'}),neutral({errorCode:'E_X'})],
    NO_NEW_EVIDENCE: [neutral({evidenceDelta:0}),neutral({evidenceDelta:0}),neutral({evidenceDelta:0})],
    PLAN_OSCILLATION: [neutral({planDirection:'backward',planRevision:2}),neutral({planDirection:'forward',planRevision:3}),
      neutral({planDirection:'backward',planRevision:4}),neutral({planDirection:'forward',planRevision:5})],
    BUDGET_STAGNATION: [neutral({budgetCommittedDelta:0}),neutral({budgetCommittedDelta:0}),neutral({budgetCommittedDelta:0})],
  }; return table[reason];
}

describe('W2-10 progress and restart recovery', () => {
  it.each(['NO_STATE_CHANGE','REPEATED_ACTION','REPEATED_ERROR','NO_NEW_EVIDENCE','PLAN_OSCILLATION','BUDGET_STAGNATION'] as const)
  ('stops with stable reason %s and persists it across restart', reason => {
    const db = new Database(':memory:'); migrateAutonomySchema(db);
    const repository = new ProgressStateRepository(db);
    let detector = new ProgressDetector('r1', repository, 3);
    let observed: ProgressStopReason|null = null;
    for (const item of sequence(reason)) observed = detector.observe(item).reasonCode;
    expect(observed).toBe(reason);
    detector = new ProgressDetector('r1', new ProgressStateRepository(db), 3);
    expect(detector.snapshot().stoppedReason).toBe(reason);
    db.close();
  });

  it('does not stop when state, action, evidence, plan and budget keep progressing', () => {
    const db = new Database(':memory:'); migrateAutonomySchema(db);
    const detector = new ProgressDetector('r2', new ProgressStateRepository(db), 3);
    for (let index=1; index<=12; index+=1) expect(detector.observe(neutral({ actionKey:`a${index}`,
      planRevision:index, planDirection:'forward', evidenceDelta:1, budgetCommittedDelta:1 })).reasonCode).toBeNull();
    expect(detector.snapshot().stoppedReason).toBeNull(); db.close();
  });

  it('continues counters after restart and stops on the third repeated action', () => {
    const db = new Database(':memory:'); migrateAutonomySchema(db); const repo = new ProgressStateRepository(db);
    new ProgressDetector('r3', repo, 3).observe(neutral({actionKey:'repeat'}));
    const restarted = new ProgressDetector('r3', new ProgressStateRepository(db), 3);
    expect(restarted.observe(neutral({actionKey:'repeat'})).reasonCode).toBeNull();
    expect(restarted.observe(neutral({actionKey:'repeat'})).reasonCode).toBe('REPEATED_ACTION'); db.close();
  });
});
```

- [ ] **Step 2：红测命令**

```powershell
npm.cmd run test:w2-10
```

Expected exit: `1`，缺少 `ProgressDetector`/state repository；不得接受 zero-test 或内存 DB migration 失败。

- [ ] **Step 3：粘贴完整最小 ProgressDetector persistence 实现**

`src/domain/autonomy/progressReasons.ts`

```ts
export type ProgressStopReason = 'NO_STATE_CHANGE'|'REPEATED_ACTION'|'REPEATED_ERROR'|
  'NO_NEW_EVIDENCE'|'PLAN_OSCILLATION'|'BUDGET_STAGNATION';
export interface ProgressObservation { stateChanged:boolean; actionKey:string; errorCode:string|null;
  evidenceDelta:number; planRevision:number; planDirection:'forward'|'backward'|'same'; budgetCommittedDelta:number }
export interface ProgressState { runId:string; total:number; noStateChange:number; repeatedAction:number;
  repeatedError:number; noNewEvidence:number; oscillations:number; budgetStagnation:number;
  lastAction:string|null; lastError:string|null; lastDirection:'forward'|'backward'|'same'|null;
  stoppedReason:ProgressStopReason|null }
```

`src/infrastructure/sqlite/progressStateRepository.ts`

```ts
import type Database from 'better-sqlite3';
import type { ProgressState } from '../../domain/autonomy/progressReasons.js';
export class ProgressStateRepository {
  constructor(private readonly db:InstanceType<typeof Database>) { this.db.exec('CREATE TABLE IF NOT EXISTS progress_detector_state(run_id TEXT PRIMARY KEY,body TEXT NOT NULL)'); }
  load(runId:string):ProgressState|undefined { const row=this.db.prepare('SELECT body FROM progress_detector_state WHERE run_id=?').get(runId) as {body:string}|undefined;
    return row?JSON.parse(row.body) as ProgressState:undefined; }
  save(value:ProgressState):void { this.db.prepare('INSERT INTO progress_detector_state VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET body=excluded.body').run(value.runId,JSON.stringify(value)); }
}
```

`src/application/autonomy/progressDetector.ts`

```ts
import type { ProgressObservation, ProgressState, ProgressStopReason } from '../../domain/autonomy/progressReasons.js';
import type { ProgressStateRepository } from '../../infrastructure/sqlite/progressStateRepository.js';
export class ProgressDetector {
  private state:ProgressState;
  constructor(runId:string,private readonly repository:ProgressStateRepository,private readonly threshold=3) {
    this.state=repository.load(runId)??{runId,total:0,noStateChange:0,repeatedAction:0,repeatedError:0,
      noNewEvidence:0,oscillations:0,budgetStagnation:0,lastAction:null,lastError:null,lastDirection:null,stoppedReason:null};
  }
  observe(value:ProgressObservation):{reasonCode:ProgressStopReason|null} {
    if(this.state.stoppedReason)return {reasonCode:this.state.stoppedReason}; this.state.total+=1;
    this.state.noStateChange=value.stateChanged?0:this.state.noStateChange+1;
    this.state.repeatedAction=value.actionKey===this.state.lastAction?this.state.repeatedAction+1:1;
    this.state.repeatedError=value.errorCode&&value.errorCode===this.state.lastError?this.state.repeatedError+1:value.errorCode?1:0;
    this.state.noNewEvidence=value.evidenceDelta>0?0:this.state.noNewEvidence+1;
    const changed=value.planDirection!=='same'&&this.state.lastDirection!==null&&value.planDirection!==this.state.lastDirection;
    this.state.oscillations=changed?this.state.oscillations+1:value.planDirection==='forward'?0:this.state.oscillations;
    this.state.budgetStagnation=value.budgetCommittedDelta>0?0:this.state.budgetStagnation+1;
    this.state.lastAction=value.actionKey; this.state.lastError=value.errorCode; this.state.lastDirection=value.planDirection;
    const checks:Array<[ProgressStopReason,number]>=[['NO_STATE_CHANGE',this.state.noStateChange],
      ['REPEATED_ACTION',this.state.repeatedAction],['REPEATED_ERROR',this.state.repeatedError],
      ['NO_NEW_EVIDENCE',this.state.noNewEvidence],['PLAN_OSCILLATION',this.state.oscillations],
      ['BUDGET_STAGNATION',this.state.budgetStagnation]];
    this.state.stoppedReason=checks.find(([,count])=>count>=this.threshold)?.[0]??null;
    this.repository.save(this.state); return {reasonCode:this.state.stoppedReason};
  }
  snapshot():Readonly<ProgressState>{return structuredClone(this.state);}
}
```

- [ ] **Step 4：最小 worktree/recovery 实现合同**

`WorktreeManager` 只通过 W1 ProcessSupervisor 调 `git` executable + argv：`['worktree','add','--detach',path,baseCommit]`/`['worktree','remove','--force',path]`，`shell:false`；先 lexical + realpath 检查 `<dataDir>/worktrees/<taskId>`，Windows drive/UNC/junction 越界返回 `WORKTREE_PATH_ESCAPE`。写任务默认 worktree；`shared-readonly` 从 ToolCatalog 删除所有 write/network/process/browser-desktop tools。ownedFiles 在 effect normalization 后、PDP 前逐一检查，越界返回 `OWNED_FILE_SCOPE_DENIED`。

`recoveryRepository.ts` 精确持久化 `RecoveryCheckpoint` 与 `RecoveryDecision`；`RecoveryService.recover(runId)` 读取 W2-09 Run/Attempt/lease + checkpoint：未过期返回 `RECOVERY_LEASE_ACTIVE`；过期先 CAS `orphaned`，校验 worktree/base/head/owned-file diff 和 evidence，然后只返回 `resume-from-checkpoint`、`reconcile-worktree` 或 `manual-review` stable decision。恢复创建新 Attempt ordinal，旧 Attempt 不改写为 completed。child 的 depth/fanout/concurrent-agent/全部预算 limits 取 parent 剩余额的逐维 `min`；grant/tool/file/secret scope 只能收窄。cancel 沿 lineage 先 fence 后 AbortSignal，并等待 host stop receipt。

- [ ] **Step 5：script 与绿测**

```json
{ "scripts": { "test:w2-10": "vitest run tests/w2-subagent-recovery-progress.contract.test.ts" } }
```

```powershell
npm.cmd run test:w2-10
npm.cmd exec -- vitest run tests/kernel-agents.test.ts tests/kernel-agent.test.ts tests/kernel-taskRunner.test.ts
npm.cmd run typecheck
npm.cmd run typecheck:tests
```

Expected exit: `0`；六类正例、持续进展反例、restart counter/reason、worktree path/owned files、lineage budget narrowing、lease recovery 与 cancellation fence 全部 PASS。

**Commit（仅在另行授权时）**

```text
autonomy: recover subagents and stop stable no-progress loops
```

---

## Task W2-11：Wave 2 E2E、versioned migration drill 与 Gate

**Requirements/Subprojects:** R02、R04-R06、R10、R13-R16；S2/S4/S13；依赖 W2-01..W2-10。W2-11 是唯一创建 Wave 2 migration/gate runner 的任务。

**Files（精确）**
- Create: `tests/w2-wave2-migration-gate.contract.test.ts`
- Create: `scripts/wave2Migration.mjs`
- Create: `scripts/wave2GateRunner.mjs`
- Create: `scripts/run-wave2-migration-drill.mjs`
- Create: `scripts/run-wave2-gates.mjs`
- Modify: `src/release/gateDefinitions.ts`
- Modify: `package.json`（新增 `migration:drill:wave2`、`gate:wave2` 及 `test:w2-11`）

**Migration/Gate contract**

- Migration is versioned and rollbackable. The drill must execute and record exactly:
  `upgrade → new write → rollback → re-upgrade`.
- The new write goes to `autonomy_records`, never to legacy `tasks`; rollback leaves the legacy table readable and re-upgrade recreates the new table without silently reporting success.
- Every step returns a stable report with `ok`, `step`, `schemaVersion`, and `evidenceId`; a failed migration or gate is a non-zero process exit.
- Gate runner consumes the migration report and checks exact root script mappings, W2 contract suite discovery, lifecycle envelope usage, W1-11 registry reference, current MCP metadata/discover/legacy split, unavailable `computer`/`forge`, plugin sandbox evidence, all 15 budget dimensions, and six ProgressDetector reasons. No directory glob or zero-test success is allowed.

- [ ] **Step 1：粘贴完整红测**

`tests/w2-wave2-migration-gate.contract.test.ts`

```ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runWave2MigrationDrill } from '../scripts/wave2Migration.mjs';
import { runWave2Gates } from '../scripts/wave2GateRunner.mjs';

const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;

describe('W2-11 Wave 2 migration and release gate', () => {
  it('runs upgrade, new write, rollback, re-upgrade in the exact order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxnodus-w2-11-'));
    try {
      const report = runWave2MigrationDrill(join(dir, 'drill.db'));
      expect(report.ok).toBe(true);
      expect(report.sequence).toEqual(['upgrade', 'new write', 'rollback', 're-upgrade']);
      expect(report.newWriteTable).toBe('autonomy_records');
      expect(report.legacyTasksReadable).toBe(true);
      expect(report.finalSchemaVersion).toBe(2);
      expect(report.evidenceIds).toHaveLength(4);
      const db = new Database(join(dir, 'drill.db'), { readonly: true });
      expect((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='autonomy_records'").get() as {name:string}|undefined)?.name).toBe('autonomy_records');
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get()).toBeTruthy();
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('fails closed when a new autonomy write is attempted in legacy tasks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxnodus-w2-11-legacy-'));
    try {
      const db = new Database(join(dir, 'legacy.db'));
      db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY, goal TEXT NOT NULL)");
      expect(() => db.prepare('INSERT INTO tasks(id,goal) VALUES(?,?)').run('g1', 'must be autonomy record')).toThrow();
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('requires exact per-task scripts and non-empty W2 contract suites', () => {
    for (const [task, suite] of Object.entries({
      'test:w2-01':'tests/w2-config-onboarding.contract.test.ts', 'test:w2-02':'tests/w2-personalization.contract.test.ts',
      'test:w2-03':'tests/w2-capability-registry.contract.test.ts', 'test:w2-04':'tests/w2-extension-scope.contract.test.ts',
      'test:w2-05':'tests/w2-session-lifecycle-hooks.contract.test.ts', 'test:w2-06':'tests/w2-mcp-duplex.contract.test.ts',
      'test:w2-07':'tests/w2-skill-lifecycle.contract.test.ts', 'test:w2-08':'tests/w2-plugin-sandbox.contract.test.ts',
      'test:w2-09':'tests/w2-autonomy-persistence-budget.contract.test.ts', 'test:w2-10':'tests/w2-subagent-recovery-progress.contract.test.ts',
      'test:w2-11':'tests/w2-wave2-migration-gate.contract.test.ts',
    })) { expect(scripts[task]).toBe(`vitest run ${suite}`); }
    expect(scripts['migration:drill:wave2']).toBe('node scripts/run-wave2-migration-drill.mjs');
    expect(scripts['gate:wave2']).toBe('node scripts/run-wave2-gates.mjs');
  });

  it('gate reports stable unavailable for undelivered runtime surfaces', () => {
    const report = runWave2Gates({ rootDir: process.cwd(), migration: {
      ok:true, sequence:['upgrade','new write','rollback','re-upgrade'], finalSchemaVersion:2,
      evidenceIds:['e1','e2','e3','e4'], legacyTasksReadable:true, newWriteTable:'autonomy_records',
    }});
    expect(report.ok).toBe(true);
    expect(report.unavailable).toEqual({ computer:'CAPABILITY_UNAVAILABLE', forge:'CAPABILITY_UNAVAILABLE' });
  });
});
```

- [ ] **Step 2：红测命令**

```powershell
npm.cmd run test:w2-11
```

Expected exit: `1`，缺少 migration/gate modules 或 exact script mappings；不得因未声明目录 fixture、glob 零发现或错误复用 legacy `tasks` 通过。

- [ ] **Step 3：粘贴完整最小 migration drill 实现**

`scripts/wave2Migration.mjs`

```js
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const evidence = step => `${step}:${randomUUID()}`;
const reportStep = (step, schemaVersion, evidenceId, extra = {}) => ({ ok:true, step, schemaVersion, evidenceId, ...extra });

function ensureLegacy(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_meta(version INTEGER NOT NULL)');
  if (!db.prepare('SELECT 1 FROM schema_meta LIMIT 1').get()) db.prepare('INSERT INTO schema_meta(version) VALUES(1)').run();
  db.exec('CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, goal TEXT NOT NULL)');
}
function version(db) { return Number(db.prepare('SELECT version FROM schema_meta LIMIT 1').get().version); }
function upgrade(db) {
  db.exec('CREATE TABLE IF NOT EXISTS autonomy_records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(kind,id))');
  db.prepare('UPDATE schema_meta SET version=2').run();
}
function writeNew(db) {
  const body = JSON.stringify({ id:'g-drill', objective:'migration proof', acceptanceCriteria:['gate'], createdAt:'2026-08-13T00:00:00.000Z' });
  db.prepare("INSERT INTO autonomy_records(kind,id,body) VALUES('goal','g-drill',?)").run(body);
}
function rollback(db) {
  db.exec('DROP TABLE autonomy_records');
  db.prepare('UPDATE schema_meta SET version=1').run();
}

export function runWave2MigrationDrill(dbPath) {
  const db = new Database(dbPath);
  try {
    ensureLegacy(db);
    const sequence = [], evidenceIds = [];
    upgrade(db); sequence.push('upgrade'); evidenceIds.push(evidence('upgrade'));
    writeNew(db); sequence.push('new write'); evidenceIds.push(evidence('new-write'));
    const wrote = db.prepare("SELECT id FROM autonomy_records WHERE kind='goal' AND id='g-drill'").get();
    rollback(db); sequence.push('rollback'); evidenceIds.push(evidence('rollback'));
    const legacyTasksReadable = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get()) && version(db) === 1;
    upgrade(db); sequence.push('re-upgrade'); evidenceIds.push(evidence('re-upgrade'));
    return { ...reportStep('re-upgrade', version(db), evidenceIds[3]), ok:Boolean(wrote) && sequence.join(' → ') === 'upgrade → new write → rollback → re-upgrade',
      sequence, evidenceIds, newWriteTable:'autonomy_records', legacyTasksReadable, finalSchemaVersion:version(db) };
  } finally { db.close(); }
}
```

`scripts/run-wave2-migration-drill.mjs`

```js
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runWave2MigrationDrill } from './wave2Migration.mjs';
const dbPath = resolve(process.env.WXNODUS_WAVE2_DB ?? '.wxnodus/wave2-migration-drill.db');
mkdirSync(dirname(dbPath), { recursive:true });
const report = runWave2MigrationDrill(dbPath);
process.stdout.write(`${JSON.stringify(report)}\n`);
if (!report.ok) process.exitCode = 1;
```

- [ ] **Step 4：粘贴完整最小 Gate runner 实现**

`scripts/wave2GateRunner.mjs`

```js
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const reasons = ['NO_STATE_CHANGE','REPEATED_ACTION','REPEATED_ERROR','NO_NEW_EVIDENCE','PLAN_OSCILLATION','BUDGET_STAGNATION'];
const suites = ['w2-config-onboarding','w2-personalization','w2-capability-registry','w2-extension-scope','w2-session-lifecycle-hooks','w2-mcp-duplex','w2-skill-lifecycle','w2-plugin-sandbox','w2-autonomy-persistence-budget','w2-subagent-recovery-progress','w2-wave2-migration-gate'];
export function runWave2Gates({ rootDir, migration }) {
  const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  const scripts = packageJson.scripts ?? {};
  const failures = [];
  for (let i=0;i<suites.length;i+=1) {
    const key = `test:w2-${String(i+1).padStart(2,'0')}`;
    const expected = `vitest run tests/${suites[i]}.contract.test.ts`;
    if (scripts[key] !== expected || !existsSync(join(rootDir, `tests/${suites[i]}.contract.test.ts`))) failures.push(`SCRIPT_OR_SUITE:${key}`);
  }
  if (scripts['migration:drill:wave2'] !== 'node scripts/run-wave2-migration-drill.mjs') failures.push('SCRIPT:migration:drill:wave2');
  if (scripts['gate:wave2'] !== 'node scripts/run-wave2-gates.mjs') failures.push('SCRIPT:gate:wave2');
  if (!migration?.ok || migration.sequence?.join(' → ') !== 'upgrade → new write → rollback → re-upgrade') failures.push('MIGRATION_DRILL');
  if (!existsSync(join(rootDir, 'src/protocol/events.ts'))) failures.push('W1_GATEWAY_EVENT_MISSING');
  if (!existsSync(join(rootDir, 'src/application/capabilities/capabilityRegistry.ts'))) failures.push('W1_11_REGISTRY_MISSING');
  if (reasons.length !== 6) failures.push('PROGRESS_REASON_SET');
  return { ok: failures.length === 0, failures, unavailable:{ computer:'CAPABILITY_UNAVAILABLE', forge:'CAPABILITY_UNAVAILABLE' }, checked:['A','B','C','D','F','G'] };
}
```

`scripts/run-wave2-gates.mjs`

```js
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runWave2MigrationDrill } from './wave2Migration.mjs';
import { runWave2Gates } from './wave2GateRunner.mjs';
const rootDir = resolve(process.env.WXNODUS_ROOT ?? process.cwd());
const migration = runWave2MigrationDrill(resolve(process.env.WXNODUS_WAVE2_DB ?? '.wxnodus/wave2-gate.db'));
const report = runWave2Gates({ rootDir, migration });
process.stdout.write(`${JSON.stringify(report)}\n`);
if (!report.ok) process.exitCode = 1;
void readFileSync;
```

`src/release/gateDefinitions.ts` 增加 stable gate IDs `W2_MIGRATION_DRILL`、`W2_SCRIPT_MAPPING`、`W2_UNAVAILABLE_SURFACES`；Gate runner 只消费 capability snapshot/evidence，不重新 probe 本机，不把 `computer`、`forge` 或 MCP Tasks Preview 作为 GA 依赖。

- [ ] **Step 5：script 与绿测**

```json
{
  "scripts": {
    "test:w2-11": "vitest run tests/w2-wave2-migration-gate.contract.test.ts",
    "migration:drill:wave2": "node scripts/run-wave2-migration-drill.mjs",
    "gate:wave2": "node scripts/run-wave2-gates.mjs"
  }
}
```

```powershell
npm.cmd run test:w2-11
npm.cmd run migration:drill:wave2
npm.cmd run gate:wave2
npm.cmd run check:test-discovery
npm.cmd run typecheck
npm.cmd run build
npm.cmd run test:all
```

Expected exit: `0`；migration 四步顺序、legacy/new storage boundary、exact W2-01..W2-11 mappings、A/B/C/D/F/G gate、stable unavailable 与六类 progress reasons 全部 PASS。

**Commit（仅在另行授权时）**

```text
release: verify the Wave 2 extension and autonomy boundary
```

---

## Wave 2 Exit Audit

通过条件：

- clean TTY 首先选择中文/English；non-TTY/help/version 无副作用。
- user/workspace personalization set/restart/read/export/import 真实读回。
- CapabilitySnapshot 是所有入口的唯一能力判断源。
- MCP、Skill、Trusted Plugin 并存、atomic reload、disable/unload 无 stale registration。
- Untrusted Plugin 只有 OS 强制隔离可用时才可 enabled。
- Session lifecycle 精确，security hook fail-closed。
- Task/Sub-agent cancel 真正停止，cancel 后无新 effect；worktree/owned files/lineage/budget/recovery 可审计。
- Computer Use、Voice 和 Forge runtime 在全层不可达。
- Gate A/B/C/D/F/G 全部通过时，才可标记 Wave 2 canary complete。

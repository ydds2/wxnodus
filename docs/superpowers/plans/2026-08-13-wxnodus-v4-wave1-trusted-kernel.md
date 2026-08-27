# WxNodus V4 Wave 1 可信内核实施计划

> 日期：2026-08-13
> 前置：Wave 0 Gate A/B/C/F 通过
> Channel：internal
> Required Gates：A、B、C、D（可信内核）、F、G（内核 criteria）

## Goal

将 Gateway、Command、Memory、工具副作用、权限、预算和完成语义从 UI、文本正则及各入口的局部实现中抽出，形成可由 CLI/Wire/HTTP/TUI 共享的可信内核。Wave 1 完成后，输入解析、工具执行、Memory scope 和 Run 完成状态均由结构化协议控制；Voice、Computer、Forge 和 Distribution 必须保持不可达。

## Architecture

新增 `src/protocol/`、`src/application/`、`src/domain/`、`src/infrastructure/`、`src/bootstrap/`。旧 `src/kernel/` 和 `src/app/` 通过 compatibility adapter 逐步接入，不一次性重写。

## Tech Stack

TypeScript discriminated unions、AbortController、better-sqlite3 transaction/outbox、Node crypto、HTTP/SSE adapter、Vitest unit/property/contract/integration。

## Global Constraints

- Domain 不 import React、SQLite、Playwright、PowerShell 或模型 SDK。
- 任何错误控制流依赖稳定 code，不匹配中文或英文字符串。
- `AgentResult.ok`、Tool result 和 CompletionDecision 不复用同一布尔语义。
- 所有新增写操作带 `actorId/sessionId/runId/correlationId/policySnapshotId/timestamp`；允许无 run 的 session lifecycle 写入时，`runId` 显式为 `null`，不得省略审计字段。
- Wave 1 未迁移能力通过 CapabilityPort/CapabilityRegistry fence，不允许旧入口绕过。
- 新增协议和 Domain 类型只允许单一 owner；后续任务只能 import/实现既有 port，不得重声明同名 DTO。
- 时间一律为 UTC ISO-8601 字符串；测试使用注入 clock，不依赖墙钟和 `setTimeout()` 猜测。
- 安全拒绝、scope 拒绝、token 拒绝、命令解析、工具解析和 embedding fencing 必须断言稳定 error code。

## Dependency / Ownership Contract（顶部合同优先于后续任务局部 Files）

| Contract | 创建任务 | 精确 owner 文件 | 后续消费规则 |
|---|---|---|---|
| `GatewayError` / `OperationResult` / run status | W1-01 | `src/protocol/errors.ts`、`src/protocol/results.ts`、`src/protocol/runs.ts` | W1-02..11 只 import |
| `OperationContext` | W1-01 | `src/protocol/operationContext.ts` | W1-02..11 只 import，不得重声明 |
| lifecycle `GatewayEvent` envelope | W1-01 | `src/protocol/events.ts` | CLI/Wire/HTTP/TUI/Kernel 全部使用同一 envelope，不得创建 frontend 私有 lifecycle DTO |
| `GatewayPort` | W1-01 | `src/protocol/gateway.ts` | W1-03 实现 adapters |
| `CapabilityPort`、`CapabilitySnapshot`、capability stable codes | W1-02 | `src/domain/capabilities/capability.ts` | W1-11 **只实现** `src/application/capabilities/capabilityRegistry.ts`；不得再次创建 capability 类型文件。若 W1-11 局部 Files 仍列 `Create: src/domain/capabilities/capability.ts`，执行时必须按本顶部合同解释为 Consume，不得覆盖 |
| `EffectDescriptor` | W1-05 | `src/domain/effects/effectDescriptor.ts` | W1-07 只消费并创建 journal/PDP/budget；不得再次创建 effect descriptor。若 W1-07 局部 Files 重复列出，执行时以本顶部合同为准 |
| memory provenance / retention / ranking components | W1-06 | `src/domain/memory/memoryRepository.ts` | 后续 Tool pipeline 和 Evidence 只消费 |

### Global execution context

```ts
export interface OperationContext {
  actorId: string;
  sessionId: string;
  runId: string | null;
  correlationId: string;
  policySnapshotId: string;
  locale: string;
  source: 'cli' | 'wire' | 'http' | 'tui' | 'kernel' | 'worker';
  capabilities: readonly string[];
  timestamp: string;
}
```

### Lifecycle envelope contract

所有 `session.*`、`run.*`、`turn.*` lifecycle event 必须具有同一顶层 envelope：
`locale/source/capabilities/policySnapshotId/correlationId/timestamp` 均为 required；`session.start` 要求 `sessionId` 但允许 `runId` 缺省，`run.*` 要求 `sessionId+runId`，`turn.*` 要求 `sessionId+runId+turnId`。`secret` event 必须 `retention='audit'` 且声明 redaction；任何 adapter 不得在 payload 中复制这些 envelope 字段。

### Dependency floors（不新增 runtime dependency）

- Node `>=22.0.0 <23.0.0`（唯一支持范围；本计划、`package.json#engines.node`、CI/setup-node 和发布 Gate 必须逐字一致，不接受仅写 `>=22` 或浮动到 Node 23）；TypeScript `^5.5.4`；Vitest `^2.1.0`；better-sqlite3 `^11.3.0`；sqlite-vec `^0.1.6`。
- W1-01..06 只使用现有依赖和 Node built-ins：`node:crypto`、`node:http`、`node:https`、`node:net`、`node:tls`、`node:url`。
- HTTP TLS 最低 `TLSv1.2`；release mode 非 loopback 不存在明文降级开关。

### Exact `package.json` script mapping

下列每个新 script 都必须在对应任务的 `Files` 中列出 `Modify: package.json`，值逐字一致：

```json
{
  "scripts": {
    "typecheck:tests": "tsc -p tsconfig.tests.json --noEmit",
    "test:w1-01": "vitest run tests/wave1/w1-01-protocol.test.ts",
    "test:w1-02": "vitest run tests/wave1/w1-02-bootstrap.test.ts",
    "test:w1-03": "vitest run tests/wave1/w1-03-http-gateway-security.test.ts",
    "test:w1-04": "vitest run tests/wave1/w1-04-command-contract.test.ts",
    "test:w1-05": "vitest run tests/wave1/w1-05-tool-catalog.test.ts",
    "test:w1-06": "vitest run tests/wave1/w1-06-memory-durability.test.ts",
    "test:wave1:trusted-kernel": "vitest run tests/wave1/w1-01-protocol.test.ts tests/wave1/w1-02-bootstrap.test.ts tests/wave1/w1-03-http-gateway-security.test.ts tests/wave1/w1-04-command-contract.test.ts tests/wave1/w1-05-tool-catalog.test.ts tests/wave1/w1-06-memory-durability.test.ts",
    "memory:curate": "tsx scripts/memory-curator.ts"
  }
}
```

`tsconfig.tests.json` 由 W1-01 创建，精确内容：

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

---

## Task W1-01：GatewayError、OperationResult 与运行状态协议

**Requirements/Subprojects:** R01、R10、R12、R15；S1/S9

**Files（精确）**
- Create: `src/protocol/errors.ts`
- Create: `src/protocol/results.ts`
- Create: `src/protocol/runs.ts`
- Create: `src/protocol/operationContext.ts`
- Create: `src/protocol/events.ts`
- Create: `src/protocol/gateway.ts`
- Create: `tests/wave1/w1-01-protocol.test.ts`
- Create: `tsconfig.tests.json`
- Modify: `src/wxnodus-ui/gatewayTypes.ts`（仅 compatibility re-export；现有 response DTO 保留）
- Modify: `package.json`（只新增 `typecheck:tests`、`test:w1-01`；值必须与顶部 mapping 完全一致）

**Interfaces / stable codes**

```ts
export type GatewayErrorCode =
  | 'EVENT_TIMESTAMP_INVALID'
  | 'EVENT_LIFECYCLE_SESSION_REQUIRED'
  | 'EVENT_LIFECYCLE_RUN_REQUIRED'
  | 'EVENT_LIFECYCLE_TURN_REQUIRED'
  | 'EVENT_SECRET_REDACTION_REQUIRED'
  | 'EVENT_SECRET_RETENTION_REQUIRED'
  | 'GATEWAY_METHOD_UNSUPPORTED';

export interface GatewayError {
  code: GatewayErrorCode | (string & {});
  message: string;
  messageKey: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  causeId?: string;
}

export type OperationResult<T> =
  | { ok: true; value: T; evidenceIds?: string[] }
  | { ok: false; error: GatewayError; evidenceIds?: string[] };

export type RunFinalStatus =
  | 'succeeded' | 'failed' | 'blocked'
  | 'incomplete' | 'inconclusive' | 'cancelled';
```

lifecycle event 统一使用顶部 envelope；`message` 只用于展示，所有分支只看 `error.code`。

- [ ] **Step 1: 粘贴完整红测 `tests/wave1/w1-01-protocol.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { gatewayError } from '../../src/protocol/errors.js';
import { err, ok } from '../../src/protocol/results.js';
import { isRunFinalStatus } from '../../src/protocol/runs.js';
import { createGatewayEvent } from '../../src/protocol/events.js';

const baseEnvelope = {
  schemaVersion: 1 as const,
  producer: 'test.kernel',
  timestamp: '2026-08-13T00:00:00.000Z',
  locale: 'zh-CN',
  source: 'kernel' as const,
  capabilities: ['command', 'memory'] as const,
  policySnapshotId: 'policy-001',
  correlationId: 'corr-001',
  sensitivity: 'internal' as const,
  retention: 'session' as const,
};

describe('W1-01 stable result protocol', () => {
  it('branches on stable code even when localized message changes', () => {
    const zh = err(gatewayError('GATEWAY_METHOD_UNSUPPORTED', '不支持的方法', 'gateway.unsupported'));
    const en = err(gatewayError('GATEWAY_METHOD_UNSUPPORTED', 'Unsupported method', 'gateway.unsupported'));
    expect(zh.ok).toBe(false);
    expect(en.ok).toBe(false);
    if (!zh.ok && !en.ok) expect(zh.error.code).toBe(en.error.code);
  });

  it('does not treat OperationResult.ok as a RunFinalStatus', () => {
    const result = ok({ accepted: true });
    expect(result.ok).toBe(true);
    expect(isRunFinalStatus(String(result.ok))).toBe(false);
    expect(isRunFinalStatus('succeeded')).toBe(true);
  });
});

describe('W1-01 lifecycle envelope', () => {
  it('requires the same locale/source/capabilities/policy/correlation/timestamp envelope', () => {
    const event = createGatewayEvent({
      ...baseEnvelope,
      type: 'session.start',
      sessionId: 'session-001',
      payload: { restored: false },
    });
    expect(event.ok).toBe(true);
    if (event.ok) {
      expect(event.value).toMatchObject({
        locale: 'zh-CN',
        source: 'kernel',
        capabilities: ['command', 'memory'],
        policySnapshotId: 'policy-001',
        correlationId: 'corr-001',
        timestamp: '2026-08-13T00:00:00.000Z',
        sessionId: 'session-001',
      });
      expect(event.value).not.toHaveProperty('runId');
    }
  });

  it.each([
    ['session.start', {}, 'EVENT_LIFECYCLE_SESSION_REQUIRED'],
    ['run.start', { sessionId: 's1' }, 'EVENT_LIFECYCLE_RUN_REQUIRED'],
    ['turn.start', { sessionId: 's1', runId: 'r1' }, 'EVENT_LIFECYCLE_TURN_REQUIRED'],
  ] as const)('rejects invalid %s identity with a stable code', (type, ids, code) => {
    const result = createGatewayEvent({ ...baseEnvelope, ...ids, type, payload: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it('requires audit retention and explicit redaction for secret events', () => {
    const missingRedaction = createGatewayEvent({
      ...baseEnvelope,
      type: 'secret.request',
      sessionId: 's1',
      sensitivity: 'secret',
      retention: 'audit',
      payload: { requestId: 'secret-1' },
    });
    expect(missingRedaction.ok).toBe(false);
    if (!missingRedaction.ok) expect(missingRedaction.error.code).toBe('EVENT_SECRET_REDACTION_REQUIRED');

    const wrongRetention = createGatewayEvent({
      ...baseEnvelope,
      type: 'secret.request',
      sessionId: 's1',
      sensitivity: 'secret',
      retention: 'session',
      redaction: { strategy: 'drop', fields: ['payload.value'] },
      payload: { requestId: 'secret-1' },
    });
    expect(wrongRetention.ok).toBe(false);
    if (!wrongRetention.ok) expect(wrongRetention.error.code).toBe('EVENT_SECRET_RETENTION_REQUIRED');
  });

  it('rejects a non-ISO timestamp', () => {
    const result = createGatewayEvent({
      ...baseEnvelope,
      type: 'session.start',
      sessionId: 's1',
      timestamp: '08/13/2026',
      payload: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('EVENT_TIMESTAMP_INVALID');
  });
});
```

- [ ] **Step 2: 红测命令**

```powershell
npm.cmd run test:w1-01
npm.cmd run typecheck:tests
```

预期：FAIL，`src/protocol/*` 与 `tsconfig.tests.json` 尚不存在；失败不得来自测试发现错误。

- [ ] **Step 3: 粘贴最小实现（按注释分拆到精确文件）**

```ts
// src/protocol/errors.ts
export type GatewayErrorCode =
  | 'EVENT_TIMESTAMP_INVALID'
  | 'EVENT_LIFECYCLE_SESSION_REQUIRED'
  | 'EVENT_LIFECYCLE_RUN_REQUIRED'
  | 'EVENT_LIFECYCLE_TURN_REQUIRED'
  | 'EVENT_SECRET_REDACTION_REQUIRED'
  | 'EVENT_SECRET_RETENTION_REQUIRED'
  | 'GATEWAY_METHOD_UNSUPPORTED';

export interface GatewayError {
  code: GatewayErrorCode | (string & {});
  message: string;
  messageKey: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  causeId?: string;
}

export function gatewayError(
  code: GatewayError['code'],
  message: string,
  messageKey: string,
  options: Pick<GatewayError, 'retryable' | 'details' | 'causeId'> = { retryable: false },
): GatewayError {
  return { code, message, messageKey, retryable: options.retryable, details: options.details, causeId: options.causeId };
}

// src/protocol/results.ts
import type { GatewayError } from './errors.js';
export type OperationResult<T> =
  | { ok: true; value: T; evidenceIds?: string[] }
  | { ok: false; error: GatewayError; evidenceIds?: string[] };
export const ok = <T>(value: T, evidenceIds?: string[]): OperationResult<T> => ({ ok: true, value, evidenceIds });
export const err = <T = never>(error: GatewayError, evidenceIds?: string[]): OperationResult<T> => ({ ok: false, error, evidenceIds });

// src/protocol/runs.ts
export const RUN_FINAL_STATUSES = ['succeeded', 'failed', 'blocked', 'incomplete', 'inconclusive', 'cancelled'] as const;
export type RunFinalStatus = (typeof RUN_FINAL_STATUSES)[number];
export function isRunFinalStatus(value: string): value is RunFinalStatus {
  return (RUN_FINAL_STATUSES as readonly string[]).includes(value);
}

// src/protocol/operationContext.ts
import type { GatewayEventSource } from './events.js';
export interface OperationContext {
  actorId: string;
  sessionId: string;
  runId: string | null;
  correlationId: string;
  policySnapshotId: string;
  locale: string;
  source: GatewayEventSource;
  capabilities: readonly string[];
  timestamp: string;
}

// src/protocol/events.ts
import { gatewayError } from './errors.js';
import { err, ok, type OperationResult } from './results.js';
export type GatewayEventSource = 'cli' | 'wire' | 'http' | 'tui' | 'kernel' | 'worker';
export interface EventRedaction { strategy: 'drop' | 'mask' | 'hash'; fields: readonly string[] }
export interface GatewayEvent<T = unknown> {
  schemaVersion: 1;
  type: string;
  producer: string;
  timestamp: string;
  locale: string;
  source: GatewayEventSource;
  capabilities: readonly string[];
  policySnapshotId: string;
  correlationId: string;
  sensitivity: 'public' | 'internal' | 'secret';
  retention: 'ephemeral' | 'session' | 'audit';
  redaction?: EventRedaction;
  sessionId?: string;
  runId?: string;
  turnId?: string;
  payload: T;
}
export type GatewayEventInput<T> = GatewayEvent<T>;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export function createGatewayEvent<T>(input: GatewayEventInput<T>): OperationResult<GatewayEvent<T>> {
  if (!ISO_UTC.test(input.timestamp) || Number.isNaN(Date.parse(input.timestamp))) {
    return err(gatewayError('EVENT_TIMESTAMP_INVALID', '事件时间必须是 UTC ISO-8601', 'event.timestamp.invalid'));
  }
  if (/^(session|run|turn)\./.test(input.type) && !input.sessionId) {
    return err(gatewayError('EVENT_LIFECYCLE_SESSION_REQUIRED', '生命周期事件缺少 sessionId', 'event.lifecycle.session_required'));
  }
  if (/^(run|turn)\./.test(input.type) && !input.runId) {
    return err(gatewayError('EVENT_LIFECYCLE_RUN_REQUIRED', '运行事件缺少 runId', 'event.lifecycle.run_required'));
  }
  if (/^turn\./.test(input.type) && !input.turnId) {
    return err(gatewayError('EVENT_LIFECYCLE_TURN_REQUIRED', '轮次事件缺少 turnId', 'event.lifecycle.turn_required'));
  }
  if (input.sensitivity === 'secret' && !input.redaction?.fields.length) {
    return err(gatewayError('EVENT_SECRET_REDACTION_REQUIRED', 'secret 事件必须声明 redaction', 'event.secret.redaction_required'));
  }
  if (input.sensitivity === 'secret' && input.retention !== 'audit') {
    return err(gatewayError('EVENT_SECRET_RETENTION_REQUIRED', 'secret 事件必须使用 audit retention', 'event.secret.retention_required'));
  }
  return ok(Object.freeze({ ...input, capabilities: Object.freeze([...input.capabilities]) }));
}

// src/protocol/gateway.ts
import type { GatewayEvent } from './events.js';
import type { OperationResult } from './results.js';
export interface GatewayRequestOptions { signal?: AbortSignal; correlationId?: string }
export interface GatewayMethodMap { [method: string]: { params: unknown; value: unknown } }
export interface GatewayPort<M extends GatewayMethodMap = GatewayMethodMap> {
  request<K extends keyof M & string>(method: K, params: M[K]['params'], options?: GatewayRequestOptions): Promise<OperationResult<M[K]['value']>>;
  subscribe(handler: (event: GatewayEvent) => void): () => void;
}
```

同时将以下 compatibility exports 加到 `src/wxnodus-ui/gatewayTypes.ts` 顶部，现有 DTO 不删除：

```ts
export type { GatewayError } from '../protocol/errors.js';
export type { OperationResult } from '../protocol/results.js';
export type { RunFinalStatus } from '../protocol/runs.js';
export type { GatewayEvent as ProtocolGatewayEvent } from '../protocol/events.js';
```

- [ ] **Step 4: 绿测命令**

```powershell
npm.cmd run test:w1-01
npm.cmd run typecheck:tests
npm.cmd exec -- vitest run tests/kernel-gateway.test.ts
```

预期：PASS；compatibility re-export 不改变旧 `GatewayEvent` union 的运行行为。

**Commit（仅供后续执行者；本次不提交）**

```text
core: define stable result and lifecycle protocols
```

---

## Task W1-02：Application Services、CapabilityPort 与可回收组合根

**Requirements/Subprojects:** R01、R11、R12；S1

**Files（精确）**
- Create: `src/application/sessionService.ts`
- Create: `src/application/promptService.ts`
- Create: `src/application/commandService.ts`
- Create: `src/application/memoryService.ts`
- Create: `src/application/applicationServices.ts`
- Create: `src/domain/capabilities/capability.ts`（**本任务创建 CapabilityPort；W1-11 只实现 registry**）
- Create: `src/bootstrap/bootstrapTypes.ts`
- Create: `src/bootstrap/bootstrapConfig.ts`
- Create: `src/bootstrap/bootstrapRepositories.ts`
- Create: `src/bootstrap/bootstrapKernel.ts`
- Create: `src/bootstrap/bootstrapExtensions.ts`
- Create: `src/bootstrap/bootstrapPresentation.ts`
- Create: `src/bootstrap/bootstrapShutdown.ts`
- Create: `src/bootstrap/createApplication.ts`
- Create: `tests/wave1/w1-02-bootstrap.test.ts`
- Modify: `src/cli/index.ts`（仅保留 pre-bootstrap args、phase implementation 装配、frontend 选择和 finally shutdown）
- Modify: `package.json`（只新增 `test:w1-02`；值与顶部 mapping 完全一致）

**Interfaces / stable codes**

```ts
export type CapabilityId = 'command' | 'memory' | 'offline-model' | 'voice' | 'computer' | 'forge' | 'distribution';
export interface CapabilitySnapshot {
  id: string;
  policySnapshotId: string;
  generatedAt: string;
  states: Readonly<Record<CapabilityId, 'available' | 'unavailable'>>;
}
export interface CapabilityPort {
  snapshot(): CapabilitySnapshot;
  require(id: CapabilityId): OperationResult<{ id: CapabilityId; snapshotId: string }>;
}
export interface ApplicationInstance {
  services: ApplicationServices;
  gateway: GatewayPort;
  capabilities: CapabilityPort;
  shutdown(reason: string): Promise<void>;
}
```

稳定 code：`CAPABILITY_UNAVAILABLE`、`BOOTSTRAP_PHASE_FAILED`、`BOOTSTRAP_INCOMPLETE`。组合顺序固定为 `config → repositories → kernel → extensions → presentation`，失败后只 dispose 已成功启动的资源，严格逆序；shutdown 幂等。

- [ ] **Step 1: 粘贴完整红测 `tests/wave1/w1-02-bootstrap.test.ts`**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApplication } from '../../src/bootstrap/createApplication.js';
import type { BootstrapOptions, BootstrapPhase, BootstrapState } from '../../src/bootstrap/bootstrapTypes.js';
import { capabilityUnavailable, type CapabilityPort } from '../../src/domain/capabilities/capability.js';
import { gatewayError } from '../../src/protocol/errors.js';
import { err, ok } from '../../src/protocol/results.js';

const services = {
  sessions: { open: async () => ok({ sessionId: 's1' }) },
  prompts: { submit: async () => ok({ runId: 'r1' }) },
  commands: { execute: async () => ok({ output: '' }) },
  memory: { search: async () => ok([]) },
};
const gateway = { request: async () => ok({}), subscribe: () => () => undefined };
const capabilities: CapabilityPort = {
  snapshot: () => ({
    id: 'caps-1',
    policySnapshotId: 'policy-1',
    generatedAt: '2026-08-13T00:00:00.000Z',
    states: { command: 'available', memory: 'available', 'offline-model': 'available', voice: 'unavailable', computer: 'unavailable', forge: 'unavailable', distribution: 'unavailable' },
  }),
  require(id) {
    return this.snapshot().states[id] === 'available'
      ? ok({ id, snapshotId: this.snapshot().id })
      : capabilityUnavailable(id, this.snapshot().id);
  },
};

function phase(
  name: string,
  order: string[],
  disposed: string[],
  patch: Partial<BootstrapState> = {},
): BootstrapPhase {
  return async () => {
    order.push(name);
    return ok({
      patch,
      resources: [{ id: name, dispose: async () => { disposed.push(name); } }],
    });
  };
}

function options(order: string[], disposed: string[]): BootstrapOptions {
  return {
    headless: true,
    phases: {
      config: phase('config', order, disposed),
      repositories: phase('repositories', order, disposed),
      kernel: phase('kernel', order, disposed, { services: services as never, gateway: gateway as never, capabilities }),
      extensions: phase('extensions', order, disposed),
      presentation: phase('presentation', order, disposed),
    },
  };
}

describe('W1-02 bootstrap lifecycle', () => {
  it('runs fixed phases and shuts resources down once in reverse order', async () => {
    const order: string[] = [];
    const disposed: string[] = [];
    const result = await createApplication(options(order, disposed));
    expect(result.ok).toBe(true);
    expect(order).toEqual(['config', 'repositories', 'kernel', 'extensions', 'presentation']);
    if (!result.ok) return;
    await result.value.shutdown('test-complete');
    await result.value.shutdown('duplicate');
    expect(disposed).toEqual(['presentation', 'extensions', 'kernel', 'repositories', 'config']);
  });

  it('disposes only started resources when a phase fails and preserves the stable cause code', async () => {
    const order: string[] = [];
    const disposed: string[] = [];
    const opts = options(order, disposed);
    opts.phases.kernel = async () => {
      order.push('kernel');
      return err(gatewayError('REPOSITORY_OPEN_FAILED', '数据库打不开', 'repository.open_failed'));
    };
    const result = await createApplication(opts);
    expect(result.ok).toBe(false);
    expect(order).toEqual(['config', 'repositories', 'kernel']);
    expect(disposed).toEqual(['repositories', 'config']);
    if (!result.ok) {
      expect(result.error.code).toBe('BOOTSTRAP_PHASE_FAILED');
      expect(result.error.details).toMatchObject({ phase: 'kernel', causeCode: 'REPOSITORY_OPEN_FAILED' });
    }
  });

  it('exposes CapabilityPort now and returns a stable unavailable code', () => {
    const result = capabilities.require('voice');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CAPABILITY_UNAVAILABLE');
  });

  it('keeps headless application/bootstrap/domain sources free of React and Ink imports', () => {
    const root = process.cwd();
    const files = [
      'src/application/applicationServices.ts',
      'src/bootstrap/bootstrapTypes.ts',
      'src/bootstrap/createApplication.ts',
      'src/domain/capabilities/capability.ts',
    ];
    for (const file of files) {
      const source = readFileSync(join(root, file), 'utf8');
      expect(source).not.toMatch(/from ['"](?:react|ink|@wxnodus\/ink)/);
      expect(source).not.toMatch(/src\/infrastructure|\.\.\/infrastructure/);
    }
  });
});
```

- [ ] **Step 2: 红测命令**

```powershell
npm.cmd run test:w1-02
```

预期：FAIL，application/bootstrap/capability ports 尚不存在。

- [ ] **Step 3: 粘贴最小实现（按注释分拆到精确文件）**

```ts
// src/application/sessionService.ts
import type { OperationResult } from '../protocol/results.js';
export interface SessionService { open(input: { sessionId?: string }): Promise<OperationResult<{ sessionId: string }>> }

// src/application/promptService.ts
import type { OperationResult } from '../protocol/results.js';
export interface PromptService { submit(input: { sessionId: string; text: string }): Promise<OperationResult<{ runId: string }>> }

// src/application/commandService.ts
import type { OperationResult } from '../protocol/results.js';
export interface CommandService { execute(input: { raw: string; sessionId: string }): Promise<OperationResult<{ output: string }>> }

// src/application/memoryService.ts
import type { OperationResult } from '../protocol/results.js';
export interface MemoryService { search(input: { query: string; sessionId: string }): Promise<OperationResult<readonly unknown[]>> }

// src/application/applicationServices.ts
import type { CommandService } from './commandService.js';
import type { MemoryService } from './memoryService.js';
import type { PromptService } from './promptService.js';
import type { SessionService } from './sessionService.js';
export interface ApplicationServices { sessions: SessionService; prompts: PromptService; commands: CommandService; memory: MemoryService }

// src/domain/capabilities/capability.ts
import { gatewayError } from '../../protocol/errors.js';
import { err, type OperationResult } from '../../protocol/results.js';
export type CapabilityId = 'command' | 'memory' | 'offline-model' | 'voice' | 'computer' | 'forge' | 'distribution';
export interface CapabilitySnapshot {
  id: string;
  policySnapshotId: string;
  generatedAt: string;
  states: Readonly<Record<CapabilityId, 'available' | 'unavailable'>>;
}
export interface CapabilityPort {
  snapshot(): CapabilitySnapshot;
  require(id: CapabilityId): OperationResult<{ id: CapabilityId; snapshotId: string }>;
}
export function capabilityUnavailable(id: CapabilityId, snapshotId: string): OperationResult<never> {
  return err(gatewayError('CAPABILITY_UNAVAILABLE', `能力不可用：${id}`, 'capability.unavailable', {
    retryable: false,
    details: { capabilityId: id, snapshotId },
  }));
}

// src/bootstrap/bootstrapTypes.ts
import type { ApplicationServices } from '../application/applicationServices.js';
import type { CapabilityPort } from '../domain/capabilities/capability.js';
import type { GatewayPort } from '../protocol/gateway.js';
import type { OperationResult } from '../protocol/results.js';
export type BootstrapPhaseName = 'config' | 'repositories' | 'kernel' | 'extensions' | 'presentation';
export interface BootstrapResource { id: string; dispose(reason: string): void | Promise<void> }
export interface BootstrapState {
  config?: unknown;
  repositories?: unknown;
  services?: ApplicationServices;
  gateway?: GatewayPort;
  capabilities?: CapabilityPort;
  extensions?: unknown;
  presentation?: unknown;
}
export interface BootstrapPhaseOutput { patch?: Partial<BootstrapState>; resources?: BootstrapResource[] }
export type BootstrapPhase = (state: Readonly<BootstrapState>) => Promise<OperationResult<BootstrapPhaseOutput>>;
export interface BootstrapOptions {
  headless: boolean;
  phases: Record<BootstrapPhaseName, BootstrapPhase>;
}
export interface ApplicationInstance {
  services: ApplicationServices;
  gateway: GatewayPort;
  capabilities: CapabilityPort;
  shutdown(reason: string): Promise<void>;
}

// src/bootstrap/bootstrapConfig.ts
import type { BootstrapPhase } from './bootstrapTypes.js';
export const bootstrapConfig = (phase: BootstrapPhase): BootstrapPhase => phase;
// src/bootstrap/bootstrapRepositories.ts
import type { BootstrapPhase } from './bootstrapTypes.js';
export const bootstrapRepositories = (phase: BootstrapPhase): BootstrapPhase => phase;
// src/bootstrap/bootstrapKernel.ts
import type { BootstrapPhase } from './bootstrapTypes.js';
export const bootstrapKernel = (phase: BootstrapPhase): BootstrapPhase => phase;
// src/bootstrap/bootstrapExtensions.ts
import type { BootstrapPhase } from './bootstrapTypes.js';
export const bootstrapExtensions = (phase: BootstrapPhase): BootstrapPhase => phase;
// src/bootstrap/bootstrapPresentation.ts
import type { BootstrapPhase } from './bootstrapTypes.js';
export const bootstrapPresentation = (phase: BootstrapPhase): BootstrapPhase => phase;

// src/bootstrap/bootstrapShutdown.ts
import type { BootstrapResource } from './bootstrapTypes.js';
export function createShutdown(resources: BootstrapResource[]): (reason: string) => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;
  return async (reason: string) => {
    shutdownPromise ??= (async () => {
      for (const resource of [...resources].reverse()) await resource.dispose(reason);
    })();
    await shutdownPromise;
  };
}

// src/bootstrap/createApplication.ts
import { bootstrapConfig } from './bootstrapConfig.js';
import { bootstrapExtensions } from './bootstrapExtensions.js';
import { bootstrapKernel } from './bootstrapKernel.js';
import { bootstrapPresentation } from './bootstrapPresentation.js';
import { bootstrapRepositories } from './bootstrapRepositories.js';
import { createShutdown } from './bootstrapShutdown.js';
import type { ApplicationInstance, BootstrapOptions, BootstrapPhaseName, BootstrapResource, BootstrapState } from './bootstrapTypes.js';
import { gatewayError } from '../protocol/errors.js';
import { err, ok, type OperationResult } from '../protocol/results.js';
const ORDER: BootstrapPhaseName[] = ['config', 'repositories', 'kernel', 'extensions', 'presentation'];
export async function createApplication(options: BootstrapOptions): Promise<OperationResult<ApplicationInstance>> {
  const state: BootstrapState = {};
  const resources: BootstrapResource[] = [];
  const phases = {
    config: bootstrapConfig(options.phases.config),
    repositories: bootstrapRepositories(options.phases.repositories),
    kernel: bootstrapKernel(options.phases.kernel),
    extensions: bootstrapExtensions(options.phases.extensions),
    presentation: bootstrapPresentation(options.phases.presentation),
  };
  for (const name of ORDER) {
    const result = await phases[name](Object.freeze({ ...state }));
    if (!result.ok) {
      await createShutdown(resources)(`bootstrap:${name}:failed`);
      return err(gatewayError('BOOTSTRAP_PHASE_FAILED', `启动阶段失败：${name}`, 'bootstrap.phase_failed', {
        retryable: result.error.retryable,
        causeId: result.error.causeId,
        details: { phase: name, causeCode: result.error.code },
      }));
    }
    Object.assign(state, result.value.patch ?? {});
    resources.push(...(result.value.resources ?? []));
  }
  if (!state.services || !state.gateway || !state.capabilities) {
    await createShutdown(resources)('bootstrap:incomplete');
    return err(gatewayError('BOOTSTRAP_INCOMPLETE', '组合根缺少必要端口', 'bootstrap.incomplete'));
  }
  return ok({ services: state.services, gateway: state.gateway, capabilities: state.capabilities, shutdown: createShutdown(resources) });
}
```

`src/cli/index.ts` 的迁移必须保持现有 CLI 行为，但对象创建改为上述五个 phase implementation；`finally` 中只调用一次 `application.shutdown(reason)`。Presentation phase 必须在 `headless=true` 时动态跳过 React/Ink import。

- [ ] **Step 4: 绿测命令**

```powershell
npm.cmd run test:w1-02
npm.cmd run typecheck:tests
npm.cmd exec -- vitest run tests/app-layer.test.ts
```

预期：PASS；任何 phase failure 都不泄露 DB/process/subscription。

**Commit（仅供后续执行者；本次不提交）**

```text
core: introduce application services capability port and bootstrap phases
```

---

## Task W1-03：统一 Gateway adapters 与安全 HTTP/Wire

**Requirements/Subprojects:** R01、R11、R12；S1；Gate D/F

**Files（精确）**
- Create: `src/application/gatewayService.ts`
- Create: `src/presentation/shared/inProcessAdapter.ts`
- Create: `src/presentation/cli/cliGatewayAdapter.ts`
- Create: `src/presentation/wire/wireGatewayAdapter.ts`
- Create: `src/presentation/http/httpSecurity.ts`
- Create: `src/presentation/http/httpTokenStore.ts`
- Create: `src/presentation/http/httpSessionIsolation.ts`
- Create: `src/presentation/http/httpGatewayAdapter.ts`
- Create: `src/presentation/tui/inProcessGatewayAdapter.ts`
- Create: `tests/wave1/w1-03-http-gateway-security.test.ts`
- Modify: `src/cli/serve.ts`（删除 `Access-Control-Allow-Origin: *`，只作为 HTTPS/HTTP server host，RPC 委托 HttpGatewayAdapter）
- Modify: `src/wxnodus-ui/wxGateway.ts`（委托 GatewayService）
- Modify: `src/wxnodus-ui/gatewayClient.ts`（消费统一 OperationResult/event envelope）
- Modify: `src/wxnodus-ui/bridge/interfaces.ts`（引用 GatewayPort）
- Modify: `src/cli/index.ts`（选择 adapter，不再创建第二套 `/gateway` server）
- Modify: `package.json`（只新增 `test:w1-03`；值与顶部 mapping 完全一致）

**Security contract / stable codes**

- bind 默认 `127.0.0.1`；release mode 下非 loopback 若无 TLS，bootstrap 立即返回 `HTTP_PLAINTEXT_NON_LOOPBACK_BLOCKED`，不得先 listen 再警告。
- TLS `minVersion` 固定至少 `TLSv1.2`；握手事实低于 1.2 返回 `HTTP_TLS_VERSION_UNSUPPORTED`；配置证书必须经系统 trust 或 pinned fingerprint 验证，否则 `HTTP_CERTIFICATE_UNTRUSTED`。
- Host 与 Origin 分别精确 allowlist；Origin 缺省可用于非浏览器客户端，但存在时必须命中；CORS 只回显已允许 Origin，永不 `*`。
- 仅当 TCP peer 命中 `trustedProxyCidrs` 才接受 `Forwarded`/`X-Forwarded-*`；其他 peer 只要携带任一 forwarded header 就返回 `HTTP_UNTRUSTED_FORWARDED_HEADER`。
- Bearer token 使用 SHA-256 hash 存储，支持 `notBefore/expiresAt`、graceful rotation、即时 revocation；稳定 code 为 `HTTP_TOKEN_MISSING`、`HTTP_TOKEN_INVALID`、`HTTP_TOKEN_EXPIRED`、`HTTP_TOKEN_REVOKED`。
- token subject 即 client identity；session ownership 绑定 subject，跨 client session 返回 `HTTP_SESSION_CROSS_CLIENT`。任何 body/query 中的 client id 都不可信。
- `/gateway` 和旧 `/rpc` 不得各自持有独立 Agent/Memory/Session；兼容 `/rpc` 只能 translate 后委托同一 HttpGatewayAdapter。

- [ ] **Step 1: 粘贴完整红测 `tests/wave1/w1-03-http-gateway-security.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import type { GatewayService, GatewayServiceRequest } from '../../src/application/gatewayService.js';
import { createCliGatewayAdapter } from '../../src/presentation/cli/cliGatewayAdapter.js';
import { createHttpGatewayAdapter } from '../../src/presentation/http/httpGatewayAdapter.js';
import { createHttpSessionIsolation } from '../../src/presentation/http/httpSessionIsolation.js';
import { createHttpTokenStore } from '../../src/presentation/http/httpTokenStore.js';
import { createInProcessGatewayAdapter } from '../../src/presentation/tui/inProcessGatewayAdapter.js';
import { createWireGatewayAdapter } from '../../src/presentation/wire/wireGatewayAdapter.js';
import { gatewayError } from '../../src/protocol/errors.js';
import { err, ok } from '../../src/protocol/results.js';

const NOW = Date.parse('2026-08-13T00:00:00.000Z');
const FUTURE = '2026-08-14T00:00:00.000Z';
const requestLog: GatewayServiceRequest[] = [];
const service: GatewayService = {
  async request(request) {
    requestLog.push(request);
    if (request.method === 'blocked') return err(gatewayError('POLICY_DENIED', '策略拒绝', 'policy.denied'));
    return ok({ method: request.method, sessionId: request.sessionId, source: request.source });
  },
  subscribe: () => () => undefined,
};

function tokenStore() {
  return createHttpTokenStore([{
    id: 'token-a-v1',
    subject: 'client-a',
    secret: 'secret-a-v1',
    notBefore: '2026-08-12T00:00:00.000Z',
    expiresAt: FUTURE,
  }]);
}

function secureConfig(overrides: Record<string, unknown> = {}) {
  return {
    bindHost: '0.0.0.0',
    releaseMode: true,
    hostAllowlist: ['gateway.example.test'],
    originAllowlist: ['https://app.example.test'],
    trustedProxyCidrs: ['10.0.0.0/8'],
    tls: { minVersion: 'TLSv1.2' as const, certificateTrust: 'system' as const },
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    method: 'prompt.submit',
    params: { sessionId: 'session-a', text: 'hello' },
    headers: {
      authorization: 'Bearer secret-a-v1',
      host: 'gateway.example.test',
      origin: 'https://app.example.test',
    },
    peerAddress: '203.0.113.7',
    transport: { encrypted: true, tlsVersion: 'TLSv1.3', certificateTrusted: true },
    correlationId: 'corr-http-1',
    ...overrides,
  };
}

describe('W1-03 HTTP bootstrap and transport security', () => {
  it('blocks release-mode plaintext on any non-loopback bind before listen', () => {
    const created = createHttpGatewayAdapter(service, {
      ...secureConfig({ tls: undefined }),
      tokens: tokenStore(),
      sessions: createHttpSessionIsolation(),
      now: () => NOW,
    });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error.code).toBe('HTTP_PLAINTEXT_NON_LOOPBACK_BLOCKED');
  });

  it.each([
    [{ transport: { encrypted: true, tlsVersion: 'TLSv1.1', certificateTrusted: true } }, 'HTTP_TLS_VERSION_UNSUPPORTED'],
    [{ transport: { encrypted: true, tlsVersion: 'TLSv1.3', certificateTrusted: false } }, 'HTTP_CERTIFICATE_UNTRUSTED'],
    [{ headers: { authorization: 'Bearer secret-a-v1', host: 'evil.test', origin: 'https://app.example.test' } }, 'HTTP_HOST_NOT_ALLOWED'],
    [{ headers: { authorization: 'Bearer secret-a-v1', host: 'gateway.example.test', origin: 'https://evil.test' } }, 'HTTP_ORIGIN_NOT_ALLOWED'],
    [{ headers: { host: 'gateway.example.test', origin: 'https://app.example.test' } }, 'HTTP_TOKEN_MISSING'],
    [{ headers: { authorization: 'Bearer wrong', host: 'gateway.example.test', origin: 'https://app.example.test' } }, 'HTTP_TOKEN_INVALID'],
  ] as const)('rejects request facts with stable code %s', async (override, code) => {
    const created = createHttpGatewayAdapter(service, {
      ...secureConfig(), tokens: tokenStore(), sessions: createHttpSessionIsolation(), now: () => NOW,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const response = await created.value.request(request(override));
    expect(response.result.ok).toBe(false);
    if (!response.result.ok) expect(response.result.error.code).toBe(code);
    expect(response.corsOrigin).not.toBe('*');
  });

  it('rejects forwarded headers from an untrusted peer and accepts them only from a trusted CIDR', async () => {
    const created = createHttpGatewayAdapter(service, {
      ...secureConfig(), tokens: tokenStore(), sessions: createHttpSessionIsolation(), now: () => NOW,
    });
    if (!created.ok) throw new Error(created.error.code);
    const headers = {
      authorization: 'Bearer secret-a-v1',
      host: 'gateway.example.test',
      origin: 'https://app.example.test',
      'x-forwarded-for': '198.51.100.20',
      'x-forwarded-proto': 'https',
    };
    const rejected = await created.value.request(request({ headers, peerAddress: '203.0.113.7' }));
    expect(rejected.result.ok).toBe(false);
    if (!rejected.result.ok) expect(rejected.result.error.code).toBe('HTTP_UNTRUSTED_FORWARDED_HEADER');

    created.value.bindSession('client-a', 'session-a');
    const accepted = await created.value.request(request({ headers, peerAddress: '10.2.3.4' }));
    expect(accepted.result.ok).toBe(true);
    expect(accepted.clientIp).toBe('198.51.100.20');
    expect(accepted.corsOrigin).toBe('https://app.example.test');
  });
});

describe('W1-03 token lifecycle and client isolation', () => {
  it('supports grace rotation, expiry, and immediate revocation', () => {
    const store = tokenStore();
    expect(store.verify('secret-a-v1', NOW).ok).toBe(true);
    store.rotate('client-a', {
      id: 'token-a-v2', subject: 'client-a', secret: 'secret-a-v2',
      notBefore: '2026-08-13T00:00:00.000Z', expiresAt: FUTURE,
    }, '2026-08-13T00:05:00.000Z');
    expect(store.verify('secret-a-v1', NOW + 60_000).ok).toBe(true);
    expect(store.verify('secret-a-v2', NOW + 60_000).ok).toBe(true);
    const expired = store.verify('secret-a-v1', NOW + 6 * 60_000);
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.error.code).toBe('HTTP_TOKEN_EXPIRED');
    store.revoke('token-a-v2', '2026-08-13T00:07:00.000Z');
    const revoked = store.verify('secret-a-v2', NOW + 8 * 60_000);
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.error.code).toBe('HTTP_TOKEN_REVOKED');
  });

  it('prevents one token subject from accessing another client session', async () => {
    const store = tokenStore();
    store.rotate('client-b', {
      id: 'token-b-v1', subject: 'client-b', secret: 'secret-b-v1',
      notBefore: '2026-08-12T00:00:00.000Z', expiresAt: FUTURE,
    }, '2026-08-13T00:00:00.000Z');
    const created = createHttpGatewayAdapter(service, {
      ...secureConfig(), tokens: store, sessions: createHttpSessionIsolation(), now: () => NOW,
    });
    if (!created.ok) throw new Error(created.error.code);
    created.value.bindSession('client-a', 'session-a');
    created.value.bindSession('client-b', 'session-b');
    const crossed = await created.value.request(request({
      params: { sessionId: 'session-a', text: 'steal' },
      headers: { authorization: 'Bearer secret-b-v1', host: 'gateway.example.test' },
    }));
    expect(crossed.result.ok).toBe(false);
    if (!crossed.result.ok) expect(crossed.result.error.code).toBe('HTTP_SESSION_CROSS_CLIENT');
  });
});

describe('W1-03 shared adapters and restored session', () => {
  it('delegates CLI/TUI/Wire through one service and keeps a restored session', async () => {
    requestLog.length = 0;
    const cli = createCliGatewayAdapter(service, 'restored-session');
    const tui = createInProcessGatewayAdapter(service, 'restored-session');
    const wire = createWireGatewayAdapter(service, 'restored-session');
    const beforeReady = wire.connectApproval(() => undefined);
    expect(beforeReady.ok).toBe(false);
    if (!beforeReady.ok) expect(beforeReady.error.code).toBe('WIRE_GATEWAY_NOT_READY');
    wire.markReady();
    expect(wire.connectApproval(() => undefined).ok).toBe(true);
    await cli.request('blocked', {});
    await tui.request('blocked', {});
    await wire.request('blocked', {});
    expect(requestLog.map(x => x.sessionId)).toEqual(['restored-session', 'restored-session', 'restored-session']);
    expect(requestLog.map(x => x.source)).toEqual(['cli', 'tui', 'wire']);
  });
});
```

- [ ] **Step 2: 红测命令**

```powershell
npm.cmd run test:w1-03
```

预期：FAIL，统一 adapters、HTTP policy、token store 和 session isolation 尚不存在；旧 `serve.ts` 仍返回 CORS `*`。

- [ ] **Step 3: 粘贴最小实现（按注释分拆到精确文件）**

```ts
// src/application/gatewayService.ts
import type { GatewayEventSource } from '../protocol/events.js';
import type { OperationResult } from '../protocol/results.js';
export interface GatewayServiceRequest {
  method: string;
  params: Record<string, unknown>;
  sessionId: string;
  source: GatewayEventSource;
  correlationId: string;
  signal?: AbortSignal;
}
export interface GatewayService {
  request(request: GatewayServiceRequest): Promise<OperationResult<unknown>>;
  subscribe(handler: (event: import('../protocol/events.js').GatewayEvent) => void): () => void;
}

// src/presentation/shared/inProcessAdapter.ts
import { randomUUID } from 'node:crypto';
import type { GatewayService } from '../../application/gatewayService.js';
import type { GatewayEventSource } from '../../protocol/events.js';
export function createSharedAdapter(service: GatewayService, source: GatewayEventSource, restoredSessionId: string) {
  let sessionId = restoredSessionId;
  return {
    bindSession(next: string) { sessionId = next; },
    request(method: string, params: Record<string, unknown>, options: { signal?: AbortSignal; correlationId?: string } = {}) {
      return service.request({ method, params, sessionId, source, signal: options.signal, correlationId: options.correlationId ?? randomUUID() });
    },
    subscribe: service.subscribe,
  };
}

// src/presentation/cli/cliGatewayAdapter.ts
import type { GatewayService } from '../../application/gatewayService.js';
import { createSharedAdapter } from '../shared/inProcessAdapter.js';
export const createCliGatewayAdapter = (service: GatewayService, sessionId: string) => createSharedAdapter(service, 'cli', sessionId);

// src/presentation/tui/inProcessGatewayAdapter.ts
import type { GatewayService } from '../../application/gatewayService.js';
import { createSharedAdapter } from '../shared/inProcessAdapter.js';
export const createInProcessGatewayAdapter = (service: GatewayService, sessionId: string) => createSharedAdapter(service, 'tui', sessionId);

// src/presentation/wire/wireGatewayAdapter.ts
import type { GatewayService } from '../../application/gatewayService.js';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';
import { createSharedAdapter } from '../shared/inProcessAdapter.js';
export function createWireGatewayAdapter(service: GatewayService, sessionId: string) {
  let ready = false;
  return {
    ...createSharedAdapter(service, 'wire', sessionId),
    markReady() { ready = true; },
    connectApproval(_handler: (input: unknown) => void) {
      return ready ? ok(undefined) : err(gatewayError('WIRE_GATEWAY_NOT_READY', 'Wire Gateway 尚未 ready', 'wire.gateway.not_ready'));
    },
  };
}

// src/presentation/http/httpTokenStore.ts
import { createHash, timingSafeEqual } from 'node:crypto';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';
export interface HttpTokenInput { id: string; subject: string; secret: string; notBefore: string; expiresAt: string }
interface TokenRecord extends Omit<HttpTokenInput, 'secret'> { hash: Buffer; revokedAt?: string; retireAt?: string }
export interface VerifiedToken { id: string; subject: string }
const digest = (secret: string) => createHash('sha256').update(secret, 'utf8').digest();
export function createHttpTokenStore(initial: HttpTokenInput[]) {
  const records = new Map(initial.map(input => [input.id, { ...input, secret: undefined, hash: digest(input.secret) } as TokenRecord]));
  return {
    verify(secret: string, nowMs: number): OperationResult<VerifiedToken> {
      const hash = digest(secret);
      const record = [...records.values()].find(item => timingSafeEqual(item.hash, hash));
      if (!record) return err(gatewayError('HTTP_TOKEN_INVALID', 'Bearer token 无效', 'http.token.invalid'));
      if (record.revokedAt && nowMs >= Date.parse(record.revokedAt)) return err(gatewayError('HTTP_TOKEN_REVOKED', 'Bearer token 已撤销', 'http.token.revoked'));
      if (nowMs < Date.parse(record.notBefore) || nowMs >= Date.parse(record.retireAt ?? record.expiresAt)) return err(gatewayError('HTTP_TOKEN_EXPIRED', 'Bearer token 不在有效期', 'http.token.expired'));
      return ok({ id: record.id, subject: record.subject });
    },
    rotate(subject: string, next: HttpTokenInput, graceUntil: string) {
      for (const record of records.values()) if (record.subject === subject && !record.revokedAt) record.retireAt = graceUntil;
      records.set(next.id, { ...next, secret: undefined, hash: digest(next.secret) } as TokenRecord);
    },
    revoke(id: string, revokedAt: string) { const record = records.get(id); if (record) record.revokedAt = revokedAt; },
  };
}
export type HttpTokenStore = ReturnType<typeof createHttpTokenStore>;

// src/presentation/http/httpSessionIsolation.ts
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';
export function createHttpSessionIsolation() {
  const ownerBySession = new Map<string, string>();
  return {
    bind(subject: string, sessionId: string) {
      const owner = ownerBySession.get(sessionId);
      if (owner && owner !== subject) return err(gatewayError('HTTP_SESSION_CROSS_CLIENT', 'session 属于其他 client', 'http.session.cross_client'));
      ownerBySession.set(sessionId, subject);
      return ok({ sessionId });
    },
    assertOwner(subject: string, sessionId: string) {
      const owner = ownerBySession.get(sessionId);
      return owner === subject
        ? ok({ sessionId })
        : err(gatewayError('HTTP_SESSION_CROSS_CLIENT', '禁止跨 client 访问 session', 'http.session.cross_client'));
    },
  };
}
export type HttpSessionIsolation = ReturnType<typeof createHttpSessionIsolation>;

// src/presentation/http/httpSecurity.ts
import { isIP } from 'node:net';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';
export interface HttpSecurityConfig {
  bindHost: string;
  releaseMode: boolean;
  hostAllowlist: readonly string[];
  originAllowlist: readonly string[];
  trustedProxyCidrs: readonly string[];
  tls?: { minVersion: 'TLSv1.2' | 'TLSv1.3'; certificateTrust: 'system' | { pinnedSha256: readonly string[] } };
}
export interface HttpRequestFacts {
  headers: Record<string, string | undefined>;
  peerAddress: string;
  transport: { encrypted: boolean; tlsVersion?: string; certificateTrusted: boolean };
}
const loopback = (host: string) => host === '127.0.0.1' || host === '::1' || host === 'localhost';
const ipv4 = (value: string) => value.split('.').reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
function inCidr(address: string, cidr: string): boolean {
  const [network, bitsText] = cidr.split('/');
  if (isIP(address) !== 4 || isIP(network ?? '') !== 4) return address === network;
  const bits = Number(bitsText ?? 32);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4(address) & mask) === (ipv4(network!) & mask);
}
const forwarded = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'];
export function validateHttpSecurityConfig(config: HttpSecurityConfig) {
  if (config.releaseMode && !loopback(config.bindHost) && !config.tls) {
    return err(gatewayError('HTTP_PLAINTEXT_NON_LOOPBACK_BLOCKED', 'release mode 禁止非 loopback 明文 HTTP', 'http.plaintext.non_loopback_blocked'));
  }
  return ok(config);
}
export function evaluateHttpTransport(config: HttpSecurityConfig, facts: HttpRequestFacts) {
  const host = (facts.headers.host ?? '').toLowerCase();
  const origin = facts.headers.origin;
  if (!config.hostAllowlist.map(x => x.toLowerCase()).includes(host)) return err(gatewayError('HTTP_HOST_NOT_ALLOWED', 'Host 不在 allowlist', 'http.host.not_allowed'));
  if (origin && !config.originAllowlist.includes(origin)) return err(gatewayError('HTTP_ORIGIN_NOT_ALLOWED', 'Origin 不在 allowlist', 'http.origin.not_allowed'));
  const trustedProxy = config.trustedProxyCidrs.some(cidr => inCidr(facts.peerAddress, cidr));
  if (!trustedProxy && forwarded.some(name => facts.headers[name] !== undefined)) return err(gatewayError('HTTP_UNTRUSTED_FORWARDED_HEADER', '不信任 peer 提供的 forwarded header', 'http.forwarded.untrusted'));
  if (config.tls) {
    if (!facts.transport.encrypted || !['TLSv1.2', 'TLSv1.3'].includes(facts.transport.tlsVersion ?? '')) return err(gatewayError('HTTP_TLS_VERSION_UNSUPPORTED', 'TLS 版本低于 1.2', 'http.tls.version_unsupported'));
    if (!facts.transport.certificateTrusted) return err(gatewayError('HTTP_CERTIFICATE_UNTRUSTED', 'TLS 证书不可信', 'http.certificate.untrusted'));
  }
  const clientIp = trustedProxy ? (facts.headers['x-forwarded-for']?.split(',')[0]?.trim() || facts.peerAddress) : facts.peerAddress;
  return ok({ clientIp, corsOrigin: origin });
}

// src/presentation/http/httpGatewayAdapter.ts
import { randomUUID } from 'node:crypto';
import type { GatewayService } from '../../application/gatewayService.js';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';
import { evaluateHttpTransport, validateHttpSecurityConfig, type HttpRequestFacts, type HttpSecurityConfig } from './httpSecurity.js';
import type { HttpSessionIsolation } from './httpSessionIsolation.js';
import type { HttpTokenStore } from './httpTokenStore.js';
export interface HttpGatewayConfig extends HttpSecurityConfig { tokens: HttpTokenStore; sessions: HttpSessionIsolation; now(): number }
export interface HttpGatewayRequest extends HttpRequestFacts { method: string; params: Record<string, unknown>; correlationId?: string; signal?: AbortSignal }
export function createHttpGatewayAdapter(service: GatewayService, config: HttpGatewayConfig) {
  const valid = validateHttpSecurityConfig(config);
  if (!valid.ok) return valid;
  return ok({
    bindSession(subject: string, sessionId: string) { return config.sessions.bind(subject, sessionId); },
    async request(input: HttpGatewayRequest) {
      const transport = evaluateHttpTransport(config, input);
      if (!transport.ok) return { result: transport, corsOrigin: undefined, clientIp: input.peerAddress };
      const authorization = input.headers.authorization ?? '';
      const match = /^Bearer (.+)$/i.exec(authorization);
      if (!match) return { result: err(gatewayError('HTTP_TOKEN_MISSING', '缺少 Bearer token', 'http.token.missing')), corsOrigin: transport.value.corsOrigin, clientIp: transport.value.clientIp };
      const token = config.tokens.verify(match[1]!, config.now());
      if (!token.ok) return { result: token, corsOrigin: transport.value.corsOrigin, clientIp: transport.value.clientIp };
      const sessionId = String(input.params.sessionId ?? input.params.session_id ?? '');
      const ownership = config.sessions.assertOwner(token.value.subject, sessionId);
      if (!ownership.ok) return { result: ownership, corsOrigin: transport.value.corsOrigin, clientIp: transport.value.clientIp };
      const result = await service.request({ method: input.method, params: input.params, sessionId, source: 'http', correlationId: input.correlationId ?? randomUUID(), signal: input.signal });
      return { result, corsOrigin: transport.value.corsOrigin, clientIp: transport.value.clientIp };
    },
  });
}
```

`src/cli/serve.ts` integration 必须：

1. release 非 loopback 时只调用 `node:https.createServer({ minVersion: 'TLSv1.2', cert, key })`；证书在 bootstrap 时经系统 trust 配置或 SHA-256 pin 校验，验证结果映射到 `certificateTrusted`；失败不 listen。
2. `req.socket.remoteAddress` 是唯一 proxy trust 起点；只在 CIDR 命中后读取 forwarded headers。
3. OPTIONS 也先验证 Host/Origin；response 仅在 `corsOrigin` 存在时设置该精确值和 `Vary: Origin`。
4. `/rpc` 仅转换 legacy method/params 后调用同一 adapter；删除第二套 `/gateway` server 初始化路径。
5. token 的明文只在创建/轮换时返回一次，持久层只保存 hash、id、subject、有效期和 revokedAt。

- [ ] **Step 4: 绿测命令**

```powershell
npm.cmd run test:w1-03
npm.cmd run typecheck:tests
npm.cmd exec -- vitest run tests/kernel-serve.test.ts tests/kernel-gateway.test.ts
```

预期：PASS；release non-loopback plaintext、低 TLS、不可信证书、Host/Origin、untrusted forwarded、无效/撤销 token、跨 client session 均以稳定 code 拒绝。

**Commit（仅供后续执行者；本次不提交）**

```text
protocol: unify gateway adapters and enforce secure HTTP transport
```

---

## Task W1-04：Command Grammar、Registry 与安全名称

**Requirements/Subprojects:** R03、R12；S3

**Files（精确）**
- Create: `src/protocol/commands.ts`
- Create: `src/application/commandGrammar.ts`
- Create: `src/application/commandRegistry.ts`
- Create: `src/domain/identifiers.ts`
- Create: `src/domain/safeNames.ts`
- Create: `tests/wave1/w1-04-command-contract.test.ts`
- Modify: `src/application/commandService.ts`（W1-02 port 增加基于 grammar/registry 的 factory）
- Modify: `src/app/CommandBus.ts`（保留 façade，内部委托 registry）
- Modify: `src/cli/args.ts`（未知 flag 和缺值返回 stable parse result，不再忽略）
- Modify: `src/commands/intent.ts`（任何 `/...` 均进入 command path；unknown 不降级 chat）
- Modify: `src/wxnodus-ui/commands/slashHandler.ts`（传 raw command）
- Modify: `package.json`（只新增 `test:w1-04`；值与顶部 mapping 完全一致）

**Interfaces / stable codes**

```ts
export interface ParsedCommand {
  name: string;
  args: string[];
  flags: Record<string, string | boolean>;
  raw: string;
}
export interface CommandDefinition {
  name: string;
  owner: string;
  minArgs: number;
  maxArgs?: number;
  flags: Readonly<Record<string, { type: 'boolean' | 'string'; required?: boolean }>>;
}
export interface CommandRegistration { id: string; owner: string; dispose(): void }
```

稳定 code：`COMMAND_NOT_SLASH`、`COMMAND_PARSE_UNTERMINATED_QUOTE`、`COMMAND_FLAG_MALFORMED`、`COMMAND_FLAG_UNKNOWN`、`COMMAND_FLAG_VALUE_MISSING`、`COMMAND_ARGUMENT_MISSING`、`COMMAND_ARGUMENT_EXCESS`、`COMMAND_UNKNOWN`、`COMMAND_ALREADY_REGISTERED`、`SAFE_NAME_TRAVERSAL`、`SAFE_NAME_ABSOLUTE_PATH`、`SAFE_NAME_SEPARATOR`、`SAFE_NAME_CONTROL_CHAR`、`SAFE_NAME_TRAILING_DOT_SPACE`、`SAFE_NAME_WINDOWS_RESERVED`、`SAFE_NAME_COLLISION`。

- [ ] **Step 1: 粘贴完整红测 `tests/wave1/w1-04-command-contract.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createCommandService } from '../../src/application/commandService.js';
import { parseCommand } from '../../src/application/commandGrammar.js';
import { createCommandRegistry } from '../../src/application/commandRegistry.js';
import { validateSafeName } from '../../src/domain/safeNames.js';
import { ok } from '../../src/protocol/results.js';

const context = {
  actorId: 'user-1', sessionId: 'session-1', runId: null,
  correlationId: 'corr-1', policySnapshotId: 'policy-1',
  locale: 'zh-CN', source: 'cli' as const,
  capabilities: ['command'] as const,
  timestamp: '2026-08-13T00:00:00.000Z',
};

describe('W1-04 command grammar', () => {
  it('parses quotes, escaped quotes/backslashes, JSON with spaces, flags, and -- terminator', () => {
    const result = parseCommand(String.raw`/deploy "C:\Program Files\wx" '{"name": "wx nodus", "quote": "a\"b"}' --mode=release --target "local host" -- --literal`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      name: '/deploy',
      args: ['C:\\Program Files\\wx', '{"name": "wx nodus", "quote": "a\\"b"}', '--literal'],
      flags: { mode: 'release', target: 'local host' },
      raw: String.raw`/deploy "C:\Program Files\wx" '{"name": "wx nodus", "quote": "a\"b"}' --mode=release --target "local host" -- --literal`,
    });
  });

  it('treats --flag=value and --flag value identically', () => {
    const inline = parseCommand('/build app --mode=release');
    const separate = parseCommand('/build app --mode release');
    expect(inline.ok && inline.value.flags).toEqual(separate.ok && separate.value.flags);
  });

  it('returns a stable code for unterminated quotes', () => {
    const result = parseCommand('/build "unfinished');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('COMMAND_PARSE_UNTERMINATED_QUOTE');
  });
});

describe('W1-04 registry and entrypoint contract', () => {
  it('distinguishes unknown, missing, excess, unknown-flag, and missing-flag-value codes', async () => {
    const registry = createCommandRegistry();
    registry.register({
      name: '/deploy', owner: 'core', minArgs: 1, maxArgs: 1,
      flags: { mode: { type: 'string', required: true }, force: { type: 'boolean' } },
    }, async input => ok({ output: `${input.args[0]}:${input.flags.mode}` }));

    const cases = [
      ['/ghost', 'COMMAND_UNKNOWN'],
      ['/deploy --mode release', 'COMMAND_ARGUMENT_MISSING'],
      ['/deploy app extra --mode release', 'COMMAND_ARGUMENT_EXCESS'],
      ['/deploy app --bogus x --mode release', 'COMMAND_FLAG_UNKNOWN'],
      ['/deploy app --mode', 'COMMAND_FLAG_VALUE_MISSING'],
    ] as const;
    for (const [raw, code] of cases) {
      const parsed = parseCommand(raw);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      const result = await registry.execute(parsed.value, context);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(code);
    }
  });

  it('never downgrades an unknown slash command into chat', async () => {
    const chatFallback = vi.fn();
    const service = createCommandService(createCommandRegistry(), chatFallback);
    const result = await service.execute({ raw: '/definitely-unknown', sessionId: 'session-1' }, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('COMMAND_UNKNOWN');
    expect(chatFallback).not.toHaveBeenCalled();
  });

  it('disposes only the registration captured by its owner and supports owner cleanup', () => {
    const registry = createCommandRegistry();
    const a = registry.register({ name: '/a', owner: 'plugin:a', minArgs: 0, flags: {} }, async () => ok({ output: 'a' }));
    const b = registry.register({ name: '/b', owner: 'plugin:b', minArgs: 0, flags: {} }, async () => ok({ output: 'b' }));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    a.value.dispose();
    expect(registry.list().map(x => x.name)).toEqual(['/b']);
    expect(registry.unregisterOwner('plugin:a')).toBe(0);
    expect(registry.unregisterOwner('plugin:b')).toBe(1);
    expect(registry.list()).toEqual([]);
  });
});

describe('W1-04 safe names', () => {
  it.each([
    ['..', 'SAFE_NAME_TRAVERSAL'],
    ['C:\\temp', 'SAFE_NAME_ABSOLUTE_PATH'],
    ['\\\\server\\share', 'SAFE_NAME_ABSOLUTE_PATH'],
    ['a/b', 'SAFE_NAME_SEPARATOR'],
    ['a\\b', 'SAFE_NAME_SEPARATOR'],
    ['bad\u0000name', 'SAFE_NAME_CONTROL_CHAR'],
    ['trailing.', 'SAFE_NAME_TRAILING_DOT_SPACE'],
    ['trailing ', 'SAFE_NAME_TRAILING_DOT_SPACE'],
    ['CON', 'SAFE_NAME_WINDOWS_RESERVED'],
    ['nul.txt', 'SAFE_NAME_WINDOWS_RESERVED'],
  ] as const)('rejects %s with %s', (name, code) => {
    const result = validateSafeName(name, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it('detects case and NFKC collisions after normalization', () => {
    const caseCollision = validateSafeName('Plugin', ['plugin']);
    expect(caseCollision.ok).toBe(false);
    if (!caseCollision.ok) expect(caseCollision.error.code).toBe('SAFE_NAME_COLLISION');
    const unicodeCollision = validateSafeName('Ａgent', ['Agent']);
    expect(unicodeCollision.ok).toBe(false);
    if (!unicodeCollision.ok) expect(unicodeCollision.error.code).toBe('SAFE_NAME_COLLISION');
  });
});
```

- [ ] **Step 2: 红测命令**

```powershell
npm.cmd run test:w1-04
```

预期：FAIL，当前 `CommandBus` 使用 whitespace split、未知 flag 静默忽略、unknown slash 会进入 chat。

- [ ] **Step 3: 粘贴最小实现（按注释分拆到精确文件）**

```ts
// src/protocol/commands.ts
import type { OperationContext } from './operationContext.js';
import type { OperationResult } from './results.js';
export interface ParsedCommand { name: string; args: string[]; flags: Record<string, string | boolean>; raw: string }
export interface CommandDefinition {
  name: string;
  owner: string;
  minArgs: number;
  maxArgs?: number;
  flags: Readonly<Record<string, { type: 'boolean' | 'string'; required?: boolean }>>;
}
export interface CommandOutput { output: string }
export type CommandHandler = (input: ParsedCommand, context: OperationContext) => Promise<OperationResult<CommandOutput>>;
export interface CommandRegistration { id: string; owner: string; dispose(): void }

// OperationContext 由 W1-01 的 src/protocol/operationContext.ts 唯一创建；本任务只通过上述 import 消费。

// src/application/commandGrammar.ts
import { gatewayError } from '../protocol/errors.js';
import { err, ok, type OperationResult } from '../protocol/results.js';
import type { ParsedCommand } from '../protocol/commands.js';
function tokenize(raw: string): OperationResult<string[]> {
  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | null = null;
  let active = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === '\\' && raw[i + 1] !== undefined) {
        const next = raw[i + 1]!;
        if (next === quote || next === '\\') { token += next; i++; } else token += ch;
      } else if (ch === quote) quote = null;
      else token += ch;
      active = true;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; active = true; continue; }
    if (/\s/.test(ch)) {
      if (active) { tokens.push(token); token = ''; active = false; }
      continue;
    }
    token += ch;
    active = true;
  }
  if (quote) return err(gatewayError('COMMAND_PARSE_UNTERMINATED_QUOTE', '命令引号未闭合', 'command.quote.unterminated'));
  if (active) tokens.push(token);
  return ok(tokens);
}
export function parseCommand(raw: string): OperationResult<ParsedCommand> {
  const lexed = tokenize(raw.trim());
  if (!lexed.ok) return lexed;
  const [name, ...tail] = lexed.value;
  if (!name?.startsWith('/')) return err(gatewayError('COMMAND_NOT_SLASH', '输入不是 slash command', 'command.not_slash'));
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let parseFlags = true;
  for (let i = 0; i < tail.length; i++) {
    const token = tail[i]!;
    if (parseFlags && token === '--') { parseFlags = false; continue; }
    if (parseFlags && token.startsWith('--')) {
      const body = token.slice(2);
      if (!body || body.startsWith('-')) return err(gatewayError('COMMAND_FLAG_MALFORMED', 'flag 格式错误', 'command.flag.malformed'));
      const equals = body.indexOf('=');
      if (equals >= 0) {
        const key = body.slice(0, equals);
        const value = body.slice(equals + 1);
        if (!key || !value) return err(gatewayError('COMMAND_FLAG_MALFORMED', 'flag 格式错误', 'command.flag.malformed'));
        flags[key] = value;
      } else if (tail[i + 1] !== undefined && !tail[i + 1]!.startsWith('--')) {
        flags[body] = tail[++i]!;
      } else flags[body] = true;
      continue;
    }
    args.push(token);
  }
  return ok({ name: name.toLowerCase(), args, flags, raw });
}

// src/application/commandRegistry.ts
import { randomUUID } from 'node:crypto';
import type { CommandDefinition, CommandHandler, CommandOutput, CommandRegistration, ParsedCommand } from '../protocol/commands.js';
import type { OperationContext } from '../protocol/operationContext.js';
import { gatewayError } from '../protocol/errors.js';
import { err, ok, type OperationResult } from '../protocol/results.js';
interface Entry { id: string; definition: CommandDefinition; handler: CommandHandler }
export function createCommandRegistry() {
  const entries = new Map<string, Entry>();
  return {
    register(definition: CommandDefinition, handler: CommandHandler): OperationResult<CommandRegistration> {
      const name = definition.name.toLowerCase();
      if (entries.has(name)) return err(gatewayError('COMMAND_ALREADY_REGISTERED', `命令已注册：${name}`, 'command.already_registered'));
      const entry: Entry = { id: randomUUID(), definition: { ...definition, name }, handler };
      entries.set(name, entry);
      return ok({ id: entry.id, owner: definition.owner, dispose: () => { if (entries.get(name)?.id === entry.id) entries.delete(name); } });
    },
    unregisterOwner(owner: string): number {
      let count = 0;
      for (const [name, entry] of entries) if (entry.definition.owner === owner) { entries.delete(name); count++; }
      return count;
    },
    list(): CommandDefinition[] { return [...entries.values()].map(x => x.definition).sort((a, b) => a.name.localeCompare(b.name)); },
    async execute(input: ParsedCommand, context: OperationContext): Promise<OperationResult<CommandOutput>> {
      const entry = entries.get(input.name.toLowerCase());
      if (!entry) return err(gatewayError('COMMAND_UNKNOWN', `未知命令：${input.name}`, 'command.unknown'));
      if (input.args.length < entry.definition.minArgs) return err(gatewayError('COMMAND_ARGUMENT_MISSING', '命令参数不足', 'command.argument.missing'));
      if (entry.definition.maxArgs !== undefined && input.args.length > entry.definition.maxArgs) return err(gatewayError('COMMAND_ARGUMENT_EXCESS', '命令参数过多', 'command.argument.excess'));
      for (const [name, value] of Object.entries(input.flags)) {
        const spec = entry.definition.flags[name];
        if (!spec) return err(gatewayError('COMMAND_FLAG_UNKNOWN', `未知 flag：--${name}`, 'command.flag.unknown'));
        if (spec.type === 'string' && value === true) return err(gatewayError('COMMAND_FLAG_VALUE_MISSING', `flag 缺值：--${name}`, 'command.flag.value_missing'));
        if (spec.type === 'boolean' && value !== true) return err(gatewayError('COMMAND_FLAG_MALFORMED', `boolean flag 不接受值：--${name}`, 'command.flag.malformed'));
      }
      for (const [name, spec] of Object.entries(entry.definition.flags)) {
        if (spec.required && input.flags[name] === undefined) return err(gatewayError('COMMAND_FLAG_VALUE_MISSING', `缺少 flag：--${name}`, 'command.flag.value_missing'));
      }
      return entry.handler(input, context);
    },
  };
}
export type CommandRegistry = ReturnType<typeof createCommandRegistry>;

// src/application/commandService.ts（替换 W1-02 的空 port 实现，保留其 interface）
import type { OperationContext } from '../protocol/operationContext.js';
import type { OperationResult } from '../protocol/results.js';
import type { CommandRegistry } from './commandRegistry.js';
import { parseCommand } from './commandGrammar.js';
export interface CommandService { execute(input: { raw: string; sessionId: string }, context: OperationContext): Promise<OperationResult<{ output: string }>> }
export function createCommandService(registry: CommandRegistry, _chatFallback: (text: string) => unknown): CommandService {
  return {
    async execute(input, context) {
      const parsed = parseCommand(input.raw);
      if (!parsed.ok) return parsed;
      return registry.execute(parsed.value, { ...context, sessionId: input.sessionId });
    },
  };
}

// src/domain/identifiers.ts
export function canonicalIdentifier(value: string): string { return value.normalize('NFKC').toLocaleLowerCase('en-US'); }

// src/domain/safeNames.ts
import { canonicalIdentifier } from './identifiers.js';
import { gatewayError } from '../protocol/errors.js';
import { err, ok } from '../protocol/results.js';
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
export function validateSafeName(input: string, existing: readonly string[]) {
  const normalized = input.normalize('NFKC');
  if (normalized === '..' || normalized.split(/[\\/]/).includes('..')) return err(gatewayError('SAFE_NAME_TRAVERSAL', '名称包含路径穿越', 'safe_name.traversal'));
  if (/^[a-z]:/i.test(normalized) || /^\\\\/.test(normalized) || normalized.startsWith('/')) return err(gatewayError('SAFE_NAME_ABSOLUTE_PATH', '名称不能是绝对路径', 'safe_name.absolute_path'));
  if (/[\\/]/.test(normalized)) return err(gatewayError('SAFE_NAME_SEPARATOR', '名称不能包含路径分隔符', 'safe_name.separator'));
  if(/[\u0000-\u001f\u007f]/.test(normalized)) return err(gatewayError('SAFE_NAME_CONTROL_CHAR', '名称不能包含控制字符', 'safe_name.control_char'));
  if (/[. ]$/.test(normalized)) return err(gatewayError('SAFE_NAME_TRAILING_DOT_SPACE', '名称不能以点或空格结尾', 'safe_name.trailing_dot_space'));
  if (RESERVED.test(normalized)) return err(gatewayError('SAFE_NAME_WINDOWS_RESERVED', '名称是 Windows 保留名', 'safe_name.windows_reserved'));
  const key = canonicalIdentifier(normalized);
  if (existing.some(item => canonicalIdentifier(item) === key)) return err(gatewayError('SAFE_NAME_COLLISION', '名称在 NFKC/case 归一化后冲突', 'safe_name.collision'));
  return ok(normalized);
}
```

`OperationContext` 已由 W1-01 在 `src/protocol/operationContext.ts` 唯一落盘；W1-04 只能 import，不能第二次创建。`CommandBus` façade 将旧 handlers 以 owner `legacy:core` 注册，旧返回字符串显式转换为 `ok({ output })`；异常转换为 `COMMAND_HANDLER_FAILED`。`routeInput()` 遇到任何 slash 输入都返回 command path，unknown 由 registry 给出 `COMMAND_UNKNOWN`。

- [ ] **Step 4: 绿测命令**

```powershell
npm.cmd run test:w1-04
npm.cmd run typecheck:tests
npm.cmd exec -- vitest run tests/commands.test.ts tests/commands-intent.test.ts
```

预期：PASS；所有入口共享 raw grammar，未知 slash 不进入 chat。

**Commit（仅供后续执行者；本次不提交）**

```text
commands: add shared grammar owned registry and safe names
```

---

## Task W1-05：ToolId、EffectDescriptor、ToolDescriptor 与基础 ToolCatalog

**Requirements/Subprojects:** R03、R04、R06、R10；S4/S13 前置

**Files（精确）**
- Create: `src/domain/effects/effectDescriptor.ts`（**本任务创建；W1-07 只消费**）
- Create: `src/domain/tools/toolIds.ts`
- Create: `src/domain/tools/toolDescriptor.ts`
- Create: `src/domain/tools/toolCatalog.ts`
- Create: `tests/wave1/w1-05-tool-catalog.test.ts`
- Modify: `src/kernel/tools.ts`（legacy `ToolDef` → descriptor adapter；builtin namespace）
- Modify: `src/kernel/mcp.ts`（只 register/unregister owner，不覆盖全量 map）
- Modify: `src/kernel/plugins.ts`（只 register/unregister owner，不覆盖全量 map）
- Modify: `src/kernel/agent.ts`（每 turn 获取 immutable catalog snapshot）
- Modify: `package.json`（只新增 `test:w1-05`；值与顶部 mapping 完全一致）

**Interfaces / stable codes**

```ts
export type ToolNamespace = 'builtin' | 'mcp' | 'plugin' | 'skill' | 'forge' | 'agent';
export type ToolId = `${ToolNamespace}:${string}` & { readonly __brand: 'ToolId' };
export interface EffectDescriptor {
  kind: 'filesystem.read' | 'filesystem.write' | 'process.spawn' | 'network.request'
    | 'memory.read' | 'memory.write' | 'config.write' | 'extension.manage' | 'ui.external';
  resource: string;
  operation: string;
  external: boolean;
  dataClassification: 'public' | 'internal' | 'secret';
  reversibility: 'reversible' | 'compensatable' | 'irreversible';
}
export interface ToolDescriptor {
  id: ToolId;
  owner: string;
  inputSchema: Record<string, unknown>;
  effects: readonly EffectDescriptor[];
  timeoutMs: number;
  cancellation: 'required' | 'supported' | 'unsupported';
  idempotency: 'idempotent' | 'conditional' | 'non_idempotent';
  evidenceProducer: boolean;
}
```

稳定 code：`TOOL_ID_INVALID`、`TOOL_NAMESPACE_UNSUPPORTED`、`TOOL_ALREADY_REGISTERED`、`TOOL_DESCRIPTOR_INCOMPLETE`、`TOOL_NOT_FOUND`、`TOOL_ID_AMBIGUOUS`、`TOOL_OWNER_MISMATCH`。

- [ ] **Step 1: 粘贴完整红测 `tests/wave1/w1-05-tool-catalog.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { createEffectDescriptor } from '../../src/domain/effects/effectDescriptor.js';
import { createToolCatalog } from '../../src/domain/tools/toolCatalog.js';
import type { ToolDescriptor } from '../../src/domain/tools/toolDescriptor.js';
import { parseToolId } from '../../src/domain/tools/toolIds.js';

function descriptor(rawId: string, owner: string): ToolDescriptor {
  const id = parseToolId(rawId);
  if (!id.ok) throw new Error(id.error.code);
  return {
    id: id.value,
    owner,
    inputSchema: { type: 'object', additionalProperties: false },
    effects: [createEffectDescriptor({
      kind: 'filesystem.read', resource: 'workspace://**/*', operation: 'read',
      external: false, dataClassification: 'internal', reversibility: 'reversible',
    })],
    timeoutMs: 5_000,
    cancellation: 'supported',
    idempotency: 'idempotent',
    evidenceProducer: true,
  };
}

describe('W1-05 ToolId', () => {
  it.each(['builtin:read', 'mcp:read', 'plugin:read', 'skill:read', 'forge:read', 'agent:read'])('accepts namespace %s', raw => {
    expect(parseToolId(raw).ok).toBe(true);
  });

  it.each([
    ['read', 'TOOL_ID_INVALID'],
    ['unknown:read', 'TOOL_NAMESPACE_UNSUPPORTED'],
    ['mcp:', 'TOOL_ID_INVALID'],
    ['mcp:../read', 'TOOL_ID_INVALID'],
    ['mcp:Read', 'TOOL_ID_INVALID'],
  ] as const)('rejects %s with %s', (raw, code) => {
    const result = parseToolId(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });
});

describe('W1-05 ToolCatalog', () => {
  it('allows same local name across MCP and Plugin and rejects ambiguous bare lookup', () => {
    const catalog = createToolCatalog();
    expect(catalog.register('mcp:filesystem', [descriptor('mcp:read', 'mcp:filesystem')]).ok).toBe(true);
    expect(catalog.register('plugin:workspace', [descriptor('plugin:read', 'plugin:workspace')]).ok).toBe(true);
    expect(catalog.resolve('mcp:read').ok).toBe(true);
    expect(catalog.resolve('plugin:read').ok).toBe(true);
    const bare = catalog.resolve('read');
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error.code).toBe('TOOL_ID_AMBIGUOUS');
  });

  it('keeps unique bare-name compatibility and owner-scoped disposal', () => {
    const catalog = createToolCatalog();
    const mcp = catalog.register('mcp:filesystem', [descriptor('mcp:read', 'mcp:filesystem')]);
    const plugin = catalog.register('plugin:writer', [descriptor('plugin:write', 'plugin:writer')]);
    expect(mcp.ok && plugin.ok).toBe(true);
    expect(catalog.resolve('read').ok).toBe(true);
    if (!mcp.ok) return;
    mcp.value.dispose();
    expect(catalog.resolve('mcp:read').ok).toBe(false);
    expect(catalog.resolve('plugin:write').ok).toBe(true);
  });

  it('rejects duplicate ids and owner spoofing with stable codes', () => {
    const catalog = createToolCatalog();
    expect(catalog.register('mcp:a', [descriptor('mcp:read', 'mcp:a')]).ok).toBe(true);
    const duplicate = catalog.register('mcp:b', [descriptor('mcp:read', 'mcp:b')]);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe('TOOL_ALREADY_REGISTERED');
    const spoofed = catalog.register('plugin:a', [descriptor('plugin:write', 'plugin:b')]);
    expect(spoofed.ok).toBe(false);
    if (!spoofed.ok) expect(spoofed.error.code).toBe('TOOL_OWNER_MISMATCH');
  });

  it.each([
    [{ effects: [] }, 'effects'],
    [{ timeoutMs: 0 }, 'timeoutMs'],
    [{ cancellation: undefined }, 'cancellation'],
  ] as const)('rejects an external descriptor missing %s', (patch, field) => {
    const catalog = createToolCatalog();
    const invalid = { ...descriptor('mcp:external', 'mcp:a'), ...patch } as unknown as ToolDescriptor;
    const result = catalog.register('mcp:a', [invalid]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TOOL_DESCRIPTOR_INCOMPLETE');
      expect(result.error.details).toMatchObject({ field });
    }
  });

  it('returns an immutable per-turn snapshot', () => {
    const catalog = createToolCatalog();
    catalog.register('builtin:core', [descriptor('builtin:read', 'builtin:core')]);
    const snapshot = catalog.snapshot();
    catalog.register('plugin:later', [descriptor('plugin:write', 'plugin:later')]);
    expect(snapshot.map(tool => tool.id)).toEqual(['builtin:read']);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
  });
});
```

- [ ] **Step 2: 红测命令**

```powershell
npm.cmd run test:w1-05
```

预期：FAIL，EffectDescriptor/ToolId/ToolCatalog 尚不存在；MCP/Plugin 当前仍可能通过 `agent.updateTools()` 覆盖整个 map。

- [ ] **Step 3: 粘贴最小实现（按注释分拆到精确文件）**

```ts
// src/domain/effects/effectDescriptor.ts
export type EffectKind =
  | 'filesystem.read' | 'filesystem.write' | 'process.spawn' | 'network.request'
  | 'memory.read' | 'memory.write' | 'config.write' | 'extension.manage' | 'ui.external';
export interface EffectDescriptor {
  kind: EffectKind;
  resource: string;
  operation: string;
  external: boolean;
  dataClassification: 'public' | 'internal' | 'secret';
  reversibility: 'reversible' | 'compensatable' | 'irreversible';
}
export function createEffectDescriptor(input: EffectDescriptor): EffectDescriptor {
  return Object.freeze({ ...input });
}

// src/domain/tools/toolIds.ts
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';
export const TOOL_NAMESPACES = ['builtin', 'mcp', 'plugin', 'skill', 'forge', 'agent'] as const;
export type ToolNamespace = (typeof TOOL_NAMESPACES)[number];
export type ToolId = `${ToolNamespace}:${string}` & { readonly __brand: 'ToolId' };
const LOCAL = /^[a-z0-9][a-z0-9._-]*$/;
export function parseToolId(raw: string) {
  const colon = raw.indexOf(':');
  if (colon < 1 || colon === raw.length - 1) return err(gatewayError('TOOL_ID_INVALID', `无效 ToolId：${raw}`, 'tool.id.invalid'));
  const namespace = raw.slice(0, colon);
  const local = raw.slice(colon + 1);
  if (!(TOOL_NAMESPACES as readonly string[]).includes(namespace)) return err(gatewayError('TOOL_NAMESPACE_UNSUPPORTED', `不支持的 tool namespace：${namespace}`, 'tool.namespace.unsupported'));
  if (!LOCAL.test(local)) return err(gatewayError('TOOL_ID_INVALID', `无效 ToolId local name：${local}`, 'tool.id.invalid'));
  return ok(raw as ToolId);
}
export function localToolName(id: ToolId): string { return id.slice(id.indexOf(':') + 1); }

// src/domain/tools/toolDescriptor.ts
import type { EffectDescriptor } from '../effects/effectDescriptor.js';
import type { ToolId } from './toolIds.js';
export interface ToolDescriptor {
  id: ToolId;
  owner: string;
  inputSchema: Record<string, unknown>;
  effects: readonly EffectDescriptor[];
  timeoutMs: number;
  cancellation: 'required' | 'supported' | 'unsupported';
  idempotency: 'idempotent' | 'conditional' | 'non_idempotent';
  evidenceProducer: boolean;
}

// src/domain/tools/toolCatalog.ts
import { randomUUID } from 'node:crypto';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';
import type { ToolDescriptor } from './toolDescriptor.js';
import { localToolName, parseToolId, type ToolId } from './toolIds.js';
function freezeDescriptor(tool: ToolDescriptor): ToolDescriptor {
  return Object.freeze({ ...tool, inputSchema: Object.freeze({ ...tool.inputSchema }), effects: Object.freeze(tool.effects.map(effect => Object.freeze({ ...effect }))) });
}
function validateDescriptor(tool: ToolDescriptor) {
  if (!tool.effects?.length) return 'effects';
  if (!Number.isFinite(tool.timeoutMs) || tool.timeoutMs <= 0) return 'timeoutMs';
  if (!['required', 'supported', 'unsupported'].includes(tool.cancellation)) return 'cancellation';
  if (!['idempotent', 'conditional', 'non_idempotent'].includes(tool.idempotency)) return 'idempotency';
  if (!tool.inputSchema || typeof tool.inputSchema !== 'object') return 'inputSchema';
  return null;
}
export function createToolCatalog() {
  const tools = new Map<ToolId, ToolDescriptor>();
  return {
    register(owner: string, incoming: readonly ToolDescriptor[]) {
      for (const tool of incoming) {
        if (tool.owner !== owner) return err(gatewayError('TOOL_OWNER_MISMATCH', 'tool owner 与 registration owner 不一致', 'tool.owner.mismatch', { retryable: false, details: { owner, descriptorOwner: tool.owner } }));
        const parsed = parseToolId(tool.id);
        if (!parsed.ok) return parsed;
        const missing = validateDescriptor(tool);
        if (missing) return err(gatewayError('TOOL_DESCRIPTOR_INCOMPLETE', `tool descriptor 缺少 ${missing}`, 'tool.descriptor.incomplete', { retryable: false, details: { field: missing, toolId: tool.id } }));
        if (tools.has(tool.id)) return err(gatewayError('TOOL_ALREADY_REGISTERED', `ToolId 已注册：${tool.id}`, 'tool.already_registered'));
      }
      const registrationId = randomUUID();
      const ids = incoming.map(tool => tool.id);
      for (const tool of incoming) tools.set(tool.id, freezeDescriptor(tool));
      let disposed = false;
      return ok({
        id: registrationId,
        owner,
        dispose() {
          if (disposed) return;
          disposed = true;
          for (const id of ids) if (tools.get(id)?.owner === owner) tools.delete(id);
        },
      });
    },
    resolve(raw: string) {
      if (raw.includes(':')) {
        const parsed = parseToolId(raw);
        if (!parsed.ok) return parsed;
        const tool = tools.get(parsed.value);
        return tool ? ok(tool) : err(gatewayError('TOOL_NOT_FOUND', `tool 不存在：${raw}`, 'tool.not_found'));
      }
      const matches = [...tools.values()].filter(tool => localToolName(tool.id) === raw);
      if (matches.length === 1) return ok(matches[0]!);
      if (matches.length > 1) return err(gatewayError('TOOL_ID_AMBIGUOUS', `裸 tool name 有歧义：${raw}`, 'tool.id.ambiguous', { retryable: false, details: { candidates: matches.map(x => x.id) } }));
      return err(gatewayError('TOOL_NOT_FOUND', `tool 不存在：${raw}`, 'tool.not_found'));
    },
    list(owner?: string) { return [...tools.values()].filter(tool => !owner || tool.owner === owner).sort((a, b) => a.id.localeCompare(b.id)); },
    snapshot(): readonly ToolDescriptor[] { return Object.freeze([...tools.values()].sort((a, b) => a.id.localeCompare(b.id))); },
  };
}
export type ToolCatalog = ReturnType<typeof createToolCatalog>;
```

Legacy adapter 规则必须明确：`coreTools()` 的 key `fs_read` 映射为 `builtin:fs_read`；MCP server owner 为 `mcp:<server-id>`，Plugin owner 为 `plugin:<plugin-id>`，Skill/Agent 同理。每个外部 tool 注册前补齐 effects/timeout/cancellation/idempotency/evidence metadata；推断不出来就拒绝 `TOOL_DESCRIPTOR_INCOMPLETE`，不以默认 read-only 降级。Agent 在 turn 开始调用一次 `catalog.snapshot()` 并在该 turn 内固定使用，不读取中途变更。

- [ ] **Step 4: 绿测命令**

```powershell
npm.cmd run test:w1-05
npm.cmd run typecheck:tests
npm.cmd exec -- vitest run tests/kernel-tools.test.ts tests/kernel-mcp.test.ts tests/kernel-plugins.test.ts
```

预期：PASS；同名 MCP/Plugin 共存，裸名称仅唯一时兼容，owner disposal 不影响其他来源。

**Commit（仅供后续执行者；本次不提交）**

```text
core: introduce effect descriptors and namespaced tool catalog identities
```

---

## Task W1-06：Black Hole Memory 事务、作用域、保留策略与 durable embedding outbox

**Requirements/Subprojects:** R09、R10；S5；Gate C/D/G

**Files（精确）**
- Create: `src/domain/memory/memoryScope.ts`
- Create: `src/domain/memory/memoryRanking.ts`
- Create: `src/domain/memory/memoryRepository.ts`
- Create: `src/domain/memory/embeddingJobs.ts`
- Create: `src/domain/memory/memoryCurator.ts`
- Create: `src/infrastructure/sqlite/memoryMigrations.ts`
- Create: `src/infrastructure/sqlite/memoryRepository.ts`
- Create: `src/infrastructure/sqlite/embeddingJobsRepository.ts`
- Create: `src/infrastructure/sqlite/embeddingWorker.ts`
- Create: `scripts/memory-curator.ts`
- Create: `tests/wave1/w1-06-memory-durability.test.ts`
- Modify: `src/application/memoryService.ts`（W1-02 port 委托新 repository）
- Modify: `src/kernel/memory.ts`（legacy façade）
- Modify: `src/store/db.ts`（只调用 `migrateMemory`；不再分散写 memory schema）
- Modify: `src/kernel/imageHistory.ts`（summary mutation 走 repository）
- Modify: `src/commands/handlers.ts`（memory mutations/curator 走 service）
- Modify: `src/kernel/tools.ts`（memory tools 走 service）
- Modify: `src/wxnodus-ui/wxGateway.ts`（memory RPC 走 service）
- Modify: `package.json`（新增 `test:w1-06`、`test:wave1:trusted-kernel`、`memory:curate`；值与顶部 mapping 完全一致）

**Interfaces / invariant / stable codes**

```ts
export interface MemoryScope { sessionId?: string; projectId?: string; userArchive?: boolean; globalOptIn?: boolean }
export interface MemoryProvenance {
  sourceType: 'conversation' | 'tool' | 'file' | 'image' | 'import' | 'curator';
  sourceId: string; sourceUri?: string; capturedAt: string; actorId: string;
  correlationId: string; policySnapshotId: string; sourceTrust: number; contentHash: string;
}
export interface RetentionPolicy {
  class: 'ephemeral' | 'session' | 'project' | 'archive' | 'audit';
  retainUntil: string | null;
}
export type EmbeddingState = 'pending' | 'processing' | 'ready' | 'failed' | 'tombstoned';
export interface MemoryRankingComponents {
  fts: number; vector: number; recency: number; salience: number; sourceTrust: number; scopeWeight: number;
}
```

- append/update/delete/compact/image-summary/session-delete 在一个 SQLite transaction 内同时更新 primary、FTS、vector fencing、outbox；任一步失败全部 rollback。
- dedup key 固定为 `scopeTier + scopeKey + role + SHA-256(NFKC(content))`；重复 append 不新增 primary/FTS/job，更新 `lastSeenAt/dedupCount` 并合并 provenance；不得跨 scope 去重。
- worker 只可写回与 primary generation 相同的 embedding；旧 job 返回 `EMBEDDING_GENERATION_STALE`。
- `maxStaleTimeMs` 是硬 SLO：pending/processing 从 `createdAt` 超时产生 `EMBEDDING_MAX_STALE_EXCEEDED`；worker 最旧优先，lease 到期 reclaim。
- orphan detection 同时检测 vector 无 active/matching primary=`EMBEDDING_ORPHAN_VECTOR`，ready primary 无 matching vector=`EMBEDDING_VECTOR_MISSING`。
- retention 到期先 tombstone primary，再在同事务删除 FTS/vector 并 tombstone jobs；provenance 留在 tombstone。Curator 默认 dry-run，只有 `--apply` 写库。
- 同池排序固定为 `0.30*fts + 0.25*vector + 0.15*recency + 0.10*salience + 0.10*sourceTrust + 0.10*scopeWeight`；六分量 clamp `[0,1]` 并返回。scopeWeight 固定 `session=1.0/project=0.8/user_archive=0.6/global=0.4`。
- stable codes：`MEMORY_SCOPE_REQUIRED`、`MEMORY_SCOPE_DENIED`、`MEMORY_TRANSACTION_FAILED`、`EMBEDDING_GENERATION_STALE`、`EMBEDDING_MAX_STALE_EXCEEDED`、`EMBEDDING_ORPHAN_VECTOR`、`EMBEDDING_VECTOR_MISSING`、`EMBEDDING_JOB_DEAD_LETTERED`。

- [ ] **Step 1: 粘贴完整红测 `tests/wave1/w1-06-memory-durability.test.ts`**

```ts
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryCurator } from '../../src/domain/memory/memoryCurator.js';
import { rankMemoryCandidates } from '../../src/domain/memory/memoryRanking.js';
import type { AppendMemory } from '../../src/domain/memory/memoryRepository.js';
import type { MemoryScope } from '../../src/domain/memory/memoryScope.js';
import { createEmbeddingWorker } from '../../src/infrastructure/sqlite/embeddingWorker.js';
import { createEmbeddingJobsRepository } from '../../src/infrastructure/sqlite/embeddingJobsRepository.js';
import { migrateMemory } from '../../src/infrastructure/sqlite/memoryMigrations.js';
import { openMemoryRepository } from '../../src/infrastructure/sqlite/memoryRepository.js';
import type { Db } from '../../src/store/db.js';

const START = Date.parse('2026-08-13T00:00:00.000Z');
const scopeA: MemoryScope = { sessionId: 'session-a', projectId: 'project-a' };
const scopeB: MemoryScope = { sessionId: 'session-b', projectId: 'project-a' };
let nowMs = START;
let serial = 0;
let db: Db;
let repository: ReturnType<typeof openMemoryRepository>;
let jobs: ReturnType<typeof createEmbeddingJobsRepository>;
const iso = (ms: number) => new Date(ms).toISOString();
function input(content: string, patch: Partial<AppendMemory> = {}): AppendMemory {
  return {
    role: 'user', content, salience: 0.5,
    retention: { class: 'session', retainUntil: null },
    provenance: {
      sourceType: 'conversation', sourceId: 'turn-1', capturedAt: iso(nowMs), actorId: 'user-1',
      correlationId: `corr-${serial + 1}`, policySnapshotId: 'policy-1', sourceTrust: 0.8,
    },
    ...patch,
  };
}
beforeEach(() => {
  nowMs = START; serial = 0;
  db = new Database(':memory:') as Db;
  migrateMemory(db, { embeddingDimensions: 3 });
  repository = openMemoryRepository(db, { now: () => nowMs, idFactory: prefix => `${prefix}-${++serial}` });
  jobs = createEmbeddingJobsRepository(db);
});
afterEach(() => db.close());

describe('W1-06 transaction, scope, dedup, provenance', () => {
  it('rolls back primary/FTS when outbox insert fails and otherwise gives read-your-writes', () => {
    db.exec(`CREATE TRIGGER reject_job BEFORE INSERT ON embedding_jobs BEGIN SELECT RAISE(ABORT,'forced'); END;`);
    const failed = repository.append(input('transactional memory'), scopeA);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe('MEMORY_TRANSACTION_FAILED');
    expect((db.prepare(`SELECT COUNT(*) c FROM memory_records`).get() as { c: number }).c).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) c FROM memory_fts`).get() as { c: number }).c).toBe(0);
    db.exec(`DROP TRIGGER reject_job`);
    const appended = repository.append(input('transactional memory'), scopeA);
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    expect(repository.search({ text: 'transactional', limit: 10, now: iso(nowMs) }, scopeA)).toMatchObject({ ok: true });
    expect(db.prepare(`SELECT state FROM embedding_jobs WHERE record_id=?`).get(appended.value.record.id)).toEqual({ state: 'pending' });
  });

  it('deduplicates only within the same scope and merges durable provenance/sourceTrust', () => {
    const first = repository.append(input('same normalized content'), scopeA);
    const duplicate = repository.append(input('ｓａｍｅ normalized content', {
      provenance: {
        sourceType: 'file', sourceId: 'file-1', sourceUri: 'file:///workspace/a.txt', capturedAt: iso(nowMs),
        actorId: 'user-1', correlationId: 'corr-file', policySnapshotId: 'policy-1', sourceTrust: 0.95,
      },
    }), scopeA);
    const otherScope = repository.append(input('same normalized content'), scopeB);
    expect(first.ok && duplicate.ok && otherScope.ok).toBe(true);
    if (!first.ok || !duplicate.ok || !otherScope.ok) return;
    expect(duplicate.value).toMatchObject({ deduplicated: true, record: { id: first.value.record.id, dedupCount: 2, sourceTrust: 0.95 } });
    expect(duplicate.value.record.provenance.map(p => p.sourceId)).toEqual(['turn-1', 'file-1']);
    expect(otherScope.value.record.id).not.toBe(first.value.record.id);
    expect((db.prepare(`SELECT COUNT(*) c FROM embedding_jobs WHERE record_id=?`).get(first.value.record.id) as { c: number }).c).toBe(1);
  });

  it('applies scope before FTS/vector candidates and requires global opt-in', () => {
    repository.append(input('shared keyword from A'), scopeA);
    repository.append(input('shared keyword from B'), scopeB);
    repository.append(input('shared keyword global'), { globalOptIn: true });
    const privateHits = repository.search({ text: 'shared', limit: 10, now: iso(nowMs) }, scopeA);
    expect(privateHits.ok && privateHits.value.map(x => x.record.content)).toEqual(['shared keyword from A']);
    const globalHits = repository.search({ text: 'shared', limit: 10, now: iso(nowMs) }, { ...scopeA, globalOptIn: true });
    expect(globalHits.ok && globalHits.value.map(x => x.record.content).sort()).toEqual(['shared keyword from A', 'shared keyword global']);
  });
});

describe('W1-06 generation, stale time, orphan and retry', () => {
  it('rejects old generation writeback and leaves no stale index after delete', () => {
    const appended = repository.append(input('generation one'), scopeA);
    if (!appended.ok) throw new Error(appended.error.code);
    const oldJob = jobs.claim('worker-1', nowMs, 1_000, 3);
    if (!oldJob.ok || !oldJob.value) throw new Error('expected job');
    expect(repository.update(appended.value.record.id, { content: 'generation two' }, scopeA)).toMatchObject({ ok: true, value: { generation: 2 } });
    const stale = jobs.complete(oldJob.value, [1, 0, 0], nowMs);
    expect(stale).toMatchObject({ ok: false, error: { code: 'EMBEDDING_GENERATION_STALE' } });
    expect(db.prepare(`SELECT content FROM memory_fts WHERE record_id=?`).get(appended.value.record.id)).toEqual({ content: 'generation two' });
    expect(repository.delete(appended.value.record.id, scopeA).ok).toBe(true);
    expect((db.prepare(`SELECT COUNT(*) c FROM memory_fts WHERE record_id=?`).get(appended.value.record.id) as { c: number }).c).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) c FROM memory_vectors WHERE record_id=?`).get(appended.value.record.id) as { c: number }).c).toBe(0);
  });

  it('detects max stale/orphan, reclaims an expired lease, and dead-letters repeated failure', async () => {
    const appended = repository.append(input('stale embedding'), scopeA);
    if (!appended.ok) throw new Error(appended.error.code);
    expect(jobs.claim('dead-worker', nowMs, 1_000, 2).ok).toBe(true);
    db.prepare(`INSERT INTO memory_vectors VALUES ('orphan',1,'[0,0,1]',?)`).run(nowMs);
    nowMs += 61_000;
    expect(repository.inspectIndexHealth(nowMs, 60_000)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'EMBEDDING_MAX_STALE_EXCEEDED', recordId: appended.value.record.id }),
      expect.objectContaining({ code: 'EMBEDDING_ORPHAN_VECTOR', recordId: 'orphan' }),
    ]));
    const reclaim = createEmbeddingWorker({ jobs, repository, workerId: 'worker-2', leaseMs: 5_000, maxAttempts: 2, maxStaleTimeMs: 60_000, now: () => nowMs, embed: async () => [1, 0, 0] });
    expect(await reclaim.runOnce()).toMatchObject({ ok: true, value: { processed: true } });

    repository.append(input('cannot embed'), scopeA);
    const failing = createEmbeddingWorker({ jobs, repository, workerId: 'worker-fail', leaseMs: 5_000, maxAttempts: 2, maxStaleTimeMs: 60_000, now: () => nowMs, embed: async () => { throw new Error('offline'); } });
    expect((await failing.runOnce()).ok).toBe(false);
    nowMs += 1;
    expect(await failing.runOnce()).toMatchObject({ ok: false, error: { code: 'EMBEDDING_JOB_DEAD_LETTERED' } });
  });
});

describe('W1-06 six-component ranking, retention, curator and rebuild', () => {
  it('returns six normalized components and ranks sourceTrust/scopeWeight in the same score', () => {
    const ranked = rankMemoryCandidates([
      { id: 'global-low', fts: 0.8, vector: 0.8, recency: 0.5, salience: 0.5, sourceTrust: 0.1, scopeWeight: 0.4 },
      { id: 'session-trusted', fts: 0.8, vector: 0.8, recency: 0.5, salience: 0.5, sourceTrust: 1, scopeWeight: 1 },
    ]);
    expect(ranked.map(x => x.id)).toEqual(['session-trusted', 'global-low']);
    expect(ranked[0]?.score).toBeCloseTo(0.765);
    expect(ranked[0]?.components).toEqual({ fts: 0.8, vector: 0.8, recency: 0.5, salience: 0.5, sourceTrust: 1, scopeWeight: 1 });
    for (const value of Object.values(ranked[0]!.components)) expect(value).toBeGreaterThanOrEqual(0);
    for (const value of Object.values(ranked[0]!.components)) expect(value).toBeLessThanOrEqual(1);
  });

  it('keeps curator dry-run read-only, applies retention atomically, and preserves provenance', () => {
    const expired = repository.append(input('expired but auditable', { retention: { class: 'session', retainUntil: '2026-08-12T00:00:00.000Z' } }), scopeA);
    if (!expired.ok) throw new Error(expired.error.code);
    db.prepare(`INSERT INTO memory_vectors VALUES (?,?,?,?)`).run(expired.value.record.id, 1, '[1,0,0]', nowMs);
    db.prepare(`UPDATE memory_records SET embedding_state='ready' WHERE id=?`).run(expired.value.record.id);
    const curator = createMemoryCurator(repository);
    expect(curator.run({ mode: 'dry-run', now: iso(nowMs) })).toMatchObject({ ok: true, value: { applied: 0, actions: [{ recordId: expired.value.record.id }] } });
    expect(db.prepare(`SELECT tombstoned_at FROM memory_records WHERE id=?`).get(expired.value.record.id)).toEqual({ tombstoned_at: null });
    expect(curator.run({ mode: 'apply', now: iso(nowMs) })).toMatchObject({ ok: true, value: { applied: 1 } });
    const row = db.prepare(`SELECT provenance_json,tombstoned_at FROM memory_records WHERE id=?`).get(expired.value.record.id) as { provenance_json: string; tombstoned_at: number };
    expect(JSON.parse(row.provenance_json)[0].sourceId).toBe('turn-1');
    expect(row.tombstoned_at).toBe(nowMs);
    expect((db.prepare(`SELECT COUNT(*) c FROM memory_fts WHERE record_id=?`).get(expired.value.record.id) as { c: number }).c).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) c FROM memory_vectors WHERE record_id=?`).get(expired.value.record.id) as { c: number }).c).toBe(0);
  });

  it('rebuilds idempotently from active primary state and removes orphan issues', () => {
    repository.append(input('rebuild one'), scopeA);
    repository.append(input('rebuild two'), scopeA);
    db.prepare(`INSERT INTO memory_vectors VALUES ('orphan',1,'[0,0,1]',?)`).run(nowMs);
    const first = repository.rebuild(scopeA);
    const second = repository.rebuild(scopeA);
    expect(first).toMatchObject({ ok: true, value: { activeRecords: 2, ftsRows: 2, queuedEmbeddings: 2, removedOrphans: 1 } });
    expect(second).toMatchObject({ ok: true, value: { activeRecords: 2, ftsRows: 2, queuedEmbeddings: 2, removedOrphans: 0 } });
    expect(repository.inspectIndexHealth(nowMs, 60_000).some(x => x.code === 'EMBEDDING_ORPHAN_VECTOR')).toBe(false);
  });
});
```

- [ ] **Step 2: 红测命令**

```powershell
npm.cmd run test:w1-06
```

预期：FAIL，事务 repository、durable outbox、max stale、orphan、六分量 ranking、retention curator 尚不存在。

- [ ] **Step 3: 粘贴最小实现（按注释分拆到精确文件）**

```ts
// src/domain/memory/memoryScope.ts
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';
export interface MemoryScope { sessionId?: string; projectId?: string; userArchive?: boolean; globalOptIn?: boolean }
export type MemoryScopeTier = 'session' | 'project' | 'user_archive' | 'global';
export interface StoredMemoryScope { tier: MemoryScopeTier; key: string }
export const MEMORY_SCOPE_WEIGHT = Object.freeze({ session: 1, project: 0.8, user_archive: 0.6, global: 0.4 } satisfies Record<MemoryScopeTier, number>);
export function resolveWriteScope(scope: MemoryScope) {
  if (scope.sessionId) return ok<StoredMemoryScope>({ tier: 'session', key: scope.sessionId });
  if (scope.projectId) return ok<StoredMemoryScope>({ tier: 'project', key: scope.projectId });
  if (scope.userArchive) return ok<StoredMemoryScope>({ tier: 'user_archive', key: 'user' });
  if (scope.globalOptIn) return ok<StoredMemoryScope>({ tier: 'global', key: 'global' });
  return err(gatewayError('MEMORY_SCOPE_REQUIRED', '写入必须声明 memory scope', 'memory.scope.required'));
}
export function accessibleScopes(scope: MemoryScope): StoredMemoryScope[] {
  const out: StoredMemoryScope[] = [];
  if (scope.sessionId) out.push({ tier: 'session', key: scope.sessionId });
  if (scope.projectId) out.push({ tier: 'project', key: scope.projectId });
  if (scope.userArchive) out.push({ tier: 'user_archive', key: 'user' });
  if (scope.globalOptIn) out.push({ tier: 'global', key: 'global' });
  return out;
}

// src/domain/memory/memoryRanking.ts
export interface MemoryRankingComponents { fts: number; vector: number; recency: number; salience: number; sourceTrust: number; scopeWeight: number }
export interface MemoryRankingCandidate extends MemoryRankingComponents { id: string }
const clamp = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
export function rankMemoryCandidates(input: readonly MemoryRankingCandidate[]) {
  return input.map(item => {
    const components = { fts: clamp(item.fts), vector: clamp(item.vector), recency: clamp(item.recency), salience: clamp(item.salience), sourceTrust: clamp(item.sourceTrust), scopeWeight: clamp(item.scopeWeight) };
    const score = 0.30 * components.fts + 0.25 * components.vector + 0.15 * components.recency + 0.10 * components.salience + 0.10 * components.sourceTrust + 0.10 * components.scopeWeight;
    return { id: item.id, score, components };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

// src/domain/memory/memoryRepository.ts
import type { MemoryScope, MemoryScopeTier } from './memoryScope.js';
import type { MemoryRankingComponents } from './memoryRanking.js';
import type { OperationResult } from '../../protocol/results.js';
export interface MemoryProvenanceInput { sourceType: 'conversation'|'tool'|'file'|'image'|'import'|'curator'; sourceId: string; sourceUri?: string; capturedAt: string; actorId: string; correlationId: string; policySnapshotId: string; sourceTrust: number }
export interface MemoryProvenance extends MemoryProvenanceInput { contentHash: string }
export interface RetentionPolicy { class: 'ephemeral'|'session'|'project'|'archive'|'audit'; retainUntil: string | null }
export interface AppendMemory { role: 'user'|'assistant'|'system'|'tool'; content: string; salience: number; retention: RetentionPolicy; provenance: MemoryProvenanceInput }
export interface MemoryRecord {
  id: string; scopeTier: MemoryScopeTier; scopeKey: string; role: AppendMemory['role']; content: string; contentHash: string;
  generation: number; embeddingState: 'pending'|'processing'|'ready'|'failed'|'tombstoned'; salience: number;
  provenance: readonly MemoryProvenance[]; sourceTrust: number; retention: RetentionPolicy;
  createdAt: string; updatedAt: string; lastSeenAt: string; dedupCount: number; tombstonedAt: string | null;
}
export interface MemoryPatch { content?: string; salience?: number; retention?: RetentionPolicy; provenance?: MemoryProvenanceInput }
export interface MemoryQuery { text: string; embedding?: readonly number[]; limit: number; now: string }
export interface MemorySearchHit { record: MemoryRecord; score: number; components: MemoryRankingComponents }
export interface RebuildReport { activeRecords: number; ftsRows: number; queuedEmbeddings: number; removedOrphans: number }
export interface IndexHealthIssue { code: 'EMBEDDING_MAX_STALE_EXCEEDED'|'EMBEDDING_ORPHAN_VECTOR'|'EMBEDDING_VECTOR_MISSING'; recordId: string; ageMs?: number }
export interface RetentionAction { recordId: string; action: 'tombstone'; retainUntil: string }
export interface MemoryRepository {
  append(input: AppendMemory, scope: MemoryScope): OperationResult<{ record: MemoryRecord; deduplicated: boolean }>;
  update(id: string, patch: MemoryPatch, scope: MemoryScope): OperationResult<MemoryRecord>;
  delete(id: string, scope: MemoryScope): OperationResult<void>;
  search(query: MemoryQuery, scope: MemoryScope): OperationResult<MemorySearchHit[]>;
  rebuild(scope: MemoryScope): OperationResult<RebuildReport>;
  inspectIndexHealth(nowMs: number, maxStaleTimeMs: number): IndexHealthIssue[];
  retentionPlan(nowMs: number): RetentionAction[];
  applyRetention(actions: readonly RetentionAction[], nowMs: number): OperationResult<number>;
}

// src/domain/memory/embeddingJobs.ts
export interface EmbeddingJob { id: string; recordId: string; generation: number; state: 'pending'|'processing'|'ready'|'failed'|'tombstoned'; attempts: number; createdAt: number; updatedAt: number; leaseOwner: string | null; leaseUntil: number | null }

// src/domain/memory/memoryCurator.ts
import type { MemoryRepository } from './memoryRepository.js';
import { ok } from '../../protocol/results.js';
export function createMemoryCurator(repository: MemoryRepository) {
  return { run(input: { mode: 'dry-run'|'apply'; now: string }) {
    const actions = repository.retentionPlan(Date.parse(input.now));
    if (input.mode === 'dry-run') return ok({ mode: input.mode, actions, applied: 0 });
    const applied = repository.applyRetention(actions, Date.parse(input.now));
    return applied.ok ? ok({ mode: input.mode, actions, applied: applied.value }) : applied;
  } };
}

// src/infrastructure/sqlite/memoryMigrations.ts
import type { Db } from '../../store/db.js';
export function migrateMemory(db: Db, options: { embeddingDimensions: number }): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_records(id TEXT PRIMARY KEY,scope_tier TEXT NOT NULL,scope_key TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,content_hash TEXT NOT NULL,generation INTEGER NOT NULL,embedding_state TEXT NOT NULL,salience REAL NOT NULL,provenance_json TEXT NOT NULL,source_trust REAL NOT NULL,retention_class TEXT NOT NULL,retain_until INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,dedup_count INTEGER NOT NULL DEFAULT 1,tombstoned_at INTEGER);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_memory_dedup_active ON memory_records(scope_tier,scope_key,role,content_hash) WHERE tombstoned_at IS NULL;
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(record_id UNINDEXED,scope_tier UNINDEXED,scope_key UNINDEXED,content,tokenize='unicode61');
    CREATE TABLE IF NOT EXISTS embedding_jobs(id TEXT PRIMARY KEY,record_id TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL,lease_owner TEXT,lease_until INTEGER,last_error_code TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(record_id,generation));
    CREATE INDEX IF NOT EXISTS ix_embedding_claim ON embedding_jobs(state,available_at,lease_until,created_at);
    CREATE TABLE IF NOT EXISTS embedding_dead_letter(job_id TEXT PRIMARY KEY,record_id TEXT NOT NULL,generation INTEGER NOT NULL,error_code TEXT NOT NULL,attempts INTEGER NOT NULL,failed_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_vectors(record_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,embedding_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
  `);
  try { db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(embedding float[${options.embeddingDimensions}]);`); } catch { /* exact JSON fallback */ }
}

// src/infrastructure/sqlite/embeddingJobsRepository.ts
import type { Db } from '../../store/db.js';
import type { EmbeddingJob } from '../../domain/memory/embeddingJobs.js';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';
const mapJob = (row: Record<string, unknown>): EmbeddingJob => ({ id: String(row.id), recordId: String(row.record_id), generation: Number(row.generation), state: row.state as EmbeddingJob['state'], attempts: Number(row.attempts), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), leaseOwner: row.lease_owner === null ? null : String(row.lease_owner), leaseUntil: row.lease_until === null ? null : Number(row.lease_until) });
export function createEmbeddingJobsRepository(db: Db) {
  const claim = db.transaction((workerId: string, now: number, leaseMs: number, maxAttempts: number) => {
    const row = db.prepare(`SELECT * FROM embedding_jobs WHERE attempts < @max AND available_at<=@now AND (state IN ('pending','failed') OR (state='processing' AND lease_until<=@now)) ORDER BY created_at,id LIMIT 1`).get({ max: maxAttempts, now }) as Record<string, unknown> | undefined;
    if (!row) return null;
    db.prepare(`UPDATE embedding_jobs SET state='processing',attempts=attempts+1,lease_owner=?,lease_until=?,updated_at=? WHERE id=?`).run(workerId, now + leaseMs, now, row.id);
    return mapJob({ ...row, state: 'processing', attempts: Number(row.attempts) + 1, lease_owner: workerId, lease_until: now + leaseMs, updated_at: now });
  });
  return {
    claim(workerId: string, now: number, leaseMs: number, maxAttempts: number) { return ok(claim(workerId, now, leaseMs, maxAttempts)); },
    complete(job: EmbeddingJob, embedding: readonly number[], now: number) {
      return db.transaction(() => {
        const record = db.prepare(`SELECT generation,tombstoned_at FROM memory_records WHERE id=?`).get(job.recordId) as { generation: number; tombstoned_at: number | null } | undefined;
        if (!record || record.tombstoned_at !== null || record.generation !== job.generation) {
          db.prepare(`UPDATE embedding_jobs SET state='tombstoned',last_error_code='EMBEDDING_GENERATION_STALE',updated_at=? WHERE id=?`).run(now, job.id);
          return err(gatewayError('EMBEDDING_GENERATION_STALE', 'embedding generation 已过期', 'embedding.generation.stale'));
        }
        db.prepare(`INSERT INTO memory_vectors VALUES (?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET generation=excluded.generation,embedding_json=excluded.embedding_json,updated_at=excluded.updated_at`).run(job.recordId, job.generation, JSON.stringify(embedding), now);
        db.prepare(`UPDATE memory_records SET embedding_state='ready',updated_at=? WHERE id=? AND generation=?`).run(now, job.recordId, job.generation);
        db.prepare(`UPDATE embedding_jobs SET state='ready',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?`).run(now, job.id);
        return ok(undefined);
      })();
    },
    fail(job: EmbeddingJob, errorCode: string, now: number, maxAttempts: number) {
      if (job.attempts >= maxAttempts) {
        db.transaction(() => {
          db.prepare(`UPDATE embedding_jobs SET state='failed',lease_owner=NULL,lease_until=NULL,last_error_code=?,updated_at=? WHERE id=?`).run(errorCode, now, job.id);
          db.prepare(`INSERT OR REPLACE INTO embedding_dead_letter VALUES (?,?,?,?,?,?)`).run(job.id, job.recordId, job.generation, errorCode, job.attempts, now);
          db.prepare(`UPDATE memory_records SET embedding_state='failed',updated_at=? WHERE id=? AND generation=?`).run(now, job.recordId, job.generation);
        })();
        return err(gatewayError('EMBEDDING_JOB_DEAD_LETTERED', 'embedding job 已进入 dead letter', 'embedding.job.dead_lettered'));
      }
      db.prepare(`UPDATE embedding_jobs SET state='failed',available_at=?,lease_owner=NULL,lease_until=NULL,last_error_code=?,updated_at=? WHERE id=?`).run(now, errorCode, now, job.id);
      return err(gatewayError(errorCode, 'embedding job 失败', 'embedding.job.failed', { retryable: true }));
    },
  };
}
export type EmbeddingJobsRepository = ReturnType<typeof createEmbeddingJobsRepository>;

// src/infrastructure/sqlite/embeddingWorker.ts
import type { MemoryRepository, MemoryRecord } from '../../domain/memory/memoryRepository.js';
import type { EmbeddingJobsRepository } from './embeddingJobsRepository.js';
import { ok } from '../../protocol/results.js';
export function createEmbeddingWorker(options: { jobs: EmbeddingJobsRepository; repository: MemoryRepository & { getActive(id: string): MemoryRecord | null }; workerId: string; leaseMs: number; maxAttempts: number; maxStaleTimeMs: number; now(): number; embed(text: string): Promise<readonly number[]> }) {
  return {
    async runOnce() {
      const claimed = options.jobs.claim(options.workerId, options.now(), options.leaseMs, options.maxAttempts);
      if (!claimed.ok || !claimed.value) return claimed.ok ? ok({ processed: false }) : claimed;
      const record = options.repository.getActive(claimed.value.recordId);
      if (!record) return options.jobs.complete(claimed.value, [], options.now());
      try { const embedding = await options.embed(record.content); const done = options.jobs.complete(claimed.value, embedding, options.now()); return done.ok ? ok({ processed: true, recordId: record.id }) : done; }
      catch { return options.jobs.fail(claimed.value, 'EMBEDDING_PROVIDER_FAILED', options.now(), options.maxAttempts); }
    },
    health() { return options.repository.inspectIndexHealth(options.now(), options.maxStaleTimeMs); },
  };
}

// src/infrastructure/sqlite/memoryRepository.ts
import { createHash } from 'node:crypto';
import type { Db } from '../../store/db.js';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';
import { accessibleScopes, MEMORY_SCOPE_WEIGHT, resolveWriteScope, type MemoryScope } from '../../domain/memory/memoryScope.js';
import { rankMemoryCandidates } from '../../domain/memory/memoryRanking.js';
import type { AppendMemory, IndexHealthIssue, MemoryPatch, MemoryProvenance, MemoryQuery, MemoryRecord, MemoryRepository, RetentionAction } from '../../domain/memory/memoryRepository.js';
const hash = (s: string) => createHash('sha256').update(s.normalize('NFKC')).digest('hex');
const clamp = (n: number) => Math.max(0, Math.min(1, n));
export function openMemoryRepository(db: Db, options: { now(): number; idFactory(prefix: string): string }): MemoryRepository & { getActive(id: string): MemoryRecord | null } {
  const record = (r: Record<string, unknown>): MemoryRecord => ({ id: String(r.id), scopeTier: r.scope_tier as MemoryRecord['scopeTier'], scopeKey: String(r.scope_key), role: r.role as MemoryRecord['role'], content: String(r.content), contentHash: String(r.content_hash), generation: Number(r.generation), embeddingState: r.embedding_state as MemoryRecord['embeddingState'], salience: Number(r.salience), provenance: JSON.parse(String(r.provenance_json)), sourceTrust: Number(r.source_trust), retention: { class: r.retention_class as MemoryRecord['retention']['class'], retainUntil: r.retain_until === null ? null : new Date(Number(r.retain_until)).toISOString() }, createdAt: new Date(Number(r.created_at)).toISOString(), updatedAt: new Date(Number(r.updated_at)).toISOString(), lastSeenAt: new Date(Number(r.last_seen_at)).toISOString(), dedupCount: Number(r.dedup_count), tombstonedAt: r.tombstoned_at === null ? null : new Date(Number(r.tombstoned_at)).toISOString() });
  const filter = (scope: MemoryScope) => {
    const scopes = accessibleScopes(scope); if (!scopes.length) return null;
    return { sql: scopes.map((_, i) => `(scope_tier=@t${i} AND scope_key=@k${i})`).join(' OR '), params: Object.fromEntries(scopes.flatMap((s, i) => [[`t${i}`, s.tier], [`k${i}`, s.key]])) };
  };
  const owned = (id: string, scope: MemoryScope) => { const f = filter(scope); if (!f) return err(gatewayError('MEMORY_SCOPE_REQUIRED', 'scope 必填', 'memory.scope.required')); const row = db.prepare(`SELECT * FROM memory_records WHERE id=@id AND tombstoned_at IS NULL AND (${f.sql})`).get({ id, ...f.params }) as Record<string, unknown> | undefined; return row ? ok(row) : err(gatewayError('MEMORY_SCOPE_DENIED', 'memory scope 拒绝', 'memory.scope.denied')); };
  const tombstone = db.transaction((id: string, now: number) => { db.prepare(`UPDATE memory_records SET embedding_state='tombstoned',tombstoned_at=?,updated_at=? WHERE id=? AND tombstoned_at IS NULL`).run(now, now, id); db.prepare(`DELETE FROM memory_fts WHERE record_id=?`).run(id); db.prepare(`DELETE FROM memory_vectors WHERE record_id=?`).run(id); db.prepare(`UPDATE embedding_jobs SET state='tombstoned',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE record_id=? AND state!='ready'`).run(now, id); });
  const api: MemoryRepository & { getActive(id: string): MemoryRecord | null } = {
    append(input, scope) {
      try { return db.transaction(() => {
        const target = resolveWriteScope(scope); if (!target.ok) return target; const now = options.now(); const content = input.content.normalize('NFKC'); const contentHash = hash(content);
        const existing = db.prepare(`SELECT * FROM memory_records WHERE scope_tier=? AND scope_key=? AND role=? AND content_hash=? AND tombstoned_at IS NULL`).get(target.value.tier, target.value.key, input.role, contentHash) as Record<string, unknown> | undefined;
        const provenance: MemoryProvenance = { ...input.provenance, sourceTrust: clamp(input.provenance.sourceTrust), contentHash };
        if (existing) { const list = JSON.parse(String(existing.provenance_json)) as MemoryProvenance[]; if (!list.some(p => p.sourceType === provenance.sourceType && p.sourceId === provenance.sourceId && p.contentHash === contentHash)) list.push(provenance); db.prepare(`UPDATE memory_records SET provenance_json=?,source_trust=?,last_seen_at=?,updated_at=?,dedup_count=dedup_count+1 WHERE id=?`).run(JSON.stringify(list), Math.max(Number(existing.source_trust), provenance.sourceTrust), now, now, existing.id); return ok({ record: record(db.prepare(`SELECT * FROM memory_records WHERE id=?`).get(existing.id) as Record<string, unknown>), deduplicated: true }); }
        const id = options.idFactory('memory'); const retainUntil = input.retention.retainUntil === null ? null : Date.parse(input.retention.retainUntil);
        db.prepare(`INSERT INTO memory_records VALUES (?,?,?,?,?,?,1,'pending',?,?,?,?,?,?,?,?,1,NULL)`).run(id, target.value.tier, target.value.key, input.role, content, contentHash, clamp(input.salience), JSON.stringify([provenance]), provenance.sourceTrust, input.retention.class, retainUntil, now, now, now);
        db.prepare(`INSERT INTO memory_fts VALUES (?,?,?,?)`).run(id, target.value.tier, target.value.key, content);
        db.prepare(`INSERT INTO embedding_jobs(id,record_id,generation,state,attempts,available_at,created_at,updated_at) VALUES (?,?,1,'pending',0,?,?,?)`).run(options.idFactory('embedding-job'), id, now, now, now);
        return ok({ record: record(db.prepare(`SELECT * FROM memory_records WHERE id=?`).get(id) as Record<string, unknown>), deduplicated: false });
      })(); } catch (cause) { return err(gatewayError('MEMORY_TRANSACTION_FAILED', 'memory append transaction 失败', 'memory.transaction.failed', { retryable: false, details: { cause: String(cause) } })); }
    },
    update(id, patch: MemoryPatch, scope) {
      try { return db.transaction(() => { const current = owned(id, scope); if (!current.ok) return current; const before = record(current.value); const now = options.now(); const content = (patch.content ?? before.content).normalize('NFKC'); const generation = before.generation + 1; const list = [...before.provenance]; if (patch.provenance) list.push({ ...patch.provenance, sourceTrust: clamp(patch.provenance.sourceTrust), contentHash: hash(content) }); const retention = patch.retention ?? before.retention; db.prepare(`UPDATE memory_records SET content=?,content_hash=?,generation=?,embedding_state='pending',salience=?,provenance_json=?,source_trust=?,retention_class=?,retain_until=?,updated_at=? WHERE id=?`).run(content, hash(content), generation, clamp(patch.salience ?? before.salience), JSON.stringify(list), Math.max(...list.map(p => p.sourceTrust)), retention.class, retention.retainUntil === null ? null : Date.parse(retention.retainUntil), now, id); db.prepare(`DELETE FROM memory_fts WHERE record_id=?`).run(id); db.prepare(`INSERT INTO memory_fts VALUES (?,?,?,?)`).run(id, before.scopeTier, before.scopeKey, content); db.prepare(`DELETE FROM memory_vectors WHERE record_id=?`).run(id); db.prepare(`UPDATE embedding_jobs SET state='tombstoned',updated_at=? WHERE record_id=? AND generation<?`).run(now, id, generation); db.prepare(`INSERT INTO embedding_jobs(id,record_id,generation,state,attempts,available_at,created_at,updated_at) VALUES (?,?,?,'pending',0,?,?,?)`).run(options.idFactory('embedding-job'), id, generation, now, now, now); return ok(record(db.prepare(`SELECT * FROM memory_records WHERE id=?`).get(id) as Record<string, unknown>)); })(); } catch (cause) { return err(gatewayError('MEMORY_TRANSACTION_FAILED', 'memory update transaction 失败', 'memory.transaction.failed', { retryable: false, details: { cause: String(cause) } })); }
    },
    delete(id, scope) { const check = owned(id, scope); if (!check.ok) return check; try { tombstone(id, options.now()); return ok(undefined); } catch (cause) { return err(gatewayError('MEMORY_TRANSACTION_FAILED', 'memory delete transaction 失败', 'memory.transaction.failed', { retryable: false, details: { cause: String(cause) } })); } },
    search(query: MemoryQuery, scope) {
      const f = filter(scope); if (!f) return err(gatewayError('MEMORY_SCOPE_REQUIRED', 'scope 必填', 'memory.scope.required'));
      const rows = db.prepare(`SELECT r.*,bm25(memory_fts) fts_rank,v.embedding_json FROM memory_fts JOIN memory_records r ON r.id=memory_fts.record_id LEFT JOIN memory_vectors v ON v.record_id=r.id AND v.generation=r.generation WHERE memory_fts MATCH @match AND r.tombstoned_at IS NULL AND (${f.sql}) LIMIT @limit`).all({ match: query.text, limit: Math.max(query.limit * 8, 32), ...f.params }) as Array<Record<string, unknown>>;
      const ranked = rankMemoryCandidates(rows.map(r => ({ id: String(r.id), fts: 1 / (1 + Math.abs(Number(r.fts_rank))), vector: 0, recency: 1 / (1 + Math.max(0, Date.parse(query.now) - Number(r.updated_at)) / (30 * 86_400_000)), salience: Number(r.salience), sourceTrust: Number(r.source_trust), scopeWeight: MEMORY_SCOPE_WEIGHT[r.scope_tier as keyof typeof MEMORY_SCOPE_WEIGHT] })));
      const byId = new Map(rows.map(r => [String(r.id), r])); return ok(ranked.slice(0, query.limit).map(x => ({ record: record(byId.get(x.id)!), score: x.score, components: x.components })));
    },
    rebuild(scope) { const f = filter(scope); if (!f) return err(gatewayError('MEMORY_SCOPE_REQUIRED', 'scope 必填', 'memory.scope.required')); try { const report = db.transaction(() => { const before = db.prepare(`SELECT COUNT(*) c FROM memory_vectors WHERE record_id NOT IN (SELECT id FROM memory_records WHERE tombstoned_at IS NULL)`).get() as { c: number }; db.prepare(`DELETE FROM memory_vectors WHERE record_id NOT IN (SELECT id FROM memory_records WHERE tombstoned_at IS NULL)`).run(); const rows = db.prepare(`SELECT * FROM memory_records WHERE tombstoned_at IS NULL AND (${f.sql}) ORDER BY id`).all(f.params) as Array<Record<string, unknown>>; for (const r of rows) { db.prepare(`DELETE FROM memory_fts WHERE record_id=?`).run(r.id); db.prepare(`INSERT INTO memory_fts VALUES (?,?,?,?)`).run(r.id, r.scope_tier, r.scope_key, r.content); if (r.embedding_state !== 'ready') db.prepare(`INSERT OR IGNORE INTO embedding_jobs(id,record_id,generation,state,attempts,available_at,created_at,updated_at) VALUES (?,?,?,'pending',0,?,?,?)`).run(`rebuild:${r.id}:${r.generation}`, r.id, r.generation, options.now(), options.now(), options.now()); } return { activeRecords: rows.length, ftsRows: rows.length, queuedEmbeddings: rows.filter(r => r.embedding_state !== 'ready').length, removedOrphans: before.c }; })(); return ok(report); } catch (cause) { return err(gatewayError('MEMORY_TRANSACTION_FAILED', 'memory rebuild transaction 失败', 'memory.transaction.failed', { retryable: false, details: { cause: String(cause) } })); } },
    inspectIndexHealth(now, maxStale) { const issues: IndexHealthIssue[] = []; issues.push(...(db.prepare(`SELECT record_id,created_at FROM embedding_jobs WHERE state IN ('pending','processing') AND created_at<=?`).all(now - maxStale) as Array<{ record_id: string; created_at: number }>).map(r => ({ code: 'EMBEDDING_MAX_STALE_EXCEEDED' as const, recordId: r.record_id, ageMs: now - r.created_at }))); issues.push(...(db.prepare(`SELECT v.record_id FROM memory_vectors v LEFT JOIN memory_records r ON r.id=v.record_id WHERE r.id IS NULL OR r.tombstoned_at IS NOT NULL OR r.generation!=v.generation`).all() as Array<{ record_id: string }>).map(r => ({ code: 'EMBEDDING_ORPHAN_VECTOR' as const, recordId: r.record_id }))); issues.push(...(db.prepare(`SELECT r.id FROM memory_records r LEFT JOIN memory_vectors v ON v.record_id=r.id AND v.generation=r.generation WHERE r.tombstoned_at IS NULL AND r.embedding_state='ready' AND v.record_id IS NULL`).all() as Array<{ id: string }>).map(r => ({ code: 'EMBEDDING_VECTOR_MISSING' as const, recordId: r.id }))); return issues; },
    retentionPlan(now) { return (db.prepare(`SELECT id,retain_until FROM memory_records WHERE tombstoned_at IS NULL AND retain_until IS NOT NULL AND retain_until<=? ORDER BY retain_until,id`).all(now) as Array<{ id: string; retain_until: number }>).map(r => ({ recordId: r.id, action: 'tombstone', retainUntil: new Date(r.retain_until).toISOString() })); },
    applyRetention(actions: readonly RetentionAction[], now) { try { db.transaction(() => { for (const action of actions) tombstone(action.recordId, now); })(); return ok(actions.length); } catch (cause) { return err(gatewayError('MEMORY_TRANSACTION_FAILED', 'retention transaction 失败', 'memory.transaction.failed', { retryable: false, details: { cause: String(cause) } })); } },
    getActive(id) { const row = db.prepare(`SELECT * FROM memory_records WHERE id=? AND tombstoned_at IS NULL`).get(id) as Record<string, unknown> | undefined; return row ? record(row) : null; },
  };
  return api;
}

// scripts/memory-curator.ts
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createMemoryCurator } from '../src/domain/memory/memoryCurator.js';
import { migrateMemory } from '../src/infrastructure/sqlite/memoryMigrations.js';
import { openMemoryRepository } from '../src/infrastructure/sqlite/memoryRepository.js';
import { closeDB, openDB } from '../src/store/db.js';
const args = process.argv.slice(2); const apply = args.includes('--apply');
const dataAt = args.indexOf('--data-dir'); const nowAt = args.indexOf('--now');
const dataDir = resolve(dataAt >= 0 ? String(args[dataAt + 1]) : String(process.env.WXNODUS_DATA_DIR ?? '.wxnodus'));
const now = nowAt >= 0 ? String(args[nowAt + 1]) : new Date().toISOString();
const db = openDB(dataDir);
try {
  migrateMemory(db, { embeddingDimensions: 384 });
  const repository = openMemoryRepository(db, { now: () => Date.parse(now), idFactory: prefix => `${prefix}-${randomUUID()}` });
  const result = createMemoryCurator(repository).run({ mode: apply ? 'apply' : 'dry-run', now });
  process.stdout.write(`${JSON.stringify(result)}\n`); if (!result.ok) process.exitCode = 1;
} finally { closeDB(db); }
```

Integration 必须：

1. `src/store/db.ts` 在 sqlite-vec 加载后调用 `migrateMemory(db,{ embeddingDimensions:384 })`；若 vec0 可用，同事务更新 vec0 与 `memory_vectors` metadata/fallback。
2. session/project/global KNN 分别带 partition predicate 执行，再与同 scope FTS 合并到六分量同池；不得全局 KNN 后 JS 过滤。上面最小代码中的 `vector: 0` 仅是无 vec0 测试 fallback，生产 path 必须传真实归一化 cosine/KNN score。
3. compact、image summary、session delete、memory tools 全部委托 repository；禁止直接改旧 FTS/vector。
4. worker 启动和每 lease 周期调用 `health()`；max stale 必须告警并最旧优先，不静默永久 FTS-only。
5. `npm.cmd run memory:curate -- --data-dir <dir>` 只输出计划；追加 `--apply` 才写库。报告含 action/recordId/retention/provenance sourceId，不输出 secret content。

- [ ] **Step 4: 绿测命令**

```powershell
npm.cmd run test:w1-06
npm.cmd run typecheck:tests
npm.cmd exec -- vitest run tests/kernel-memory.test.ts tests/store-db.test.ts
```

预期：PASS；max stale/orphan/dedup/retention/curator/provenance/六分量排序均有稳定红绿覆盖，mutation 无 stale FTS/vector。

**Commit（仅供后续执行者；本次不提交）**

```text
memory: enforce scoped transactional indexing retention and durable embeddings
```

---

## Task W1-07：PDP、ApprovalGrant、EffectJournal 与 BudgetLedger

**Requirements/Subprojects:** R10、R15、R16、R18；S13 前置；Gate C/F

**Files（精确）**
- Consume: `src/domain/effects/effectDescriptor.ts`（W1-05 唯一 `EffectDescriptor`，本任务不得重定义）
- Create: `src/domain/security/pdp.ts`
- Create: `src/domain/security/approvalGrant.ts`
- Create: `src/domain/effects/effectJournal.ts`
- Create: `src/domain/budget/budgetLedger.ts`
- Create: `src/infrastructure/sqlite/policyRepository.ts`
- Create: `src/infrastructure/sqlite/authorizationUnitOfWork.ts`
- Create: `src/infrastructure/sqlite/securityMigrations.ts`
- Modify: `src/migrations/db/registry.ts`（注册 Wave 1 forward-only additive migration）
- Modify: `src/kernel/permissions.ts`（legacy adapter；ApprovalCache 只抑制重复 UI prompt）
- Modify: `src/store/db.ts`（只调用 migration registry）
- Create: `tests/wave1/w1-07-security-control-plane.test.ts`
- Modify: `package.json`（`test:w1-07` → `vitest run tests/wave1/w1-07-security-control-plane.test.ts`）

**Authoritative contracts / stable codes**

```ts
import type { EffectDescriptor } from '../effects/effectDescriptor.js';
import type { ToolId } from '../tools/toolIds.js';

export interface AuthorizationContext {
  actorId: string; sessionId: string; runId: string; toolId: ToolId;
  argsHash: string; effect: EffectDescriptor; resourceHash: string;
  policySnapshotId: string; budgetSnapshotId: string;
}
export interface ApprovalGrant {
  id: string; actorId: string; sessionId: string; runId: string; toolId: ToolId;
  argsHash: string; effectHash: string; resourceHash: string;
  policySnapshotId: string; budgetSnapshotId: string;
  authorizationContextHash: string; nonce: string; expiresAt: string;
  status: 'issued' | 'consumed' | 'revoked';
}
```

`authorizationContextHash` 对完整 `AuthorizationContext` 做 canonical SHA-256（对象 key 递归排序、数组保持顺序、拒绝 `undefined`/非有限数字）；`effectHash` 对 W1-05 的完整 `EffectDescriptor` 做相同 hash。稳定 code：`POLICY_UNAVAILABLE`、`POLICY_DENIED`、`APPROVAL_CONTEXT_MISMATCH`、`APPROVAL_EXPIRED`、`APPROVAL_REVOKED`、`APPROVAL_REPLAYED`、`POLICY_CHANGED`、`BUDGET_SNAPSHOT_CHANGED`、`BUDGET_EXCEEDED`、`EFFECT_JOURNAL_INTEGRITY_FAILED`。

- [ ] **Step 1: 粘贴完整红测 `tests/wave1/w1-07-security-control-plane.test.ts`**

```ts
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { EffectDescriptor } from '../../src/domain/effects/effectDescriptor.js';
import type { ToolId } from '../../src/domain/tools/toolIds.js';
import { authorizationContextHash, sha256Canonical, type AuthorizationContext } from '../../src/domain/security/approvalGrant.js';
import { SqlitePolicyRepository } from '../../src/infrastructure/sqlite/policyRepository.js';
import { installSecuritySchema, SqliteAuthorizationUnitOfWork } from '../../src/infrastructure/sqlite/authorizationUnitOfWork.js';

const opened: Database.Database[] = [];
const effect: EffectDescriptor = {
  kind: 'filesystem.write', resource: 'file:///workspace/result.txt', operation: 'replace',
  external: false, dataClassification: 'internal', reversibility: 'reversible',
};
const context = (patch: Partial<AuthorizationContext> = {}): AuthorizationContext => ({
  actorId: 'maker-1', sessionId: 'session-1', runId: 'run-1',
  toolId: 'builtin:fs-write' as ToolId,
  argsHash: sha256Canonical({ path: 'result.txt', content: 'safe' }),
  effect, resourceHash: sha256Canonical(effect.resource),
  policySnapshotId: 'policy-1', budgetSnapshotId: 'budget-1', ...patch,
});
function fixture(policyJson = JSON.stringify({
  version: 1, hardRedlineKinds: ['process.spawn'],
  rules: [{ effectKind: 'filesystem.write', action: 'require_approval' }],
}), checksum?: string) {
  const db = new Database(':memory:'); opened.push(db); installSecuritySchema(db);
  db.prepare('INSERT INTO policy_snapshots VALUES(?,?,?,1)')
    .run('policy-1', policyJson, checksum ?? sha256Canonical(JSON.parse(policyJson)));
  db.prepare('INSERT INTO budget_snapshots VALUES(?,?,?,1)')
    .run('budget-1', JSON.stringify({ externalWrites: 1 }), JSON.stringify({ externalWrites: 0 }));
  const policy = new SqlitePolicyRepository(db);
  return { db, policy, uow: new SqliteAuthorizationUnitOfWork(db, policy) };
}
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

describe('W1-07 canonical authorization', () => {
  it('binds budget snapshot and the full canonical context, then consumes once', () => {
    const { uow } = fixture();
    const issued = uow.issue({ id: 'grant-1', context: context(), nonce: 'nonce-1', expiresAt: '2030-01-01T00:00:00.000Z', now: '2026-08-13T00:00:00.000Z' });
    expect(issued).toMatchObject({ ok: true, value: { budgetSnapshotId: 'budget-1', authorizationContextHash: authorizationContextHash(context()) } });
    expect(uow.consumeAndReserve({ grantId: 'grant-1', context: context(), reservation: { externalWrites: 1 }, now: '2026-08-13T00:00:01.000Z' })).toMatchObject({ ok: true });
    expect(uow.consumeAndReserve({ grantId: 'grant-1', context: context(), reservation: { externalWrites: 1 }, now: '2026-08-13T00:00:02.000Z' })).toMatchObject({ ok: false, error: { code: 'APPROVAL_REPLAYED' } });
  });

  it.each([
    { actorId: 'maker-2' }, { sessionId: 'session-2' }, { runId: 'run-2' },
    { toolId: 'builtin:bash' as ToolId }, { argsHash: 'a'.repeat(64) },
    { effect: { ...effect, operation: 'append' } }, { resourceHash: 'b'.repeat(64) },
    { policySnapshotId: 'policy-2' }, { budgetSnapshotId: 'budget-2' },
  ] as Array<Partial<AuthorizationContext>>)('rejects context drift atomically: %j', patch => {
    const { db, uow } = fixture();
    expect(uow.issue({ id: 'grant-drift', context: context(), nonce: 'nonce-drift', expiresAt: '2030-01-01T00:00:00.000Z', now: '2026-08-13T00:00:00.000Z' }).ok).toBe(true);
    expect(uow.consumeAndReserve({ grantId: 'grant-drift', context: context(patch), reservation: { externalWrites: 1 }, now: '2026-08-13T00:00:01.000Z' })).toMatchObject({ ok: false, error: { code: 'APPROVAL_CONTEXT_MISMATCH' } });
    expect(db.prepare('SELECT status FROM approval_grants WHERE id=?').get('grant-drift')).toEqual({ status: 'issued' });
    expect(db.prepare('SELECT count(*) count FROM effect_journal').get()).toEqual({ count: 0 });
    expect(JSON.parse((db.prepare('SELECT used_json FROM budget_snapshots WHERE id=?').get('budget-1') as { used_json: string }).used_json)).toEqual({ externalWrites: 0 });
  });

  it.each([
    ['corrupt', '{"version":', sha256Canonical({ version: 1 })],
    ['truncated', '{"version":1,"rules":[', sha256Canonical({ version: 1 })],
    ['checksum drift', JSON.stringify({ version: 1, hardRedlineKinds: [], rules: [] }), '0'.repeat(64)],
  ])('maps %s policy to POLICY_UNAVAILABLE and creates no side effect', (_name, json, checksum) => {
    const { db, uow } = fixture(json, checksum);
    expect(uow.issue({ id: 'grant-bad', context: context(), nonce: 'nonce-bad', expiresAt: '2030-01-01T00:00:00.000Z', now: '2026-08-13T00:00:00.000Z' })).toMatchObject({ ok: false, error: { code: 'POLICY_UNAVAILABLE' } });
    expect(db.prepare('SELECT count(*) count FROM approval_grants').get()).toEqual({ count: 0 });
  });

  it('maps permission denied to POLICY_UNAVAILABLE', () => {
    const { db } = fixture();
    const denied = new SqlitePolicyRepository(db, () => { throw Object.assign(new Error('denied'), { code: 'SQLITE_AUTH' }); });
    const uow = new SqliteAuthorizationUnitOfWork(db, denied);
    expect(uow.issue({ id: 'grant-denied', context: context(), nonce: 'nonce-denied', expiresAt: '2030-01-01T00:00:00.000Z', now: '2026-08-13T00:00:00.000Z' })).toMatchObject({ ok: false, error: { code: 'POLICY_UNAVAILABLE' } });
  });

  it('enforces hard redlines, expiry, revocation, and budget limits with no partial writes', () => {
    const hard = fixture();
    const processEffect: EffectDescriptor = { ...effect, kind: 'process.spawn', resource: 'process://cmd.exe' };
    expect(hard.uow.issue({ id: 'grant-hard', context: context({ effect: processEffect }), nonce: 'nonce-hard', expiresAt: '2030-01-01T00:00:00.000Z', now: '2026-08-13T00:00:00.000Z' }))
      .toMatchObject({ ok: false, error: { code: 'POLICY_DENIED' } });
    expect(hard.uow.issue({ id: 'grant-expired', context: context(), nonce: 'nonce-expired', expiresAt: '2026-08-12T00:00:00.000Z', now: '2026-08-13T00:00:00.000Z' }))
      .toMatchObject({ ok: false, error: { code: 'APPROVAL_EXPIRED' } });

    const revoked = fixture();
    expect(revoked.uow.issue({ id: 'grant-revoked', context: context(), nonce: 'nonce-revoked', expiresAt: '2030-01-01T00:00:00.000Z', now: '2026-08-13T00:00:00.000Z' }).ok).toBe(true);
    revoked.db.prepare("UPDATE approval_grants SET status='revoked' WHERE id=?").run('grant-revoked');
    expect(revoked.uow.consumeAndReserve({ grantId: 'grant-revoked', context: context(), reservation: { externalWrites: 1 }, now: '2026-08-13T00:00:01.000Z' }))
      .toMatchObject({ ok: false, error: { code: 'APPROVAL_REVOKED' } });

    const budget = fixture();
    expect(budget.uow.issue({ id: 'grant-budget', context: context(), nonce: 'nonce-budget', expiresAt: '2030-01-01T00:00:00.000Z', now: '2026-08-13T00:00:00.000Z' }).ok).toBe(true);
    expect(budget.uow.consumeAndReserve({ grantId: 'grant-budget', context: context(), reservation: { externalWrites: 2 }, now: '2026-08-13T00:00:01.000Z' }))
      .toMatchObject({ ok: false, error: { code: 'BUDGET_EXCEEDED' } });
    expect(budget.db.prepare('SELECT status FROM approval_grants WHERE id=?').get('grant-budget')).toEqual({ status: 'issued' });
    expect(budget.db.prepare('SELECT count(*) count FROM effect_journal').get()).toEqual({ count: 0 });
  });

  it('rechecks policy and budget in the consume transaction and verifies the journal chain', () => {
    const { db, uow } = fixture();
    expect(uow.issue({ id: 'grant-policy', context: context(), nonce: 'nonce-policy', expiresAt: '2030-01-01T00:00:00.000Z', now: '2026-08-13T00:00:00.000Z' }).ok).toBe(true);
    db.prepare('UPDATE policy_snapshots SET active=0').run();
    const replacement = { version: 1, hardRedlineKinds: [], rules: [{ effectKind: 'filesystem.write', action: 'deny' }] };
    db.prepare('INSERT INTO policy_snapshots VALUES(?,?,?,1)').run('policy-2', JSON.stringify(replacement), sha256Canonical(replacement));
    expect(uow.consumeAndReserve({ grantId: 'grant-policy', context: context(), reservation: { externalWrites: 1 }, now: '2026-08-13T00:00:01.000Z' })).toMatchObject({ ok: false, error: { code: 'POLICY_CHANGED' } });
    expect(db.prepare('SELECT status FROM approval_grants WHERE id=?').get('grant-policy')).toEqual({ status: 'issued' });

    const fresh = fixture();
    expect(fresh.uow.issue({ id: 'grant-chain', context: context(), nonce: 'nonce-chain', expiresAt: '2030-01-01T00:00:00.000Z', now: '2026-08-13T00:00:00.000Z' }).ok).toBe(true);
    expect(fresh.uow.consumeAndReserve({ grantId: 'grant-chain', context: context(), reservation: { externalWrites: 1 }, now: '2026-08-13T00:00:01.000Z' }).ok).toBe(true);
    expect(fresh.uow.verifyJournal()).toEqual({ ok: true, value: undefined });
    fresh.db.prepare("UPDATE effect_journal SET payload_json='{}' WHERE sequence=1").run();
    expect(fresh.uow.verifyJournal()).toMatchObject({ ok: false, error: { code: 'EFFECT_JOURNAL_INTEGRITY_FAILED' } });
  });
});
```

- [ ] **Step 2: 红测命令**

```powershell
npm.cmd run test:w1-07
```

预期：FAIL，当前 ApprovalCache 不是授权，且没有 policy/budget snapshot binding、single-use nonce 或事务 journal。

- [ ] **Step 3: 粘贴最小实现（按注释分拆到精确文件）**

```ts
// src/domain/security/approvalGrant.ts
import { createHash } from 'node:crypto';
import type { EffectDescriptor } from '../effects/effectDescriptor.js';
import type { ToolId } from '../tools/toolIds.js';
export interface AuthorizationContext { actorId: string; sessionId: string; runId: string; toolId: ToolId; argsHash: string; effect: EffectDescriptor; resourceHash: string; policySnapshotId: string; budgetSnapshotId: string }
export interface ApprovalGrant { id: string; actorId: string; sessionId: string; runId: string; toolId: ToolId; argsHash: string; effectHash: string; resourceHash: string; policySnapshotId: string; budgetSnapshotId: string; authorizationContextHash: string; nonce: string; expiresAt: string; status: 'issued' | 'consumed' | 'revoked' }
function canonical(value: unknown): string {
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw Object.assign(new Error('CANONICAL_VALUE_UNSUPPORTED'), { code: 'CANONICAL_VALUE_UNSUPPORTED' });
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
export const sha256Canonical = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const authorizationContextHash = (value: AuthorizationContext) => sha256Canonical(value);

// src/infrastructure/sqlite/policyRepository.ts
import type Database from 'better-sqlite3';
import type { OperationResult } from '../../protocol/results.js';
import { sha256Canonical } from '../../domain/security/approvalGrant.js';
export interface PolicyDocument { version: 1; hardRedlineKinds: string[]; rules: Array<{ effectKind: string; action: 'allow' | 'deny' | 'require_approval' }> }
export interface PolicySnapshot { id: string; checksum: string; document: PolicyDocument }
type Row = { id: string; document_json: string; checksum: string };
const unavailable = (): OperationResult<never> => ({ ok: false, error: { code: 'POLICY_UNAVAILABLE', message: 'Policy unavailable', messageKey: 'policy.unavailable', retryable: false } });
export class SqlitePolicyRepository {
  constructor(private readonly db: Database.Database, private readonly readRaw: () => Row | undefined = () => this.db.prepare('SELECT id,document_json,checksum FROM policy_snapshots WHERE active=1').get() as Row | undefined) {}
  loadActive(): OperationResult<PolicySnapshot> {
    try {
      const row = this.readRaw(); if (!row) return unavailable();
      const document = JSON.parse(row.document_json) as PolicyDocument;
      if (document.version !== 1 || !Array.isArray(document.rules) || !Array.isArray(document.hardRedlineKinds) || sha256Canonical(document) !== row.checksum) return unavailable();
      return { ok: true, value: { id: row.id, checksum: row.checksum, document } };
    } catch { return unavailable(); }
  }
}

// src/infrastructure/sqlite/authorizationUnitOfWork.ts
import type Database from 'better-sqlite3';
import type { OperationResult } from '../../protocol/results.js';
import { authorizationContextHash, sha256Canonical, type ApprovalGrant, type AuthorizationContext } from '../../domain/security/approvalGrant.js';
import { SqlitePolicyRepository, type PolicyDocument } from './policyRepository.js';
type Budget = Record<string, number>;
type Code = 'POLICY_UNAVAILABLE'|'POLICY_DENIED'|'APPROVAL_CONTEXT_MISMATCH'|'APPROVAL_EXPIRED'|'APPROVAL_REVOKED'|'APPROVAL_REPLAYED'|'POLICY_CHANGED'|'BUDGET_SNAPSHOT_CHANGED'|'BUDGET_EXCEEDED'|'EFFECT_JOURNAL_INTEGRITY_FAILED';
const fail = (code: Code): OperationResult<never> => ({ ok: false, error: { code, message: code, messageKey: code, retryable: false } });
class Rollback extends Error { constructor(readonly result: OperationResult<never>) { super(result.error.code); } }
const value = <T>(result: OperationResult<T>): T => { if (!result.ok) throw new Rollback(result); return result.value; };
const decision = (policy: PolicyDocument, effectKind: string) => policy.hardRedlineKinds.includes(effectKind) ? 'deny' : policy.rules.find(rule => rule.effectKind === effectKind)?.action ?? 'deny';
export function installSecuritySchema(db: Database.Database): void { db.exec(`
  CREATE TABLE policy_snapshots(id TEXT PRIMARY KEY,document_json TEXT NOT NULL,checksum TEXT NOT NULL,active INTEGER NOT NULL);
  CREATE UNIQUE INDEX policy_one_active ON policy_snapshots(active) WHERE active=1;
  CREATE TABLE budget_snapshots(id TEXT PRIMARY KEY,limits_json TEXT NOT NULL,used_json TEXT NOT NULL,active INTEGER NOT NULL);
  CREATE UNIQUE INDEX budget_one_active ON budget_snapshots(active) WHERE active=1;
  CREATE TABLE approval_grants(id TEXT PRIMARY KEY,context_hash TEXT NOT NULL UNIQUE,context_json TEXT NOT NULL,effect_hash TEXT NOT NULL,nonce TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,status TEXT NOT NULL);
  CREATE TABLE effect_journal(sequence INTEGER PRIMARY KEY AUTOINCREMENT,effect_id TEXT NOT NULL,state TEXT NOT NULL,payload_json TEXT NOT NULL,prev_hash TEXT NOT NULL,entry_hash TEXT NOT NULL,created_at TEXT NOT NULL);
`); }
export class SqliteAuthorizationUnitOfWork {
  constructor(private readonly db: Database.Database, private readonly policies: SqlitePolicyRepository) {}
  issue(input: { id: string; context: AuthorizationContext; nonce: string; expiresAt: string; now: string }): OperationResult<ApprovalGrant> {
    try { return this.db.transaction(() => {
      const policy = value(this.policies.loadActive());
      if (policy.id !== input.context.policySnapshotId) throw new Rollback(fail('POLICY_CHANGED'));
      const budget = this.db.prepare('SELECT id FROM budget_snapshots WHERE active=1').get() as { id: string } | undefined;
      if (!budget || budget.id !== input.context.budgetSnapshotId) throw new Rollback(fail('BUDGET_SNAPSHOT_CHANGED'));
      if (decision(policy.document, input.context.effect.kind) === 'deny') throw new Rollback(fail('POLICY_DENIED'));
      if (input.expiresAt <= input.now) throw new Rollback(fail('APPROVAL_EXPIRED'));
      const grant: ApprovalGrant = { id: input.id, actorId: input.context.actorId, sessionId: input.context.sessionId, runId: input.context.runId, toolId: input.context.toolId, argsHash: input.context.argsHash, effectHash: sha256Canonical(input.context.effect), resourceHash: input.context.resourceHash, policySnapshotId: input.context.policySnapshotId, budgetSnapshotId: input.context.budgetSnapshotId, authorizationContextHash: authorizationContextHash(input.context), nonce: input.nonce, expiresAt: input.expiresAt, status: 'issued' };
      this.db.prepare("INSERT INTO approval_grants VALUES(?,?,?,?,?,?, 'issued')").run(grant.id, grant.authorizationContextHash, JSON.stringify(input.context), grant.effectHash, grant.nonce, grant.expiresAt);
      return { ok: true as const, value: grant };
    })(); } catch (error) { return error instanceof Rollback ? error.result : fail('POLICY_UNAVAILABLE'); }
  }
  consumeAndReserve(input: { grantId: string; context: AuthorizationContext; reservation: Budget; now: string }): OperationResult<{ reservationId: string }> {
    try { return this.db.transaction(() => {
      const grant = this.db.prepare('SELECT * FROM approval_grants WHERE id=?').get(input.grantId) as Record<string, string> | undefined;
      if (!grant || grant.context_hash !== authorizationContextHash(input.context) || grant.effect_hash !== sha256Canonical(input.context.effect)) throw new Rollback(fail('APPROVAL_CONTEXT_MISMATCH'));
      if (grant.status === 'consumed') throw new Rollback(fail('APPROVAL_REPLAYED'));
      if (grant.status === 'revoked') throw new Rollback(fail('APPROVAL_REVOKED'));
      if (grant.expires_at <= input.now) throw new Rollback(fail('APPROVAL_EXPIRED'));
      const policy = value(this.policies.loadActive());
      if (policy.id !== input.context.policySnapshotId) throw new Rollback(fail('POLICY_CHANGED'));
      if (decision(policy.document, input.context.effect.kind) === 'deny') throw new Rollback(fail('POLICY_DENIED'));
      const budget = this.db.prepare('SELECT id,limits_json,used_json FROM budget_snapshots WHERE active=1').get() as { id: string; limits_json: string; used_json: string } | undefined;
      if (!budget || budget.id !== input.context.budgetSnapshotId) throw new Rollback(fail('BUDGET_SNAPSHOT_CHANGED'));
      const limits = JSON.parse(budget.limits_json) as Budget, used = JSON.parse(budget.used_json) as Budget;
      for (const [key, amount] of Object.entries(input.reservation)) if ((used[key] ?? 0) + amount > (limits[key] ?? 0)) throw new Rollback(fail('BUDGET_EXCEEDED'));
      for (const [key, amount] of Object.entries(input.reservation)) used[key] = (used[key] ?? 0) + amount;
      if (this.db.prepare("UPDATE approval_grants SET status='consumed' WHERE id=? AND status='issued'").run(input.grantId).changes !== 1) throw new Rollback(fail('APPROVAL_REPLAYED'));
      this.db.prepare('UPDATE budget_snapshots SET used_json=? WHERE id=?').run(JSON.stringify(used), budget.id);
      this.appendJournal(input.grantId, 'reserved', { contextHash: grant.context_hash, reservation: input.reservation }, input.now);
      return { ok: true as const, value: { reservationId: input.grantId } };
    })(); } catch (error) { return error instanceof Rollback ? error.result : fail('POLICY_UNAVAILABLE'); }
  }
  verifyJournal(): OperationResult<void> {
    let previous = 'GENESIS';
    for (const row of this.db.prepare('SELECT * FROM effect_journal ORDER BY sequence').all() as Array<Record<string, string | number>>) {
      const expected = sha256Canonical({ sequence: row.sequence, effectId: row.effect_id, state: row.state, payloadJson: row.payload_json, previous, createdAt: row.created_at });
      if (row.prev_hash !== previous || row.entry_hash !== expected) return fail('EFFECT_JOURNAL_INTEGRITY_FAILED');
      previous = String(row.entry_hash);
    }
    return { ok: true, value: undefined };
  }
  private appendJournal(effectId: string, state: string, payload: unknown, createdAt: string): void {
    const tail = this.db.prepare('SELECT sequence,entry_hash FROM effect_journal ORDER BY sequence DESC LIMIT 1').get() as { sequence: number; entry_hash: string } | undefined;
    const previous = tail?.entry_hash ?? 'GENESIS', sequence = (tail?.sequence ?? 0) + 1, payloadJson = JSON.stringify(payload);
    const entryHash = sha256Canonical({ sequence, effectId, state, payloadJson, previous, createdAt });
    this.db.prepare('INSERT INTO effect_journal VALUES(?,?,?,?,?,?,?)').run(sequence, effectId, state, payloadJson, previous, entryHash, createdAt);
  }
}
```

`securityMigrations.ts` 使用 W0 `MigrationDescriptor` 声明 additive `forward-only`：保持 N-1 可忽略新表的读写窗口，`reconcile()` 校验 grant/context/budget binding 与 journal chain，`recovery()` 仅允许 forward-fix 或已验证 backup restore。不得用 `IF NOT EXISTS` 成功冒充 migration history/checksum。

- [ ] **Step 4: 绿测命令**

```powershell
npm.cmd run test:w1-07
npm.cmd run typecheck:tests
npm.cmd exec -- vitest run tests/kernel-permissions.test.ts
```

预期：PASS；issue、consume、PDP recheck、budget reserve、grant state 和 journal append 使用同一 SQLite connection/transaction。policy corrupt、truncated、permission-denied、checksum drift 全部 `POLICY_UNAVAILABLE`，所有副作用 fail closed。

**Commit（仅供后续执行者；本次不提交）**

```text
security: bind approvals to canonical effects policy and budget snapshots
```

---

## Task W1-08：统一 ToolExecutionPipeline 与副作用旁路封堵

**Requirements/Subprojects:** R01、R03-R10、R15-R16；S1/S4/S13

**Files（精确）**
- Create: `src/domain/tools/toolExecutionPipeline.ts`
- Create: `src/application/toolExecutionService.ts`
- Create: `src/infrastructure/process/processSupervisor.ts`
- Modify: `src/kernel/agent.ts`
- Modify: `src/kernel/taskRunner.ts`
- Modify: `src/wxnodus-ui/wxGateway.ts`
- Modify: `src/commands/handlers.ts`
- Modify: `src/commands/handlersExt.ts`
- Modify: `src/kernel/tools.ts`
- Create: `tests/wave1/w1-08-tool-execution-pipeline.test.ts`
- Modify: `package.json`（`test:w1-08` → `vitest run tests/wave1/w1-08-tool-execution-pipeline.test.ts`）

**Interfaces / stable codes**

```ts
export interface ToolExecutionPipeline {
  execute(request: ToolExecutionRequest, context: OperationContext, signal: AbortSignal):
    Promise<OperationResult<ToolExecutionReceipt>>;
}
export interface ToolExecutionReceipt {
  effectId: string; toolId: ToolId; state: 'verified';
  value: unknown; evidenceIds: string[]; reservationId?: string;
}
```

稳定 code：`TOOL_INPUT_INVALID`、`POLICY_DENIED`、`POLICY_UNAVAILABLE`、`APPROVAL_REQUIRED`、`BUDGET_EXCEEDED`、`TOOL_EXECUTION_FAILED`、`TOOL_RESULT_INVALID`、`TOOL_POSTCONDITION_FAILED`、`OPERATION_CANCELLED`、`PROCESS_TERMINATION_FAILED`。任何失败都保留原 code；不得把错误字符串包装成 `ok`。

- [ ] **Step 1: 粘贴完整红测 `tests/wave1/w1-08-tool-execution-pipeline.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createToolExecutionPipeline, type PipelinePorts } from '../../src/domain/tools/toolExecutionPipeline.js';
import type { EffectDescriptor } from '../../src/domain/effects/effectDescriptor.js';
import type { ToolDescriptor } from '../../src/domain/tools/toolDescriptor.js';
import type { ToolId } from '../../src/domain/tools/toolIds.js';
import { gatewayError } from '../../src/protocol/errors.js';
import type { OperationContext } from '../../src/protocol/operationContext.js';
import { err, ok } from '../../src/protocol/results.js';

const effect: EffectDescriptor = {
  kind: 'filesystem.write', resource: 'file:///workspace/a.txt', operation: 'replace',
  external: false, dataClassification: 'internal', reversibility: 'reversible',
};
const descriptor: ToolDescriptor = {
  id: 'builtin:fs-write' as ToolId, owner: 'builtin:core',
  inputSchema: { type: 'object', required: ['path', 'content'] }, effects: [effect],
  timeoutMs: 5_000, cancellation: 'required', idempotency: 'conditional', evidenceProducer: true,
};
const context: OperationContext = {
  actorId: 'maker-1', sessionId: 'session-1', runId: 'run-1', correlationId: 'corr-1',
  policySnapshotId: 'policy-1', locale: 'zh-CN', source: 'cli', capabilities: [],
  timestamp: '2026-08-13T00:00:00.000Z',
};
const request = { id: 'effect-1', toolId: descriptor.id, args: { path: 'a.txt', content: 'ok' } };

function fixture(overrides: Partial<PipelinePorts> = {}) {
  const order: string[] = [];
  const step = <T>(name: string, value: T) => vi.fn(async () => { order.push(name); return ok(value); });
  const ports: PipelinePorts = {
    resolve: step('resolve', descriptor), validate: step('validate', undefined),
    normalize: step('normalize', { args: request.args, argsHash: 'a'.repeat(64), effect }),
    decide: step('pdp', { action: 'allow' as const, reasonCode: 'POLICY_ALLOW', obligations: [] }),
    authorizeAndReserve: step('authorize-reserve', { reservationId: 'reservation-1' }),
    execute: vi.fn(async () => { order.push('execute'); return ok({ bytesWritten: 2 }); }),
    appendJournal: vi.fn(async state => { order.push(`journal:${state}`); return ok(undefined); }),
    verifyPostcondition: step('postcondition', undefined),
    captureEvidence: step('evidence', ['evidence-1']), commitBudget: step('commit', undefined),
    releaseBudget: step('release', undefined), ...overrides,
  };
  return { order, ports, pipeline: createToolExecutionPipeline(ports) };
}

describe('W1-08 ToolExecutionPipeline', () => {
  it('uses one fixed order and returns only a verified receipt', async () => {
    const { order, pipeline } = fixture();
    const result = await pipeline.execute(request, context, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, value: { effectId: 'effect-1', state: 'verified', evidenceIds: ['evidence-1'] } });
    expect(order).toEqual(['resolve', 'validate', 'normalize', 'pdp', 'authorize-reserve', 'execute', 'journal:applied', 'postcondition', 'evidence', 'commit']);
  });

  it.each(['POLICY_DENIED', 'POLICY_UNAVAILABLE', 'BUDGET_EXCEEDED'] as const)('fails closed on %s before implementation', async code => {
    const execute = vi.fn();
    const { pipeline } = fixture({
      decide: code === 'POLICY_DENIED'
        ? vi.fn(async () => ok({ action: 'deny' as const, reasonCode: code }))
        : vi.fn(async () => err(gatewayError(code, code, code))),
      authorizeAndReserve: code === 'BUDGET_EXCEEDED'
        ? vi.fn(async () => err(gatewayError(code, code, code)))
        : vi.fn(async () => ok({ reservationId: 'unused' })),
      execute,
    });
    const result = await pipeline.execute(request, context, new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects string-shaped false success and releases reservation', async () => {
    const releaseBudget = vi.fn(async () => ok(undefined));
    const { pipeline } = fixture({ execute: vi.fn(async () => 'failed' as never), releaseBudget });
    expect(await pipeline.execute(request, context, new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'TOOL_RESULT_INVALID' } });
    expect(releaseBudget).toHaveBeenCalledWith('reservation-1', context);
  });

  it('does not apply a late result after cancellation', async () => {
    const controller = new AbortController();
    const appendJournal = vi.fn(async () => ok(undefined));
    const { pipeline } = fixture({
      execute: vi.fn(async () => { controller.abort(); return ok({ late: true }); }), appendJournal,
    });
    expect(await pipeline.execute(request, context, controller.signal)).toMatchObject({ ok: false, error: { code: 'OPERATION_CANCELLED' } });
    expect(appendJournal).toHaveBeenCalledWith('cancelled', expect.anything(), context);
    expect(appendJournal).not.toHaveBeenCalledWith('applied', expect.anything(), context);
  });

  it('passes the W1-05 canonical descriptor unchanged to PDP and authorization', async () => {
    const decide = vi.fn(async () => ok({ action: 'allow' as const, reasonCode: 'POLICY_ALLOW', obligations: [] }));
    const authorizeAndReserve = vi.fn(async () => ok({ reservationId: 'reservation-1' }));
    const { pipeline } = fixture({ decide, authorizeAndReserve });
    await pipeline.execute(request, context, new AbortController().signal);
    expect(decide.mock.calls[0]?.[0].effect).toBe(effect);
    expect(authorizeAndReserve.mock.calls[0]?.[0].effect).toBe(effect);
  });
});
```

- [ ] **Step 2: 红测命令**

```powershell
npm.cmd run test:w1-08
```

预期：FAIL；现有 Agent、TaskRunner、Gateway、memory/config/extension handlers 仍能直接调用实现或进程 API。

- [ ] **Step 3: 粘贴最小 pipeline 实现**

`src/domain/tools/toolExecutionPipeline.ts`

```ts
import type { EffectDescriptor } from '../effects/effectDescriptor.js';
import type { ToolDescriptor } from './toolDescriptor.js';
import type { ToolId } from './toolIds.js';
import type { GatewayError } from '../../protocol/errors.js';
import { gatewayError } from '../../protocol/errors.js';
import type { OperationContext } from '../../protocol/operationContext.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';

export interface ToolExecutionRequest { id: string; toolId: ToolId; args: unknown }
export interface NormalizedExecution { args: unknown; argsHash: string; effect: EffectDescriptor }
export interface ToolExecutionReceipt { effectId: string; toolId: ToolId; state: 'verified'; value: unknown; evidenceIds: string[]; reservationId?: string }
type Decision = { action: 'allow'; reasonCode: string; obligations: unknown[] } | { action: 'deny'; reasonCode: string } | { action: 'require_approval'; reasonCode: string; obligations: unknown[] };
export interface PipelinePorts {
  resolve(toolId: ToolId): Promise<OperationResult<ToolDescriptor>>;
  validate(descriptor: ToolDescriptor, args: unknown): Promise<OperationResult<void>>;
  normalize(descriptor: ToolDescriptor, args: unknown, context: OperationContext): Promise<OperationResult<NormalizedExecution>>;
  decide(input: NormalizedExecution, context: OperationContext): Promise<OperationResult<Decision>>;
  authorizeAndReserve(input: NormalizedExecution, decision: Decision, context: OperationContext): Promise<OperationResult<{ reservationId?: string }>>;
  execute(descriptor: ToolDescriptor, args: unknown, context: OperationContext, signal: AbortSignal): Promise<unknown>;
  appendJournal(state: 'applied' | 'failed' | 'cancelled', payload: unknown, context: OperationContext): Promise<OperationResult<void>>;
  verifyPostcondition(descriptor: ToolDescriptor, value: unknown, context: OperationContext): Promise<OperationResult<void>>;
  captureEvidence(descriptor: ToolDescriptor, value: unknown, context: OperationContext): Promise<OperationResult<string[]>>;
  commitBudget(reservationId: string | undefined, value: unknown, context: OperationContext): Promise<OperationResult<void>>;
  releaseBudget(reservationId: string | undefined, context: OperationContext): Promise<OperationResult<void>>;
}
const cancelled = (): OperationResult<never> => err(gatewayError('OPERATION_CANCELLED', 'Operation cancelled', 'operation.cancelled'));
const malformed = (): OperationResult<never> => err(gatewayError('TOOL_RESULT_INVALID', 'Tool must return OperationResult', 'tool.result.invalid'));
const isResult = (value: unknown): value is OperationResult<unknown> => Boolean(value && typeof value === 'object' && typeof (value as { ok?: unknown }).ok === 'boolean');
export function createToolExecutionPipeline(ports: PipelinePorts) {
  return {
    async execute(request: ToolExecutionRequest, context: OperationContext, signal: AbortSignal): Promise<OperationResult<ToolExecutionReceipt>> {
      if (signal.aborted) return cancelled();
      const descriptor = await ports.resolve(request.toolId); if (!descriptor.ok) return descriptor;
      const valid = await ports.validate(descriptor.value, request.args); if (!valid.ok) return valid;
      const normalized = await ports.normalize(descriptor.value, request.args, context); if (!normalized.ok) return normalized;
      const decision = await ports.decide(normalized.value, context); if (!decision.ok) return decision;
      if (decision.value.action === 'deny') return err(gatewayError('POLICY_DENIED', decision.value.reasonCode, 'policy.denied'));
      const reserved = await ports.authorizeAndReserve(normalized.value, decision.value, context); if (!reserved.ok) return reserved;
      if (signal.aborted) { await ports.releaseBudget(reserved.value.reservationId, context); return cancelled(); }
      const raw = await ports.execute(descriptor.value, normalized.value.args, context, signal);
      if (!isResult(raw)) { await ports.releaseBudget(reserved.value.reservationId, context); return malformed(); }
      if (signal.aborted) { await ports.appendJournal('cancelled', { effectId: request.id }, context); await ports.releaseBudget(reserved.value.reservationId, context); return cancelled(); }
      if (!raw.ok) { await ports.appendJournal('failed', { effectId: request.id, code: raw.error.code }, context); await ports.releaseBudget(reserved.value.reservationId, context); return raw as OperationResult<never>; }
      const applied = await ports.appendJournal('applied', { effectId: request.id, value: raw.value }, context); if (!applied.ok) { await ports.releaseBudget(reserved.value.reservationId, context); return applied; }
      const post = await ports.verifyPostcondition(descriptor.value, raw.value, context); if (!post.ok) { await ports.releaseBudget(reserved.value.reservationId, context); return post; }
      const evidence = await ports.captureEvidence(descriptor.value, raw.value, context); if (!evidence.ok) { await ports.releaseBudget(reserved.value.reservationId, context); return evidence; }
      const committed = await ports.commitBudget(reserved.value.reservationId, raw.value, context); if (!committed.ok) return committed;
      return ok({ effectId: request.id, toolId: request.toolId, state: 'verified', value: raw.value, evidenceIds: evidence.value, reservationId: reserved.value.reservationId });
    },
  };
}
export type ToolExecutionPipeline = ReturnType<typeof createToolExecutionPipeline>;
```

`ToolExecutionService` 只委托该 pipeline。Agent、slash、TaskRunner shell、Gateway shell、memory mutation、config/plugin/skill/MCP 管理都必须从 W1-05 `ToolDescriptor.effects` 取得 canonical effect；静态 bypass test 只允许 `processSupervisor.ts` import `node:child_process`，只允许 repository/migration 文件 import mutating `node:fs` API。Windows `ProcessSupervisor` 取消必须终止 process tree 并用 generation fence 丢弃迟到结果。

- [ ] **Step 4: 绿测命令**

```powershell
npm.cmd run test:w1-08
npm.cmd run typecheck:tests
npm.cmd exec -- vitest run tests/kernel-agent.test.ts tests/kernel-taskRunner.test.ts
```

预期：PASS；所有可达副作用经过统一顺序，任何 policy/grant/budget/journal/evidence 异常都 fail closed。

**Commit（仅供后续执行者；本次不提交）**

```text
core: route every reachable side effect through one pipeline
```

---

## Task W1-09：CompletionGate、闭包 Evidence 与可验证独立复核

**Requirements/Subprojects:** R15、R16、R19；S9

**Files（精确）**
- Create: `src/domain/quality/evidence.ts`
- Create: `src/domain/quality/verification.ts`
- Create: `src/domain/quality/review.ts`
- Create: `src/domain/quality/completionGate.ts`
- Create: `src/application/quality/verifierRegistry.ts`
- Create: `src/infrastructure/quality/fileEvidenceStore.ts`
- Create: `src/infrastructure/quality/fileReviewNonceStore.ts`
- Modify: `src/kernel/agent.ts`
- Modify: `src/kernel/taskRunner.ts`
- Create: `tests/wave1/w1-09-trusted-completion.test.ts`
- Modify: `package.json`（`test:w1-09` → `vitest run tests/wave1/w1-09-trusted-completion.test.ts`）

Wave 1 必须落地可信基础，而不是只接收 verifier/reviewer 自报结果。Wave 3 只能在同一 `VerifierRegistry` 增加 verifier descriptor/adapter 覆盖，不得届时才引入 registry、immutable store、binding、integrity 或 independent review。

**最终信任边界（强制）**：删除 `EvidenceRecord`、`VerificationResult`、`ReviewerAttestation` 和 Gate input 上所有 `trusted: boolean` / `trusted: true` 字段，也不得导出 `{ trusted: true; ... }` 形式的 `Trusted*` 结构类型。调用者可构造的 record、attestation、JSON、spread/type assertion 一律是不可信数据。`FileEvidenceStore.readVerified()` 与 `ReviewerAttestationVerifier.verify()` 只能在全部检查成功后返回 receipt；receipt 由各自实例私有 `WeakSet<object>` 认领，`owns(receipt)` 以对象身份判定来源，不能通过序列化或对象字面量伪造。`CompletionGate` 构造时注入这两个 verifier 实例，只接受二者拥有的 `VerifiedEvidenceReceipt` 与 `VerifiedReviewerAttestationReceipt`，不接受布尔值、自报签名结果或裸 attestation。

**ReviewerAttestationVerifier 合同（强制）**：

1. 以递归 key 排序、数组保序、拒绝 `undefined`/非有限数字的 canonical encoder 重建 review input；输入包含 `schemaVersion/reviewRunId/runId/outcome/maker/reviewer/artifact/environment/policy/evidence/issuer/keyId/nonce/issuedAt/expiresAt`，`reviewInputHash` 为其完整 SHA-256。
2. 逐字段绑定当前 `runId`、artifact `{ id, sha256, commitSha }`、environment `{ snapshotId, sha256 }`、policy `{ snapshotId, sha256 }` 和按顺序且 ID 唯一的完整 `EvidenceRef[]`；任何 drift 为 `REVIEW_BINDING_MISMATCH`。
3. 使用 Node `crypto.verify` 验证 Ed25519 signature；trust policy 必须同时允许 issuer、keyId、算法、key active window、未 revoked、reviewer actor scope。unknown issuer、unknown/revoked/out-of-window key 和 signature mismatch 分别 fail closed，不能签发 receipt。
4. `maker.actorId !== reviewer.actorId` 且 `maker.contextHash !== reviewer.contextHash`；两个条件都必须成立，contextHash 是独立执行上下文的 canonical hash，不得由 Maker 传入 reviewer 字段。
5. 验证 UTC `issuedAt/expiresAt`、`expiresAt > issuedAt`、`now` 位于有效期内、`now-issuedAt <= maxAgeMs` 且未来偏移不超过 `maxClockSkewMs`；过期、过旧或未来票据均 `REVIEW_ATTESTATION_STALE`。
6. 验签和全部 binding/freshness/key policy 成功后，使用 durable `ReviewNonceStore.consume({ issuer,keyId,nonce,reviewInputHash,expiresAt })` 以原子 create-if-absent 消耗 nonce；相同 `(issuer,keyId,nonce)` 第二次消费返回 `REVIEW_ATTESTATION_REPLAYED`。nonce store 不可用时 fail closed 为 `REVIEW_ATTESTATION_INVALID`。

稳定 code：`VERIFIER_NOT_FOUND`、`VERIFIER_DUPLICATE_ID`、`VERIFIER_INPUT_INVALID`、`VERIFIER_ASSERTION_FAILED`、`VERIFIER_CRASH`、`VERIFIER_CANCELLED`、`EVIDENCE_WRITE_FAILED`、`EVIDENCE_IMMUTABLE_VIOLATION`、`EVIDENCE_INTEGRITY_FAILED`、`EVIDENCE_BINDING_MISMATCH`、`EVIDENCE_ATTACHMENT_MISSING`、`EVIDENCE_ATTACHMENT_PATH_INVALID`、`EVIDENCE_ATTACHMENT_ID_DUPLICATE`、`EVIDENCE_ATTACHMENT_LENGTH_MISMATCH`、`EVIDENCE_ATTACHMENT_HASH_MISMATCH`、`EVIDENCE_ATTACHMENT_CLOSURE_INVALID`、`REVIEWER_NOT_INDEPENDENT`、`REVIEW_BINDING_MISMATCH`、`REVIEW_ATTESTATION_INVALID`、`REVIEW_ISSUER_NOT_ALLOWED`、`REVIEW_KEY_NOT_ALLOWED`、`REVIEW_SIGNATURE_INVALID`、`REVIEW_ATTESTATION_STALE`、`REVIEW_ATTESTATION_REPLAYED`、`GATE_UNTRUSTED_INPUT`。

- [ ] **Step 1: 粘贴完整红测 `tests/wave1/w1-09-trusted-completion.test.ts`**

```ts
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTrustedVerifierRegistry } from '../../src/application/quality/verifierRegistry.js';
import { CompletionGate } from '../../src/domain/quality/completionGate.js';
import type { EvidenceAttachment, EvidenceRecord } from '../../src/domain/quality/evidence.js';
import { createReviewerAttestation, ReviewerAttestationVerifier, type ReviewBinding, type ReviewRun } from '../../src/domain/quality/review.js';
import { FileEvidenceStore } from '../../src/infrastructure/quality/fileEvidenceStore.js';
import { FileReviewNonceStore } from '../../src/infrastructure/quality/fileReviewNonceStore.js';

const sha = (char: string) => char.repeat(64);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stdout = Buffer.from('ok', 'utf8'), stderr = Buffer.alloc(0);
const evidence = (): EvidenceRecord => ({
  id: 'evidence-1', schemaVersion: 1, runId: 'run-1', createdAt: '2026-08-13T00:00:00.000Z',
  objective: { id: 'objective-1', description: 'write verified artifact' },
  criteria: [{ id: 'criterion-1', description: 'command exits zero', required: true, expected: 0, observed: 0, status: 'passed' }],
  command: { executable: 'npm.cmd', argv: ['run', 'build'], cwd: 'C:/workspace', normalized: 'npm.cmd run build', timeoutMs: 60_000 },
  exit: { code: 0, signal: null, timedOut: false, aborted: false },
  stdout: { attachmentId: 'stdout-1', relativePath: 'logs/stdout.bin', sha256: digest(stdout), bytes: stdout.byteLength },
  stderr: { attachmentId: 'stderr-1', relativePath: 'logs/stderr.bin', sha256: digest(stderr), bytes: stderr.byteLength },
  artifact: { id: 'artifact-1', sha256: sha('c'), commitSha: '7'.repeat(40) },
  environment: { snapshotId: 'env-1', sha256: sha('d'), platform: 'win32', arch: 'x64' },
  capability: { snapshotId: 'cap-1', sha256: sha('e'), requiredIds: ['process.execute'] },
  policy: { snapshotId: 'policy-1', sha256: sha('f'), decisionId: 'decision-1' },
  verifier: { id: 'command.exit-code', version: '1.0.0', inputSha256: sha('1'), status: 'passed' },
  correlation: { correlationId: 'corr-1', traceId: 'trace-1' },
  lineage: { sessionId: 'session-1', artifactIds: ['artifact-1'], priorEvidenceIds: [] },
  authority: { source: 'process-supervisor', sourceRecordId: 'process-1', sourceStatus: 'passed' },
});
const attachments = (): EvidenceAttachment[] => [
  { attachmentId: 'stdout-1', relativePath: 'logs/stdout.bin', content: stdout },
  { attachmentId: 'stderr-1', relativePath: 'logs/stderr.bin', content: stderr },
];
const reviewRun = (nonce = 'nonce-1'): ReviewRun => ({
  id: 'review-1', runId: 'run-1', maker: { actorId: 'maker-1', contextHash: sha('7') }, reviewer: { actorId: 'reviewer-1', contextHash: sha('9') },
  artifact: evidence().artifact, environment: { snapshotId: 'env-1', sha256: sha('d') }, policy: { snapshotId: 'policy-1', sha256: sha('f') },
  evidence: [], status: 'completed', startedAt: '2026-08-13T00:01:00.000Z', completedAt: '2026-08-13T00:01:30.000Z', nonce,
});
const binding = (evidenceRefs: ReviewBinding['evidence']): ReviewBinding => ({ runId: 'run-1', artifact: evidence().artifact,
  environment: { snapshotId: 'env-1', sha256: sha('d') }, policy: { snapshotId: 'policy-1', sha256: sha('f') }, evidence: evidenceRefs });
function reviewFixture(root: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signer = { issuer: 'review-service-1', keyId: 'review-key-1', sign: async (hash: Uint8Array) => sign(null, hash, privateKey) };
  const verifier = new ReviewerAttestationVerifier({ resolve: (issuer, keyId) => issuer === signer.issuer && keyId === signer.keyId ? {
    issuer, keyId, algorithm: 'Ed25519' as const, publicKey, reviewerActorIds: ['reviewer-1'], activeFrom: '2026-08-01T00:00:00.000Z',
    activeUntil: '2026-09-01T00:00:00.000Z', maxAgeMs: 600_000, maxClockSkewMs: 5_000,
  } : undefined }, new FileReviewNonceStore(join(root, 'review-nonces')));
  return { signer, verifier };
}

describe('W1-09 trusted quality foundation', () => {
  it('runs registered verifiers without exposing caller-assignable trust', async () => {
    const registry = createTrustedVerifierRegistry({ fileExists: async () => true });
    const passed = await registry.verify({ id: 'v1', verifierId: 'command.exit-code', input: { actual: 0, expected: 0 } }, new AbortController().signal);
    expect(passed).toMatchObject({ ok: true, value: { status: 'passed' } });
    if (passed.ok) expect(passed.value.authority).not.toHaveProperty('trusted');
    expect(await registry.verify({ id: 'v2', verifierId: 'unknown', input: {} }, new AbortController().signal))
      .toMatchObject({ ok: false, error: { code: 'VERIFIER_NOT_FOUND' } });
  });

  it('closes record attachment references and rejects missing/path/id/length/hash defects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-w1-evidence-')), store = new FileEvidenceStore(root);
    const ref = await store.append(evidence(), attachments()); if (!ref.ok) throw new Error(ref.error.code);
    expect(await store.readVerified(ref.value)).toMatchObject({ ok: true, value: { record: { id: 'evidence-1' } } });
    await rm(join(root, 'records', 'evidence-1', 'attachments', 'logs', 'stdout.bin'));
    expect(await store.readVerified(ref.value)).toMatchObject({ ok: false, error: { code: 'EVIDENCE_ATTACHMENT_MISSING' } });

    const duplicate = evidence(); duplicate.stderr = { ...duplicate.stderr, attachmentId: duplicate.stdout.attachmentId };
    expect(await new FileEvidenceStore(await mkdtemp(join(tmpdir(), 'wxnodus-dup-'))).append(duplicate, attachments()))
      .toMatchObject({ ok: false, error: { code: 'EVIDENCE_ATTACHMENT_ID_DUPLICATE' } });
    const escaped = evidence(); escaped.stdout = { ...escaped.stdout, relativePath: '../escape.bin' };
    expect(await new FileEvidenceStore(await mkdtemp(join(tmpdir(), 'wxnodus-path-'))).append(escaped, attachments()))
      .toMatchObject({ ok: false, error: { code: 'EVIDENCE_ATTACHMENT_PATH_INVALID' } });
    const short = evidence(); short.stdout = { ...short.stdout, bytes: 1 };
    expect(await new FileEvidenceStore(await mkdtemp(join(tmpdir(), 'wxnodus-len-'))).append(short, attachments()))
      .toMatchObject({ ok: false, error: { code: 'EVIDENCE_ATTACHMENT_LENGTH_MISMATCH' } });
    const corrupt = evidence(); corrupt.stdout = { ...corrupt.stdout, sha256: sha('0') };
    expect(await new FileEvidenceStore(await mkdtemp(join(tmpdir(), 'wxnodus-hash-'))).append(corrupt, attachments()))
      .toMatchObject({ ok: false, error: { code: 'EVIDENCE_ATTACHMENT_HASH_MISMATCH' } });
  });

  it('verifies canonical bindings/signature/key policy/freshness and rejects replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-review-')), store = new FileEvidenceStore(root);
    const ref = await store.append(evidence(), attachments()); if (!ref.ok) throw new Error(ref.error.code);
    const { signer, verifier } = reviewFixture(root), expected = binding([ref.value]);
    const attestation = await createReviewerAttestation({ ...reviewRun(), evidence: [ref.value] }, 'passed', signer,
      { issuedAt: '2026-08-13T00:02:00.000Z', expiresAt: '2026-08-13T00:07:00.000Z' });
    if (!attestation.ok) throw new Error(attestation.error.code);
    expect(await verifier.verify(attestation.value, expected, '2026-08-13T00:03:00.000Z')).toMatchObject({ ok: true });
    expect(await verifier.verify(attestation.value, expected, '2026-08-13T00:03:01.000Z'))
      .toMatchObject({ ok: false, error: { code: 'REVIEW_ATTESTATION_REPLAYED' } });
    const forged = { ...attestation.value, signature: Buffer.alloc(64).toString('base64') };
    expect(await reviewFixture(await mkdtemp(join(tmpdir(), 'wxnodus-forged-'))).verifier.verify(forged, expected, '2026-08-13T00:03:00.000Z'))
      .toMatchObject({ ok: false, error: { code: 'REVIEW_SIGNATURE_INVALID' } });
    const stale = await createReviewerAttestation({ ...reviewRun('nonce-stale'), evidence: [ref.value] }, 'passed', signer,
      { issuedAt: '2026-08-12T00:00:00.000Z', expiresAt: '2026-08-12T00:05:00.000Z' });
    if (!stale.ok) throw new Error(stale.error.code);
    expect(await reviewFixture(await mkdtemp(join(tmpdir(), 'wxnodus-stale-'))).verifier.verify(stale.value, expected, '2026-08-13T00:03:00.000Z'))
      .toMatchObject({ ok: false, error: { code: 'REVIEW_ATTESTATION_STALE' } });
  });

  it('CompletionGate rejects forged trusted objects and accepts only verifier-owned receipts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-gate-')), store = new FileEvidenceStore(root);
    const ref = await store.append(evidence(), attachments()); if (!ref.ok) throw new Error(ref.error.code);
    const verifiedEvidence = await store.readVerified(ref.value); if (!verifiedEvidence.ok) throw new Error(verifiedEvidence.error.code);
    const { signer, verifier } = reviewFixture(root), expected = binding([ref.value]);
    const signed = await createReviewerAttestation({ ...reviewRun(), evidence: [ref.value] }, 'passed', signer,
      { issuedAt: '2026-08-13T00:02:00.000Z', expiresAt: '2026-08-13T00:07:00.000Z' }); if (!signed.ok) throw new Error(signed.error.code);
    const review = await verifier.verify(signed.value, expected, '2026-08-13T00:03:00.000Z'); if (!review.ok) throw new Error(review.error.code);
    const gate = new CompletionGate(store, verifier), input = { ...expected, requiredCriterionIds: ['criterion-1'], evidence: [verifiedEvidence.value], review: review.value };
    expect(gate.decide(input, '2026-08-13T00:03:01.000Z')).toMatchObject({ ok: true, value: { status: 'succeeded' } });
    expect(gate.decide({ ...input, review: { trusted: true, attestation: signed.value } as never }, '2026-08-13T00:03:01.000Z'))
      .toMatchObject({ ok: false, error: { code: 'GATE_UNTRUSTED_INPUT' } });
    expect(gate.decide({ ...input, evidence: [{ ...verifiedEvidence.value }] as never }, '2026-08-13T00:03:01.000Z'))
      .toMatchObject({ ok: false, error: { code: 'GATE_UNTRUSTED_INPUT' } });
    expect(gate.decide({ ...input, artifact: { ...input.artifact, commitSha: '8'.repeat(40) } }, '2026-08-13T00:03:01.000Z'))
      .toMatchObject({ ok: false, error: { code: 'EVIDENCE_BINDING_MISMATCH' } });
  });
});
```

- [ ] **Step 2: 红测命令**

```powershell
npm.cmd run test:w1-09
```

预期：FAIL；当前 evidence 可变、attachment 没有引用闭包，reviewer attestation 无验签/issuer-key policy/freshness/nonce/replay，且普通对象可通过 `trusted: true` 伪造 Gate 信任。

- [ ] **Step 3: 粘贴完整最小实现**

`src/domain/quality/evidence.ts`

```ts
export type VerificationStatus = 'passed' | 'failed' | 'inconclusive' | 'cancelled';
export type AuthoritySource = 'process-supervisor' | 'filesystem-reader' | 'workspace-reader' | 'http-client' |
  'database-client' | 'browser-driver' | 'uia-driver' | 'ocr-engine' | 'approval-repository';
export interface ArtifactBinding { id: string; sha256: string; commitSha: string }
export interface EvidenceAttachmentRef { attachmentId: string; relativePath: string; sha256: string; bytes: number }
export interface EvidenceAttachment { attachmentId: string; relativePath: string; content: Uint8Array }
export interface EvidenceRecord {
  id: string; schemaVersion: 1; runId: string; createdAt: string; objective: { id: string; description: string };
  criteria: Array<{ id: string; description: string; required: boolean; expected: unknown; observed: unknown; status: VerificationStatus; failureCode?: string }>;
  command: { executable: string; argv: string[]; cwd: string; normalized: string; timeoutMs: number };
  exit: { code: number | null; signal: string | null; timedOut: boolean; aborted: boolean };
  stdout: EvidenceAttachmentRef; stderr: EvidenceAttachmentRef; artifact: ArtifactBinding;
  environment: { snapshotId: string; sha256: string; platform: NodeJS.Platform; arch: string };
  capability: { snapshotId: string; sha256: string; requiredIds: string[] }; policy: { snapshotId: string; sha256: string; decisionId: string };
  verifier: { id: string; version: string; inputSha256: string; status: VerificationStatus };
  correlation: { correlationId: string; causationId?: string; traceId: string };
  lineage: { sessionId: string; parentRunId?: string; taskId?: string; artifactIds: string[]; priorEvidenceIds: string[] };
  authority: { source: AuthoritySource; sourceRecordId: string; sourceStatus: VerificationStatus };
}
export interface EvidenceRef { id: string; sha256: string }
export type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T : T extends readonly (infer U)[] ? readonly DeepReadonly<U>[] : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export interface VerifiedEvidenceReceipt { readonly record: DeepReadonly<EvidenceRecord>; readonly ref: DeepReadonly<EvidenceRef>; readonly verifiedAt: string }
```

`VerifiedEvidenceReceipt` 不含 `trusted` 字段；TypeScript interface 本身不是安全边界，运行时真实性只由创建它的 `FileEvidenceStore.owns()` 判定。

`src/domain/quality/verification.ts`

```ts
import type { AuthoritySource, VerificationStatus } from './evidence.js'; import type { OperationResult } from '../../protocol/results.js';
export interface VerificationRequest { id: string; verifierId: string; input: unknown }
export interface VerificationResult { verificationId: string; status: VerificationStatus; observed: unknown; failureCode?: string;
  authority: { source: AuthoritySource; sourceRecordId: string; sourceStatus: VerificationStatus } }
export interface VerifierRegistry { verify(request: VerificationRequest, signal: AbortSignal): Promise<OperationResult<VerificationResult>> }
```

`src/application/quality/verifierRegistry.ts`

```ts
import { gatewayError } from '../../protocol/errors.js'; import { err, ok } from '../../protocol/results.js';
import type { VerificationResult, VerifierRegistry } from '../../domain/quality/verification.js';
type Verifier = (input: unknown, signal: AbortSignal) => Promise<VerificationResult>;
export function createTrustedVerifierRegistry(probe: { fileExists(path: string): Promise<boolean> }): VerifierRegistry {
  const verifiers = new Map<string, Verifier>();
  const register = (id: string, verifier: Verifier) => { if (verifiers.has(id)) throw Object.assign(new Error('duplicate'), { code: 'VERIFIER_DUPLICATE_ID' }); verifiers.set(id, verifier); };
  register('command.exit-code', async (input, signal) => {
    if (signal.aborted) return { verificationId: '', status: 'cancelled', observed: null, failureCode: 'VERIFIER_CANCELLED', authority: { source: 'process-supervisor', sourceRecordId: 'cancelled', sourceStatus: 'cancelled' } };
    const value = input as { actual?: unknown; expected?: unknown }; if (typeof value?.actual !== 'number' || typeof value?.expected !== 'number') throw Object.assign(new Error('invalid'), { code: 'VERIFIER_INPUT_INVALID' });
    const passed = value.actual === value.expected; return { verificationId: '', status: passed ? 'passed' : 'failed', observed: value.actual, failureCode: passed ? undefined : 'VERIFIER_ASSERTION_FAILED', authority: { source: 'process-supervisor', sourceRecordId: `exit:${value.actual}`, sourceStatus: passed ? 'passed' : 'failed' } };
  });
  register('file.exists', async (input, signal) => {
    if (signal.aborted) return { verificationId: '', status: 'cancelled', observed: null, failureCode: 'VERIFIER_CANCELLED', authority: { source: 'filesystem-reader', sourceRecordId: 'cancelled', sourceStatus: 'cancelled' } };
    const path = (input as { path?: unknown })?.path; if (typeof path !== 'string') throw Object.assign(new Error('invalid'), { code: 'VERIFIER_INPUT_INVALID' });
    const exists = await probe.fileExists(path); return { verificationId: '', status: exists ? 'passed' : 'failed', observed: exists, failureCode: exists ? undefined : 'VERIFIER_ASSERTION_FAILED', authority: { source: 'filesystem-reader', sourceRecordId: path, sourceStatus: exists ? 'passed' : 'failed' } };
  });
  return { async verify(request, signal) {
    const verifier = verifiers.get(request.verifierId); if (!verifier) return err(gatewayError('VERIFIER_NOT_FOUND', request.verifierId, 'verifier.notFound'));
    try { return ok({ ...(await verifier(request.input, signal)), verificationId: request.id }); }
    catch (error) { if ((error as { code?: string }).code === 'VERIFIER_INPUT_INVALID') return err(gatewayError('VERIFIER_INPUT_INVALID', 'Invalid verifier input', 'verifier.input.invalid')); return ok({ verificationId: request.id, status: 'inconclusive', observed: null, failureCode: 'VERIFIER_CRASH', authority: { source: 'process-supervisor', sourceRecordId: request.id, sourceStatus: 'inconclusive' } }); }
  } };
}
```

`src/infrastructure/quality/fileEvidenceStore.ts`

```ts
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { EvidenceAttachment, EvidenceAttachmentRef, EvidenceRecord, EvidenceRef, VerifiedEvidenceReceipt } from '../../domain/quality/evidence.js';
import { gatewayError } from '../../protocol/errors.js'; import { err, ok, type OperationResult } from '../../protocol/results.js';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object') { for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item); Object.freeze(value); }
  return value as DeepReadonly<T>;
}
const safeId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
const fail = <T = never>(code: string): OperationResult<T> => err(gatewayError(code, code, `evidence.${code.toLowerCase()}`));
const raise = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const refsOf = (record: EvidenceRecord): EvidenceAttachmentRef[] => [record.stdout, record.stderr];
function containedPath(base: string, relativePath: string): string | null {
  if (!relativePath || relativePath.includes('\\') || relativePath.includes('\0') || relativePath.split('/').some(part => !part || part === '.' || part === '..')) return null;
  const target = resolve(base, ...relativePath.split('/')), rel = relative(base, target);
  return !rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : target;
}
async function listRegularFiles(root: string, prefix = ''): Promise<string[]> {
  const dir = prefix ? join(root, ...prefix.split('/')) : root, output: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) raise('EVIDENCE_ATTACHMENT_PATH_INVALID');
    if (entry.isDirectory()) output.push(...await listRegularFiles(root, path));
    else if (entry.isFile()) output.push(path);
    else raise('EVIDENCE_ATTACHMENT_PATH_INVALID');
  }
  return output.sort();
}
export class FileEvidenceStore {
  readonly #receipts = new WeakSet<object>();
  constructor(private readonly root: string, private readonly clock: () => string = () => new Date().toISOString()) {}
  owns(receipt: unknown): receipt is VerifiedEvidenceReceipt { return typeof receipt === 'object' && receipt !== null && this.#receipts.has(receipt); }
  async append(record: EvidenceRecord, attachments: readonly EvidenceAttachment[]): Promise<OperationResult<EvidenceRef>> {
    if (!safeId(record.id) || !safeId(record.runId)) return fail('EVIDENCE_WRITE_FAILED');
    const refs = refsOf(record), refIds = refs.map(x => x.attachmentId), refPaths = refs.map(x => x.relativePath), inputIds = attachments.map(x => x.attachmentId);
    if (new Set(refIds).size !== refs.length || new Set(inputIds).size !== attachments.length) return fail('EVIDENCE_ATTACHMENT_ID_DUPLICATE');
    if (new Set(refPaths).size !== refs.length) return fail('EVIDENCE_ATTACHMENT_CLOSURE_INVALID');
    const byId = new Map(attachments.map(item => [item.attachmentId, item]));
    if (byId.size !== refs.length || refs.some(ref => !byId.has(ref.attachmentId)) || attachments.some(item => !refIds.includes(item.attachmentId))) return fail('EVIDENCE_ATTACHMENT_CLOSURE_INVALID');
    for (const ref of refs) {
      const input = byId.get(ref.attachmentId)!;
      if (!safeId(ref.attachmentId) || input.relativePath !== ref.relativePath) return fail('EVIDENCE_ATTACHMENT_CLOSURE_INVALID');
      if (!containedPath('/', ref.relativePath)) return fail('EVIDENCE_ATTACHMENT_PATH_INVALID');
      if (input.content.byteLength !== ref.bytes) return fail('EVIDENCE_ATTACHMENT_LENGTH_MISMATCH');
      if (!/^[a-f0-9]{64}$/.test(ref.sha256) || digest(input.content) !== ref.sha256) return fail('EVIDENCE_ATTACHMENT_HASH_MISMATCH');
    }
    const recordsRoot = join(this.root, 'records'), finalDir = join(recordsRoot, record.id);
    const tempDir = join(recordsRoot, `.tmp-${record.id}-${randomUUID()}`), attachmentRoot = join(tempDir, 'attachments');
    try {
      await mkdir(attachmentRoot, { recursive: true });
      for (const ref of refs) {
        const input = byId.get(ref.attachmentId)!, target = containedPath(attachmentRoot, ref.relativePath); if (!target) raise('EVIDENCE_ATTACHMENT_PATH_INVALID');
        await mkdir(dirname(target), { recursive: true }); const handle = await open(target, 'wx');
        try { await handle.writeFile(input.content); await handle.sync(); } finally { await handle.close(); }
        const readback = await open(target, 'r');
        try { const stat = await readback.stat(), bytes = await readback.readFile(); if (!stat.isFile() || stat.size !== ref.bytes || bytes.byteLength !== ref.bytes) raise('EVIDENCE_ATTACHMENT_LENGTH_MISMATCH'); if (digest(bytes) !== ref.sha256) raise('EVIDENCE_ATTACHMENT_HASH_MISMATCH'); }
        finally { await readback.close(); }
      }
      const recordBytes = Buffer.from(JSON.stringify(record), 'utf8'), recordHandle = await open(join(tempDir, 'record.json'), 'wx');
      try { await recordHandle.writeFile(recordBytes); await recordHandle.sync(); } finally { await recordHandle.close(); }
      await rename(tempDir, finalDir);
      for (const ref of refs) await chmod(join(finalDir, 'attachments', ...ref.relativePath.split('/')), 0o444); await chmod(join(finalDir, 'record.json'), 0o444);
      const ref = { id: record.id, sha256: digest(recordBytes) }, verified = await this.verifyStored(ref); if (!verified.ok) return verified;
      return ok(ref);
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      const code = (error as NodeJS.ErrnoException).code;
      if (typeof code === 'string' && code.startsWith('EVIDENCE_')) return fail(code);
      return code === 'EEXIST' || code === 'ENOTEMPTY' ? fail('EVIDENCE_IMMUTABLE_VIOLATION') : fail('EVIDENCE_WRITE_FAILED');
    }
  }
  async verifyIntegrity(ref: EvidenceRef): Promise<OperationResult<EvidenceRef>> { const result = await this.verifyStored(ref); return result.ok ? ok(ref) : result; }
  async readVerified(ref: EvidenceRef): Promise<OperationResult<VerifiedEvidenceReceipt>> {
    const result = await this.verifyStored(ref); if (!result.ok) return result;
    const receipt = Object.freeze({ record: Object.freeze(result.value), ref: Object.freeze({ ...ref }), verifiedAt: this.clock() });
    this.#receipts.add(receipt); return ok(receipt);
  }
  private async verifyStored(ref: EvidenceRef): Promise<OperationResult<EvidenceRecord>> {
    try {
      if (!safeId(ref.id) || !/^[a-f0-9]{64}$/.test(ref.sha256)) return fail('EVIDENCE_INTEGRITY_FAILED');
      const recordDir = join(this.root, 'records', ref.id), recordPath = join(recordDir, 'record.json'), recordHandle = await open(recordPath, 'r');
      let recordBytes: Buffer;
      try { const stat = await recordHandle.stat(); if (!stat.isFile()) return fail('EVIDENCE_INTEGRITY_FAILED'); recordBytes = await recordHandle.readFile(); }
      finally { await recordHandle.close(); }
      if (digest(recordBytes) !== ref.sha256) return fail('EVIDENCE_INTEGRITY_FAILED');
      const record = JSON.parse(recordBytes.toString('utf8')) as EvidenceRecord;
      if (record.id !== ref.id || record.schemaVersion !== 1 || record.authority?.sourceStatus !== record.verifier.status) return fail('EVIDENCE_INTEGRITY_FAILED');
      const refs = refsOf(record);
      if (new Set(refs.map(x => x.attachmentId)).size !== refs.length) return fail('EVIDENCE_ATTACHMENT_ID_DUPLICATE');
      if (new Set(refs.map(x => x.relativePath)).size !== refs.length) return fail('EVIDENCE_ATTACHMENT_CLOSURE_INVALID');
      const attachmentRoot = join(recordDir, 'attachments'), realRoot = await realpath(attachmentRoot).catch(() => null); if (!realRoot) return fail('EVIDENCE_ATTACHMENT_MISSING');
      const actual = await listRegularFiles(attachmentRoot), expected = refs.map(x => x.relativePath).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) return fail('EVIDENCE_ATTACHMENT_CLOSURE_INVALID');
      for (const attachment of refs) {
        const target = containedPath(attachmentRoot, attachment.relativePath); if (!target) return fail('EVIDENCE_ATTACHMENT_PATH_INVALID');
        const stat = await lstat(target).catch(() => null); if (!stat) return fail('EVIDENCE_ATTACHMENT_MISSING'); if (!stat.isFile() || stat.isSymbolicLink()) return fail('EVIDENCE_ATTACHMENT_PATH_INVALID');
        const realTarget = await realpath(target), rel = relative(realRoot, realTarget); if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return fail('EVIDENCE_ATTACHMENT_PATH_INVALID');
        const handle = await open(target, 'r');
        try { const opened = await handle.stat(), bytes = await handle.readFile(); if (!opened.isFile() || opened.size !== attachment.bytes || bytes.byteLength !== attachment.bytes) return fail('EVIDENCE_ATTACHMENT_LENGTH_MISMATCH'); if (!/^[a-f0-9]{64}$/.test(attachment.sha256) || digest(bytes) !== attachment.sha256) return fail('EVIDENCE_ATTACHMENT_HASH_MISMATCH'); }
        finally { await handle.close(); }
      }
      return ok(record);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return fail('EVIDENCE_ATTACHMENT_MISSING');
      return typeof code === 'string' && code.startsWith('EVIDENCE_') ? fail(code) : fail('EVIDENCE_INTEGRITY_FAILED');
    }
  }
}
```

`append()` 先验证输入引用集合，再把 record 与 attachments 写到同一临时目录、对打开的文件句柄 readback，最后原子 rename；`readVerified()` 每次都重新读取实际字节。attachment 目录中的实际 regular-file 集合必须与 record 引用集合逐项相等，既不能 missing 也不能多出游离文件。

`src/infrastructure/quality/fileReviewNonceStore.ts`

```ts
import { createHash } from 'node:crypto'; import { mkdir, open } from 'node:fs/promises'; import { join } from 'node:path';
import type { ReviewNonceStore } from '../../domain/quality/review.js'; import { gatewayError } from '../../protocol/errors.js'; import { err, ok, type OperationResult } from '../../protocol/results.js';
export class FileReviewNonceStore implements ReviewNonceStore {
  constructor(private readonly root: string) {}
  async consume(input: { issuer: string; keyId: string; nonce: string; reviewInputHash: string; expiresAt: string }): Promise<OperationResult<void>> {
    const key = createHash('sha256').update(`${input.issuer}\0${input.keyId}\0${input.nonce}`).digest('hex');
    try {
      await mkdir(this.root, { recursive: true }); const handle = await open(join(this.root, `${key}.used`), 'wx');
      try { await handle.writeFile(JSON.stringify(input)); await handle.sync(); } finally { await handle.close(); }
      return ok(undefined);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EEXIST'
        ? err(gatewayError('REVIEW_ATTESTATION_REPLAYED', 'Review nonce already consumed', 'review.attestation.replayed'))
        : err(gatewayError('REVIEW_ATTESTATION_INVALID', 'Review nonce store unavailable', 'review.nonce.unavailable'));
    }
  }
}
```

`src/domain/quality/review.ts`

```ts
import { createHash, verify as verifySignature, type KeyObject } from 'node:crypto'; import type { ArtifactBinding, EvidenceRef } from './evidence.js';
import { gatewayError } from '../../protocol/errors.js'; import { err, ok, type OperationResult } from '../../protocol/results.js';
export interface ReviewRun { id: string; runId: string; maker: { actorId: string; contextHash: string }; reviewer: { actorId: string; contextHash: string }; artifact: ArtifactBinding; environment: { snapshotId: string; sha256: string }; policy: { snapshotId: string; sha256: string }; evidence: EvidenceRef[]; status: 'running' | 'completed'; startedAt: string; completedAt?: string; nonce: string }
export interface ReviewBinding { runId: string; artifact: ArtifactBinding; environment: ReviewRun['environment']; policy: ReviewRun['policy']; evidence: EvidenceRef[] }
export interface ReviewerAttestation { schemaVersion: 1; reviewRunId: string; runId: string; outcome: 'passed' | 'failed' | 'inconclusive'; maker: ReviewRun['maker']; reviewer: ReviewRun['reviewer']; artifact: ArtifactBinding; environment: ReviewRun['environment']; policy: ReviewRun['policy']; evidence: EvidenceRef[]; issuer: string; keyId: string; nonce: string; issuedAt: string; expiresAt: string; reviewInputHash: string; signature: string }
export interface VerifiedReviewerAttestationReceipt { readonly attestation: Readonly<ReviewerAttestation>; readonly bindingHash: string; readonly verifiedAt: string }
export interface ReviewNonceStore { consume(input: { issuer: string; keyId: string; nonce: string; reviewInputHash: string; expiresAt: string }): Promise<OperationResult<void>> }
export interface ReviewerKeyPolicy { issuer: string; keyId: string; algorithm: 'Ed25519'; publicKey: KeyObject; reviewerActorIds: readonly string[]; activeFrom: string; activeUntil: string; revokedAt?: string; maxAgeMs: number; maxClockSkewMs: number }
export interface ReviewerTrustPolicy { resolve(issuer: string, keyId: string): ReviewerKeyPolicy | undefined }
const canonical = (value: unknown): string => {
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('CANONICAL_VALUE_UNSUPPORTED');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
};
const hashCanonical = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const same = (left: unknown, right: unknown) => hashCanonical(left) === hashCanonical(right);
function unsigned(run: ReviewRun, outcome: ReviewerAttestation['outcome'], authority: { issuer: string; keyId: string }, time: { issuedAt: string; expiresAt: string }) {
  return { schemaVersion: 1 as const, reviewRunId: run.id, runId: run.runId, outcome, maker: run.maker, reviewer: run.reviewer,
    artifact: run.artifact, environment: run.environment, policy: run.policy, evidence: run.evidence,
    issuer: authority.issuer, keyId: authority.keyId, nonce: run.nonce, issuedAt: time.issuedAt, expiresAt: time.expiresAt };
}
export async function createReviewerAttestation(run: ReviewRun, outcome: ReviewerAttestation['outcome'], authority: { issuer: string; keyId: string; sign(hash: Uint8Array): Promise<Uint8Array> }, time: { issuedAt: string; expiresAt: string }): Promise<OperationResult<ReviewerAttestation>> {
  try { const body = unsigned(run, outcome, authority, time), reviewInputHash = hashCanonical(body); return ok({ ...body, reviewInputHash, signature: Buffer.from(await authority.sign(Buffer.from(reviewInputHash, 'hex'))).toString('base64') }); }
  catch { return err(gatewayError('REVIEW_ATTESTATION_INVALID', 'Review signing failed', 'review.attestation.invalid')); }
}
export class ReviewerAttestationVerifier {
  readonly #receipts = new WeakSet<object>();
  constructor(private readonly policy: ReviewerTrustPolicy, private readonly nonces: ReviewNonceStore) {}
  owns(receipt: unknown): receipt is VerifiedReviewerAttestationReceipt { return typeof receipt === 'object' && receipt !== null && this.#receipts.has(receipt); }
  async verify(attestation: ReviewerAttestation, expected: ReviewBinding, now: string): Promise<OperationResult<VerifiedReviewerAttestationReceipt>> {
    try {
      if (attestation.maker.actorId === attestation.reviewer.actorId || attestation.maker.contextHash === attestation.reviewer.contextHash)
        return err(gatewayError('REVIEWER_NOT_INDEPENDENT', 'Reviewer identity and context must both be independent', 'reviewer.notIndependent'));
      if (attestation.runId !== expected.runId || !same(attestation.artifact, expected.artifact) || !same(attestation.environment, expected.environment) || !same(attestation.policy, expected.policy) || !same(attestation.evidence, expected.evidence))
        return err(gatewayError('REVIEW_BINDING_MISMATCH', 'Review binding mismatch', 'review.binding.mismatch'));
      if (!attestation.nonce || new Set(attestation.evidence.map(item => item.id)).size !== attestation.evidence.length)
        return err(gatewayError('REVIEW_ATTESTATION_INVALID', 'Review input invalid', 'review.attestation.invalid'));
      const key = this.policy.resolve(attestation.issuer, attestation.keyId);
      if (!key) return err(gatewayError('REVIEW_ISSUER_NOT_ALLOWED', 'Review issuer/key unknown', 'review.issuer.notAllowed'));
      if (key.algorithm !== 'Ed25519' || key.revokedAt || !key.reviewerActorIds.includes(attestation.reviewer.actorId))
        return err(gatewayError('REVIEW_KEY_NOT_ALLOWED', 'Review key not allowed', 'review.key.notAllowed'));
      const nowMs = Date.parse(now), issued = Date.parse(attestation.issuedAt), expires = Date.parse(attestation.expiresAt), activeFrom = Date.parse(key.activeFrom), activeUntil = Date.parse(key.activeUntil);
      if (![nowMs, issued, expires, activeFrom, activeUntil].every(Number.isFinite) || expires <= issued || issued > nowMs + key.maxClockSkewMs || expires <= nowMs || nowMs - issued > key.maxAgeMs)
        return err(gatewayError('REVIEW_ATTESTATION_STALE', 'Review attestation stale', 'review.attestation.stale'));
      if (issued < activeFrom || issued >= activeUntil) return err(gatewayError('REVIEW_KEY_NOT_ALLOWED', 'Review key inactive', 'review.key.notAllowed'));
      const body = { schemaVersion: attestation.schemaVersion, reviewRunId: attestation.reviewRunId, runId: attestation.runId, outcome: attestation.outcome,
        maker: attestation.maker, reviewer: attestation.reviewer, artifact: attestation.artifact, environment: attestation.environment, policy: attestation.policy,
        evidence: attestation.evidence, issuer: attestation.issuer, keyId: attestation.keyId, nonce: attestation.nonce, issuedAt: attestation.issuedAt, expiresAt: attestation.expiresAt };
      const reviewInputHash = hashCanonical(body);
      if (reviewInputHash !== attestation.reviewInputHash) return err(gatewayError('REVIEW_ATTESTATION_INVALID', 'Canonical review input mismatch', 'review.attestation.invalid'));
      if (!verifySignature(null, Buffer.from(reviewInputHash, 'hex'), key.publicKey, Buffer.from(attestation.signature, 'base64')))
        return err(gatewayError('REVIEW_SIGNATURE_INVALID', 'Review signature invalid', 'review.signature.invalid'));
      const consumed = await this.nonces.consume({ issuer: attestation.issuer, keyId: attestation.keyId, nonce: attestation.nonce, reviewInputHash, expiresAt: attestation.expiresAt });
      if (!consumed.ok) return consumed;
      const receipt = Object.freeze({ attestation: Object.freeze({ ...attestation }), bindingHash: hashCanonical(expected), verifiedAt: now });
      this.#receipts.add(receipt); return ok(receipt);
    } catch { return err(gatewayError('REVIEW_ATTESTATION_INVALID', 'Review attestation invalid', 'review.attestation.invalid')); }
  }
}
```

`createReviewerAttestation()` 只生成不可信的 signed input，不能生成 receipt；independence、binding、issuer/key/signature、freshness 和 replay 只由 `ReviewerAttestationVerifier.verify()` 裁决。

`src/domain/quality/completionGate.ts`

```ts
import type { ArtifactBinding, VerifiedEvidenceReceipt } from './evidence.js';
import type { ReviewBinding, ReviewerAttestationVerifier, VerifiedReviewerAttestationReceipt } from './review.js';
import type { FileEvidenceStore } from '../../infrastructure/quality/fileEvidenceStore.js'; import type { RunFinalStatus } from '../../protocol/runs.js';
import { gatewayError } from '../../protocol/errors.js'; import { err, ok, type OperationResult } from '../../protocol/results.js';
export interface CompletionDecision { runId: string; status: RunFinalStatus; artifact: ArtifactBinding; criterionResults: Array<{ id: string; status: string }>; evidenceIds: string[]; reviewInputHash: string; reasons: string[]; decidedAt: string }
interface Input extends Omit<ReviewBinding, 'evidence'> { requiredCriterionIds: string[]; evidence: VerifiedEvidenceReceipt[]; review: VerifiedReviewerAttestationReceipt }
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export class CompletionGate {
  constructor(private readonly evidenceStore: FileEvidenceStore, private readonly reviewerVerifier: ReviewerAttestationVerifier) {}
  decide(input: Input, decidedAt: string): OperationResult<CompletionDecision> {
    if (!input.evidence.length || !input.evidence.every(receipt => this.evidenceStore.owns(receipt)) || !this.reviewerVerifier.owns(input.review))
      return err(gatewayError('GATE_UNTRUSTED_INPUT', 'Gate accepts verifier-owned receipts only', 'gate.untrustedInput'));
    const records = input.evidence.map(item => item.record), refs = input.evidence.map(item => item.ref);
    if (records.some(record => record.runId !== input.runId || !same(record.artifact, input.artifact) || record.environment.snapshotId !== input.environment.snapshotId || record.environment.sha256 !== input.environment.sha256 || record.policy.snapshotId !== input.policy.snapshotId || record.policy.sha256 !== input.policy.sha256))
      return err(gatewayError('EVIDENCE_BINDING_MISMATCH', 'Evidence binding mismatch', 'evidence.binding.mismatch'));
    const review = input.review.attestation;
    if (review.runId !== input.runId || !same(review.artifact, input.artifact) || !same(review.environment, input.environment) || !same(review.policy, input.policy) || !same(review.evidence, refs))
      return err(gatewayError('REVIEW_BINDING_MISMATCH', 'Review binding mismatch', 'review.binding.mismatch'));
    const criteria = records.flatMap(record => record.criteria).filter(criterion => input.requiredCriterionIds.includes(criterion.id));
    const missing = input.requiredCriterionIds.some(id => !criteria.some(criterion => criterion.id === id));
    const status: RunFinalStatus = missing ? 'incomplete' : criteria.some(criterion => criterion.status === 'failed') || review.outcome === 'failed' ? 'failed'
      : criteria.some(criterion => criterion.status === 'cancelled') ? 'cancelled'
      : criteria.some(criterion => criterion.status === 'inconclusive') || review.outcome === 'inconclusive' ? 'inconclusive' : 'succeeded';
    return ok({ runId: input.runId, status, artifact: input.artifact, criterionResults: criteria.map(criterion => ({ id: criterion.id, status: criterion.status })),
      evidenceIds: refs.map(ref => ref.id), reviewInputHash: review.reviewInputHash, reasons: status === 'succeeded' ? [] : [status], decidedAt });
  }
}
```

Maker 只能提交 `candidate_complete`；`AgentResult.ok` 不能写 final status，Task parent 聚合 `CompletionDecision` 而不是 bool。`CompletionGate` 不提供默认构造器，组合根必须注入签发当前 receipts 的同一 `FileEvidenceStore` 与 `ReviewerAttestationVerifier` 实例。spread/JSON/type assertion 产生的新对象不在私有 `WeakSet` 中，因此即使携带 `trusted: true` 也必须 `GATE_UNTRUSTED_INPUT`。任何 record/attachment/checksum、artifact `sha256/commitSha`、environment、policy、evidence list 或 review binding 漂移均 fail closed。

- [ ] **Step 4: 绿测命令**

```powershell
npm.cmd run test:w1-09
npm.cmd run typecheck:tests
npm.cmd exec -- vitest run tests/kernel-agent.test.ts tests/kernel-taskRunner.test.ts
```

预期：PASS；Wave 1 已拥有最小可信 registry/store/review/completion foundation；Wave 3 只增加 verifier 覆盖和 authoritative adapters。

**Commit（仅供后续执行者；本次不提交）**

```text
quality: establish trusted evidence and independent completion review
```

---

## Task W1-10：Offline Provider 无 API key 端到端可达

**Requirements/Subprojects:** R10、R15、R17；Model core

**Files（精确）**
- Create: `src/domain/models/modelProvider.ts`
- Create: `src/application/models/modelRouter.ts`
- Create: `src/infrastructure/providers/offlineProvider.ts`
- Create: `src/infrastructure/providers/cloudProvider.ts`
- Modify: `src/kernel/providers.ts`
- Modify: `src/kernel/offlineModel.ts`
- Modify: `src/kernel/llmStream.ts`
- Modify: `src/kernel/llmOnce.ts`
- Modify: `src/kernel/agent.ts`
- Modify: `src/commands/handlers.ts`
- Modify: `src/commands/handlersExt.ts`
- Create: `tests/wave1/w1-10-offline-provider.test.ts`
- Modify: `package.json`（`test:w1-10` → `vitest run tests/wave1/w1-10-offline-provider.test.ts`）

**Stable codes**

`MODEL_PROVIDER_NOT_FOUND`、`MODEL_API_KEY_REQUIRED`、`OFFLINE_MODEL_NOT_READY`、`OFFLINE_MODEL_LOAD_FAILED`、`MODEL_INFERENCE_TIMEOUT`、`MODEL_INFERENCE_CANCELLED`、`MODEL_INFERENCE_FAILED`、`MODEL_EMPTY_RESPONSE`、`MODEL_TOOL_CALL_UNSUPPORTED`。

- [ ] **Step 1: 粘贴完整红测 `tests/wave1/w1-10-offline-provider.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest';
import { ModelRouter } from '../../src/application/models/modelRouter.js';
import { CloudProvider } from '../../src/infrastructure/providers/cloudProvider.js';
import { OfflineProvider } from '../../src/infrastructure/providers/offlineProvider.js';
import type { ModelInferenceRequest } from '../../src/domain/models/modelProvider.js';
import type { OperationContext } from '../../src/protocol/operationContext.js';

const context: OperationContext = { actorId: 'maker-1', sessionId: 'session-1', runId: 'run-1', correlationId: 'corr-1',
  policySnapshotId: 'policy-1', locale: 'zh-CN', source: 'kernel', capabilities: ['offline-model'], timestamp: '2026-08-13T00:00:00.000Z' };
const request = (modelId: string): ModelInferenceRequest => ({ modelId, messages: [{ role: 'user', content: 'reply with text' }] });
const offlineId = 'offline:Qwen2.5-1.5B';

describe('W1-10 provider route', () => {
  it('routes a cached offline model before any API-key gate', async () => {
    const infer = vi.fn(async () => ({ content: 'local answer', promptTokens: 4, completionTokens: 2 }));
    const router = new ModelRouter([
      new OfflineProvider({ isReady: () => true, infer }),
      new CloudProvider({ infer: vi.fn() }),
    ]);
    const result = await router.infer(request(offlineId), context, null, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, value: { content: 'local answer', modelId: offlineId,
      usage: { kind: 'estimated', promptTokens: 4, completionTokens: 2 }, toolCalls: [] } });
    expect(infer).toHaveBeenCalledOnce();
  });

  it('requires a key only after routing to a cloud descriptor', async () => {
    const router = new ModelRouter([new OfflineProvider({ isReady: () => true, infer: vi.fn() }), new CloudProvider({ infer: vi.fn() })]);
    expect(await router.infer(request('deepseek-chat'), context, null, new AbortController().signal))
      .toMatchObject({ ok: false, error: { code: 'MODEL_API_KEY_REQUIRED' } });
  });

  it.each([
    ['not-ready', { isReady: () => false, infer: vi.fn() }, 'OFFLINE_MODEL_NOT_READY'],
    ['load-failed', { isReady: () => true, infer: vi.fn(async () => { throw Object.assign(new Error('load'), { code: 'OFFLINE_MODEL_LOAD_FAILED' }); }) }, 'OFFLINE_MODEL_LOAD_FAILED'],
  ] as const)('returns %s as a stable code', async (_name, adapter, code) => {
    const router = new ModelRouter([new OfflineProvider(adapter)]);
    expect(await router.infer(request(offlineId), context, null, new AbortController().signal)).toMatchObject({ ok: false, error: { code } });
  });

  it('distinguishes timeout and cancellation and fences late output', async () => {
    const pending: Array<(value: { content: string; promptTokens: number; completionTokens: number }) => void> = [];
    const provider = new OfflineProvider({ isReady: () => true, infer: vi.fn(() => new Promise(resolve => pending.push(resolve))) });
    const controller = new AbortController();
    const work = provider.infer({ ...request(offlineId), timeoutMs: 5_000 }, context, null, controller.signal);
    controller.abort(); pending[0]?.({ content: 'late', promptTokens: 1, completionTokens: 1 });
    expect(await work).toMatchObject({ ok: false, error: { code: 'MODEL_INFERENCE_CANCELLED' } });
  });

  it('never converts offline text that resembles a tool call into an executable call', async () => {
    const provider = new OfflineProvider({ isReady: () => true,
      infer: vi.fn(async () => ({ content: '{"tool":"filesystem.write","args":{"path":"x"}}', promptTokens: 9, completionTokens: 4 })) });
    const result = await provider.infer(request(offlineId), context, null, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, value: { toolCalls: [] } });
    if (result.ok) expect(result.value.content).toContain('filesystem.write');
  });
});
```

- [ ] **Step 2: 红测命令**

```powershell
npm.cmd run test:w1-10
```

预期：FAIL；现有入口仍可能在 provider route 前 key gate，离线错误为自然语言字符串且 usage 固定 `0/0`。

- [ ] **Step 3: 粘贴完整最小实现**

`src/domain/models/modelProvider.ts`

```ts
import type { ChatMessage } from '../../kernel/providers.js';
import type { OperationContext } from '../../protocol/operationContext.js';
import type { OperationResult } from '../../protocol/results.js';
export interface ModelProviderDescriptor { id: string; modelPrefix: string; requiresApiKey: boolean;
  capabilities: { streaming: boolean; toolCalls: boolean; vision: boolean } }
export interface ModelInferenceRequest { modelId: string; messages: ChatMessage[]; timeoutMs?: number; tools?: unknown[] }
export interface ModelInferenceResponse { modelId: string; content: string; toolCalls: Array<{ id: string; name: string; arguments: string }>;
  usage: { kind: 'measured' | 'estimated'; promptTokens: number; completionTokens: number } | { kind: 'unavailable'; reasonCode: string } }
export interface ModelProvider { descriptor: ModelProviderDescriptor; supports(modelId: string): boolean;
  infer(request: ModelInferenceRequest, context: OperationContext, apiKey: string | null, signal: AbortSignal): Promise<OperationResult<ModelInferenceResponse>> }
```

`src/infrastructure/providers/offlineProvider.ts`

```ts
import type { ModelInferenceRequest, ModelInferenceResponse, ModelProvider } from '../../domain/models/modelProvider.js';
import type { OperationContext } from '../../protocol/operationContext.js';
import { gatewayError } from '../../protocol/errors.js'; import { err, ok } from '../../protocol/results.js';
type Adapter = { isReady(modelId: string): boolean;
  infer(modelId: string, request: ModelInferenceRequest, signal: AbortSignal): Promise<{ content: string; promptTokens?: number; completionTokens?: number }> };
export class OfflineProvider implements ModelProvider {
  readonly descriptor = { id: 'offline', modelPrefix: 'offline:', requiresApiKey: false,
    capabilities: { streaming: true, toolCalls: false, vision: false } } as const;
  constructor(private readonly adapter: Adapter) {}
  supports(modelId: string) { return modelId.startsWith(this.descriptor.modelPrefix); }
  async infer(request: ModelInferenceRequest, _context: OperationContext, _apiKey: string | null, signal: AbortSignal): Promise<OperationResult<ModelInferenceResponse>> {
    if (!this.adapter.isReady(request.modelId)) return err(gatewayError('OFFLINE_MODEL_NOT_READY', 'Offline model is not ready', 'offline.notReady'));
    if (request.tools?.length) return err(gatewayError('MODEL_TOOL_CALL_UNSUPPORTED', 'Offline provider does not support tools', 'model.tools.unsupported'));
    if (signal.aborted) return err(gatewayError('MODEL_INFERENCE_CANCELLED', 'Inference cancelled', 'model.cancelled'));
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'MODEL_INFERENCE_TIMEOUT' })), request.timeoutMs ?? 120_000); });
      const value = await Promise.race([this.adapter.infer(request.modelId, request, signal), timeout]);
      if (signal.aborted) return err(gatewayError('MODEL_INFERENCE_CANCELLED', 'Inference cancelled', 'model.cancelled'));
      if (!value.content.trim()) return err(gatewayError('MODEL_EMPTY_RESPONSE', 'Model returned empty content', 'model.empty'));
      const usage = typeof value.promptTokens === 'number' && typeof value.completionTokens === 'number'
        ? { kind: 'estimated' as const, promptTokens: value.promptTokens, completionTokens: value.completionTokens }
        : { kind: 'unavailable' as const, reasonCode: 'OFFLINE_USAGE_UNAVAILABLE' };
      return ok({ modelId: request.modelId, content: value.content, toolCalls: [], usage });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (signal.aborted) return err(gatewayError('MODEL_INFERENCE_CANCELLED', 'Inference cancelled', 'model.cancelled'));
      if (code === 'MODEL_INFERENCE_TIMEOUT' || code === 'OFFLINE_MODEL_LOAD_FAILED') return err(gatewayError(code, code, `model.${code}`));
      return err(gatewayError('MODEL_INFERENCE_FAILED', 'Offline inference failed', 'model.inference.failed'));
    } finally { if (timer) clearTimeout(timer); }
  }
}
```

`src/infrastructure/providers/cloudProvider.ts`

```ts
import type { ModelInferenceRequest, ModelProvider } from '../../domain/models/modelProvider.js';
import type { OperationContext } from '../../protocol/operationContext.js';
import { gatewayError } from '../../protocol/errors.js'; import { err } from '../../protocol/results.js';
export class CloudProvider implements ModelProvider {
  readonly descriptor = { id: 'cloud-openai-compatible', modelPrefix: '', requiresApiKey: true,
    capabilities: { streaming: true, toolCalls: true, vision: true } } as const;
  constructor(private readonly adapter: { infer(request: ModelInferenceRequest, key: string, signal: AbortSignal): Promise<any> }) {}
  supports(modelId: string) { return !modelId.startsWith('offline:'); }
  async infer(request: ModelInferenceRequest, _context: OperationContext, apiKey: string | null, signal: AbortSignal) {
    if (!apiKey) return err(gatewayError('MODEL_API_KEY_REQUIRED', 'API key required', 'model.apiKey.required'));
    return this.adapter.infer(request, apiKey, signal);
  }
}
```

`src/application/models/modelRouter.ts`

```ts
import type { ModelInferenceRequest, ModelProvider } from '../../domain/models/modelProvider.js';
import type { OperationContext } from '../../protocol/operationContext.js';
import { gatewayError } from '../../protocol/errors.js'; import { err } from '../../protocol/results.js';
export class ModelRouter {
  constructor(private readonly providers: ModelProvider[]) {}
  async infer(request: ModelInferenceRequest, context: OperationContext, apiKey: string | null, signal: AbortSignal) {
    const provider = this.providers.find(candidate => candidate.supports(request.modelId));
    if (!provider) return err(gatewayError('MODEL_PROVIDER_NOT_FOUND', request.modelId, 'model.provider.notFound'));
    if (provider.descriptor.requiresApiKey && !apiKey) return err(gatewayError('MODEL_API_KEY_REQUIRED', 'API key required', 'model.apiKey.required'));
    return provider.infer(request, context, apiKey, signal);
  }
}
```

`providers.ts` 只负责 catalog/key resolution，不得在 route 前拒绝所有 no-key 请求。`llmStream.ts`、`llmOnce.ts`、Agent、`/compact`、`/build` 先调用 `ModelRouter`；offline descriptor 的 `toolCalls=false` 必须使请求不携带 tools，响应始终 `toolCalls: []`，文本中的 JSON 永远只作为文本。`/offline download|on` 是 W1-08 pipeline 副作用；generation/Abort fence 使取消后的迟到 inference 不更新 Run。

- [ ] **Step 4: 绿测命令**

```powershell
npm.cmd run test:w1-10
npm.cmd run typecheck:tests
npm.cmd exec -- vitest run tests/kernel-offlineModel.test.ts tests/kernel-providers.test.ts tests/kernel-llmStream.test.ts
```

预期：PASS；cached offline 模型无需 key 可达，cloud 仍强制 key，所有错误只按 stable code 分支。

**Commit（仅供后续执行者；本次不提交）**

```text
models: make the offline provider a first-class route
```

---

## Task W1-11：Wave 1 Capability Fence、Migration Drill、E2E 与 Gate

**Requirements/Subprojects:** R01、R03、R09-R12、R15-R16；S1/S3/S5/S9

**Dependency（强制）**：W1-11 依赖 W1-02 的 `CapabilityPort`/`CapabilitySnapshot`；W1-11 **修改实现而不创建第二个 capability interface**。后续 **W2-03 显式依赖 W1-11**，并只能扩展此 registry/port 的能力与生命周期，不得平行创建 capability 系统。

**Files（精确）**
- Consume/Modify implementation only: `src/domain/capabilities/capability.ts`（W1-02 owner；只在确需扩展既有 union 时修改，禁止重声明 `CapabilityPort`）
- Create: `src/application/capabilities/capabilityRegistry.ts`
- Create: `tests/wave1/w1-11-capability-gate.test.ts`
- Create: `scripts/run-wave1-gates.mjs`
- Create: `scripts/run-wave1-migration-drill.mjs`
- Modify: `src/release/gateDefinitions.ts`
- Modify: `package.json`：
  - `test:w1-11` → `vitest run tests/wave1/w1-11-capability-gate.test.ts`
  - `gate:wave1` → `node scripts/run-wave1-gates.mjs`
  - `migration:drill:wave1` → `node scripts/run-wave1-migration-drill.mjs`
  - `test:wave1:trusted-kernel` → `vitest run tests/wave1/w1-01-protocol.test.ts tests/wave1/w1-02-bootstrap.test.ts tests/wave1/w1-03-http-gateway-security.test.ts tests/wave1/w1-04-command-contract.test.ts tests/wave1/w1-05-tool-catalog.test.ts tests/wave1/w1-06-memory-durability.test.ts tests/wave1/w1-07-security-control-plane.test.ts tests/wave1/w1-08-tool-execution-pipeline.test.ts tests/wave1/w1-09-trusted-completion.test.ts tests/wave1/w1-10-offline-provider.test.ts tests/wave1/w1-11-capability-gate.test.ts`

**Stable codes**：`CAPABILITY_UNAVAILABLE`（W1-02 authoritative）、`GATE_REQUIRED_FAILED`、`GATE_EVIDENCE_UNTRUSTED`、`GATE_REVIEW_UNTRUSTED`、`GATE_NOT_APPLICABLE_INVALID`、`MIGRATION_DRILL_FAILED`。

- [ ] **Step 1: 粘贴完整红测 `tests/wave1/w1-11-capability-gate.test.ts`**

```ts
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Wave1CapabilityRegistry } from '../../src/application/capabilities/capabilityRegistry.js';
import type { CapabilityPort } from '../../src/domain/capabilities/capability.js';
import { evaluateWave1Gates } from '../../src/release/gateDefinitions.js';
import { FileEvidenceStore } from '../../src/infrastructure/quality/fileEvidenceStore.js';
import type { TrustedReviewerAttestation } from '../../src/domain/quality/review.js';

const unavailable = ['voice', 'computer', 'forge', 'distribution'] as const;
const sha = (c: string) => c.repeat(64);
const reviewer: TrustedReviewerAttestation = { trusted: true, attestation: {
  id: 'att-1', reviewRunId: 'review-1', runId: 'gate-wave1', outcome: 'passed',
  maker: { actorId: 'maker-1', contextHash: sha('1') }, reviewer: { actorId: 'reviewer-1', contextHash: sha('2') },
  artifact: { id: 'artifact-1', sha256: sha('3') }, environment: { snapshotId: 'env-1', sha256: sha('4') },
  policy: { snapshotId: 'policy-1', sha256: sha('5') }, evidence: [], reviewInputHash: sha('6'),
  issuer: 'review-service-1', signature: 'sig', trusted: true, createdAt: '2026-08-13T00:00:00.000Z',
} };

describe('W1-11 capability and gate boundary', () => {
  it('implements the W1-02 CapabilityPort and fences undelivered capabilities at every adapter', () => {
    const registry: CapabilityPort = new Wave1CapabilityRegistry('policy-1', () => '2026-08-13T00:00:00.000Z');
    for (const id of unavailable) expect(registry.require(id)).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE' } });
    expect(registry.require('command')).toMatchObject({ ok: true });
  });

  it('Gate G accepts only integrity-checked Evidence and trusted reviewer attestations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-wave1-gate-')); const store = new FileEvidenceStore(root);
    const record = { id: 'gate-evidence-1', schemaVersion: 1, runId: 'gate-wave1', createdAt: '2026-08-13T00:00:00.000Z',
      objective: { id: 'gate-g', description: 'trusted completion' }, criteria: [{ id: 'gate-g', description: 'trusted completion', required: true, expected: true, observed: true, status: 'passed' }],
      command: { executable: 'npm.cmd', argv: ['run', 'test:w1-11'], cwd: 'C:/workspace', normalized: 'npm.cmd run test:w1-11', timeoutMs: 60_000 },
      exit: { code: 0, signal: null, timedOut: false, aborted: false }, stdout: { attachmentId: 'stdout', sha256: sha('a'), bytes: 1 }, stderr: { attachmentId: 'stderr', sha256: sha('b'), bytes: 0 },
      artifact: reviewer.attestation.artifact, environment: { ...reviewer.attestation.environment, platform: 'win32', arch: 'x64' },
      capability: { snapshotId: 'cap-1', sha256: sha('c'), requiredIds: ['command'] }, policy: { ...reviewer.attestation.policy, decisionId: 'decision-1' },
      verifier: { id: 'command.exit-code', version: '1.0.0', inputSha256: sha('d'), status: 'passed' }, correlation: { correlationId: 'corr-1', traceId: 'trace-1' },
      lineage: { sessionId: 'session-1', artifactIds: ['artifact-1'], priorEvidenceIds: [] }, authority: { source: 'process-supervisor', sourceRecordId: 'proc-1', sourceStatus: 'passed', trusted: true },
    } as const;
    const ref = await store.append(record); if (!ref.ok) throw new Error(ref.error.code);
    const trusted = await store.readTrusted(ref.value); if (!trusted.ok) throw new Error(trusted.error.code);
    const gates = evaluateWave1Gates([{ id: 'G', required: true, evidence: [trusted.value], reviewer }]);
    expect(gates).toMatchObject({ ok: true, value: { passed: true } });
    expect(evaluateWave1Gates([{ id: 'G', required: true, evidence: [{ ...trusted.value, trusted: false }] as never, reviewer }]))
      .toMatchObject({ ok: false, error: { code: 'GATE_EVIDENCE_UNTRUSTED' } });
    await chmod(join(root, 'records', `${ref.value.id}.json`), 0o644); await writeFile(join(root, 'records', `${ref.value.id}.json`), '{}');
    expect(await store.readTrusted(ref.value)).toMatchObject({ ok: false, error: { code: 'EVIDENCE_INTEGRITY_FAILED' } });
  });

  it('requires the Wave migration drill order for rollbackable and forward-only descriptors', async () => {
    const { runWaveMigrationDrill } = await import('../../scripts/run-wave1-migration-drill.mjs');
    const forward: string[] = [];
    expect(await runWaveMigrationDrill({ id: 'w1-security', strategy: 'forward-only' as const,
      upgrade: vi.fn(async () => forward.push('upgrade')), confirmNewWrite: vi.fn(async () => forward.push('new-write')),
      reconcile: vi.fn(async () => forward.push('forward-reconcile')), reupgrade: vi.fn(async () => forward.push('re-upgrade')) })).toEqual({ ok: true });
    expect(forward).toEqual(['upgrade', 'new-write', 'forward-reconcile', 're-upgrade']);
    const rollbackable: string[] = [];
    expect(await runWaveMigrationDrill({ id: 'w1-config', strategy: 'rollbackable' as const,
      upgrade: vi.fn(async () => rollbackable.push('upgrade')), confirmNewWrite: vi.fn(async () => rollbackable.push('new-write')),
      rollback: vi.fn(async () => rollbackable.push('rollback')), reupgrade: vi.fn(async () => rollbackable.push('re-upgrade')) })).toEqual({ ok: true });
    expect(rollbackable).toEqual(['upgrade', 'new-write', 'rollback', 're-upgrade']);
  });
});
```

- [ ] **Step 2: 红测命令**

```powershell
npm.cmd run test:w1-11
```

预期：FAIL；旧 voice/computer/forge RPC/slash 仍可能可达，Gate G 尚可读取普通 JSON/self-reported pass，迁移 drill 不完整。

- [ ] **Step 3: 粘贴完整最小实现**

`src/application/capabilities/capabilityRegistry.ts`

```ts
import { createHash } from 'node:crypto';
import { capabilityUnavailable, type CapabilityId, type CapabilityPort, type CapabilitySnapshot } from '../../domain/capabilities/capability.js';
import { ok } from '../../protocol/results.js';
const states: CapabilitySnapshot['states'] = Object.freeze({ command: 'available', memory: 'available', 'offline-model': 'available',
  voice: 'unavailable', computer: 'unavailable', forge: 'unavailable', distribution: 'unavailable' });
export class Wave1CapabilityRegistry implements CapabilityPort {
  constructor(private readonly policySnapshotId: string, private readonly clock: () => string) {}
  snapshot(): CapabilitySnapshot {
    const generatedAt = this.clock(); const id = createHash('sha256').update(JSON.stringify({ policySnapshotId: this.policySnapshotId, states })).digest('hex');
    return { id, policySnapshotId: this.policySnapshotId, generatedAt, states };
  }
  require(id: CapabilityId) {
    const snapshot = this.snapshot();
    return snapshot.states[id] === 'available' ? ok({ id, snapshotId: snapshot.id }) : capabilityUnavailable(id, snapshot.id);
  }
}
```

`src/release/gateDefinitions.ts`

```ts
import type { TrustedEvidence } from '../domain/quality/evidence.js';
import type { TrustedReviewerAttestation } from '../domain/quality/review.js';
import { gatewayError } from '../protocol/errors.js'; import { err, ok } from '../protocol/results.js';
export interface Wave1GateInput { id: 'A' | 'B' | 'C' | 'D' | 'F' | 'G'; required: boolean;
  evidence: TrustedEvidence[]; reviewer?: TrustedReviewerAttestation;
  notApplicable?: { requirementId: string; profile: string; platform: string; unreachableEvidenceIds: string[] } }
export function evaluateWave1Gates(gates: Wave1GateInput[]) {
  for (const gate of gates) {
    if (gate.notApplicable) {
      if (!gate.notApplicable.requirementId || !gate.notApplicable.profile || !gate.notApplicable.platform || !gate.notApplicable.unreachableEvidenceIds.length)
        return err(gatewayError('GATE_NOT_APPLICABLE_INVALID', gate.id, 'gate.na.invalid'));
      continue;
    }
    if (!gate.evidence.length || gate.evidence.some(item => item.trusted !== true))
      return err(gatewayError('GATE_EVIDENCE_UNTRUSTED', gate.id, 'gate.evidence.untrusted'));
    if (gate.id === 'G' && (!gate.reviewer || gate.reviewer.trusted !== true || gate.reviewer.attestation.trusted !== true))
      return err(gatewayError('GATE_REVIEW_UNTRUSTED', gate.id, 'gate.review.untrusted'));
    if (gate.required && gate.evidence.some(item => item.record.criteria.some(c => c.required && c.status !== 'passed')))
      return err(gatewayError('GATE_REQUIRED_FAILED', gate.id, 'gate.required.failed'));
  }
  return ok({ passed: true, gateIds: gates.map(gate => gate.id) });
}
```

`scripts/run-wave1-migration-drill.mjs`

```js
export async function runWaveMigrationDrill(descriptor) {
  const failed = stage => ({ ok: false, error: { code: 'MIGRATION_DRILL_FAILED', stage } });
  try {
    await descriptor.upgrade();
    await descriptor.confirmNewWrite();
    if (descriptor.strategy === 'rollbackable') {
      if (typeof descriptor.rollback !== 'function') return failed('rollback');
      await descriptor.rollback();
    } else {
      const recover = descriptor.reconcile ?? descriptor.recovery;
      if (typeof recover !== 'function') return failed('forward-reconcile');
      await recover();
    }
    await descriptor.reupgrade();
    return { ok: true };
  } catch (error) { return { ...failed('exception'), error: { code: 'MIGRATION_DRILL_FAILED', stage: 'exception', cause: String(error) } }; }
}
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  throw new Error('Provide the Wave 1 migration registry adapter before invoking the drill');
}
```

`scripts/run-wave1-gates.mjs`

```js
import { spawnSync } from 'node:child_process';
const commands = [
  ['npm.cmd', ['run', 'test:wave1:trusted-kernel']],
  ['npm.cmd', ['run', 'typecheck:tests']],
  ['npm.cmd', ['run', 'build']],
  ['npm.cmd', ['run', 'migration:drill:wave1']],
];
for (const [command, args] of commands) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
```

所有 CLI/Wire/HTTP/TUI/Command/Gateway/ToolCatalog dispatch 在执行前调用同一个 W1-02 `CapabilityPort.require()`。Gate G 的类型与运行时都只允许 W1-09 `TrustedEvidence` 和 `TrustedReviewerAttestation`；禁止直接读取 `src/build/evidence.ts` 的 mutable JSON 或 `status === 'ok'`。Gate A/B/C/D/F/G required failure 退出 1；E/H/I 及未交付能力只有带 requirement/profile/platform/unreachable trusted evidence 时才能 N/A。

迁移 drill 对当波每个 descriptor 固定执行：`upgrade → 新版本确认写入 → rollback（rollbackable）或 reconcile/recovery（forward-only）→ re-upgrade`。必须确认 N-1/N 写兼容、迁移历史/checksum 与 W1-07 journal/evidence integrity；任一步失败均 `MIGRATION_DRILL_FAILED`，Gate 不得继续。

- [ ] **Step 4: 绿测命令**

```powershell
npm.cmd run test:w1-11
npm.cmd run test:wave1:trusted-kernel
npm.cmd run typecheck:tests
npm.cmd run build
npm.cmd run migration:drill:wave1
npm.cmd run gate:wave1
```

预期：PASS；Gate runner 对失败返回非零，且 Gate G 无任何 untrusted evidence/reviewer 路径。

**Commit（仅供后续执行者；本次不提交）**

```text
release: enforce the Wave 1 trusted-kernel boundary
```

---

## Wave 1 Exit Audit

必须保存：

```powershell
npm.cmd run check:test-discovery
npm.cmd run typecheck
npm.cmd run typecheck:tests
npm.cmd run build
npm.cmd run test:all
npm.cmd run gate:wave1
```

通过条件：

- CLI/TUI/Wire/HTTP 复用同一 Gateway/Application services。
- unknown args、错误和完成状态不依赖文本。
- MCP/Plugin 同名 tool identity 不覆盖；完整生命周期仍留 Wave 2。
- Memory 具有 scope、事务 outbox、tombstone、重建和无 stale index。
- 所有可达副作用经过 pipeline；grant/budget/journal 可持久化并经 failure injection。
- Agent 不再用非空文本或 `[GOAL_DONE]` 自判成功。
- offline provider 无 API key 可达且不能伪造 tool call。
- Voice/Computer/Forge/Distribution 不可达并有 N/A evidence。
- Gate A/B/C/D/F/G 全部通过时，才可标记 Wave 1 internal complete。

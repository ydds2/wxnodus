# WxNodus V4 分 Wave 实施总路线图

> 状态：已批准设计的执行计划
> 日期：2026-08-13
> 设计基线：`docs/superpowers/specs/2026-08-13-wxnodus-production-cli-design.md`
> 设计提交：`50089fa`
> 迁移策略：V4 Strangler Migration

## Goal

在不丢失 V3 用户数据、命令、Sessions、Skills、Plugins、MCP 配置和项目产物的前提下，把 WxNodus 演进为 Windows 本地优先、Agent-neutral、Evidence-native 的生产级可验证软件交付编译器。最终交付必须覆盖 R01-R20、S1-S13，并通过 GA 所需 Gate A-I；计划、manifest、测试数量或模型自述均不能代替真实能力与证据。

## Architecture

目标依赖方向固定为：

```text
Presentation -> Protocol + Application Ports
Application  -> Domain Ports
Domain       -> no React/SQLite/Playwright/PowerShell/model SDK dependency
Infrastructure -> Domain/Application ports
Bootstrap    -> composes all layers
```

可信执行主链固定为：

```text
Request
-> Application Service
-> ToolExecutionPipeline
-> ToolCatalog Resolve
-> Schema Validation
-> Effect Normalization
-> PDP / ApprovalGrant
-> Budget Reserve
-> Execute with AbortSignal
-> EffectJournal
-> Postcondition Verification
-> Evidence
-> Budget Commit/Release
-> CompletionGate
-> Protocol Result
-> Presentation Projection
```

## Tech Stack

- Node.js 的唯一支持表达式固定为 `^22.22.2 || ^24.15.0 || >=26.0.0`、TypeScript strict、ESM/NodeNext；根 `engines.node`、安装器、CI、CapabilityReport、文档和发布产物必须逐字使用这一表达式，不得另设 release-tooling 范围或使用其他 Node 支持表述。CI 至少在 `22.22.2`、`24.15.0` 与当期可用的最新 Node 26+ 上做 floor/current smoke。
- React 19 与仓库内 `@wxnodus/ink`，只用于 Presentation。
- better-sqlite3、FTS5、sqlite-vec，作为 Infrastructure adapter。
- Playwright Core、robotjs、node-screenshots、PowerShell UIA，作为可替换 Computer Use drivers。
- ffmpeg、whisper.cpp、Windows SAPI，作为 Voice workers/adapters。
- Vitest，辅以 property、contract、integration、E2E、failure-injection 和真实 Windows 验收。
- npm package、checksum、CycloneDX/SPDX SBOM、许可证报告、签名和 provenance 作为发布供应链产物。

## Global Constraints

1. 每个行为变更先写能稳定暴露旧缺陷的失败测试，再做最小实现。
2. `OperationResult.ok` 只代表单次操作；Run 是否完成只能由 `CompletionDecision.status` 决定。
3. 所有副作用必须经过 ToolExecutionPipeline；slash、Agent、Wire、HTTP、TUI 和 TaskRunner 不得有旁路。
4. Hard redline 具有稳定 ID/version/checksum，任何 approval 和 yolo 均不可覆盖。
5. Security-critical hook、verifier、policy 或 sandbox 异常默认 fail-closed；展示/遥测 hook 才可显式 fail-open。
6. 每个 migration 必须声明 `rollbackable` 或 `forward-only`；后者必须用 expand/contract、N-1 兼容窗口和写入对账。
7. 每个 Extension registration 都归属于 owner scope，并返回 disposer；candidate 失败时保留旧健康 scope。
8. Untrusted Plugin 没有 OS 强制隔离时只能 `quarantined`，不能 `enabled`。
9. Secret 使用 opaque reference；不得进入普通 event、日志、Memory、Evidence 或模型消息。
10. Wave 0-3 只允许 internal/canary；尚未交付能力必须在 CapabilityRegistry 中为 `unavailable` 且入口不可达。
11. 禁止 `TBD`、占位 handler、隐式成功、吞掉 migration/verifier/registry 错误。
12. Windows 自动化脚本使用 argv 数组或 `npm.cmd`，不得依赖 shell 字符串拼接。
13. 每个 Task 完成时必须执行该 Task 的红/绿测试、相关回归、`npm run typecheck`；每个 Wave 结束执行 build、完整测试发现审计和当期 Gate。
14. Requirement coverage 的唯一命令和 runner 固定为 `check:requirement-coverage` → `scripts/check-requirement-coverage.mjs`；任何历史 alias 及第二套 coverage runner 在任何 Wave 均禁止出现。
15. MCP modern 合同固定为 `2026-07-28`；`initialize`/`notifications/initialized` 和旧 protocol version 只能存在于单一 legacy compatibility adapter，modern client/server、Gate 与 Forge 模板不得 import、advertise 或生成 legacy handshake。
16. Windows 11 current production x64（当期仍在 Microsoft 服务期的 GA Channel）是 V4 production/release 主证据环境；runner 必须记录 product/display version、完整 OS build/UBR、image/runner identity 与捕获时间，计划中的 `24H2/26100` 只作为最低代表性 fixture，不得冒充永远固定的 current production。Windows 10 22H2 build `19045` 是 non-GA legacy compatibility 环境，只生成 best-effort build、CLI/数据迁移及不依赖 Playwright 的兼容证据，不运行/满足 Gate E，不得替代 Windows 11 production evidence，其失败也不降低 Windows 11 Tier 1 门。

## Final-review Authority

本文件是分 Wave 计划的最终审查覆盖层。若任一 Wave 子计划与下列规范在命令名、Gate scope、known-failure 状态、MCP era、Node/Windows 范围、release cell 或 evidence schema 上冲突，以本文件为准；对应 owner Task 必须先机械修正其任务段和测试，再执行实现，禁止同时保留两套合同或兼容 alias。

## Plan Files

| 文件 | 范围 | 主要 Gate |
|---|---|---|
| `2026-08-13-wxnodus-v4-wave0-baseline.md` | Compatibility/Policy/Requirement manifests、测试发现、config/DB migration、基线 Gate | A、B、C、F |
| `2026-08-13-wxnodus-v4-wave1-trusted-kernel.md` | S1、S3、S5、Tool pipeline/PDP/Journal/Budget、CompletionGate、offline provider | A、B、C、D、F、G |
| `2026-08-13-wxnodus-v4-wave2-config-extensions-autonomy.md` | S2、S4、S13、Session lifecycle、MCP/Skill/Plugin、CapabilityRegistry | A、B、C、D、F、G |
| `2026-08-13-wxnodus-v4-wave3-production-capabilities.md` | S6-S9、S11/S12 PTY 前置、跨平台 PTY、真实 Windows Voice/Computer、Build/Evidence/TUI 分层 | A-G |
| `2026-08-13-wxnodus-v4-wave4-forge-release.md` | S10、S12、三档安装、供应链、跨平台、遗留 adapter 删除 | A-I |

## Dependency DAG

```text
W0-01 Test Discovery
  -> W0-02 Compatibility Manifest
  -> W0-03 Policy Manifest
  -> W0-04 Requirement Coverage
  -> W0-05 Config Migration Foundation
  -> W0-06 DB Migration Foundation
  -> W0-07 Known-Failure Baseline
  -> W0-08 Baseline Gate Runner

W1-01 Protocol Results
  -> W1-02 Bootstrap/Application Boundary [首次定义 CapabilityPort]
  -> W1-03 Gateway Adapters
  -> W1-04 Command Grammar/Safe Names
  -> W1-05 ToolCatalog Identity [首次定义 EffectDescriptor]
  -> W1-06 Memory Transactions/Outbox
  -> W1-07 PDP/Approval/Journal/Budget
  -> W1-08 ToolExecutionPipeline Integration
  -> W1-09 CompletionGate
  -> W1-10 Offline Provider
  -> W1-11 Wave 1 Capability Fence/Gates

W2-01 Onboarding/i18n
  -> W2-02 Personalization/Config Migration
W1-11 + W2-02
  -> W2-03 CapabilityRegistry
W1-05 + W1-08 + W2-03
  -> W2-04 Extension Scopes
  -> W2-05 Session Lifecycle
  -> W2-06 MCP Client + WxNodus MCP Server Adapter
  -> W2-07 Skill Lifecycle
  -> W2-08 Plugin Broker/Sandbox
W1-07 + W1-08 + W2-03
  -> W2-09 TaskTicket/TaskRunner
  -> W2-10 Sub-agent Worktree/Recovery
W2-08 + W2-10
  -> W2-11 Wave 2 Gates

W1-09 + W2-03
  -> W3-01 Quality Domain/Failure Propagation
  -> W3-02 Protocol/TUI Boundary
  -> W3-03 Voice State Machine
  -> W3-04 Async Voice Infrastructure
  -> W3-05 ComputerUseService
  -> W3-06 Browser/UIA/Coordinate Drivers
  -> W3-07 BuildService/DAG
  -> W3-08 Evidence/Completion Integration
W3-02
  -> W3-09 跨平台 PTY
W3-08 + W3-09
  -> W3-10 Windows Acceptance
  -> W3-11 Wave 3 Gates

W1-W3 exits
  -> W4-01 Forge Domain/Lifecycle
  -> W4-02 Forge Registry/Installer
  -> W4-03 Nine Templates/Handlers
  -> W4-04 Component Lifecycle Integration
  -> W4-05 Distribution Profiles
  -> W4-06 Package/CI Boundary
  -> W4-07 Install/Upgrade/Recovery/Uninstall
  -> W4-08 Local AI/Air-gapped Assets
  -> W4-09 SBOM/License/Checksum/Signature
  -> W4-10 Cross-platform/Release Gates
  -> W4-11 Adapter Removal/GA Audit
```

### 关键任务交付契约

- **W1-02 — CapabilityPort：** 在 Bootstrap/Application boundary 中首次定义并导出 `CapabilityPort`；后续 CapabilityRegistry、Gateway 和 Presentation 只能消费该 port，不得在各 adapter 内复制第二套 capability 判定。
- **W1-05 — EffectDescriptor：** 在 ToolCatalog identity contract 中首次定义并导出 `EffectDescriptor`；W1-07/W1-08 的 PDP、approval、budget、journal 和 verifier 均消费同一个 canonical descriptor，不得从工具名称或自然语言反推 effect。
- **W2-06 — 双向 MCP 生命周期与 era 隔离：** 同一任务必须同时交付用于连接外部 MCP Server 的 MCP client，以及把 WxNodus 自身能力暴露给外部 client 的 WxNodus MCP Server adapter；两者都纳入 W2-04 owner scope/disposer、W2-03 CapabilityRegistry 和 W1-08 ToolExecutionPipeline，server adapter 不得成为副作用旁路。
  - 唯一 modern protocol version 是 `2026-07-28`：modern 路径使用每请求 `_meta`、`server/discover`，HTTP 同时验证 `MCP-Protocol-Version`，不得发送或接受 `initialize`/`notifications/initialized`。
  - `src/infrastructure/mcp/legacyMcpCompat.ts` 是唯一 legacy handshake/version 允许点；只有 modern probe 返回明确 non-modern error/timeout 才可进入，且 legacy 使用独立 transport/session/state/transcript scope，仍受 CapabilityRegistry、pipeline、PDP、budget、cancel 与 evidence 约束。modern modules、WxNodus server、Forge MCP 模板和 GA Required capability evidence 均不得 import 或 advertise legacy；legacy evidence 只能证明 R10 compatibility，不得满足 current MCP Gate D/G/I。
  - Transport 必须覆盖 `stdio` 与 Streamable HTTP，具有 start/connect、capability negotiation、取消、超时、断线恢复、健康状态与受控 shutdown；HTTP 路径必须完成 OAuth negotiation，`stdio` 对 OAuth 明确返回 protocol-level `not_applicable`，不得伪造成功。
  - 协议面必须覆盖 Tools、Resources、Prompts、Notifications、Elicitation 与 Tasks；client/server 各自只宣告实际协商成功的 feature/version。
  - 任何尚未交付、当前 transport 不支持或对端未协商的能力，都返回结构化结果 `{ status: "unavailable", capabilityId, surface, transport, reasonCode, negotiatedVersion }`，其中 `reasonCode` 使用稳定枚举（至少包含 `NOT_DELIVERED`、`TRANSPORT_UNSUPPORTED`、`PEER_DID_NOT_NEGOTIATE`、`AUTH_NEGOTIATION_UNAVAILABLE`）；不得丢弃请求、返回空对象、用成功响应包装不支持，或仅写日志。
- **W3-09 — Cross-platform PTY：** 这是 Wave 3 的独立 Task，覆盖 R10-R12、R17 与 S11/S12；创建 PTY application port、Windows ConPTY adapter、POSIX PTY adapter 及 Windows/POSIX contract suites，覆盖 argv 启动、stdin、合并终端输出、resize、UTF-8、exit/signal、AbortSignal 取消、背压和 owner-scope dispose；TUI 只消费 PTY port，不直接 import 平台实现。该任务只交付跨平台 PTY 能力与 contract evidence。
- **W3-10 — Windows Acceptance：** 原 W3-09 顺延为 W3-10，覆盖 R07-R08、R10-R12、R15、R17 与 S6-S9/S11/S12；交付真实 Windows ConPTY 与 Voice/Computer/Build/Evidence 联合验收、`scripts/run-windows-acceptance.mjs`、`test:windows-real` 和单 run `gate:completion`，blocked precondition 必须有 diagnostics，不能伪造 passed。生产通过只认真实 Windows 11 current production；Windows 10 22H2 仅执行独立 legacy compatibility subset，不得满足 Gate E。
- **W3-11 — Wave 3 Gates 与当前兼容证据：** 原 W3-10 顺延为 W3-11，覆盖 R01、R07-R12、R15-R16、R19 与 S6-S9/S11/S12；创建 `scripts/run-wave3-gates.mjs` 与 `gate:wave3`，聚合当波 A-G，验证 PTY contract/Windows acceptance evidence，并保持 H/I 严格 N/A。Gate D 的 compatibility slice 必须包含当前 candidate 自身生成的 `C-W3`，不得只用 `priorRunIds` 引用 W0-W2 的 `C-W0/C-W1/C-W2`。
  - `C-W3` 的 authoritative input 是当前 commit/worktree artifact hash 下重跑的 V3 Compatibility Manifest 驱动回归，覆盖本波实际触及的 Voice、Browser、Computer、Build、Evidence、TUI/Gateway、PTY 和 legacy delegation surfaces；每个 entry 保存 compatibility ID、当前 test command/exitCode、正反 assertion、artifact/environment/policy binding 与 Evidence IDs。
  - W3 runner 仍不重跑 Gate C migration slice；它把已验证 prior `C-W0/C-W1/C-W2` 作为 lineage，再将当前 `C-W3` 加入当波 Gate D/G。`C-W3` 缺失、只引用旧 run、candidate hash 不同或任一触及 surface 未覆盖时，`gate:wave3` 必须 `blocked/failed`。

## Requirement Coverage

| Requirement | Planned Tasks | Primary Artifact |
|---|---|---|
| R01 Middleware | W1-01..03 | `src/protocol/`, `src/application/`, `src/bootstrap/` |
| R02 SessionStart | W2-05、W4-03..04 | Session lifecycle + Forge SessionStart handler |
| R03 Commands | W1-04、W4-03..04 | grammar/registry + Command component |
| R04 MCP Servers | W2-04、W2-06、W4-03..04 | MCP client + WxNodus MCP Server adapter、owned scope + Forge lifecycle |
| R05 Sub-agents | W2-09..10、W4-03..04 | TaskTicket/worktree + Forge lifecycle |
| R06 Plugins | W2-04、W2-08、W4-03..04 | broker/sandbox + Forge lifecycle |
| R07 Full-window Automation | W3-05..06、W3-10 | verified action loop + Windows evidence |
| R08 Voice Mode | W3-03..04、W3-10 | state machine/workers + Windows evidence |
| R09 Black Hole Engine | W1-06 | scoped transactional memory/outbox/rebuild |
| R10 Existing Core | W0-02、W1-W4 compatibility tests，含当前 W3-11 生成的 `C-W3` | manifest-driven regression/migration + PTY compatibility + current-candidate evidence |
| R11 UI Separation | W1-02..03、W2-06、W3-02、W3-09 | headless services + CLI/HTTP/Wire/MCP/TUI adapters + PTY port |
| R12 Self-developed CLI | W1-01..04、W3-02、W3-09 | protocol/grammar/adapters + cross-platform PTY shell |
| R13 First-run Locale | W2-01 | pre-bootstrap zh/en onboarding |
| R14 Personalization | W2-02 | user/workspace settings service |
| R15 Quality Control | W1-09、W3-01、W3-08、W3-10 | CompletionGate/Verifier/Evidence + Windows acceptance |
| R16 Autonomy Control | W1-07..08、W2-09..10 | budget/journal/task lineage/cancellation |
| R17 Profiles/Supply Chain | W3-09、W4-05、W4-08..09 | Standard/Full PTY + profiles/capability/bundle/SBOM/signature |
| R18 Production Lifecycle | W0-05..06、W4-06..10 | migrations/install/upgrade/recovery/CI |
| R19 Blueprint Principles | all waves，重点 W1-08、W3-08、W4-01..04 | FDR + Forge + evidence closure |
| R20 Chinese Report | W4-11 | Chinese completion report with Evidence IDs |

## Subproject Coverage

| S1-S13 | Wave/Tasks |
|---|---|
| S1 Gateway/Composition | W1-01..03 |
| S2 Config/Onboarding/i18n/Personalization | W2-01..02 |
| S3 Command Grammar/Safe Naming | W1-04 |
| S4 ToolCatalog/Extension | W1-05、W2-04..08（W2-06 同时交付 MCP client/server） |
| S5 Memory | W1-06 |
| S6 Voice | W3-03..04、W3-10..11 |
| S7 Computer | W3-05..06、W3-10..11 |
| S8 Concept Compiler | W3-07 |
| S9 Verify/Evidence/Gate | W1-09、W3-01、W3-08、W3-10..11 |
| S10 ComponentForge | W4-01..04 |
| S11 TUI Separation | W3-02、W3-09 |
| S12 Distribution/Release | W3-09、W4-05..10 |
| S13 Autonomy/Sub-agents | W1-07..08、W2-09..10 |

## Gate Execution Contract（Wave-scoped）

Gate 合同按 Wave 激活，不存在一套从 W0 起就假定全部发布命令已存在的全局命令表。每次 Gate run 只为当波 Required Gate 和有严格不可达证明的 N/A Gate 写入不可变目录：

```text
artifacts/release-evidence/{validated-run-id}/
  manifest.json
  environment.json
  commands/*.json
  stdout/*.log
  tests/*.json
  migrations/*.json          # 当波实际执行 migration/recovery 时创建
  security/*.json            # 当波实际执行 policy/security 检查时创建
  windows/*.json             # W3-10 起由真实 Windows runner 创建
  distribution/*.json        # W4-10 起由 distribution runner 创建
  completion-decision.json   # Gate G 当波 required 时创建
```

`manifest.json` 必须完整 SHA-256 覆盖全部实际附件；GateRunner 重新计算 hash，不信任附件自报状态。未激活的附件目录不得用空 JSON 预建来制造覆盖。

### Known-failure lifecycle（W0-07 首次创建，后续 fix Task 原子迁移）

`test:known-failures` 不是永久要求每个 case 退出 1。`src/release/knownFailures.ts` 对 KF-001..KF-030 的每项必须在当前 candidate 上且只能处于下列一个状态，catalog、case、regression、evidence 间不得重复、缺项或双重登记：

```ts
type KnownFailureEntry =
  | {
      id: `KF-${string}`;
      state: 'open';
      caseFile: string;
      expectedFailureCode: string;
      timeoutMs: number;
      observedEvidenceId: string;
    }
  | {
      id: `KF-${string}`;
      state: 'resolved-with-green-regression';
      regressionFile: string;
      regressionTestName: string;
      resolvedByTask: `W${number}-${string}`;
      greenEvidenceId: string;
      artifactSha256: string;
      environmentSnapshotId: string;
      policySnapshotId: string;
    };
```

- `open` 项由 known-failure wrapper 单独执行；只有精确 `exitCode === 1` 且最后一条结构化记录的 `failureId`/`failureCode` 与 catalog 相等才算“旧缺陷仍被稳定观察”。`0` 是 unexpected pass，`2`/signal/timeout 是 harness error，三者都使 wrapper 失败。
- 修复该缺陷的 owner fix Task 必须在**同一原子变更**中：先执行并保存旧 case 的 red evidence；增加完整生产路径绿色 regression；让 regression 退出 0；把 catalog 条目从 `open` 迁为 `resolved-with-green-regression`；从 wrapper input 移除旧 `.case.ts` 并删除或移入不可执行历史 fixture；把 green evidence 绑定当前 artifact/environment/policy。不得先删 case、先标 resolved、保留 open+resolved 两份，或用“现在 case 退出 0”代表 resolved。
- `test:known-failures` 每次都校验 30 个稳定 ID 恰一：对 `open` 验证预期失败，对 `resolved-with-green-regression` 验证 catalog 指向的绿色 regression 确实由当期 `test:all`/owner suite 发现并通过；最终 GA 允许且只允许全部 30 项为 `resolved-with-green-regression`。任何 `open` 项阻断其 owner capability/Wave exit，并阻断 W4 GA。

### Gate evidence runtime validator（W0-08 首次创建，W1-W4 扩展）

`src/release/evidenceSchema.ts` 必须提供单一 runtime validator；TypeScript interface、`as` cast、JSON parse 成功或附件自报 hash 均不能代替验证。所有 wave runner、CI evidence import、Gate aggregate、CompletionGate 和 release finalization 在消费 evidence 前都调用同一 validator，并按以下顺序 fail-closed：

1. **严格对象 schema：** 拒绝未知 key、缺 key、错误 primitive、稀疏数组、重复 ID、非 canonical 相对路径和 symlink/`..`/drive/UNC escape；`schemaVersion` 只接受已登记整数，不能把未来版本降级读取。
2. **枚举与 scope：** `gate` 只能是 `A..I`；`status` 只能是 `passed|failed|blocked|not_applicable`；`waveScope` 只能是 `wave0..wave4`，并须与 runner、manifest、GateDefinition 相等。required definition 禁止 `not_applicable`；N/A 只允许 definition 明确 `not_applicable`，且 requirement/profile/platform/capability/unreachable evidence 均非空、在 registry 中存在并证明入口不可达；非法 N/A 一律 `GATE_NA_SCOPE_INVALID`。
3. **命令真实性：** executed evidence 至少一个 command；每项保存 `executable`、`args: string[]`、`cwd`、started/finished、`exitCode: integer|null`、signal/timeout/aborted 与 stdout/stderr attachment IDs。`passed` 要求每个 required command `exitCode === 0` 且无 signal/timeout/abort；非零/null 不得写 passed，且记录值必须与 ProcessSupervisor authoritative record 相等。
4. **附件与 SHA-256：** `manifest.json` 枚举 run 目录下除 manifest 自身外的每个实际文件且恰一，反向也不得有未列附件；validator 用安全 realpath 打开每个附件，检查存在、regular-file、size，然后流式重算完整 64-hex SHA-256 并 exact 比对。丢失、额外、重复、路径逃逸、size/hash 不符均 `GATE_ATTACHMENT_INTEGRITY_FAILED`。
5. **binding：** 每个 gate 和 command record 必须同时绑定顶层 `runId`、candidate `artifactSetId/artifactSha256`、`environmentSnapshotId/environmentSha256`、`policySnapshotId/policySha256`、capability snapshot、commit/worktree digest、correlation/lineage；引用的 snapshot/manifest 附件必须存在并重算。gate/command/criterion/CompletionDecision 任一 binding 不同、snapshot created-after-result、或 profile/release artifact 不属于同一 candidate 时，返回 `GATE_EVIDENCE_BINDING_MISMATCH`，禁止聚合。
6. **状态一致性：** `failed|blocked` 必须有合法稳定 reasonCode 与相应 authoritative negative record；`not_applicable` 不允许 commands/伪执行附件；`passed` 不允许失败 reason、required criterion 非 passed 或 stale prior evidence。validator 返回新 validated value，原始对象不能凭类型断言进入 GateRunner。

最低判别联合由 W0-08 定义为：

```ts
type WaveScope = 'wave0'|'wave1'|'wave2'|'wave3'|'wave4';
type GateId = 'A'|'B'|'C'|'D'|'E'|'F'|'G'|'H'|'I';
type GateStatus = 'passed'|'failed'|'blocked'|'not_applicable';
interface EvidenceBinding {
  runId: string; artifactSetId: string; artifactSha256: string;
  environmentSnapshotId: string; environmentSha256: string;
  policySnapshotId: string; policySha256: string;
  capabilitySnapshotId: string; capabilitySha256: string;
  commit: string; worktreeDigest: string;
}
```

每个后续 Wave 可通过 schema version 新增字段，但不能放宽以上 invariant；W4 import 外部 CI evidence 时还必须验证 workflow run URL、artifact attestation/provenance、runner identity 与同一 binding。

### Runner 与 package command 的首次创建点

所有 npm script 都创建在仓库根 `package.json` 的 `scripts`；表中 Task 必须同时创建所列 runner 文件、root script 和至少一个可由 test discovery 计数的真实 suite。后续 Wave 可组合已存在命令，但不得提前引用后续 Wave 才创建的命令。

| First Task | 首次创建的 runner/command | 生效范围 |
|---|---|---|
| W0-01 | `scripts/check-test-discovery.mjs`；`test:all`、`typecheck:tests`、`check:test-discovery` | W0+ 的测试发现与类型闭包 |
| W0-04 | `scripts/check-requirement-coverage.mjs`；`check:requirement-coverage` | W0+ requirement manifest 闭包；唯一名称，禁止 alias/第二 runner |
| W0-07 | known-failure runner；`test:known-failures` | W0 基线及后续回归 |
| W0-08 | `scripts/run-wave-gates.mjs`、`scripts/drill-wave0-recovery.mjs`；`gate:wave0`、`drill:wave0-recovery` | 仅 W0 Gate A/B/C/F 聚合 |
| W1-11 | `scripts/run-wave1-gates.mjs`；`gate:wave1` | 仅 W1 Gate A/B/C/D/F/G 聚合 |
| W2-11 | `scripts/run-wave2-gates.mjs`；`gate:wave2` | 仅 W2 Gate A/B/C/D/F/G 聚合 |
| W3-10 | `scripts/run-windows-acceptance.mjs`；`test:windows-real`、`gate:completion` | Windows 11 current production 真实 acceptance 与单 run CompletionGate；Win10 只走独立 legacy subset |
| W3-11 | `scripts/run-wave3-gates.mjs`；`gate:wave3` | 仅 W3 Gate A-G 聚合 |
| W4-06 | `scripts/check-package-boundary.mjs`；`check:package-boundary` | 首次进入 package/clean-pack Gate A/H |
| W4-07 | distribution lifecycle runner；`test:migrations`、`drill:recovery` | 首次进入发布安装/升级/恢复 Gate C/H |
| W4-09 | supply-chain runners；`release:supply-chain`、`release:verify` | 首次进入 SBOM/license/checksum/signature/provenance Gate F/H |
| W4-10 | `scripts/run-distribution-matrix.mjs`、`scripts/run-release-gates.mjs`；`test:e2e`、`test:security`、`test:distribution`、`gate:release` | 首次聚合 A-I 与三档/三平台发布矩阵 |

### 每波可执行 Gate 集合

| Wave | Required Gates | 当波执行合同 | 严格 N/A |
|---|---|---|---|
| W0 | A/B/C/F | `build`、`typecheck`、`typecheck:tests`、`check:test-discovery`、`test:all`、`test:known-failures`、`check:requirement-coverage`、config/DB 指定 migration suites、`drill:wave0-recovery`、Policy Manifest 校验，最后 `gate:wave0` | D/E/G/H/I；必须附 capability/requirement/profile/platform 不可达证据 |
| W1 | A/B/C/D/F/G | 复用 W0 命令；由 `run-wave1-gates.mjs` 直接枚举非空 trusted-kernel contract/integration/security/completion suites，最后 `gate:wave1` | E/H/I；Voice/Computer/Forge/Distribution 全层不可达 |
| W2 | A/B/C/D/F/G | 复用 W0/W1 命令；由 `run-wave2-gates.mjs` 直接枚举非空 onboarding/config/extension/MCP/session/plugin/autonomy suites，最后 `gate:wave2` | E/H/I；Voice/Computer/Forge runtime 全层不可达 |
| W3 | A/B/C/D/E/F/G | 复用 W0-W2 命令；增加当前 candidate 的 `C-W3` compatibility regression、`test:windows-real` 与 `gate:completion`（PowerShell 先从 `latest-run.json` 读取实际 `runId`，再以 `-- --run $latest.runId` 传入），最后 `gate:wave3`。Gate C migration 只继承 prior verified evidence，不重跑；Gate D/G 必须消费当前 `C-W3`，不能只引用旧兼容证据 | H/I；GA distribution 不得宣称 ready |
| W4 | A-I | 增加 `check:package-boundary`、`test:migrations`、`drill:recovery`、`test:e2e`、`test:security`、`release:supply-chain`、`release:verify`、`test:distribution`，最后 `gate:release`；A-I 的唯一 GA definitions/commands/evidence/status 见下节 | Gate 级别无 N/A；仅 canonical 签名 profile 对目标 cell 标为 Optional/Unavailable 的**能力**可按合同降级，不能把 Required Gate 写 N/A |

因此 W0-W3 的 Gate A 不运行 `check:package-boundary`，Gate F 不运行 `release:supply-chain`，且任何 Gate 都不运行 `test:distribution`、`test:migrations`、`drill:recovery` 或 `gate:release`；这些命令在 W4 对应 Task 真实创建前必须不存在，也不得用同名 shim 预占。

### 禁止 stub、空套件与伪通过

- runner 启动前校验 root `package.json` 中当波 command 的创建 Task、真实 executable/argv 和允许 Wave；required command 缺失、提前出现、解析失败或 exit code 非零均为 `blocked/failed`，不能记 `passed`。
- 每个 test command 必须保存 test discovery 列表和 `discoveredCount`，且 `discoveredCount > 0`；零匹配 glob、`--passWithNoTests`、全量 `.skip/.todo`、空 describe、只返回 exit 0 的 shell/`node -e`、固定 `passed` JSON 均按 `EMPTY_OR_STUB_SUITE` 阻断。
- 每个 Gate runner 至少验证一个当波正向场景和一个反向/失败注入场景；只有 manifest、命令存在或 suite 数量不能作为能力证据。
- 未到创建 Wave 的命令不得伪造；当波 Required command 缺失表示 Gate 未实现，非 Required Gate 只有在完整不可达证据成立时才可 `not_applicable`。

### Wave 4 唯一 Gate A-I 定义、精确命令、evidence/status 合同

以下表是 Wave 4/GA 的唯一 `GateDefinition` 来源；W4-10 必须把它逐字实现为版本化数据并由 W4-11 复用。Wave 子计划中的概括句、workflow job 名、suite 数量和历史 gate 文件都不能新增/改名/削弱 Gate。表中命令均在仓库根以 `npm.cmd run <script>`、argv 数组、`shell:false` 执行，并写入同一个 release `runId`；`gate:release` 是在 A-I slice evidence 已生成后做聚合，不得递归运行自身。

| Gate | 唯一 GA 定义 | 精确 required commands（全部执行，顺序固定） | Required evidence/status 合同 |
|---|---|---|---|
| A | Build/package boundary | `npm.cmd run build` → `npm.cmd run typecheck` → `npm.cmd run typecheck:tests` → `npm.cmd run check:package-boundary` | 当前 candidate 的 build outputs/package file list/full hashes；四命令均 exit 0 才 `passed`，否则 `failed`；runner/toolchain 缺失为 `blocked`，永不 N/A |
| B | Automated tests/discovery | `npm.cmd run check:test-discovery` → `npm.cmd run test:all` → `npm.cmd run test:known-failures` | discovery manifest 必须证明全部 required roots/suites 非空且每个测试执行；KF-001..030 状态恰一且 GA 全为 resolved-with-green-regression；test failure=`failed`，runner 缺失=`blocked` |
| C | Migration/recovery | `npm.cmd run test:migrations` → `npm.cmd run drill:recovery` | V3 config/DB/extension fixture、backup hash、migration descriptor/checksum、rollbackable 或 forward-only 对账、确认写入 readback、RTO；演练不通过=`failed`，缺 platform/data prerequisite=`blocked` |
| D | Functional | `npm.cmd run test:e2e` | CLI/headless/JSONL/Wire/HTTP/current MCP `2026-07-28`/Build/Extension/Forge 正反 E2E，含当前 compatibility candidate；legacy MCP 证据不得满足 current MCP；任一 required surface 不通过=`failed` |
| E | Windows real-platform | `npm.cmd run test:windows-real` | **仅**真实 Windows 11 current production x64：Voice、Computer、UIA、Browser/Playwright、SAPI、急停、物理设备与后置验证；记录 exact OS build/UBR/runner identity。缺物理/runner prerequisite=`blocked`，场景失败=`failed`。Windows 10 不执行/满足 E |
| F | Security/compliance/supply chain | `npm.cmd run test:security` → `npm.cmd run release:supply-chain` → `npm.cmd run release:verify` | PDP/SSRF/path/sandbox/secret/audit negative evidence，加每个 GA target cell 的 license、SBOM、checksum、signature、provenance 离线重验；policy/tool 缺失=`blocked`，违规/篡改=`failed` |
| G | Evidence/completion | PowerShell 读取 `artifacts/release-evidence/latest-run.json` 后执行 `npm.cmd run gate:completion -- --run $latest.runId` | `$latest.runId` 必须是实际 UUID/opaque ID 并作为单独 argv；runtime validator 验证全部 A-F/H-I binding 后，全部 required criteria passed 且 independent review 才 `passed`；failed/incomplete/inconclusive/blocked/cancelled 均不得映射 passed |
| H | Distribution | `npm.cmd run test:distribution` | canonical GA target cells 的 clean/offline/airgap install、CapabilityReport、upgrade/recovery、uninstall/diagnostics，以及 package/binary/model trust artifacts；任一 Required cell/capability 缺失=`failed`，真实 runner/签名身份不可用=`blocked` |
| I | Secondary platforms | `npm.cmd run test:distribution`（消费与 H 相同的一次 matrix run，不得重复伪造） | 全部 required Linux/macOS target cells 的 build/tests/clean install/upgrade/uninstall、从签名 profile 派生的每个 Required capability 正向 probe、Optional/Unavailable 结构化 degradation；真实 runner 缺失=`blocked`，cell/probe 不通过=`failed` |

W4 `GateAggregate` 必须恰含 A-I 各一次，所有 Gate 均 Required，合法聚合状态仅 `passed|failed|blocked`：任一 `failed` 则 final=`failed`；否则任一 `blocked` 则 final=`blocked`；仅九项都 `passed` 才 final=`passed`。原始 CompletionDecision 的 `incomplete|inconclusive|cancelled` 保留在 Gate G evidence 中，并使 G/aggregate 非 passed，禁止丢信息改写为成功。`not_applicable` 出现在任一 W4 Gate evidence 都是 schema error；能力级 Optional/Unavailable 只能存在于签名 profile/CapabilityReport/cell probe 内。

### Windows production 与 legacy evidence 策略

- Wave 3/4 的 production Windows evidence 只认真实 Windows 11 current production x64。runner 每次动态验证仍在 Microsoft 服务期，并记录 edition/channel、display version、完整 build/UBR、host/runner image、interactive session、物理设备与时间；`24H2/26100` 可作为最低 fixture，但不能把版本字符串硬编码为未来唯一生产值。
- Windows 10 22H2 build `19045` 只属于 `legacy-win10-22h2-x64` 非 GA matrix；运行 best-effort `build`、CLI/noninteractive/JSONL/Wire、V3 config/DB migration 和不依赖 Playwright 的兼容 suites，状态使用 `compatible|degraded|failed|not_run`，不进入 A-I aggregate、不阻断或满足 E/H/I，也不得宣称 Browser/Playwright、Voice/Computer production support。
- 发布报告必须并列列出 Windows 11 production Evidence IDs 和 Windows 10 legacy Evidence IDs/limitations；缺 Windows 10 runner 可写 `not_run`，但不得复用 Windows 11 evidence 或 synthetic UA/compat mode 冒充。Windows 11 production 缺失则 Gate E/H `blocked`。

### Gate I 的签名 profile 精确派生规则

Gate I 不接受 `releaseMatrix.ts`、workflow input 或测试代码手写 `requiredCapabilities`，也不接受“已生成 cell 数量”作为覆盖证明。W4-10 runner 必须先离线验证 release manifest、每个 profile artifact 的 SHA-256、签名 bundle、issuer/identity policy 与 provenance；只有验证成功的 profile 才能进入派生输入。

Gate I 的 canonical required target-cell 闭包固定为以下**所有**二级平台 cells（每个 cell 都必须出现，不能只测一个 profile）：

```text
ubuntu-24.04-linux-x64-core
ubuntu-24.04-linux-x64-standard
ubuntu-24.04-linux-x64-full-local-ai
macos-14-darwin-arm64-core
macos-14-darwin-arm64-standard
macos-14-darwin-arm64-full-local-ai
```

对每个 `(profile, targetPlatform)` cell，runner 必须在已签名 profile artifact 的唯一 target-platform selector 上过滤 `availability === "required"` 的稳定 capability IDs，经去重、字典序排序和 canonical JSON 序列化得到 `derivedRequiredCapabilities`；Optional/Unavailable 集合同样从这个已签名 artifact 派生。签名 profile 若缺少任一 canonical cell、selector 无唯一命中、release matrix 多出未签名 cell、或 signed manifest 声明了本次支持范围外的 Required target selector，均返回 `MATRIX_CELL_MISSING` 或 `PROFILE_CAPABILITY_DERIVATION_MISMATCH`，不得静默丢弃。

`ReleaseMatrixCell.requiredCapabilities` 必须与 `derivedRequiredCapabilities` 做 canonical JSON **exact equality**；少一项、多一项、顺序/重复不 canonical、使用未签名/签名失效 profile、或运行时把 Required 降为 Optional/Unavailable，Gate I 均为 `blocked/failed`。每个上述 cell 还必须有自己的 build、automated-test、clean-install、upgrade、uninstall、CapabilityReport、positive Required probes、Optional/Unavailable degradation、artifact/SBOM/license/checksum/signature/provenance/airgap evidence；任何 required target cell 或 required evidence 缺失都阻断 Gate I。Windows 专属能力在 Linux/macOS 必须稳定返回 `unavailable`，不得从 Required 集合中静默删除后宣称通过。

`GateIInput` 的 runtime schema 必须包含 `releaseId`、`signedProfileDigest`、`targetSelector`、`matrixCellId`、`derivedRequiredCapabilities`、`derivedOptionalCapabilities`、`derivedUnavailableCapabilities`、`evidenceIds` 和同一 `EvidenceBinding`；validator 必须重算 signed profile digest、selector result 与所有 evidence attachment hash。`requiredCapabilities` 仅允许作为验证后的输出，不得作为未验证输入；Gate I aggregate 只有六个 canonical target cells 全部 `passed` 才能 `passed`。

## Per-task Execution Protocol

每个 Task 按以下不可缩减顺序执行；各分 Wave 计划若缺少下面任一材料，实施者必须先补齐该 Task 计划段落，不能凭摘要自行猜测实现：

1. 阅读该任务列出的现有文件与相关测试。
2. 在任务计划中给出并粘贴**一个完整可运行的代表性失败测试文件**：包含全部 imports、fixture/setup/cleanup、真实调用、至少一个具体断言和稳定测试名称；禁止只写测试要点、伪代码、`expect(true)`、省略号或“参考上一任务”。若任务包含大量同构 fixtures/cases，`Files` 必须列出完整 fixture manifest/schema/generator/golden 文件集合和生成出的所有稳定 ID/路径，但可以只手工粘贴一个代表性 red test；其余必须由版本化 generator 按 schema 生成，并由 golden snapshot/hash 清单锁定。
3. 明确红测命令、预期进程退出码和负向断言：必须写成如 `Expected exit: 1`，并点名至少一个预期 assertion/error code（例如 `CAPABILITY_UNAVAILABLE`、`EMPTY_OR_STUB_SUITE`）；若命令因编译失败为红，必须写明具体 TypeScript diagnostic 或 missing module/symbol。执行该红测并保存输出，确认失败来自目标缺口而非路径或 fixture 错误。对于 generator/schema/golden 任务，还要单独红测“schema 非法、generator 漂移、golden/hash 不匹配”至少一种负向场景。
4. 在任务计划中给出并粘贴**完整、可编译的最小实现代码**：包含 imports/exports、完整签名、返回类型、错误码和必要 disposer/AbortSignal 路径；禁止只列 interface、bullet 行为、diff 片段省略号或空 handler。实现范围不得顺带迁移下一个领域。大量同构 fixture 的最小实现应包含 generator 的完整核心算法、schema 校验入口和一个 golden 输出；不得伪装为把数十个/数百个机械变体全部手工粘贴进计划。
5. 任何新增 npm command 都必须在该任务的 `Files` 中明确写 `Modify: package.json`，并在最小实现段给出可直接粘贴到仓库根 `package.json` 的精确 `scripts` key/value；同时注明 runner 的首次创建路径（例如 `scripts/run-wave3-gates.mjs`）和归属 Task/Wave。非 root package script 必须明确目标 package 的完整路径，禁止笼统写“增加 script”。
6. 运行目标测试，写明 `Expected exit: 0` 和关键 PASS assertion；再运行相邻回归。
7. 运行 `npm run typecheck`；若任务影响 test types，同时运行 `npm run typecheck:tests`。
8. 检查 diff、无 placeholder、无 stub/空套件、无文本正则控制流、无新副作用旁路。
9. 使用 code-reviewer 做独立复核并修复高置信问题。
10. 将 test output、artifact hash、policy/environment snapshot 写入当期 evidence run。
11. 用户明确要求提交时，使用该任务给出的 commit message；未授权时保持未提交并报告。

任务计划的最低完整性示例是“完整 test 文件代码 + 精确红命令/exit/error assertion + 完整最小源码文件代码 + 精确 `package.json` script 片段 + 精确绿命令/exit/PASS assertion”；仅有 `Failing test first`/`Minimal implementation` 条目列表不满足本协议。

### 版本化同构 fixture/generator contract

当一个 Task 需要多个同构平台、profile、component、failure 或 protocol fixture 时，Task 的 `Files` 必须完整列出：

- versioned input schema（例如 `tests/fixtures/<area>/schema.v1.json`）；
- generator 的固定源码、版本、argv 和输出目录；
- golden manifest（每个生成 ID、canonical input hash、output path、output SHA-256、expected status/error）；
- 一份手工 red test 和一份 generator/golden drift test；
- implementation 中真正被运行的 generator/schema validator/golden comparator。

实现者可以用 generator 生成同构 fixtures，但不得把“每项都手工粘贴”当作真实性证明，也不得用 generator 隐藏未覆盖的 target cell：manifest 中每一行必须可追溯到 schema 输入、生成命令、golden hash 和至少一个执行/negative assertion。静态 `check:test-discovery` 必须发现生成后的真实 tests；零输出、空 golden、固定 passed JSON、未执行 generator 或缺失 schema 输入均为 `EMPTY_OR_STUB_SUITE`。

## Wave Completion Audit

每个 Wave 结束必须回答：

- 当期 Requirement/S 范围有哪些真实源码路径？
- 哪些正向和反向场景实际运行？
- 测试发现是否覆盖根、package、co-located suites？
- `check:requirement-coverage` 是否为唯一 requirement 命令，且 R01-R20/S1-S13 都闭包？
- 当期 Required Gate 是 `passed`、`failed` 还是 `blocked`；非 Required Gate 的严格 N/A 是否满足 schema？
- N/A 能力是否在命令、Gateway、ToolCatalog、CapabilityRegistry 全层不可达？
- known-failure catalog 的 30 个 ID 是否各自恰为 `open` 或 `resolved-with-green-regression`，本 Wave fix 是否完成原子迁移？
- migration 是否实际恢复/对账？
- Gate evidence 是否通过严格 runtime schema、exitCode、附件存在/SHA-256 重算及 artifact/environment/policy binding？
- 是否存在文本非空、`[GOAL_DONE]`、普通字符串或 HTTP 200 被错误当成完成？
- 是否存在未通过 pipeline 的副作用？
- 是否存在旧健康 scope 在 candidate 失败时被提前销毁？
- Wave 3 是否含当前 candidate 的 `C-W3`，而非只引用 prior compatibility evidence？
- MCP modern evidence 是否仅为 `2026-07-28`，legacy 是否隔离且未满足 current capability？
- Windows 11 production 与 Windows 10 legacy evidence 是否分离；Node scope 是否逐字等于 canonical expression？
- Gate I 是否由签名 profile 精确派生并覆盖六个 required target cells？
- 当前结论的 Evidence IDs 和完整 artifact hash 是什么？

任何不确定项均按未完成处理，下一 Wave 不得掩盖失败。

# WxNodus V4 生产级 CLI 系统设计规范

- 状态：用户已书面批准，进入分 Wave 实施
- 日期：2026-08-13
- 迁移代号：V4 Strangler Migration
- 适用仓库：`WxNodusV3CLI`
- 参考蓝图：已审阅用户提供的《Kimi Agent Skill 通用蓝图（初始蓝图）》；其相关原则已在本文第 8、15、16、21 和 26 节重新定义
- 规范性质：后续实施计划、代码变更、发布门和最终验收的固定范围

## 1. 目的

本规范定义 WxNodus 从当前 V3 演进为生产级 V4 CLI 系统的产品边界、架构边界、协议、迁移顺序、安全模型、质量控制、自主运行机制和完成标准。

V4 的产品定位是：

> Windows 本地优先、Agent-neutral、Evidence-native 的可验证软件交付编译器。它把自然语言目标编译为可运行产物、验证结果和可审计证据包；执行后端可以是本地规则、云模型、本地模型或第三方 Coding Agent。

V4 不以“模型输出了答案”作为完成，不以“工具返回了字符串”作为成功，也不以测试数量或文档完整度代替用户目标覆盖。任何完成声明都必须由独立验证和 CompletionGate 决定。

## 2. 已批准决策

用户已于 2026-08-13 明确批准以下基线：

1. 采用兼容演进式 V4，不进行一次性清洁重写。
2. Windows 11 current production x64 为一级生产平台；Windows 10 22H2 仅进入 legacy compatibility matrix；Linux/macOS 为核心能力二级平台。
3. 提供 Core、Standard、Full Local AI 三个安装档位。
4. 移除“零下载、零运行时依赖、所有能力必须单文件”的限制。
5. 保留本地优先、数据外发透明、可离线缓存、供应链可审计原则。
6. 使用 Presentation、Application、Domain Kernel、Infrastructure、Protocol 五层边界。
7. UI 与功能彻底分离；TUI、CLI、JSONL、Wire、HTTP 和 MCP 复用同一应用服务。
8. 所有工具副作用进入统一 ToolExecutionPipeline。
9. 所有成功结论进入独立 CompletionGate。
10. 按 Wave 0 至 Wave 4 交付和验收；Wave 0 至 Wave 3 为 internal/canary migration increments，只有其当期适用门通过后才能发布，未交付能力必须不可达并标记 `N/A`；Wave 4 GA 必须通过全部最终 Gate。
11. 最终完成必须覆盖用户全部显式要求，并具有真实文件、命令、测试和运行证据。

## 3. 规范词义

本文使用以下约束词：

1. **必须**：发布前不可缺失。
2. **不得**：任何模式和实现都不可违反。
3. **应**：默认实现；偏离时必须记录理由和等价验证。
4. **可以**：可选能力，不影响基础完成标准。
5. **一级平台**：必须在真实平台完成端到端验证。
6. **二级平台**：必须通过核心构建和自动化测试；平台专属能力允许诚实降级。
7. **Required**：对指定安装档位和平台必须可用；缺失直接阻断相应发布门。
8. **Optional**：可以缺失，但必须在 CapabilityReport 中标明缺失和降级行为。
9. **Unavailable**：平台或档位明确不提供；调用必须返回结构化不可用结果，不得伪装成功。

## 3.1 规范性术语和来源

FDR 在本文中固定表示五个确定性回路：Observe、Execute、Verify、Govern、Evolve。单核双壳表示共享 Application/Domain/Protocol 核心与可替换 Presentation 外壳；它不要求 V4 首发提供 Studio。

本文只将上述重新定义的术语作为验收依据。蓝图原文属于设计输入，不是实施或完成证据；实施环境不得依赖仓库外个人路径。

## 4. 明确交付目标

V4 必须交付以下能力：

1. **R01 — Middleware**：本地化、简化且可替换的中间件和应用服务层。
2. **R02 — SessionStart**：可生成、验证、批准、安装、禁用和卸载的 SessionStart 组件。
3. **R03 — Commands**：统一、安全、可生成、验证、注册和热卸载的 Commands 系统。
4. **R04 — MCP Servers**：可生成、验证、批准、安装、禁用和卸载的 MCP Servers。
5. **R05 — Sub-agents**：可生成且具有任务票据、预算、隔离、取消、验收和卸载生命周期的 Sub-agents。
6. **R06 — Plugins**：可生成且具有权限清单、强制隔离、批准、安装、禁用、卸载清理和签名信息的 Plugins。
7. **R07 — Full-window Automation**：具有多层驱动、权限控制、急停和后置验证的全窗口 AI 自动化。
8. **R08 — Voice Mode**：具有稳定状态机、可取消转录和资源生命周期的 Voice Mode。
9. **R09 — Black Hole Engine**：具有事务一致性、严格作用域和可重建索引的 Black Hole Engine。
10. **R10 — Existing Core**：保留并增强会话、权限、Hooks、工具、模型、构建、证据和审计等核心能力。
11. **R11 — UI Separation**：功能内核可脱离 TUI，通过多种 presentation adapter 使用。
12. **R12 — Self-developed CLI**：自研 CLI shell、Gateway protocol 和核心交付语义。
13. **R13 — First-run Locale**：首次交互启动必须先选择中文或 English。
14. **R14 — Personalization**：支持用户级、工作区级的名称、人格、主题、模型、工具策略、Voice 和 Memory 个性化。
15. **R15 — Quality Control**：引入独立质量控制面，消除 false success。
16. **R16 — Autonomy Control**：引入持久化自主控制面，限制预算、循环、并发、外部副作用和子代理传播。
17. **R17 — Dependencies and Profiles**：使用成熟依赖、模型和可选二进制，提供 Core/Standard/Full Local AI 三档安装、CapabilityReport、checksum、SBOM、许可证和来源审计，并支持缓存和 air-gapped 安装。
18. **R18 — Production Lifecycle**：提供 Windows 11 current production 一级平台、Windows 10 22H2 legacy compatibility matrix、Linux/macOS 二级平台的安装、升级、数据库/配置迁移、operational rollback 或明确的 forward-only recovery、卸载、诊断和发布验证。
19. **R19 — Blueprint Principles**：落实已重新定义的 FDR、单核双壳接口、ComponentForge 和“无证据不得完成”，不继承零下载/零依赖限制。
20. **R20 — Chinese Completion Report**：最终用中文报告实际完成证据、失败、阻塞和未验证项。

## 5. 非目标与边界

本次建设不包含以下范围：

1. 不在 V4 首发中建设完整图形化 Studio；只保留未来 Studio 使用同一 Application/Protocol 层的接口边界。
2. 不承诺所有本地模型在任意硬件上达到云模型质量；必须报告模型、硬件和能力限制。
3. 不为追求“完全自研”而重写 SQLite、React、Playwright、ffmpeg、Whisper、MCP transport 或密码学库。
4. 不保证所有第三方 MCP Server、Plugin 或 Skill 安全；未验证组件必须隔离并标记来源和状态。
5. 不允许 yolo 或其他权限模式绕过不可取消的硬红线。
6. 不以长期维护两套内核作为迁移策略；兼容适配层必须随领域迁移完成而删除。
7. 不把 README 声明、manifest 条目或单元测试数量视为生产完成证据。

## 6. 方案比较与选型

### 6.1 方案 A：兼容演进式 V4（采用）

在现有入口和数据外建立兼容层，按领域逐步替换内部实现。

优点：

- 保留现有命令、配置、会话、Skills、Plugins 和项目数据。
- 每一波均可独立验证并形成 internal/canary migration increment；只有达到 Wave 4 且全部最终 Gate 通过才能发布 GA。
- 通过 migration rollback、operational rollback 或明确标记的 forward-only 数据演进控制恢复风险。
- 已有真实能力不会因整体替换而丢失。

代价：

- 迁移期存在 adapter 成本。
- 必须管理旧路径退出条件，避免双轨永久化。

### 6.2 方案 B：清洁重写（不采用）

创建全新内核，仅提供旧数据一次性导入。

不采用原因：

- 用户数据、扩展生态和命令兼容风险过高。
- 大爆炸式切换难以对每项能力提供连续证据。
- 容易把已有生产缺陷和新回归混为一体。

### 6.3 方案 C：长期新旧并行（不采用）

以独立 `wxnodus-v4` 长期运行，成熟后再替换。

不采用原因：

- 会形成两套配置、Session、Memory、权限和完成语义。
- 用户和开发者无法判断哪套状态是真实来源。
- 长期维护成本高于受控适配迁移。

允许使用短期内部并行验证，但不得成为正式产品架构。

## 7. 产品和平台边界

### 7.1 一级生产平台

- Windows 11 current production x64（仍在 Microsoft 服务期的 GA Channel 版本）
- Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`
- PowerShell
- Windows UI Automation
- robotjs / node-screenshots
- Playwright
- ffmpeg
- whisper.cpp
- Windows SAPI

Windows 一级能力必须在真实 Windows 11 current production 环境完成集成验证，mock 只能作为前置测试。产品仍保持 Windows 本地优先；`engines.node`、安装器、CI、CapabilityReport、文档和发布产物必须使用同一 Node 支持表达式，不得另设 release tooling 范围。

### 7.2 二级与遗留兼容平台

Linux 和 macOS 必须支持：

- CLI 与非交互模式
- JSONL/Wire
- Session 和 Agent
- Memory
- MCP
- Skills
- Plugins
- Build/Verify/Evidence

Windows 专属能力通过 CapabilityRegistry 返回 `unavailable` 或声明的降级状态，不得返回假成功。

Windows 10 22H2 已于 2025-10-14 结束支持，且当前 Playwright 官方系统要求从 Windows 11 起；因此 Windows 10 只作为 non-GA 的 legacy compatibility matrix，记录 best-effort 构建、CLI/数据迁移和不依赖 Playwright 的兼容结果。其失败不降低 Windows 11 Tier 1 门，不得将 Windows 10 宣称为当前生产支持平台，也不得以替代浏览器运行时伪造 Playwright 官方支持。

### 7.3 安装档位

#### Core

- 基础 CLI 和 Gateway protocol
- 规则脑和确定性工具
- Session、Commands、Permissions、Hooks
- MCP/Skill 基础支持
- 不自动下载本地模型
- SQLite/FTS Memory、Plugin runtime、PTY、完整 Verify/Evidence 和 Browser DOM automation 均为 Optional；缺失时必须按 canonical 表诚实降级

#### Standard

- Core 全部 Required 能力
- SQLite/FTS Memory
- PTY
- Browser DOM automation
- Plugin runtime
- 完整 Build/Verify/Evidence
- Windows UIA、robotjs、node-screenshots、SAPI 和 Computer Use 驱动在 Windows 为 Required

#### Full Local AI

- Standard 全部 Required 能力
- embedding 模型
- whisper.cpp 和语音模型
- 本地 LLM
- 视觉模型
- 离线缓存与 air-gapped 安装清单

每个档位必须生成 CapabilityReport，缺少组件时报告安装指引、来源和降级结果。

### 7.4 Capability × Profile × Platform 合同

下表是 profile × platform 唯一 canonical 合同；Wave、安装器、CapabilityReport、测试和发布门只能引用本表，不得在别处把 Optional 提升为 Required 或把 Required 降为 Optional。

| 能力 | Windows 11 Core | Windows 11 Standard | Windows 11 Full Local AI | Linux/macOS Core | Linux/macOS Standard | Linux/macOS Full Local AI |
|---|---|---|---|---|---|---|
| CLI、Session、Commands、Permissions、Hooks、Gateway | Required | Required | Required | Required | Required | Required |
| MCP client/server、Skills、Build 基础链 | Required | Required | Required | Required | Required | Required |
| SQLite/FTS Memory、Plugin runtime、PTY、完整 Verify/Evidence | Optional | Required | Required | Optional | Required | Required |
| Browser DOM automation | Optional | Required | Required | Optional | Required | Required |
| UIA、robotjs、node-screenshots、SAPI、Computer Use | Unavailable | Required | Required | Unavailable | Unavailable | Unavailable |
| embedding/vector 混合检索 | Unavailable | Optional | Required | Unavailable | Optional | Required |
| 本地 LLM、Voice transcription、Vision models | Unavailable | Optional | Required | Unavailable | Optional | Required（受平台模型支持约束） |
| air-gapped bundle | Optional | Optional | Required | Optional | Optional | Required |

Required 能力缺失必须阻断对应档位发布；Optional 能力可以安装并验证，但缺失时必须诚实降级；Unavailable 能力被调用必须返回稳定错误码。Profile 安装器不得把上级档位能力暗示为下级档位已具备。Wave 4 的“完整发布”是指完整执行本表，而不是把 Windows Core 的 Optional 能力改为 Required。Windows 10 22H2 不进入此 canonical GA 表，只按第 7.2 节 legacy compatibility matrix 报告。

## 8. 核心设计原则

1. **Agent-neutral**：云模型、本地模型、规则执行和第三方 Agent 共享交付协议。
2. **Evidence-native**：证据不是日志附属品，而是完成决策的输入。
3. **Local-first**：默认本地存储；网络外发必须可见、可控、可审计。
4. **Least privilege**：工具、Plugin、Sub-agent 和自动化驱动只获得任务所需权限。
5. **No false success**：未执行、未验证、被拒绝、能力缺失和 inconclusive 必须如实表达。
6. **One source of truth**：Session、Voice、Run、Extension 和 Completion 各自只有一个权威状态源。
7. **Protocol before presentation**：功能先通过稳定协议暴露，再由 UI 呈现。
8. **Durable autonomy**：长任务的目标、预算、尝试、副作用和验证均持久化。
9. **Reversible migration**：schema 和领域切换必须具有备份、迁移记录和回滚策略。
10. **Mature dependencies**：优先复用成熟框架，不以单文件约束牺牲安全和质量。

## 9. 目标分层架构

```text
Presentation
├── TUI
├── CLI
├── JSONL
├── Wire
├── HTTP/SSE
├── MCP Server
└── Future Studio Adapter
        │ Gateway Protocol
Application
├── SessionService
├── PromptService
├── CommandService
├── BuildService
├── ExtensionService
├── VoiceSessionService
├── ComputerUseService
└── PersonalizationService
        │ Application Ports
Domain Kernel
├── AgentLoop
├── ToolExecutionPipeline
├── GoalPlanDag
├── PermissionPolicy
├── MemoryPolicy
├── ConceptCompiler
├── ComponentForge
├── BudgetLedger
├── ProgressDetector
└── CompletionGate
        │ Infrastructure Ports
Infrastructure
├── SQLite Repositories
├── JSON/JSONL Stores
├── MCP Transports
├── Plugin Workers
├── Process Supervisor
├── ffmpeg/Whisper/SAPI
├── robotjs/UIA/Playwright
└── Model Providers
        │
Protocol
├── DTO
├── Event Schema
├── Error Codes
├── Capability Negotiation
└── Versioning
```

### 9.1 依赖方向

- Presentation 只能依赖 Protocol 和 Application ports。
- Application 可以编排 Domain，但不得包含设备驱动细节。
- Domain 不依赖 React、SQLite、Playwright、PowerShell 或具体模型 SDK。
- Infrastructure 实现 Domain/Application 定义的 ports。
- Protocol schema 不导入 TUI 类型。
- 禁止 Gateway、Command handler 或 hook 直接操作 React/TUI 状态。

## 10. 组合根和 Gateway Protocol

### 10.1 组合根

当前集中式 CLI 入口拆为：

```text
src/bootstrap/
├── bootstrapConfig.ts
├── bootstrapRepositories.ts
├── bootstrapKernel.ts
├── bootstrapExtensions.ts
├── bootstrapPresentation.ts
├── bootstrapShutdown.ts
└── createApplication.ts
```

启动顺序固定为：

```text
ParseArgs
→ ResolveDataDir
→ PreBootstrapOnboarding
→ LoadAndMigrateConfig
→ OpenRepositories
→ CreateKernel
→ RegisterExtensions
→ CreatePresentation
→ StartServices
```

关闭顺序反向执行，并为每个资源保留 disposer。

### 10.2 Gateway 职责

Gateway 只负责：

- 协议版本协商
- 请求 schema 校验
- DTO 映射
- Application Service 调用
- 结构化错误编码
- 事件投影
- cancellation 传播

Gateway 不负责：

- 直接读写 SQLite
- 执行模型循环
- 拼装 Voice 命令
- 扫描 Plugin/Skill
- 保存人格和主题
- 推断 UI 状态

### 10.3 统一错误结构

```ts
interface GatewayError {
  code: string;
  message: string;
  messageKey: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  causeId?: string;
}
```

控制流必须依赖 `code`，不得依赖中文或英文错误文本正则。

### 10.4 HTTP 安全默认值

- 默认仅绑定 loopback。
- 默认禁用任意源 CORS。
- 使用随机 bearer token 或显式本地信任配置。
- 每个客户端使用独立 session context。
- 非 loopback 监听必须显式配置和审批，并在生产模式要求 TLS 1.2+、受信证书或受信反向代理、bearer authentication、Host/Origin policy 和 token rotation。
- 无 TLS 的非 loopback 仅允许显式 development mode，且不得通过发布门。
- token 不写入普通事件日志。

## 11. 配置、首次启动与个性化

### 11.1 配置分层

配置优先级从高到低：

1. 命令行参数
2. `WXNODUS_*` 环境变量
3. 工作区配置
4. 用户级配置
5. 平台和产品默认值

建议用户级目录遵循平台约定；工作区配置只保存可共享且不含密钥的覆盖项。

### 11.2 配置结构

```json
{
  "configVersion": 1,
  "onboardingVersion": 1,
  "locale": "zh-CN",
  "installationProfile": "standard",
  "personality": {
    "name": "WxNodus",
    "tone": "professional",
    "systemPrompt": null
  },
  "theme": {
    "preset": "nodus",
    "accent": "cyan"
  }
}
```

配置写入使用 schema 验证、临时文件、fsync/rename 或平台等价原子流程。迁移前保留带版本备份。

### 11.3 首次语言选择

交互式首次启动必须在数据库、Agent、MCP、Plugin 和 TUI 初始化前显示：

```text
Select language / 选择语言

  1. 中文
  2. English
```

规则：

- 用户级配置保存机器用户首选语言。
- 工作区允许覆盖用户首选语言。
- `--lang zh|en` 优先级最高。
- `WXNODUS_LANG` 次于命令行参数。
- `-p`、`--json`、`--wire`、`--serve`、非 TTY 永不等待输入。
- `--help` 和 `--version` 不创建 onboarding 状态。
- 非交互首次运行优先使用参数或环境变量，其次使用系统区域；无法推导时使用 English。

### 11.4 国际化覆盖

必须国际化：

- CLI help
- TUI
- Slash command 描述
- 错误和审批提示
- Voice 状态
- 安装、更新和诊断
- Forge 生成说明
- Evidence 报告
- System Prompt

英文模式不得残留决定行为的中文提示，中文模式也不得依赖英文文本解析。

### 11.5 个性化

用户可配置：

- 产品显示名称
- 人格和语气
- 自定义 system prompt
- 主题、配色和欢迎页
- 默认 Agent 和模型
- 工具和审批策略
- Voice 音色和设备
- Memory retention 和召回范围
- Extension collection

所有设置结构化持久化并可导入导出。`/personality`、`/lang` 和对应 Gateway RPC 必须读回验证后才报告成功。

## 12. Session、Commands 与 Hooks

### 12.1 Session 生命周期

事件拆分为：

- `session.start`：逻辑 session 创建时只触发一次。
- `session.resume`：从持久化状态恢复时触发。
- `run.start`：每次 Agent 或确定性任务执行开始时触发。
- `turn.start`：每个模型或规则回合触发。

所有事件必须包含 `sessionId`、`timestamp`、`locale`、`source`、`capabilities`、`policySnapshotId` 和 `correlationId`。`runId` 仅对 `run.start`、`turn.start` 必填；`session.start`、`session.resume` 可以携带可选 `triggeringRunId`，不得伪造 Run。`turn.start` 还必须包含 `turnId`。

SessionStart 组件必须声明触发事件、权限、超时、失败策略和 disposer。安全关键 SessionStart 失败默认阻止 Session 进入 ready。

### 12.2 Command Grammar

统一 grammar 支持：

- shell 风格引号和转义
- JSON 参数
- `--flag value`
- `--flag=value`
- `--` 参数终止符
- namespace 和 ownership
- alias
- register/unregister/disposer
- 热卸载

未知 flag 默认返回结构化错误，不得静默忽略。TUI、`-p` 和 Wire 共用以下输入管线：

```text
Input
→ Slash Grammar
→ Deterministic Intent
→ Natural-language Rule
→ Agent Prompt
```

Command handler 使用明确的 `CommandResult`，普通字符串不得自动解释为成功。

### 12.3 Hooks

```ts
type HookDecision =
  | { action: "continue" }
  | { action: "deny"; reason: string }
  | { action: "modify"; value: unknown }
  | { action: "require_approval"; reason: string };
```

安全关键 Hook 默认 fail-closed；仅展示和遥测 Hook 可 fail-open。每次异常都写入审计，但敏感参数必须先脱敏。

## 13. ToolCatalog、MCP、Skills 与 Plugins

### 13.1 统一 ToolCatalog

工具按来源命名：

```text
builtin:<tool>
mcp:<server>:<tool>
plugin:<plugin>:<tool>
skill:<skill>:<tool>
forge:<component>:<tool>
agent:<agent>:<tool>
```

每次注册返回 disposer。任一来源 reload 只能替换自己的 registration scope，禁止整体覆盖 extra tools。

工具元数据必须分离：

- read/write effect
- filesystem scope
- network scope
- process scope
- UI automation scope
- approval requirement
- reversibility
- idempotency
- timeout
- cancellation support
- evidence producer

### 13.2 MCP

V4 MCP modern 基线固定为 `2026-07-28`。该基线是无状态、按请求自包含的 JSON-RPC 协议：server 必须实现 `server/discover`；每个请求的 `_meta` 必须携带 `io.modelcontextprotocol/protocolVersion` 和 `io.modelcontextprotocol/clientCapabilities`，不得从连接、进程或先前请求推断会话、身份、版本或能力。modern 路径没有 `initialize` 握手或 MCP session 语义；跨请求状态只能用每次显式传递的 task/thread/application handle 标识。

MCP `2025-11-25` 及更早版本属于 legacy。`initialize`、initialized notification、stateful connection/session 及相关版本协商只能封装在独立 compat adapter，必须与 modern application/domain path 隔离；modern client 对 stdio 先用 `server/discover` 探测，只有确认 legacy 后才进入 compat adapter。不得让 legacy `initialize` 成为 modern server、Forge 模板或 GA 核心依赖。

V4 MCP client/server 的 P0 支持范围为：

- Tools
- Resources
- Prompts
- subscribe/notify subscriptions
- Form Elicitation；不得用于密码、API key、access token 或支付凭证
- stdio
- Streamable HTTP
- HTTP OAuth 2.1 adapter、Protected Resource Metadata/authorization-server discovery、PKCE、resource/audience binding 和 bearer token validation
- `server/discover`、per-request capability negotiation 和 modern `_meta`

上述 P0 能力必须在适用 client/server 角色和声明的 profile/platform 上通过正反 contract test；没有声明的能力不得被假设存在。MCP Tasks 是独立 **Preview extension**，只能显式 opt-in、capability-negotiated 并有 core synchronous/产品自有 TaskRunner fallback；它不得成为任一 GA Required AcceptanceCriterion、Build/Verify/CompletionGate、取消语义或互操作性的唯一依赖。Tasks 支持缺失时必须降级，不得阻断不依赖 Tasks 的 GA 核心流程。

所有 HTTP MCP URL、authorization metadata endpoint 和 redirect 必须通过 SSRF policy。项目配置 round-trip 不得丢失 transport 或 protocol-era 字段。

WxNodus 自身提供 MCP Server，向外暴露经权限控制的 build、verify、evidence、memory、forge、browser、computer 和 session 应用能力；这里的 `session` 是 WxNodus 应用实体，不得映射为 modern MCP transport/session 状态。

### 13.3 Skills

- 使用完整 YAML frontmatter parser。
- 明确区分目录标识、声明名称和版本标识。
- 校验路径遍历、symlink 逃逸和名称冲突。
- 支持版本、依赖、capabilities 和 entrypoints。
- 单个 Skill 加载失败不得阻断其他 Skill。
- 生成 Skill 必须通过 schema 和行为验证后才能 enabled。

### 13.4 Plugins

隔离分为两个信任等级：

- Trusted Plugin 可以使用 Worker 或普通子进程实现 crash isolation，但必须明确显示它仍继承当前用户的 OS 权限。
- Untrusted Plugin 必须运行于可强制执行的 OS sandbox、restricted token 或等价容器中；若当前平台无法提供该边界，则只能保持 quarantined，不能 enabled。

所有生产 Plugin 必须具备：

- manifest 权限声明
- `onLoad` / `onUnload`
- disposer tracking
- schema 化 capability broker 和 IPC
- timeout 和 cancellation
- crash isolation
- 来源、checksum 和签名信息
- 热卸载时清除 tools、commands、events 和资源

Untrusted Plugin 运行环境必须清除非必要环境变量和继承句柄，禁止直接使用 Node 文件、网络、进程和凭证 API；所有能力通过 broker 进入 PDP。发布门必须使用恶意测试 Plugin 验证文件、网络、环境变量、进程和 broker 越权无法逃逸。

## 14. Sub-agents 与自主执行

### 14.1 TaskTicket

```ts
interface TaskTicket {
  id: string;
  parentRunId: string;
  objective: string;
  acceptanceCriteria: string[];
  ownedFiles: string[];
  allowedTools: string[];
  budget: BudgetSlice;
  workspaceStrategy: "shared-readonly" | "worktree";
  deadline?: string;
}
```

### 14.2 隔离和治理

- 并行写代码的 Sub-agent 默认使用 Git worktree。
- 每个写任务声明 owned files。
- 两个 Agent 不得无协调地修改同一文件。
- depth、fanout、预算和 lineage 跨实例持久化。
- cancellation 沿 lineage 传播。
- Agent 被取消后，ToolExecutionPipeline 拒绝新的副作用。
- 子 Agent 不得自行提升权限、预算或可访问路径。
- 合并前必须完成 acceptance criteria、验证和冲突检查。

### 14.3 TaskRunner 语义

Shell 和 Agent task 统一拥有：

- queued/running/blocked/succeeded/failed/cancelled 状态
- timeout
- AbortSignal
- retry policy
- effect fencing
- durable log
- recovery policy

仅更新数据库状态不算取消成功；必须确认执行体停止或被隔离到无法继续产生副作用。

## 15. AI 生产质量控制面

### 15.1 完成协议

```text
Maker Agent
→ Candidate Artifact
→ Deterministic Verifier
→ Independent Reviewer
→ CompletionGate
→ Final Status
```

最终状态只有：

- `succeeded`
- `failed`
- `blocked`
- `incomplete`
- `inconclusive`
- `cancelled`

模型只能提交 `candidate_complete`。`AgentResult.ok` 不得再由输出文本非空决定。

仅当每个 Required AcceptanceCriterion 都对当前 artifact hash、environment snapshot 和 policy snapshot 获得 `passed`，且独立复核通过时，CompletionDecision 才能为 `succeeded`。状态映射固定为：

- 任一 required criterion 明确不通过：`failed`。
- 缺少产物或必需证据：`incomplete`。
- verifier 或 reviewer 异常、结果相互冲突且无法裁决：`inconclusive`。
- 能力、权限、外部依赖或必需审批不可用：`blocked`。
- 用户或上游取消：`cancelled`。

Independent Reviewer 必须与 Maker 使用不同执行身份、凭证和独立上下文，不得复用 Maker 的未验证自述。Reviewer attestation 必须绑定当前 `artifactHash`、`environmentSnapshotId`、`policySnapshotId`、acceptance criteria/result digest，并包含 reviewer identity、issuer、签名算法与 key ID/certificate reference、nonce、签发时间、有效期/最大 freshness window 和单次使用/消费状态；CompletionGate 必须验证签名与 issuer/key trust policy、freshness、nonce 唯一性及 replay ledger，过期、重复、撤销、Maker 同身份或绑定不一致一律为 `inconclusive` 或失败而不得通过。低影响确定性任务可以由独立 verifier 组合代替第二模型，但该组合须产生同等可验证 attestation，仍不得由 Maker 自判。`OperationResult.ok` 只表示某次操作成功，不得隐含目标完成。

### 15.2 持久化实体

- Run
- Attempt
- PlanStep
- AcceptanceCriterion
- VerificationRun
- Artifact
- EvidenceRecord
- CompletionDecision
- ReviewerAttestation

每个 CompletionDecision 必须可追溯到 acceptance criteria、verifier 结果、当前 artifact hash、environment/policy snapshot 和已消费的 reviewer attestation。

### 15.3 Verifier Registry

最低必须支持：

- `command.exit-code`
- `typescript.typecheck`
- `npm.build`
- `npm.test`
- `file.exists`
- `file.content`
- `workspace.diff`
- `json.schema`
- `process.readiness`
- `http.contract`
- `database.query`
- `browser.dom`
- `browser.url`
- `uia.property`
- `screenshot.ocr`
- `human.approval`

Verifier 异常得到 `inconclusive`，不得转换为通过。

### 15.4 Evidence

证据记录包含：

- 原始目标和 acceptance criteria
- 执行命令及规范化参数
- exit code
- stdout/stderr 摘要和原始附件引用
- 文件完整 SHA-256
- 稳定编码的相对路径和边界
- 环境与 capability snapshot
- verifier 名称和版本
- 时间与 correlation ID
- decision lineage
- reviewer attestation 引用、签名验证、issuer/key trust、nonce/freshness 和 replay 检查结果

最终测试后必须重新生成 Evidence，再运行 CompletionGate。证据 hash 不得截断为弱指纹。

## 16. 自主能力控制面

### 16.1 持久化控制实体

- Goal
- Plan
- PlanStep
- Run
- Attempt
- Effect
- Budget
- VerificationRun
- CompletionDecision

### 16.2 多维预算

预算至少覆盖：

- input/output tokens
- monetary cost
- wall clock
- model turns
- tool calls
- retries
- sub-agent depth
- fanout
- concurrent agents
- network requests
- external writes
- browser actions
- desktop actions
- screenshots
- affected files
- affected bytes

### 16.3 ProgressDetector

以下情况触发暂停、重规划或人工确认：

- 重复执行同一工具且输入和环境无有效变化
- 多轮无新增 artifact 或 evidence
- 相同错误超过 retry policy
- 仅修改计划但没有生产输出
- Sub-agent 深度或 fanout 接近预算
- 外部副作用数量异常上升

Goal verifier 抛错或证据缺失时最终状态必须是 `inconclusive` 或 `incomplete`，禁止 fail-open。

## 17. Black Hole Engine

### 17.1 一致性模型

Primary message、FTS、metadata、salience、audit record 和 embedding outbox 必须在同一数据库事务中提交。Vector index 由 embedding job 消费 outbox，采用有界最终一致性，并为每条记录暴露 `pending`、`ready`、`failed` 或 `tombstoned` 状态。

该模型必须覆盖 insert、update、delete、compact、session delete、image summary update 和 embedding retry，并满足：

- primary/FTS read-your-writes。
- tombstoned、已删除或 scope 已变化的旧向量不得参与检索。
- 最大允许陈旧时间可配置并可观测；超过阈值返回降级状态。
- retry/dead-letter 和 rebuild 后结果与当前 primary state 等价。

### 17.2 检索作用域

每次检索必须声明：

- session
- project
- user archive
- global opt-in

KNN 查询必须在数据库或重排前严格过滤 scope。跨项目召回默认关闭。

### 17.3 混合排序

```text
normalized(
  ftsScore
  + vectorSimilarity
  + recency
  + salience
  + sourceTrust
  + scopeWeight
)
```

各分量必须可观测并可测试，不再使用“FTS 优先、KNN 仅补齐”冒充真正融合。

### 17.4 运维能力

- embedding job queue
- retry/dead-letter
- index rebuild
- orphan detection
- deduplication
- retention policy
- curator dry-run/apply
- memory provenance
- session 删除级联验证

数据库 schema 使用真实递增版本，不允许 schema 常量与实际列迁移脱节。

## 18. Voice Runtime

### 18.1 权威状态机

```text
idle
→ listening
→ speech_detected
→ transcribing
→ thinking
→ speaking
→ listening
```

任何活动状态都可以进入 `cancelling`，完成资源终止和清理后进入 `idle`。设备丢失、Worker 崩溃或超时进入 `error`；`error` 必须携带稳定错误码并在清理完成后允许显式 `recover → idle`。`stopping` 用于正常停止 continuous session，只有音频设备、子进程、临时文件句柄和播放资源全部释放后才能进入 `idle`。

支持 push-to-talk、continuous half-duplex、wake word、interruption、cancellation 和 device selection。状态转换表必须定义每个事件的前置状态、timeout、AbortSignal 行为、重复请求幂等性和资源清理后置条件。

### 18.2 运行约束

- 修复 WAV RIFF/WAVE header 偏移和长度。
- Whisper 在 Worker 或受控子进程中运行，不阻塞主事件循环。
- 转录任务具有 timeout、AbortSignal 和进程终止确认。
- 临时音频存入独立目录并应用 retention。
- 默认不保留原始录音。
- Gateway/Application 是 Voice 状态唯一事实源，TUI 只订阅。
- 缺少 ffmpeg、whisper 或模型时返回 capability 错误和安装指引。
- 模型下载显示大小、来源、checksum 和许可证。

## 19. 全窗口 AI 自动化

### 19.1 驱动降级链

```text
Official API
→ Browser DOM
→ Windows UIA/MSAA
→ Vision/OCR
→ Coordinate Computer Use
```

选择更低层驱动前必须记录高层驱动不可用的原因。

### 19.2 动作闭环

```text
Observe
→ Resolve Target
→ Policy Check
→ Act
→ Observe Again
→ Verify Postcondition
→ Record Evidence
```

### 19.3 安全和正确性

- 修正 robotjs 双击和滚动参数。
- 正确调用 node-screenshots 尺寸 API。
- UIA Invoke/Selection 失败不得返回 `ok=true`。
- 坐标 fallback 必须真实执行并验证后置状态。
- 支持多显示器、负坐标和 per-monitor DPI。
- 每个 session 使用独立 browser context。
- 初始 URL、导航、redirect、下载和 popup 均经过网络策略。
- `/computer`、`/browser` 和 Agent tool 共用权限管线。
- 提供全局 emergency stop，立即阻止新动作并取消可取消任务。
- 外部发送、删除、付款、发布和系统配置变更要求额外批准。
- 高影响动作在批准界面显示目标、预期效果、可逆性和证据方式。

### 19.4 Windows 支持边界

GA 必须在代表性 Win32、WPF、UWP/WinUI 和 Electron 应用上验证 UIA/输入/截图；Browser DOM 单独覆盖 Chromium 页面。多显示器测试必须包含负坐标、不同缩放比和跨屏目标。

普通用户进程不得自动控制提权窗口；Windows Secure Desktop、UAC consent desktop、登录/锁屏界面和受保护系统 UI 明确在自动化范围外且为 Unavailable，不属于 Windows 11 Tier 1 或 Windows 10 legacy matrix 的验收目标。检测到完整性级别或 Secure Desktop 边界时必须停止并请求用户手动操作，不能降级为盲坐标点击。急停、高影响审批和每层 driver fallback 均必须有真实应用验收场景。

## 20. 概念编译器与 Build Pipeline

### 20.1 唯一构建语义

`/build`、自然语言构建和 Agent `scaffold_build` 必须进入同一 BuildService：

```text
Requirement
→ StructuredSpec
→ AcceptanceCriteria
→ PlanDag
→ ScaffoldOrModify
→ Build
→ Start
→ FunctionalProbe
→ Restart
→ PersistenceReadback
→ Test
→ Evidence
→ CompletionGate
```

Plan modules 必须真实驱动 scaffold 和 verifier，不得仅作为展示元数据。

### 20.2 Web 产物验收

生成的 Web 项目至少必须：

- 构建成功
- 服务静态前端
- `/` 返回可用页面
- health endpoint 可用
- 创建一条业务数据
- 停止并重启服务
- 读回该数据并验证持久化
- 执行项目测试
- 生成最终 evidence

无 test script 不得自动视为测试门通过；必须由 spec 显式声明替代 verifier。

## 21. ComponentForge

### 21.1 组件类型

Forge 支持生成：

- SessionStart package
- Command package
- MCP Server
- Sub-agent
- Plugin
- Skill
- Hook package
- Verifier
- Automation driver

### 21.2 生命周期

Forge 采用正交状态而不是一条不可逆单链：

- Generation：`draft | generated | generation_failed`
- Verification：`unverified | protocol_verified | behavior_verified | verification_failed | quarantined`
- Approval：`unreviewed | approved | rejected | revoked`
- Installation：`not_installed | installed | install_failed | uninstalled`
- Runtime：`disabled | enabled | runtime_failed`

合法转换必须由显式 policy transition 驱动，并覆盖 generate、build、fail、quarantine、approve、reject、install、enable、disable、uninstall、revoke 和 update。每个转换定义幂等键、失败清理和旧版本保留规则。

带占位业务 handler 的组件必须从 `generated/unverified` 直接进入 `quarantined`，不得获得任何 verified 状态。只有 `behavior_verified + approved + installed` 的组件才能 enabled；revoked 组件必须立即 disabled，并按策略卸载和撤销 ToolCatalog registration。

### 21.3 MCP 组件验证

生成 MCP Server 后按 modern `2026-07-28` 路径依次执行：

1. build
2. spawn
3. `server/discover`
4. 校验每请求 `_meta`、版本和 client capabilities；验证同一连接交错无关请求时无隐式 session 污染
5. `tools/list`、`resources/list`、`prompts/list` 与 subscriptions/Form Elicitation/OAuth 的适用 contract
6. `tools/call` positive case
7. `tools/call` negative case
8. process shutdown
9. install preview
10. user approval
11. config write
12. ToolCatalog reload
13. installed tool smoke test

若组件显式声明 legacy 兼容，另由独立 compat adapter 对 `2025-11-25` 执行 `initialize`/session contract；该结果不得替代 modern 验证。Tasks Preview 只能作为非阻断扩展 contract，不能替代 P0 或产品 TaskRunner 验证。

组件名称必须规范化并防止路径逃逸；目录只拼接一次。Command grammar 必须允许安全传入引用路径和 JSON。

## 22. TUI 与功能分离

### 22.1 Hooks 拆分

现有 Session shell 职责拆为：

- `useGatewayLifecycle`
- `useSessionLifecycle`
- `usePromptDispatch`
- `useVoiceSession`
- `useApprovalQueue`
- `useOverlayState`
- `useTerminalSession`
- `useConfiguration`

### 22.2 状态投影

Flow controller 拆为：

- pure reducer
- event projector
- transcript selector
- activity selector

TUI 仅负责渲染、输入、无障碍和本地临时交互状态。核心能力必须在完全不启动 React/TUI 的进程中通过 CLI、Wire、HTTP 或 MCP 运行。

遗留进程外 Gateway client 和进程内 Gateway 必须统一到一份 Protocol client interface，禁止使用 `any` 掩盖两套类型不兼容。

## 23. 数据模型与迁移

### 23.1 新增核心表或仓储

- goals
- plans
- plan_steps
- runs
- attempts
- effects
- budgets
- acceptance_criteria
- verification_runs
- artifacts
- evidence_records
- completion_decisions
- extension_registrations
- capability_snapshots
- embedding_jobs

实际表名可遵循仓库命名习惯，但实体语义和关系不可省略。

### 23.2 迁移要求

- 迁移版本单调递增。
- 每次迁移记录开始、完成、失败和 checksum。
- 修改前创建可验证备份。
- 失败时不更新 schema version。
- 旧 session、message、audit、task、usage 数据必须保留。
- FTS/vector 重建必须可恢复和可重入。
- 配置迁移与数据库迁移分别版本化。
- 迁移必须在实施计划中声明 `rollbackable` 或 `forward-only`；两者均不得静默丢失已确认写入，详细合同见第 31.3 节。

## 24. 安全、隐私与供应链

### 24.1 Permission Decision Point

所有副作用经同一 PDP 判断：

- actor
- source
- requested effect
- resource scope
- current mode
- hard redlines
- user rules
- task budget
- approval state

手动 slash 路径、MCP、Plugin、Sub-agent 和 Agent tool 不得绕过 PDP。

HardRedlinePolicy 必须有稳定规则 ID、版本和 checksum，且任何审批都不能覆盖。V4 初始规范类别至少包含：根/家目录或系统盘递归破坏、磁盘格式化/分区/裸设备写入、关机重启和 fork bomb、系统级注册表破坏、解释器管道/注入执行、凭证与密钥持久化泄漏、未经用户亲自操作的权限/密钥/安全模式变更，以及破坏远端历史的强制推送。Wave 0 必须从当前 `HARD_REDLINES`、敏感路径规则和 command redlines 生成逐条 Policy Manifest；规则增删是安全规范变更，必须审查、版本化和回归测试。

ApprovalGrant 必须绑定 `actorId`、`sessionId`、`runId`、规范化的 effect/tool/arguments、resource hash、`policySnapshotId`、nonce、过期时间和单次使用状态。ToolExecutionPipeline 在实际执行前必须重新调用 PDP；参数、目标资源、策略快照或预算发生变化时审批立即失效，防止重放和参数替换。

### 24.2 凭证和日志

- 密钥继续使用 AES-256-GCM 或等价安全存储。
- 明文密钥不得写入配置、事件、Evidence 或 crash log。
- token streaming 日志默认受 retention 和大小限制。
- Event log 统一脱敏、轮转和保留策略。
- 审计导出必须包含 schema version 和完整性校验。

### 24.3 依赖和下载

允许 npm、原生模块、模型和二进制下载，但必须：

- 锁定版本
- 校验 checksum
- 记录来源
- 生成 SBOM
- 扫描许可证
- 支持缓存和离线安装
- 对可执行文件显示信任边界
- 下载失败时诚实降级

### 24.4 发布证明边界

以下三类证明不得混称为“已签名”或互相替代：

1. **Sigstore bundle**：用于发布文件/离线包签名验证，保存 artifact digest、signature/DSSE、certificate 或 public-key reference、transparency-log/RFC 3161 verification material；Gate H 验证 subject digest、identity/issuer、签名、透明日志或时间戳和 trust root。
2. **GitHub artifact attestation 与 SBOM attestation**：build provenance attestation 绑定 workflow 构建身份与 artifact subject/digest；SBOM attestation 另将 CycloneDX SBOM 作为独立 predicate 绑定同一发布 subject。普通 Actions artifact 上传、SBOM 文件存在或 Sigstore bundle 均不等于这两种 attestation。
3. **npm publish provenance**：只对实际发布到 npm registry 的包，由受支持的 CI/trusted publishing 或 `npm publish --provenance` 生成并在 registry 验证。未发布 npm 包时状态必须为 `N/A (not published)`，不得宣称 npm provenance 已生成；`N/A` 不豁免适用的 Sigstore、GitHub artifact/SBOM attestation。

每个 release artifact 必须在 manifest 中分别记录三类证明的 `verified | failed | N/A`、subject digest 和验证命令/证据；只有实际适用且 verified 的项才能用于 Gate F/H。CycloneDX SBOM 必须版本化并绑定最终 artifact，不能用源码依赖清单替代发布产物 SBOM。

## 25. 错误处理和可观测性

### 25.1 结构化结果

跨层结果使用 discriminated union，不使用文本推断：

```ts
type OperationResult<T> =
  | { ok: true; value: T; evidenceIds?: string[] }
  | { ok: false; error: GatewayError };
```

“命令运行过”与“目标完成”是不同状态。Tool result、Run result 和 Completion decision 不得复用同一个 `ok`。

### 25.2 关联和事件

所有 Session、Run、ToolCall、Approval、Verification 和 Evidence 使用 correlation ID。事件 schema 版本化，并定义：

- producer
- timestamp
- session/run linkage
- sensitivity class
- retention class
- payload schema version

### 25.3 诚实降级

能力缺失、平台不支持、用户拒绝、验证异常、预算耗尽和取消必须使用不同错误码和最终状态。不得将 fallback 文本当作完成结果。

## 26. 关键数据流

### 26.1 交互 Prompt

```text
Presentation Input
→ PromptService
→ Intent Pipeline
→ Goal/Run Creation
→ AgentLoop or Deterministic Handler
→ ToolExecutionPipeline
→ Events
→ Verifiers
→ CompletionGate
→ Presentation Projection
```

### 26.2 Tool Call

```text
Tool Request
→ Catalog Resolve
→ Schema Validate
→ Permission Decision
→ Approval if Required
→ Budget Reserve
→ Execute with AbortSignal
→ Effect Journal
→ Postcondition Verify
→ Evidence Record
→ Budget Commit/Release
```

### 26.3 Extension Reload

```text
Discover
→ Parse and Validate
→ Resolve Dependencies
→ Policy Check
→ Load Isolated Runtime
→ Register in Owned Scope
→ Smoke Test
→ Atomic Scope Swap
→ Dispose Previous Scope
```

加载失败时保留旧的健康 registration scope，不产生半注册状态。

### 26.4 Voice Turn

```text
Audio Capture
→ VAD
→ Transcription Worker
→ PromptService
→ Run
→ Response
→ TTS Worker
→ Playback
→ Listening
```

任意取消都会停止下游阶段并清理临时资源。

### 26.5 Computer Use

```text
Task Step
→ Observe
→ Resolve Driver and Target
→ Permission/Approval
→ Action
→ Re-observe
→ Postcondition Verifier
→ Screenshot/UIA Evidence
→ Completion Input
```

## 27. 交付分解和优先顺序

该目标包含多个独立子系统，不能作为一次不可回滚的大改实施。设计范围固定，但实施按以下子项目和依赖推进。

### 27.1 子项目映射

| ID | 子项目 | 主要规范章节 | 前置依赖 |
|---|---|---|---|
| S1 | Gateway Protocol 与组合根 | 9、10、25、26 | Wave 0 基线 |
| S2 | Config、Onboarding、i18n、Personalization | 11 | S1 |
| S3 | Command Grammar 与安全命名 | 12、24 | S1、PDP 基础 |
| S4 | ToolCatalog 与 Extension Lifecycle | 13、21 | S1、ToolExecutionPipeline、PDP |
| S5 | Black Hole Memory 正确性 | 17、23 | Wave 0 数据 fixture |
| S6 | Voice Runtime | 18 | S1、ToolExecutionPipeline、CapabilityRegistry |
| S7 | Computer Use Drivers | 19、24 | S1、PDP、EffectJournal、Budget |
| S8 | Concept Compiler | 20 | S1、CompletionGate |
| S9 | Verify、Evidence 与 Gate | 15、20、29、30 | CompletionGate、EffectJournal |
| S10 | ComponentForge | 21 | S3、S4、S9、Sub-agent runtime |
| S11 | TUI 分层 | 9、22 | S1、S2 |
| S12 | Build、Test、Distribution、Release | 7、27-33 | S1-S11 |
| S13 | Autonomy、TaskRunner 与 Sub-agents | 14、16、23 | ToolExecutionPipeline、PDP、EffectJournal、Budget |

ToolExecutionPipeline、PDP、EffectJournal、BudgetLedger 和 CompletionGate 是 Wave 1 的共同可信内核，不属于可以延后的 UI 或 Extension 细节。S13 必须在 Computer Use、Untrusted Plugin 或 Forge enabled 之前达到退出标准。

### Wave 0：验收基线

- 建立 prompt-to-artifact matrix 和 Requirement ID coverage check。
- 产出 V3 Compatibility Manifest，枚举 CLI/Slash 命令、参数、退出码、配置字段、数据库 fixture、Gateway/Wire 协议和扩展格式。
- 固化现有命令、数据和协议兼容测试。
- 从当前 hard redlines、敏感路径和 command levels 产出版本化 Policy Manifest。
- 为已知 false-success 和安全缺陷建立失败测试。
- 建立数据库/配置备份和迁移恢复机制。
- 建立测试发现矩阵，确保根、packages 和 co-located tests 均被执行。

退出标准：已知缺陷能被自动化测试稳定复现，且迁移前状态可恢复。

### Wave 1：可信内核

- S1 Gateway Protocol 与组合根
- S3 Command Grammar 与安全命名
- S5 Memory 正确性
- ToolExecutionPipeline、PDP、ApprovalGrant 和 EffectJournal
- BudgetLedger 基础预留/结算语义
- CompletionGate 基础实体、状态和 required criterion 规则
- Offline provider 端到端可达
- 结构化 error/result

退出标准：输入、工具、内存和完成语义不依赖 UI 或文本正则；核心回归通过。

### Wave 2：配置和扩展

- S2 Onboarding/i18n/Personalization
- S4 ToolCatalog 和 Extension lifecycle
- S13 TaskRunner/Sub-agent lineage、取消、恢复和 worktree 隔离
- Session 生命周期
- MCP/Plugin/Skill 隔离、注册、卸载
- Capability Registry

退出标准：全新 zh/en onboarding、旧配置迁移、扩展并存/reload/unload，以及 Sub-agent 隔离/取消/恢复通过。未达到该标准前，Computer Use、Untrusted Plugin 和 Forge runtime 不得 enabled。

### Wave 3：生产能力

- S6 Voice Runtime
- S7 Computer Use Drivers
- S8 Concept Compiler
- S9 Verify/Evidence/Gate
- S11 TUI 分层

退出标准：真实 Windows Voice/Computer Use 场景、构建重启读回和无 TUI 核心运行通过。

### Wave 4：Forge 和发布

- S10 ComponentForge lifecycle
- 遗留实现和 adapter 删除
- S12 Build/Test/Distribution/Release Matrix
- 三档安装、Sigstore bundle、GitHub artifact/SBOM attestation、适用时 npm publish provenance、升级，以及 operational rollback 或预先声明并验证的 forward-only recovery

退出标准：组件生成到安装全链、clean install、upgrade、相应的 operational rollback 或 forward-only recovery 演练，以及 release evidence 通过。

Wave 0 至 Wave 3 只能作为 internal/canary migration increments；每波必须独立提交、验证并满足下表的适用门。Wave 4 才是 GA 候选。迁移若无法在规定 RTO 内恢复 N-1 读写服务，必须预先标记为 forward-only，并使用 expand/contract 和写入对账，不能称为 rollbackable。下一波不能掩盖上一波失败。

## 28. Prompt-to-Artifact 验收矩阵

| Requirement | 目标产物 | 代码边界 | 必须正反场景 | Gate / 完成证据 |
|---|---|---|---|---|
| R01 | Application Services、统一 Gateway | `src/bootstrap/`、`src/application/`、`src/protocol/` | 无 TUI 启动；UI 越层依赖应失败 | A/B/D；boundary test、headless E2E |
| R02 | Session lifecycle、Forge SessionStart 模板 | session service、hook package、forge | generate/verify/approve/install/create/resume/disable/uninstall；每 session 重入 | B/D/G；事件和生命周期证据 |
| R03 | Grammar、Registry、Command Forge 模板 | command service、forge | 引号/JSON/flag/register/reload/disable/uninstall；未知 flag | B/D/F/G；property 和 disposer tests |
| R04 | MCP `2026-07-28` client/server、P0 primitives、Forge lifecycle 与独立 legacy compat adapter | extension/MCP adapters、forge | modern `server/discover`/per-request `_meta`/无 session、Tools/Resources/Prompts/subscriptions/Form Elicitation/OAuth、approve/install/reload/disable/uninstall；legacy `2025-11-25` initialize 仅 adapter；negative call/SSRF；Tasks Preview 缺失不阻断 core | B/D/F/G；modern/legacy 分离的 protocol transcript |
| R05 | TaskTicket、worktree、Sub-agent Forge 模板 | autonomy/task runner、forge | generate/spawn/cancel/merge/recover/disable/uninstall；越权和取消竞争 | B/D/F/G；isolation、lineage、无新 effect |
| R06 | sandboxed Plugin runtime、Plugin Forge 模板 | plugin infrastructure、forge | generate/approve/install/load/crash/reload/disable/uninstall；恶意逃逸 | B/D/F/G；sandbox 和资源清理证据 |
| R07 | Driver layer、PDP、急停 | computer/browser adapters | DOM/UIA/OCR/坐标、多屏/DPI、急停、高影响审批；Secure Desktop 拒绝 | B/E/F/G；真实后置证据 |
| R08 | Voice state machine/workers | voice application/infrastructure | record/transcribe/interrupt/cancel/device-lost/recover/cleanup | B/E/G；真实音频、状态序列和资源检查 |
| R09 | scoped hybrid memory | memory policy/repositories | insert/update/delete/compact/rebuild/search；跨 scope、stale vector、dead-letter | B/C/D/G；隔离、一致性和 orphan tests |
| R10 | Session、Permissions、Hooks、Tools、Models、Build、Audit | kernel/application | V3 Compatibility Manifest 全量正反回归 | B/C/D/F/G；兼容和迁移报告 |
| R11 | presentation adapters | TUI hooks、Gateway client | CLI/Wire/HTTP/MCP 无 React；TUI adapter | A/B/D；boundary test、headless E2E |
| R12 | CLI shell/protocol | `src/cli/`、`src/protocol/` | help/prompt/json/wire/serve；未知参数和 exit code | A/B/D/F；golden output、contract tests |
| R13 | pre-bootstrap onboarding | config/bootstrap | clean TTY zh/en；non-TTY/help/version no write/no hang | B/D/G；双语言 snapshots |
| R14 | PersonalizationService | config/application/TUI | 用户级/工作区级 set/restart/read/export/import/迁移；无效 schema | B/C/D/G；持久化读回 |
| R15 | Verifier Registry、CompletionGate、ReviewerAttestation | quality domain | failed tool/test/tamper/missing/inconclusive；Maker 自述；attestation 签名/issuer/key/nonce/freshness/replay/身份独立负例 | B/D/F/G；false-success 与 attestation regression |
| R16 | Goal DAG、PDP、Budget、EffectJournal、ProgressDetector | autonomy domain | loop/cancel/recover/budget/approval replay；并发和 lineage | B/D/F/G；bounded execution evidence |
| R17 | 三档安装器、CapabilityReport、供应链产物 | installer/capabilities/release | 每档 clean/offline install、缺失 Required/Optional/Unavailable、checksum/license；分别验证 Sigstore bundle、GitHub artifact+CycloneDX SBOM attestations、适用时 npm publish provenance，未发布 npm 为 N/A 且不得宣称 | A/B/F/H；lock、SBOM、license、bundle/attestation/provenance manifest |
| R18 | Migration、distribution、diagnostics、recovery | migrations/scripts/release | Windows + Linux/macOS 构建；upgrade/write/rollback-or-forward-fix/re-upgrade/uninstall/diagnose | A/B/C/H/I；release matrix 和恢复报告 |
| R19 | FDR、单核双壳接口、Forge、Evidence | architecture/quality/autonomy/forge | Observe/Execute/Verify/Govern/Evolve；无 evidence candidate | D/G；设计到实现映射和 CompletionDecision |
| R20 | 中文交付报告 | release evidence | completion audit 包含失败、阻塞、未验证项 | G；中文报告及 Evidence IDs |

Wave 0 必须使用 Requirement ID 自动检查本矩阵的覆盖闭包；任一 R01-R20 缺少代码产物、profile/platform、正反场景、适用 Gate 或真实 Evidence，整体目标均不得宣称完成。

## 29. 测试策略

### 29.1 测试层次

1. Unit：parser、policy、reducer、ranking、state machine。
2. Property-based：Command grammar、路径规范化、配置 round-trip、事件序列。
3. Contract：Gateway DTO、MCP、Plugin IPC、Verifier protocol。
4. Integration：SQLite/FTS/vector、ProcessSupervisor、Tool pipeline、Build pipeline。
5. E2E：CLI、Wire、HTTP、TUI、Forge。
6. Real-platform：Windows 11 current production Voice、UIA、robotjs、多显示器、SAPI；Windows 10 22H2 仅运行 legacy matrix。
7. Migration：旧配置和各 schema fixture。
8. Security：SSRF、路径逃逸、权限绕过、凭证脱敏、证据篡改。
9. Failure injection：worker crash、进程超时、下载中断、DB migration 失败、取消竞争。

### 29.2 必须执行的仓库命令

发布前至少执行并保存输出：

```text
npm run build
npm run typecheck
npm test
```

若当前 `package.json` 没有独立 typecheck script，实施阶段必须新增或记录等价的 `tsc --noEmit` 命令。测试配置必须显式覆盖根 tests、package tests 和 UI co-located tests。

### 29.3 专项测试

- 首次 TTY zh/en 与非 TTY 不阻塞。
- `config.get full`、personality set/read/restart。
- offline model 无 API key 可达。
- SessionStart 每逻辑 session 一次。
- MCP 和 Plugin 工具同时存在且各自 reload 不互删。
- MCP modern `server/discover`、每请求 `_meta`、无隐式 session；legacy initialize 只经过 compat adapter；P0 primitives/OAuth 完整且 Tasks Preview 缺失不阻断。
- Memory KNN scope、索引更新/删除/重建。
- Voice WAV header、转录取消、临时文件 retention。
- Browser redirect SSRF、多 session context 隔离。
- UIA 失败、坐标 fallback、postcondition mismatch。
- Build 静态页面、业务写入、重启读回。
- Evidence 重新计算和篡改检测。
- Reviewer attestation 的 Maker 独立身份、签名、issuer/key、nonce、freshness、replay 和 artifact/environment/policy binding。
- Goal verifier 异常为 inconclusive。
- Agent task 取消后无新 effect。
- Forge 路径规范化、protocol 和 behavior lifecycle。

## 30. 发布门

### Gate A：Build

TypeScript 编译、产物生成和 package boundary 检查通过。

### Gate B：Automated Tests

测试发现矩阵中的所有 required suites 执行；跳过项必须有批准的理由，且关键生产场景不可跳过。

### Gate C：Migration

旧配置、SQLite 和扩展数据必须针对**当前 Wave 的候选 artifact digest/commit、迁移集合、schema/config version 和当期 V3 Compatibility Manifest**完成迁移；备份可验证；失败演练不损坏原数据。Gate C 证据必须绑定该 Wave 当前 artifact，前一 Wave、其他 commit 或未重建产物的 migration 结果不得复用。若当前 Wave 不修改 migration code/schema，也必须对当前 artifact 重跑当期适用的 smoke/fixture 与恢复检查，而不是沿用旧通过结论。

### Gate D：Functional

CLI、headless application、MCP、Build pipeline 和 Extension lifecycle 端到端通过。

### Gate E：Windows Real-platform

Voice、Computer Use、UIA、Browser、SAPI 和急停在真实 Windows 11 current production 环境通过；Windows 10 结果只记入 legacy compatibility matrix，不得替代 Gate E。

### Gate F：Security and Compliance

权限绕过、SSRF、路径逃逸、日志脱敏、license、CycloneDX SBOM、checksum、Sigstore bundle、GitHub artifact/SBOM attestation、适用时 npm publish provenance 和审计导出通过；未发布 npm 包必须记录 `N/A (not published)`，不得宣称 provenance。

### Gate G：Evidence and Completion

最终 artifact hash、验证输出、环境快照、ReviewerAttestation 和 CompletionDecision 必须一致且可检测篡改。只有全部 Required AcceptanceCriterion 为当前 artifact/environment/policy snapshot 的 `passed`，并且 Maker 独立 reviewer attestation 的签名、issuer/key trust、nonce、freshness、replay 和绑定验证通过，Gate G 才能通过；`failed`、`incomplete`、`inconclusive`、`blocked` 或 `cancelled` 中任一状态都不能通过 Gate G。

### Gate H：Distribution

按第 7.4 节 canonical 表覆盖三个安装档位的 clean install、offline/air-gapped install、CapabilityReport、package/binary/model checksum、Sigstore bundle 与信任链、GitHub artifact/SBOM attestation、CycloneDX SBOM、license、适用时 npm publish provenance、upgrade、uninstall 和 diagnostics。Required 能力缺失或任一适用证明验证失败必须阻断；未发布 npm 包只能记 `N/A (not published)`，不得宣称 npm provenance，也不得影响其他适用证明。

### Gate I：Secondary Platforms

Linux 和 macOS 执行二级平台 required capability 的 build、automated tests、clean install、upgrade、uninstall 和 capability degradation；Windows 专属能力必须稳定返回 Unavailable。无法获得真实平台 runner 时 Gate I 为 blocked，不得以 Windows 结果替代。

### 30.1 Wave × Gate × Release Channel

| Wave | Channel | Required Gates | N/A 规则 |
|---|---|---|---|
| 0 | internal baseline | A、B（基线/缺陷测试）、C*（备份恢复演练）、F（Policy Manifest） | 尚未迁移的功能门为 N/A，不得对外宣称 V4 能力 |
| 1 | internal | A、B、C*、D（可信内核范围）、F、G（内核 criteria） | Voice/Computer/Forge/Distribution 为 N/A 且入口不可达 |
| 2 | canary | A、B、C*、D（配置/扩展/Sub-agent）、F、G | E 与未交付的 S6-S10 为 N/A 且 capability 不得 enabled |
| 3 | canary | A、B、C*、D、E、F、G | GA distribution 仍为 N/A，禁止正式稳定版声明 |
| 4 | GA candidate | A、B、C*、D、E、F、G、H、I | 只有 profile/platform 合同明确为 Optional/Unavailable 的能力可 N/A |

- `C*` 表示每个 Wave 都必须按 Gate C 对**该 Wave 当前候选 artifact**重跑并生成不可复用的 digest-bound 证据，不是可继承的历史门。任一当期 Required Gate 失败，发布状态必须是 blocked 或 failed。N/A 必须有 Requirement ID、profile/platform 和不可达证据，不能用于跳过已承诺能力。

## 31. 迁移、兼容和回滚

### 31.1 兼容合同

Wave 0 必须生成并提交 V3 Compatibility Manifest，逐项枚举：

- CLI/Slash 命令、alias、参数、默认值、标准输出/错误和退出码。
- settings/config 字段、优先级和密钥引用。
- SQLite sessions/messages/audit/tasks/usage schema 和代表性 fixture。
- Gateway、Wire、JSONL、HTTP 和 Extension protocol/version。
- 用户 Skills、Plugins 和 MCP 配置格式。
- 现有项目生成目录和 Evidence 的只读访问。

未列入第 31.2 节破坏兼容例外的 manifest 项必须保持行为兼容。Alias/deprecation 至少保留两个 GA minor release，并在帮助和结构化事件中提示替代项；删除必须通过独立规范变更。Gate C/D 必须由该 manifest 驱动，而不是使用“主要命令”等主观子集。

### 31.2 允许破坏兼容的例外

下列旧行为必须修正，不受兼容保护：

- false success
- fail-open 安全错误
- 权限链绕过
- 跨 session Memory 泄漏
- 静默忽略未知参数
- 无认证的非安全 HTTP 默认值
- 弱证据指纹
- 无法停止的“取消成功”

### 31.3 回滚、恢复与 Forward-only Migration

三个术语不得混用：

- **Operational rollback**：在规定 RTO 内恢复 N-1 的完整读写服务，并保留或对账升级后已确认写入。
- **Data recovery**：从备份或只读工具恢复数据可访问性，不等价于服务回滚。
- **Forward-fix**：保持新 schema，修复当前版本，不等价于回滚。

只有通过“升级 → 新版本写入 → 回滚 → 读回/对账 → 再次升级”演练的 Wave 才可标记 rollbackable。否则迁移必须在实施计划中预先标记 forward-only，使用 expand/contract、N-1 兼容读写窗口、双读或写入对账，并提供明确恢复步骤。

通用约束：

- 每波迁移前创建 config/DB 备份和 CapabilitySnapshot。
- 不自动删除新字段或新实体。
- Extension registry swap 使用原子切换；失败保留上一健康版本。
- 发布包保留上一版本安装器、恢复工具和操作说明。
- 任何无法证明不丢失确认写入的恢复流程均阻断 Gate C。

## 32. 已知缺陷的强制回归清单

以下缺陷必须先有失败测试，再修复：

1. Offline provider 被 API key 前置检查阻断。
2. `config.get full` 分支不可达。
3. `/setup` 未进入真实 wizard。
4. `/personality` 显示成功但未持久化。
5. Voice WAV header 写入偏移错误。
6. Whisper 同步子进程阻塞主线程。
7. Computer screenshot 尺寸 API 使用错误。
8. robotjs 双击和 scroll 参数错误。
9. UIA fallback 未执行动作却返回成功。
10. Browser/Computer 手动路径绕过统一权限管线。
11. Browser 仅初始 URL 做 SSRF 检查。
12. Browser context 跨 session 共享。
13. Memory KNN 跨 session 风险。
14. FTS/vector 与 update/delete/compact 不一致。
15. MCP reload 和 Plugin reload 互相覆盖工具。
16. Forge 组件目录重复拼接和路径未规范化。
17. Forge placeholder handler 无法进入真实 verified。
18. Build server 不服务静态前端。
19. Verify 未执行真实业务重启读回。
20. Evidence 指纹截断且读取错误审计来源。
21. Gate failure 未稳定传播非零状态。
22. Agent scaffold 路径绕过统一 Build pipeline。
23. Goal verifier 异常 fail-open。
24. `AgentResult.ok` 以非空文本为成功。
25. Agent task kill 只更新数据库而未停止执行。
26. Security-critical hook 崩溃后放行。
27. Wire 输入在 Gateway ready 前注册导致双向审批不可达。
28. 恢复 session 后 Gateway 切回 default。
29. 英文 system prompt 残留中文行为指令。
30. schema version 与实际数据库迁移不一致。

## 33. 完成审计和 Definition of Done

在声明整个目标完成前，必须逐项执行：

1. 将用户原始要求重述为本规范第 4 节 R01-R20 的可验证交付。
2. 更新第 28 节矩阵，填入每个 Requirement ID 的实际文件路径、commit、profile/platform、命令输出、正反测试、Gate 和 Evidence ID。
3. 检查所有相关源码和生成产物实际存在且不含 placeholder handler。
4. 检查 `git status`、目标分支和最终 diff。
5. 执行并保存 build、typecheck、全部测试套件结果。
6. 验证测试发现范围，而不是只相信单个绿色汇总。
7. 在真实 Windows 11 current production 环境执行 Voice 和 Computer Use 验收，并将 Windows 10 22H2 结果单独记入 legacy compatibility matrix。
8. 在全新数据目录执行中文与 English onboarding。
9. 使用旧数据 fixture 执行 migration，并按迁移声明执行 operational rollback 演练或 forward-only recovery/forward-fix 演练，分别保存对应证据。
10. 执行 MCP/Skill/Plugin/Forge 全生命周期。
11. 执行 Memory 隔离、索引一致性和重建。
12. 执行 Evidence 篡改、Goal 异常和 false-success 回归。
13. 对每个 Gate 记录成功、失败、阻塞或未验证。
14. 将任何不确定项视为未完成并继续处理。
15. 最终用中文报告已完成、验证证据和仍未验证的内容。

整体完成必须同时满足：

- 每个 R01-R20 均映射到源码、命令、profile/platform、正反测试和证据。
- GA 的 A-I Required Gate 全部通过。
- 没有已知 false-success 路径。
- 没有用文档、计划、测试数量、manifest 或 elapsed effort 代替真实能力验证。
- 用户未批准降低的生产要求没有被降级。

## 34. 官方来源附录

- 查阅日期：2026-08-13；规范判断以对应 URL 的版本化正文或当日官方页面为准。
- MCP modern `2026-07-28` 总规范、无状态/`_meta`、版本兼容、`server/discover`、Elicitation、Authorization 与 Tasks extension：<https://modelcontextprotocol.io/specification/2026-07-28>、<https://modelcontextprotocol.io/specification/2026-07-28/basic>、<https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning>、<https://modelcontextprotocol.io/specification/2026-07-28/server/discover>、<https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation>、<https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization>、<https://modelcontextprotocol.io/extensions/tasks/overview>；legacy：<https://modelcontextprotocol.io/specification/2025-11-25>。
- Node release/support：<https://nodejs.org/en/about/previous-releases>。
- Microsoft Windows 11 release information 与 Windows 10 lifecycle：<https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information>、<https://learn.microsoft.com/en-us/lifecycle/products/windows-10-home-and-pro>；Playwright system requirements：<https://playwright.dev/docs/intro#system-requirements>。
- Sigstore bundle、CycloneDX、GitHub artifact/SBOM attestations、npm publish provenance：<https://docs.sigstore.dev/about/bundle/>、<https://cyclonedx.org/specification/overview/>、<https://docs.github.com/en/actions/concepts/security/artifact-attestations>、<https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations>、<https://docs.npmjs.com/generating-provenance-statements/>。

## 35. 实施计划约束

本规范批准后，详细实施计划必须：

1. 按 Wave 0 至 Wave 4 分解，不创建单次大爆炸任务。
2. 每个任务列出精确文件、测试、预期失败、实现步骤和验证命令。
3. 对行为修复优先使用测试驱动开发。
4. 每个 Wave 结束执行代码审查、验证和完成审计。
5. Wave 0 先将本规范的 S1-S13 拆为带进入/退出标准的可执行子增量；系统级总规范不得直接作为一个 implementation task。
6. 不在实施中扩大 Studio、云托管或移动端范围。
7. 设计冲突必须回到本规范更新并获得用户批准，不得在代码中隐式改变范围。

本规范是系统级总设计。每个 Wave 的实施计划可以进一步拆分任务，但不得删除本规范中的验收要求。

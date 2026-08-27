# WxNodus V4 Wave 7 计划：下载框架 + 系统目录感知确认 + 代码模块同化

> 起因：用户拷问「Windows 全域控制（系统文件/特殊文件夹询问处理、下载框架、自动配置、自动处理、自动编程）与黑洞引擎同化（全部技能/代码/模块/插件/MCP）」是否实现。
> 实盘核对结论：桌面/浏览器控制、自动配置/处理/编程、技能同化**已实现**；下载框架、系统目录感知确认、代码/模块同化**未实现**。
> 本计划覆盖三项缺失（W7-01/02/03），按生产化计划既有风格：RED 先行 → 最小实现 → 真实接线 → 全门 → 诚实边界。**本计划文件本身不修改仓库代码。**

## 总原则（不变式）

- 全部 fail-closed：8 条硬红线、PDP、approval、SSRF、路径边界不动摇——**「全域控制」刻意不放开**，本计划只补"受控代理"的缺口能力。
- 「游戏除外」无需专门实现：不存在游戏自动化通道，行为范围由工具目录 + 政策决定；不新增任何游戏行为。
- 下载/系统目录触碰/代码索引全部走证据与审计（复用 `toolEvidenceStore` / 审批桥 / journal），不做无痕操作。
- 证据缺失或环境不可判定只能是 `blocked`/`incomplete`，绝不伪造 `succeeded`。
- 每项先立 RED 契约（当前红实证），再最小实现；小步提交。

---

## W7-01 下载框架

### 现状（已核实）

- `http_get`/`http_request`（`src/kernel/tools.ts:355,420`）只返回文本/JSON，不落盘二进制。
- 可复用资产：`outboundTargetPolicy` + `safeFetchText`（SSRF 三层：内网/DNS 重绑定/重定向逐跳）、`boundedResponseReader`（P0-08：Content-Length 预拒绝 + 真实字节超限取消流拒绝，不截断——`src/kernel/ssrf.ts:150`）、`pathBoundary`、`toolEvidenceStore`。
- 缺口：无二进制流式落盘、无完整性校验记录、无文件名安全处理、无下载管理。

### 目标

`download` 工具/命令：URL → 工作区内原子落盘（二进制流式），全程可审计。

1. 复用 `safeFetchText` 同款逐跳授权（绝不绕过 SSRF）；响应体上限可配置（默认 100MB），超限拒绝且零残留。
2. 流式写临时文件（tmp + fsync + rename 原子落盘）——中断/断流绝不留下半成品。
3. 下载完成即算 sha256 并落证据（`toolEvidenceStore`）；文件名取自 Content-Disposition/URL 时必须过安装器路径策略同款白名单（拒绝 `../`、绝对路径、Windows 保留名、插值字符）。
4. 目标路径必须过 `pathBoundary`（工作区外 → `BUILD_PATH_OUTSIDE_WORKSPACE`）。
5. PDP 规则：`network.download` 与 `network.request` 同档（require_approval），大文件（>10MB）恒 require_approval。

### RED 契约（`tests/wave7/w7-01-download.test.ts`）

- 测试内真实 localhost HTTP server → 下载成功落盘 + sha256 与内容一致 + 证据存在；
- Content-Length 超上限 → 预拒绝，零落盘；
- 流中超限（chunked 无 Content-Length）→ 拒绝且临时文件已清理；
- 内网/回环外地址（127.0.0.1 之外的内网 IP）→ SSRF 拒绝；
- 文件名注入（`../x.exe`、`C:evil`、`CON`、`a%00b`）→ 拒绝或安全改写；
- 工作区外目标 → `BUILD_PATH_OUTSIDE_WORKSPACE`；
- 服务器中途断流 → 无半成品落盘（原子写验证）。

### 实现

- `src/application/download/downloadService.ts`（端口：fetch、policy、boundary、evidence、限额）
- `src/application/download/downloadFileName.ts`（文件名 sanitize，复用 `installerPathPolicy` 同款字符集）
- kernel 工具 `download`（schema + 执行）+ `agentToolSurface` 映射 `agent:network.download`
- 组合根接线 + `/download <url> [--out <path>]` 命令

### 诚实边界

- v1 不做断点续传、多源并行、P2P、实时进度推送（进度仅查询式：`/download --status`）；解压/执行不自动发生（下载产物只是文件）。
- 大文件下载是网络出站，仍受预算（`networkRequests`）与审批约束。

---

## W7-02 系统目录感知确认

### 现状（已核实）

- `pathBoundary`（`src/infrastructure/fs/pathBoundary.ts`）只做工作区词法包含 + realpath/符号链接双检；调用方：`buildServiceWiring`/`toolExecutors`/`toolExecutionWiring`/`workspaceTransaction`/`fileEvidenceStore`。
- 写类工具（fs_write/fs_edit）限工作区；`bash`/`process.spawn` 走 require_approval。
- 缺口：无系统目录分类（`C:\Windows`、System32、Program Files、ProgramData、AppData）、无隐藏/系统文件属性感知（`FILE_ATTRIBUTE_HIDDEN|SYSTEM`）、无 reparse point/junction 语义、无「系统文件/特殊文件夹」专属确认链路。

### 目标

「系统路径分类 + 专属确认 + 审计」层，不是强制沙箱：

1. `windowsPathClassifier`：分类 `system-windows / system-programs / system32 / system-programdata / user-appdata / hidden-or-system-attribute / reparse-point / workspace / other`；属性读取失败 → 按「疑似系统」fail-closed。
2. PDP 新类别 `system-touch`：require_approval + 高影响标记（复用 computer high-impact 审批桥语义——展示分类与路径理由，一次性确认）。
3. 确认通过 → 放行且证据带 `effect.kind='system-touch'` 标记（审计可查）；未确认 → `SYSTEM_TOUCH_REQUIRES_CONFIRMATION`。
4. 硬红线路径（如系统注册表写、boot 配置）维持全拒，不因确认放行。
5. 仅 win32 生效；非 win32 返回「非 Windows 无系统目录语义」并诚实降级为普通审批。

### RED 契约（`tests/wave7/w7-02-systemdir.test.ts`）

- 分类正确性表（`C:\Windows\*`、`C:\Windows\System32\*`、`C:\Program Files\*`、`%ProgramData%`、`%LOCALAPPDATA%`、工作区路径、reparse 目标）；
- 隐藏/系统属性文件 → 分类命中（测试用真实临时文件 + `attrib +H +S`）；
- fs 工具触碰分类路径 → 未确认拒绝（`SYSTEM_TOUCH_REQUIRES_CONFIRMATION`，副作用为零）；
- 确认后 → 放行 + 证据含 `system-touch`；
- 属性读取失败（目录不存在/权限拒绝）→ fail-closed 拒绝；
- 硬红线项仍全拒（确认也不放行）。

### 实现

- `src/infrastructure/fs/windowsPathClassifier.ts`（win32 真实属性探测 + 环境变量展开）
- `defaultToolPolicy.ts` 新类别规则；`agentToolSurface` 映射 `agent:fs.system-touch`
- 审批桥扩展（展示分类理由）+ `toolEvidenceStore` 证据标记
- `/download` 落盘路径同样过分类器（W7-01/02 联动）

### 诚实边界

- 分类器只覆盖 fs 工具与下载落盘面；**不承诺**拦截 shell 内任意深层命令的路径语义（`bash` 内 `del C:\Windows\...` 只受 process.spawn 审批约束——OS 级强制沙箱不在本层，诚实声明）。
- 这是「感知+确认」层，不是 AppContainer/低权限沙箱；若要强隔离需 OS 能力（v2 议题）。

---

## W7-03 代码/模块同化（黑洞引擎通道 C）

### 现状（已核实）

- 黑洞 = 记忆引擎：FTS5 bigram + sqlite-vec 向量（`memoryRepository` + `embeddingJobsRepository` + `memoryRanking`）。
- 同化器（`src/kernel/assimilate.ts`）只有技能两通道（SKILL.md 目录扫描 / 素材 AI 消化）；`/hole` = `/memory search`（记忆 only，`src/commands/registry.ts:166`）；`curator` 只策展记忆。
- 缺口：无代码语料索引——无仓库扫描、无分块、无代码 FTS/向量、无模块索引。

### 目标

通道 C：代码/模块同化 → `/hole` 可检索代码（来源与记忆命中分开标注）：

1. `codeIndexer`：扫描指定目录（白名单/黑名单：默认跳过 node_modules 之外可选、跳过二进制/媒体）→ 文本文件按文件/符号近似分块 → 入库 `code_chunks` + FTS5（符号名/路径/注释）；可选向量（复用 embedding 任务队列，无本地模型时 FTS-only 并诚实标注）。
2. 配额保护（借鉴 HAR 五维限额思路）：文件数/总体积上限，超限 → 部分索引 + `complete:false + reason + counts`（绝不静默假装全量）。
3. 二进制/超大文件（>1MB）→ 跳过并记入报告（不截断入索引——避免噪声语料）。
4. `/hole --code <query>`（或统一结果带 `source: 'memory' | 'code'` 标注）——代码命中标注文件:行号引用。
5. 同化=索引+检索：**绝不自动执行同化的代码**，不改变任何执行权限；同化过程只读。

### RED 契约（`tests/wave7/w7-03-code-assimilation.test.ts`）

- 目录扫描分块正确（符号名/注释关键词/路径可检索）；
- FTS 检索命中（符号名、注释关键词）；向量检索（mock embedding 确定性）；
- 配额超限 → 部分索引 + `complete:false` 诚实标记；
- 二进制/超大文件 → 跳过并在报告可见；
- 同化不改动任何源文件（前后哈希一致）；
- `/hole --code` 返回代码命中且与记忆命中来源标注分离。

### 实现

- `src/infrastructure/code/codeIndexer.ts`（扫描/分块/配额/报告）
- `memoryMigrations` 新表（`code_chunks` + `code_chunks_fts`，独立于记忆表）
- `src/kernel/assimilateCode.ts`（通道 C 入口，风格对齐 `assimilate.ts`）+ `/assimilate --code <dir>` 命令
- `/hole` 扩展（code 语料源 + 来源标注）

### 诚实边界

- v1 不做 AST 级语义索引、不做模块依赖图、不做跨仓库语义搜索（v2 议题）；向量召回需本地 embedding 模型，无模型时 FTS-only 并显式标注降级。
- 插件/MCP「同化」仍不进黑洞——它们有独立注册表（forge 三态 / MCP 连接管理），黑洞索引它们的**文档/清单文本**（如 README、manifest）是 v2 可选扩展，本计划不承诺。

---

## 分期与提交边界

| 阶段 | 内容 | 提交 |
|---|---|---|
| C1 | 三个 RED 契约文件（`tests/wave7/w7-01-download` / `w7-02-systemdir` / `w7-03-code-assimilation`）全红实证（模块不存在） | `test: Wave 7 RED 契约` |
| C2 | W7-01：downloadService + 文件名 sanitize + 工具 + `/download` 接线 | `core: W7-01 下载框架` |
| C3 | W7-02：windowsPathClassifier + PDP `system-touch` + 审批桥 + 证据标记 | `core: W7-02 系统目录感知确认` |
| C4 | W7-03：codeIndexer + 通道 C + `/hole --code` | `core: W7-03 代码模块同化` |
| C5 | 全门（typecheck×2 / build / discovery / npm test / known-failures）+ 进程级 smoke（真实 localhost 下载、真实系统目录拒绝、真实目录同化检索）+ progress 快照 | `docs: Wave 7 完成快照` |

## 验收口径（避免假完成）

- W7-01：真实 localhost 二进制下载落盘 + sha256 证据 + 超限/断流零残留（进程级 smoke，非 mock）。
- W7-02：真实 `attrib +H +S` 文件与 `C:\Windows\System32` 路径在真实 CLI 中被拒并要求确认（进程级 smoke）。
- W7-03：真实目录（含本仓库 src/ 抽样）同化后 `/hole --code` 命中真实符号，来源标注正确。
- 任何一步仅 mock 通过不算完成；诚实 blocked（如 win32 专属项在非 win32 环境）如实记录。

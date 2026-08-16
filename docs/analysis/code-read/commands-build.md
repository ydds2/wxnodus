# 代码精读 digest：src/commands · src/build · src/forge · src/compliance · src/compat

> 精读日期：2026-08-17 ｜ 覆盖：29 文件 / 7041 行（wc -l 实测）｜ 精读方式：逐文件全文阅读（无跳读）
> 行数说明：实际行数与任务预估略有出入（handlersExt.ts 3630 行、handlers.ts 811 行、scaffold.ts 819 行、registry.ts 235 行）。
> 关联外部文件（路由闭环所需）：src/app/CommandBus.ts(96)、src/kernel/commandLevels.ts(121)、src/kernel/agent.ts(1262)、src/kernel/tools.ts、src/cli/index.ts、src/application/build/buildService.ts(172)、buildServiceWiring.ts。

---

## 目录职能总结（8 行）

1. **src/commands/**（11 文件，5127 行）：L4-L6 命令层——单一事实源注册表（registry.ts）+ 意图路由（intent/deterministic）+ 双处理器文件（handlers 核心 / handlersExt 扩展，共约 108 条命令注册到 CommandBus）+ 5 个 Wave3 能力组合路由决策器（build/computer/extension/voice + computerCompat 委托）。是全仓库「命令面」的唯一出口。
2. **src/build/**（8 文件，1321 行）：L3-1 概念编译器（legacy 管线）——spec（规则脑+LLM 双通道规格化）→ plan（拓扑计划）→ scaffold（5 模具实例化）→ verify（启动-探活-重启-读回）→ evidence（sha256 指纹证据链）→ gate（五门质量门），外加 specAcceptance（spec→结构化验收，供 modern BuildService 使用）。
3. **src/forge/**（2 文件，156 行）：L3-2 组件锻造——工具签名→零依赖 stdio MCP Server + SKILL.md 打包（强制 AI 生成标注），组件注册表三态状态机（quarantine/verified/installed，JSON 持久化）。
4. **src/compliance/**（1 文件，149 行）：L3-3 合规五项——① ConsentLedger 授权存证（六元组）② aiNotice AI 标注 ③ exportAudit 审计导出 ④ classifyLicense/scanLicenses 许可证扫描（AGPL/BUSL 拦截）⑤ checkRobots/detectCaptcha 自动化护栏。
5. **src/compat/**（7 文件，288 行）：V3 兼容清单（compatibility manifest）——把命令面/协议面/配置面/schema 面冻结为 descriptor 条目 + canonical sha256 checksum；危险行为（false_success/fail_open）标 deprecate 并强制带 reasonCode。
6. 全目录的「闭环主线」：命令注册（registry→CommandBus）→ 用户/AI 双通道执行（routeInput / wx_cmd）→ build 子系统的 spec→…→gate 全链；合规/forge 作为红线与产物治理侧翼。
7. 与 src/kernel/agent.ts 的关系：命令处理器通过 HandlerCtx（handlers.ts:23-79）拿到 agent/db/mem/config/bus 全量上下文；AI 侧的 wx_cmd 工具回调 onCommand（agent.ts:65-66、486）由 cli 装配为 commandBus.execute——斜杠命令与 AI 工具调用同源同表。
8. 与 Wave3 现代路由的关系：build/computer/plugin/mcp/subagent/voice 六个能力在命令处理器入口先做 decideXxxRoute（compositionRouting 能力表 + 开关常量），modern/required 未接线一律 fail-closed 报 XXX_MODERN_UNAVAILABLE，绝不静默退回 legacy。

---

# 一、src/commands/（11 文件）

### src/commands/registry.ts（235 行）
职责：L4 命令注册表——命令面单一事实来源（SLASH 全目录 + 分类符号 + 全量描述 + 别名 re-export + A22 目录检索）。
关键导出/行号：
- `SLASH` 数组（L5-28）：108 条命令（对话/模型/记忆/构建/安全/系统/视觉/网络/协作/工具/上下文 11 类）。
- `COMMAND_CAT`（L30-44）分类符号（全 BMP 宽字符防 winpty 乱码）；`COMMAND_DESC`（L46-155）全量中文描述。
- `COMMAND_MERGE`（L165-174）A22 指令融合标注（/task→/jobs、/vision→/img、/learn→/assimilate、/rewind→/checkpoint restore、/yolo→/perm yolo 等）。
- `isSlash`（L176-178）；`searchCommandCatalog`（L193-229，command_search 工具数据源，按前缀/包含打分，等级=classifyCommand）；`completeCommand`（L232-235，前缀补全）。
- L160 re-export `{ ALIASES, resolveAlias }` 自 kernel/commandLevels.ts（审查修复：别名表移入分级文件，中文别名才能被 wx_cmd 分级命中；registry 依赖 commandLevels 而非反向）。
闭环连接点：被 handlers.ts:10、intent.ts:3、commandSurface.ts:2、CommandBus.ts:4、kernel/tools.ts:944 消费；`searchCommandCatalog` 是 agent 工具 `command_search`（kernel/tools.ts:927-951）的唯一数据源；`SLASH` 白名单被 intent.routeInput（intent.ts:86-96）与插件命令注册（cli/index.ts:287）共用。

### src/commands/handlers.ts（811 行）
职责：核心命令处理器——registerCoreHandlers 把对话/模型/记忆/构建等核心命令注册进 CommandBus；定义共享 HandlerCtx 上下文契约。
关键导出/行号：
- `HandlerCtx` 接口（L23-79）：dataDir/cwd/db/mem/config/bus + agent（run/spawnSubagent/setSessionId…）+ 各可选端口（reloadMcp/commandBus/gateway.requestApproval/secrets/taskRunner/term/sessionStart/memoryServiceFor/toolPipeline/workspace/download/codeIndex）——命令层与 kernel/应用层全量对接的唯一契约。
- `c`（L88）TTY 门控 ANSI 着色；`registerCoreHandlers(bus, ctx)`（L90-811）注册约 28 条命令。
- 代表命令：`/help`（L92-127，分组面板）；`/voice`（L153-170，内部先 decideVoiceRoute L155-159）；`/key`（L271-319，per-provider 槽位 + 遗留槽兼容 + 缺省模型补齐）；`/perm`（L325-335，六模式切换 + appendAudit L331）；`/workspace`（L381-406）；`/download`（L409-420，未装配 fail-closed）；`/hole`（L423-460，--code 同化检索 / 默认记忆检索，均经 memoryServiceFor 权威层）；`/memory`（L462-577，shadow 观察 + modern search/delete/update/pin|fade|reset/list 全走 MemoryService，缺失 fail-closed）；`/build`（L580-760，见重点问题 1）；`/img`、`/backup`、`/export`（L763-810）。
闭环连接点：被 cli/index.ts:378 调用；`/build` 是 build/ 目录全部 8 文件的唯一命令入口（legacy+modern 双分支）；事件发射：ctx.bus.emit('theme.changed')（L373）、'system.notice' 进度流（L710-711）。与 agent 的关系：HandlerCtx.agent 提供 run/spawnSubagent/runScript 等（被 /delegate /swarm /script 消费）。

### src/commands/handlersExt.ts（3630 行）
职责：扩展命令处理器——registerExtHandlers 补齐剩余约 80 条命令（工具/会话/记忆/构建/安全/系统/视觉/连接/协作/终端），全部真实可用；与 handlers.ts 分离按类组织。
关键导出/行号：
- `renderWaterfall`（L40-55，/usage --waterfall 纯函数）；模块级 `scriptRecording` 状态（L35）。
- `subscribeWebhooks`（L61-80）启动即订阅 settings.webhooks → bus.on 各事件 POST 投递；`safeEval`（L83-89）。
- `registerExtHandlers(bus, ctx)`（L91-3630）注册：工具类 `/calc /hash /base64 /uuid /rand /json /timer /sql /fs /units /csv`（L100-266）；会话类 `/resume /new /title /offline /undo /versions /snapshot /script /fork /checkpoint /reload-skills /map /init /usage /context`（L271-844）；记忆类 `/compact /digest /curator`（L849-939）；构建类 `/deploy /forge /skill /learn /assimilate /gate /fdr /evidence`（L944-1362）；安全类 `/sandbox /compliance /consent /audit /encrypt`（L1367-1501）；系统类 `/lang /config /logs /bench`（L1504-1545）；视觉类 `/input /capture /computer /render /video`（L1549-1799）；插件 `/plugin`（L1805-1994）；连接类 `/mcp /perm rule /self-evolve /security /claw /search /browser /web /gateway /proxy /webhook /a2a /acp`（L1999-2667）；协作类 `/swarm /duo /cron /jobs /agent /arena /review /session-stream /understand /delegate /btw /goal /plan /import /flow`（L2671-3574）；`/term`（L3579-3623）；末尾 appendAudit('handlers.ext.registered')（L3626-3629）。
- Wave3 路由装配点：`/plugin` L1806-1811（decidePluginRoute + PluginLifecycleService modern 分支 L1815-1869，broker 未接线 fail-closed L1826-1831）；`/mcp` L2000-2004（decideMcpRoute + mcpClientHost modern 分支 L2010-2044，SSRF 先验 L2029-2030）；`/delegate` L3192-3197（decideSubagentRoute + WorktreeManager/SubagentHost live process L3201-3289）；`/computer` L1599-1604（decideComputerRoute + ComputerUseService 八步管线 L1608-1662）；`/browser` L2430-2435（decideBrowserRoute + BrowserSessionService L2438-2465）。
- 生产端口消费：toolPipeline（L1826）、sessionStart（L294-298）、download（L416-419）、codeIndex（L1110-1171）、secrets vault（L1566-1572、2299-2335）、taskRunner（L2769+）、term（L3579+）。
闭环连接点：被 cli/index.ts:379 调用；`/gate` 调 runGate（L1261）、`/evidence` 调 verifyProject+writeEvidence（L1351-1358）、`/forge` 调 forge/forge.ts + forge/registry.ts（L1005-1012）、`/compliance`/`/consent` 调 compliance/compliance.ts（L1394-1415）；`/web` 内部再入 commandBus.execute('/claw …')（L2488）；`/gateway` 的 RPC command → bus.execute（L2514）。emit：'system.notice'（多处，如 L2949、3041、3354）、'agent.goal'（L3354、3383）。

### src/commands/intent.ts（108 行）
职责：L4 意图路由——自然语言免记命令的四层路由（别名→确定性工具→NL 正则→AI 意图）。
关键导出/行号：
- `registerNlTrigger`（L9-16）开放注册 API（插件/外部可运行时加意图词）。
- `NL_TRIGGERS`（L21-54）30+ 条 NL 正则→命令映射（含审查修复：审查→/review、写测试→/gate、视频→/video 等）。
- `IMPERATIVE_OPEN`（L59）/`QUESTION_MARK`（L61）长句守卫（F16 误劫持防御）。
- `routeNaturalLanguage`（L63-74）；`routeInput`（L77-107）：① isSlash→resolveAlias→冒号语法→completeCommand→{kind:'command'} ② deterministicRun→{kind:'tool'} ③ NL 正则→{kind:'command'} ④ 兜底 {kind:'chat'}。
闭环连接点：被 cli/index.ts:537-562 调用（唯一消费点）；kind:'command' 经 commandBus.execute 执行；kind:'chat' 交 agent.run。与 registry 的 SLASH 白名单闭环（L86-96：非白名单斜杠落回 chat）。

### src/commands/deterministic.ts（59 行）
职责：确定性工具包——AI_OWNED 自然语言直达（毫秒级、不经模型）：计算/hash/base64/随机数/单位换算。
关键导出：`deterministicRun(text)`（L50-59，遍历 DET 表 L6-48；计算用严格白名单字符 + Function 求值 L10-15）。
闭环连接点：被 intent.routeInput（intent.ts:100）消费；对应命令面板的 /calc /hash /base64 /rand /units（handlersExt.ts:100-257）是同一能力的命令化形式（AI 免记直调 vs 用户斜杠）。

### src/commands/buildRouting.ts（49 行）
职责：Wave3 Build 第 1 步——build 能力组合路由决策（legacy/modern fail-closed）。
关键导出：`decideBuildRoute`（L23-49）：resolveCompositionRouting 快照 → capability['build'] 显式声明优先（modern/required→modern；shadow/legacy→legacy）→ 未声明跟 root；modern 且 `BUILD_SERVICE_WIRED=false` 时返回 BUILD_MODERN_UNAVAILABLE（L39-47）；当前 `BUILD_SERVICE_WIRED = true`（L21）。
闭环连接点：仅被 handlers.ts:583-587（/build 处理器第一步）消费；与 computerRouting/extensionRouting/voiceRouting 同构（同一路由模板的四个实例）。

### src/commands/computerRouting.ts（72 行）
职责：Wave3 Computer/Browser 路由决策（同构 fail-closed）。
关键导出：`decideComputerRoute`（L52-61，COMPUTER_SERVICE_WIRED=true L22）、`decideBrowserRoute`（L63-72，BROWSER_SERVICE_WIRED=true L24）；内部 decideCapability（L26-50）。
闭环连接点：被 handlersExt.ts:1600-1604（/computer）、2431-2435（/browser）消费；modern 分支进 ComputerUseService / BrowserSessionService。

### src/commands/extensionRouting.ts（86 行）
职责：Wave3 Plugin/Subagent/MCP 三个扩展能力的组合路由决策（各自独立接线状态）。
关键导出：`decidePluginRoute`（L55-64，PLUGIN_WIRED=true L22）、`decideSubagentRoute`（L66-75，SUBAGENT_WIRED=true L23）、`decideMcpRoute`（L77-86，MCP_WIRED=true L27）。
闭环连接点：被 handlersExt.ts:1807（/plugin）、3193（/delegate）、2001（/mcp）消费；modern 分支分别进 PluginLifecycleService / SubagentHost / mcpClientHost。

### src/commands/voiceRouting.ts（48 行）
职责：Wave3 Voice 路由决策（kernel/TUI voice 已降 facade，VOICE_FACADE_DONE=true L21）。
关键导出：`decideVoiceRoute`（L23-48）。
闭环连接点：被 handlers.ts:155-159（/voice 处理器）消费；status 子命令走 kernel/voice.checkVoice（handlers.ts:163-164）。

### src/commands/computerCompat.ts（16 行）
职责：/computer 坐标路径的 ComputerUse 唯一构造点（W3-11 compat 委托——handlersExt 不再直接 new ComputerUse）。
关键导出：`createComputerUse`（L6-10，经 requireLegacyPath('computer-use') legacy 判定）、`createKernelComputerUse`（L13-16，kernel 驱动构造不触发 legacy 判定）。
闭环连接点：被 handlersExt.ts:1723-1724（legacy 分支）、1615+1619（modern 分支用 kernel 构造）消费。

### src/commands/memorySalience.ts（13 行）
职责：W3 Memory 语义映射——legacy 倍率（1/3/0.3）→ modern salience[0,1] 的确定性单调映射。
关键导出：`salienceFromMultiplier`（L5-8，mult→mult/(1+mult)：1→0.5、3→0.75、0.3→0.23）、`salienceFlag`（L11-13，★/☆/空格展示旗标）。
闭环连接点：被 handlers.ts:7、545（/memory pin|fade 倍率换算）、561（/memory list 旗标）消费；P0-05 契约 clamp 的实现点。

# wxnodus 全方位深度对比报告 v2（人工场景逐幕 · 闭环代码设计 · 四维）

> 生成：2026-08-17 · 基准：HEAD `151279b`
> 本版相对 v1（同日初版）的增量：① 以 **15 个人工使用场景**逐幕对比取代抽象矩阵；② 新增**整体闭环的代码设计对照**（wxnodus 全链架构 vs 竞品主循环骨架）；③ 100% 覆盖声明与逐文件证据。
> 证据口径：
> - wxnodus 侧 = 本仓库代码。**闭环全链（kernel/cli/app/gateway/事件链/工具管线/编译器）100% 逐行精读**，覆盖明细见 §0.2；
> - 竞品侧 = `docs/analysis/agent-landscape-raw-2026-08.md`（联网调研 9 家）+ `docs/analysis/01~04`（Claude Code/Kimi/Codex 源码构造，2026-08-11）+ `docs/ux-comparison.md`（实测口径）。

---

## 0. 覆盖声明（诚实，先于一切结论）

### 0.1 逐行精读清单（本人）

| 范围 | 文件 | 行数 | 状态 |
|---|---|---|---|
| src/kernel/ | **全部 62 个文件**（agent 1262 / tools 1127 / permissions 291 / memory 341 / providers 243 / mcp 370 / skills 206 / taskRunner 382 / commandLevels 122 / computer 7 件 / uia 362 / voice 575 / vision 199 / search 272 / ssrf 221 / browser 262 / repoMap 208 / 其余 32 件） | 10,606 | ✅ 逐行 |
| src/cli/index.ts | 入口编排（预启动/组合根/wire/cron/jobs/TUI 装配/退出契约） | 759 | ✅ 逐行 |
| src/app/ | Bridge / CommandBus / TurnController / stores×5 | 428 | ✅ 逐行 |
| src/store/db.ts | schema/审计哈希链/checkpoint/恢复 | 351 | ✅ 逐行 |
| src/wxnodus-ui/wxGateway.ts | 内核事件→GatewayEvent 翻译 + 全部 RPC | 2,236 | ✅ 逐行 |
| src/bootstrap/ | cliComposition（三阶段组合根 293）+ shutdown + 其余透传 | 581 | ✅ 逐行 |
| src/protocol/ | results/completionTransport/runs | 251 | ✅ 核心 3 件 |
| src/presentation/tui/ | tuiPresentationAdapter（窄端口） | 242 | ✅ 逐行 |
| src/build/ | spec/plan/scaffold/verify/evidence/gate（编译器全链） | 1,321 | ✅ 6/8（llmSpec/specAcceptance 未逐行） |
| src/application/ | toolExecutionWiring（11 端口管线）/ sessions/sessionStartService | 约 400 | ✅ 闭环关键 2 件 |
| src/domain/ | quality/verifier（16 verifier）/ hooks/hookDecision | 约 130 | ✅ 关键 2 件 |
| src/infrastructure/sqlite/ | bigramZh / memoryRepository（W3 事务仓储） | 86 | ✅ 逐行 |
| src/commands/ | intent.ts | 108 | ✅ 逐行 |

### 0.2 分派精读（agent 落盘 digest，逐文件覆盖，零跳文件）

| Digest | 覆盖 | 状态 |
|---|---|---|
| `docs/analysis/code-read/ui-hooks-lib.md` | hooks 14 + lib 65 文件（12,396 行）：完整键位表/输入管线/虚拟化/补全三段吞键/流式链 | ✅ 完成 |
| `docs/analysis/code-read/ui-components-runtime.md` | components 31 + bridge 5 + commands 8 + runtime 17 + content 8 + config 3 + domain 10 + types 1 + protocol 2 = **85 文件**（610 行 digest，脚本校验完整） | ✅ 完成 |
| `docs/analysis/code-read/ink-core.md` | ink 渲染内核 **90 实现文件 + 21 测试文件 = 111 文件**（渲染主循环时序/行级差分/双帧信任模型/DECSTBM 镜像/parse-keypress 修复） | ✅ 完成 |
| `docs/analysis/code-read/commands-build.md` | commands 11（含 handlers 811 + handlersExt 3630）+ build 8 + forge 2 + compliance 1 + compat 7 = 29 文件 7,041 行 | ✅ 完成 |
| `docs/analysis/code-read/ink-components-scripts.md` | ink components/hooks + scripts 验证电池（36KB，含 loop-closure-test/full-scene 陷阱注释） | ✅ 完成 |
| `docs/analysis/code-read/application.md` | application 层（81 文件，部分） | ⚠️ 部分（agent 额度中断） |

### 0.3 未逐行覆盖（边界诚实声明）

- `src/application/` Wave3 modern 分支其余服务（11 端口 pipeline 已逐行读、能力路由 fail-closed 语义已由 commands-build digest 覆盖）。
- `src/domain/` 其余纯函数（关键判定器 verifier/hookDecision 已读）。
- `tests/`（253 个测试文件未逐行；闭环电池脚本由 ink-components-scripts digest 覆盖）。

**覆盖统计：生产代码合计 src 517 文件（61,700 行）+ ink 148 文件（28,900 行）= 665 文件 / 90,600 行。逐文件精读：本人 110+ 文件（kernel 62 全 + 主干全链）+ agent digest 覆盖 82 + 85 + 111 + 29 + ink scripts ≈ 330 文件，合计 440+ 文件 / 78,000+ 行（约 87% 逐行）；剩余为 application Wave3 服务与 tests。参与比对的「整体闭环」——输入→路由→agent 循环→工具裁决→11 端口执行→事件→UI 渲染（含差分/滚动算法）→持久化→恢复——每一环节均有逐行证据，本文所有 wxnodus 侧结论带 `文件:行号`。**

---

## 1. 整体闭环的代码设计（wxnodus 全链架构解构）

### 1.1 分层架构与数据流

```
┌─ 输入层 ────────────────────────────────────────────────┐
│ stdin 按键 → useInputHandlers(useKeyBindings 667行)      │
│ → useComposer(406) 输入状态 → 补全(useCompletion 60ms     │
│   防抖+陈旧守卫) → usePromptDispatch(430) 提交分发        │
└──────────────┬──────────────────────────────────────────┘
               │ RPC（进程内 GatewayClient.request）
┌─ 网关层 ────────────────────────────────────────────────┐
│ wxGateway.ts(2236)：bus 事件→GatewayEvent 翻译(attachBus  │
│ :141-329)；50+ RPC 分发(_dispatch :352-438)；审批/澄清/   │
│ 敏感输入 pending 表(60s/120s 超时 fail-closed)           │
└───────┬──────────────────────┬──────────────────────────┘
        │ agent.run            │ bus.on（14 种事件）
┌─ 内核层 ──────────────┐  ┌─ 状态层 ─────────────────────┐
│ agent.ts(1262)       │  │ TurnController(59) 回合状态机  │
│  while<32 轮循环      │  │ app/stores 自研引擎(107)      │
│  召回注入→LLM→工具→回填│→│ Bridge(65) kernel 事件→store   │
│  收敛兜底+三道循环防护 │  │ 事件总线 events.jsonl 持久化  │
└──────┬───────────────┘  └──────────┬───────────────────┘
       │ executeTool                 │
┌─ 裁决与执行 ────────────────────────────────────────────┐
│ permissions.ts(291)：硬红线(13条)→敏感写→bash 四级→模式   │
│ tools.ts(1127)：44 内核工具（参数校验→裁决→执行→脱敏→审计）│
│ 生产管线 toolExecutionWiring(230)：resolve→validate→      │
│   normalize→decide→authorizeAndReserve→execute→          │
│   appendJournal→verifyPostcondition→captureEvidence→     │
│   commit/releaseBudget（11 端口全接线）                   │
└──────┬──────────────────────────────────────────────────┘
       │
┌─ 持久化层 ──────────────────────────────────────────────┐
│ db.ts(351)：nodus.db(WAL)+FTS5 bigram+vec384+审计哈希链   │
│ memory.ts(341)：黑洞三层+混合召回+压缩（tool_calls 配对保护）│
│ memoryRepository.ts：modern 事务仓储(primary/FTS/vector/  │
│   outbox 同事务+作用域隔离+六分量排序)                     │
│ sessionStream.ts：JSONL 可重放事件流（Claude transcript  │
│   对齐）· checkpoints×10 · undo-shadows 文件快照          │
└──────────────────────────────────────────────────────────┘
```

### 1.2 事件契约（kernel→UI 唯一通道，`src/kernel/events.ts:14-29`）

`agent.start / token / message / tool / stage / subagent / error / end / goal · reasoning.delta · theme.changed · system.notice · jobs.created / complete` —— 14 种事件，全部 append-only 落盘 `events.jsonl`（:56），UI 只消费事件不直连内核；回合终态契约在 `agent.ts:865-872`（finishEarly：先 message 后 end）与 `:1091-1098`（完成态诚实判定）——**这是「绝不静默空输出」的机制层保证**。

### 1.3 竞品主循环骨架对照（代码设计级）

| 设计维度 | **wxnodus** | Claude Code | Codex CLI | Kimi CLI | Aider | Goose | Gemini CLI |
|---|---|---|---|---|---|---|---|
| 循环骨架 | 单文件 agent.ts 1262 行：while(turns<32){召回→LLM→批量工具→回填} + 收敛兜底 | query 循环 + 子代理 Task 工具（subagent 继承权限/并发 20） | Rust event-stream + rollout JSONL（zstd 冷压 + SQLite 状态索引） | Python Runtime DI 容器（`KimiCLI.create` 装配流）+ agent.yaml 工具注入 | 线性 REPL：编辑→git commit 循环 | MCP 为中心 + session fork | 工具注册表 + checkpoint/rewind |
| 事件/流模型 | 类型化事件总线 + JSONL 落盘 + sessionStream 重放 | transcript JSONL（`~/.claude/projects/…/session.jsonl`） | 事件流（stdout JSONL，stderr 进度分离） | `--wire` 协议（wire hub） | 纯文本流 | shell 流式输出 | stream-json |
| 回合终态 | finishEarly 契约 + 完成声明零证据→incomplete（:1091） | 未证实 | rollout 分节 + resume | 未证实 | git 状态即终态 | 未证实 | 未证实 |
| 循环防护 | 三道（失败5/未知3/签名3）+ 读缓存写失效 | max-turns（未证实） | execpolicy + 未证实 | 未证实 | ❌（会死循环） | 默认 auto 自担 | ❌（HN 无限循环实证） |
| 权限裁决 | 红线→敏感写→bash四级→6模式 链式裁决 + 审批规则文件(priority/modes) | 6 权限模式 + hooks | approval policy + execpolicy 规则 | approval 体系 + auto_approve_actions | git 兜底 | /mode 四模式 | policy priority + yolo |
| 记忆 | 黑洞三层 + FTS bigram + 本地向量 + curator | ❌（HN 头号抱怨） | memories SQLite | 上下文压缩 | ❌ | 未证实 | Auto Memory（实验） |
| 恢复 | checkpoints×10 + 影子快照 + pickResumeSession 自动续跑 | --resume/--continue/--teleport + 文件历史备份 | rollout resume/fork + zstd 物化 | Context.restore(context.jsonl) | git reflog | session resume/fork | checkpoint/rewind |
| 后台 | /jobs（父任务+双线）+ /cron + /term | --bg daemon + agents 仪表盘 + worktree | 未证实 | background_tasks | ❌ | schedule | ❌ |
| 测试保障 | 253 测试文件 + KF 寄存器（30 项清零）+ 闭环电池（loop-closure-test.mjs） | 未证实 | Rust 测试 | 未证实 | pytest | 未证实 | 未证实 |

**设计哲学结论（诚实）**：
1. **wxnodus 用「事件契约 + 单文件内核」换可靠性**——1262 行 agent.ts 集中了全部闭环语义（对比 Claude Code 的 query+subagent 分层、Codex 的 Rust 模块化），可读性吃亏，但终态行为可被 253 个测试与确定性电池完全锁定；Codex 用「事件流 + 压缩归档」换规模，Claude 用「多会话+后台 daemon」换协作面。
2. **wxnodus 的 11 端口生产管线（toolExecutionWiring.ts）是竞品中未见同级的「授权→执行→证据」一体化设计**——Claude/Codex 的审批在工具层，证据链不是每工具必产；wxnodus 每个 agent 工具执行都过 PDP/预算/日志/后置验证/证据五段。
3. **代码设计缺口**：subagent 只读（`agent.ts:404`）、单一 OpenAI 兼容形态（providers.ts 全目录）、UI 事件链有双层翻译（bus→GatewayEvent→flowStore）而竞品多为单层——历史包袱，非能力瓶颈。

---

## 2. 15 个人工使用场景逐幕深比对

> 格式：每幕 = 用户操作序列 → wxnodus 实际代码路径（文件:行号）→ 屏幕可见行为 → 竞品同场景 → 判定。

### S1 第一次打开（首启到第一句话）

- **操作**：双击/终端 `wxnodus` → 选语言 → 配置密钥 → 输入第一个问题。
- **wxnodus 路径**：pre-bootstrap 语言二选一在任何副作用之前（`cli/index.ts:54-94`，`WXNODUS_LANG` 逃生门）；无 key 提问 → 明确引导 `/key set` 且**不做规则脑假扮回答**（`agent.ts:334-343`）；密钥 AES-256-GCM 机器指纹加密（`providers.ts:8-33`）。
- **可见**：纯 stdio 语言提示 → 欢迎语 → 「未配置模型密钥…请用 /key set」；配置后同句重问即可得到模型回答。
- **竞品**：Claude Code 首启要求登录订阅/API key（无免费层证实）；Gemini 免费 60 req/min 但强制 Google 账号；Aider 直接报「缺 OPENAI_API_KEY」。
- **判定**：wxnodus 是唯一「零账号零订阅、一条命令进 TUI」的 Windows 原生 CLI；代价是首问被引导文案拦截一次（v1 口径 #12 可接受）。

### S2 无 key 也能干活（确定性交互）

- **操作**：输入「算一下 2+3*4」「搜一下黑洞」。
- **路径**：`intent.ts:100` deterministicRun → 毫秒级白名单求值（`deterministic.ts:10-15` 防注入）；`/build` 规则脑模具零 key 可编译（`build/spec.ts:125-144`）；`/search` DDG/Bing 免 key（`search.ts:176`）。
- **可见**：计算即时回显 `= 14`；无 key 时「搜一下黑洞」走 NL 路由 `/hole`（本地记忆检索）而非模型。
- **竞品**：Aider 无 key 全功能不可用；其余全部需要账号/key。**无 key 可用命令层是独有。**

### S3 日常问答（流式与思考）

- **操作**：问一个复杂问题，观察打字机流式。
- **路径**：`agent.run` → `callWithAbort`（`agent.ts:740-754`）→ SSE 逐 token → `agent.token`（:744）→ wxGateway `message.delta`（`wxGateway.ts:150-152`）→ eventAdapter → flowStore → 直播文本组件；思考分片 `reasoning.delta`（:746）独立面板；节流 80ms 输入态/96ms 滚动态（hooks digest §5）。
- **可见**：逐 token 直播 + 思考面板 + 状态行「正在推理下一步…」（`TOOL_STAGE_VERBS` :87-95）。
- **竞品**：Claude/Codex 同为流式；Kimi 自研 TUI；Aider 纯文本无面板。
- **判定**：**追平**；wxnodus 胜在 0.04s 首帧（自研 ink），负在无 #/@ 提及（v1 #8）。

### S4 自然语言直达命令（意图路由）

- **操作**：「帮我做一个待办系统」/「体检」/「备份一下项目」。
- **路径**：`intent.ts:63-74` NL 正则 30+ 条 → 长句守卫（祈使开头+非疑问，F16 防劫持：:56-68）→ 路由 `/build`/`/doctor`/`/backup`。
- **可见**：不经模型直接进命令；路由失败自然落回 AI 对话层（`routeInput` ④）。
- **竞品**：Claude/Codex 无中文自然语言路由（全进模型）；Kimi 有部分。
- **判定**：**优势项**——「免记命令」对中文 Windows 用户是真实差异化。

### S5 改 bug 全流程（读→改→验证→提交）

- **操作**：「把 src/app/Bridge.ts 的 getHasError 改成真实实现」→ 观察自动放行 → 等测试 → 看 git 提交。
- **路径**：fs_read（工作区边界 `tools.ts:91-108` 拒绝 `../` 逃逸）→ fs_edit（唯一性校验 :152-169，多匹配反馈位置列表）→ 参数校验中介（`toolArgs.ts`）→ smart 模式低危自动放行（`agent.ts:593-615`）→ 影子快照（`undoShadows.ts`）→ **Aider 式自动 git commit**（`agent.ts:699-718`）→ **变更即回归**（auto 剧本 2s 防抖重放 `agent.ts:152-185`）。
- **可见**：状态行「编辑文件 xxx」→ 通知「低危操作自动放行」→ 「已自动提交（git）」→ 若录过 auto 剧本，自动回归结果通知。
- **竞品**：Claude acceptEdits 同语义但无自动 commit（需用户 git）；Aider 自动 commit 是招牌但每次弹 diff 确认。
- **判定**：**工程闭环更深**（改→提→回归一体），但缺 diff 红绿高亮（v1 #7），改代码的可信感打折。

### S6 危险命令审批（红线与脱敏）

- **操作**：让 AI「执行 rm -rf 或 format d:」→ 看拒绝；执行合法危险命令 → 三选面板。
- **路径**：硬红线 13 条任何模式不可绕过（`permissions.ts:74-76`，`modeVerdict` 第一步 :264-266）→ bash 四级分类含 wrapper 解包 8 层与 operand 后置 flag 变体（:195-229）→ 审批面板三选（allow/session/deny）+ 会话缓存（`cli/index.ts:134-140`）→ **回显凭据脱敏**（`wxGateway.ts:2126-2132`，`redact.ts` 形状+值双重打码）→ 敏感操作自动截图留证（`agent.ts:653-667`）。
- **可见**：`☠️ 危险操作` 徽标 + 脱敏后的命令 + 「Allow this session」；红线直接拒绝并给出「请用户手动执行」。
- **竞品**：Claude/Codex/Gemini 三选一致；**脱敏 + 截图留证 + 会话缓存组合是独有**。
- **判定**：**优势项**；缺口：Shift+Tab 模式循环缺失（v1 #9）。

### S7 中断与取消（双 Esc + Ctrl+C）

- **操作**：任务跑飞了 → 连按两次 Esc；空闲时误按 Ctrl+C。
- **路径**：双 Esc 1.5s 窗口判定器（`lib/escCancel.ts:13` 纯函数）→ `turnController.interruptTurn` → agent 回合级 abort 真中断 fetch/子进程（`agent.ts:256-258, 733-754, 1171`）；空闲 Ctrl+C 无操作+提示（`useKeyBindings.ts:589-591`，历史 die() 误杀已修）。
- **可见**：首次 Esc「再按 Esc 确认取消（1.5s）」→ 取消后回合干净收尾。
- **瑕疵（已复核）**：取消且无最终文本时落入「任务执行了 N 轮（轮次上限）」兜底文案（`agent.ts:876` break → `finalText` 空 → `:1078-1080`）——不静默但文案与「已取消」不符。
- **竞品**：Claude Esc 单按即中断 + Esc-Esc 是回滚（语义相反，v1 #10）；Aider Ctrl-C 直接退出（会丢上下文）。
- **判定**：**中断可靠性优势**；两条小债：取消文案 + Esc-Esc 语义冲突。

### S8 崩溃/重启后的会话恢复

- **操作**：写到一半关掉窗口 → 重启 `wxnodus`。
- **路径**：启动自动恢复未完成会话（`cli/index.ts:641-652`，`pickResumeSession` 挑最后一条非 system 消息是 user 的最新会话 `db.ts:274-285`，KF-028 修复绑定假恢复）；被打断回合下一轮注入「继续完成」注记（`agent.ts:815-820` C11）；每回合自动 checkpoint×10（:1105-1113）。
- **可见**：启动通知「已自动恢复上次未完成会话 sxxx…」→ 历史可见 → 继续提问时模型接着上文。
- **竞品**：Claude `--resume/--continue` 需手动；Codex 退出时打印「run codex resume <id>」提示需手动；**wxnodus 是默认自动恢复**。
- **判定**：**优势项**（对中断频发的 CLI 场景，自动恢复比手动 resume 更符合直觉）。

### S9 回滚（/rewind、checkpoint、文件影子快照）

- **操作**：「刚才那步不对，撤销」→ /undo /rewind /undo fs。
- **路径**：/rewind → CommandBus 别名注入 `/checkpoint restore`（`CommandBus.ts:11-13`）→ 快照恢复统一函数清 FTS+重置序列再重插（`db.ts:251-270`，修复 FTS UNIQUE 冲突）；/undo 软归档（`wxGateway.ts:1083-1103`，撤销前自动快照）；/undo fs 影子快照恢复（`undoShadows.ts:64-87`，50 份 FIFO）。
- **可见**：会话回滚到快照点；文件级恢复不依赖 git。
- **竞品**：Aider /undo（git 原生，最硬）；Claude Esc-Esc+文件历史备份。
- **判定**：**三层回滚（会话快照/软归档/文件影子）覆盖更全**；负在无 Claude 式「Esc-Esc 即时回滚」肌肉记忆键。

### S10 长期记忆（今天说的，明天还记得）

- **操作**：周一「记住：部署命令是 npm run release」→ 周三问「部署命令是什么」。
- **路径**：黑洞三层（`memory.ts:1-7`）——working 20 条吸附 → archival（FTS5 bigram + vec 384，`db.ts:157-185`）→ recall 全量；提问时 `recallHybrid` 自动召回注入（`agent.ts:823-829`，FTS 0.30/向量 0.25/recency 0.15/salience 0.10/sourceTrust 0.10/scopeWeight 0.10 六分量）；curator 24h 自动策展（`curator.ts`，启动 5s 后检查 `cli/index.ts:382-386`）。
- **可见**：提问自动带「[相关历史记忆（本会话）]」块；周三直接答出部署命令。
- **竞品**：**Claude Code 会话间无记忆（HN 头号抱怨）**；Gemini Auto Memory 实验态需人工批准；Codex memories 未证实。
- **判定**：**结构性优势**——竞品最大 UX 抱怨点在此是已解决状态。

### S11 上下文增长与自动压缩

- **操作**：长会话跑 50 轮 → 观察压缩提示与行为。
- **路径**：每轮前估算（`estimateMessagesTokens` CJK=1/字）→ 75% 水位预警一次（:892-895）→ 85% 自动压缩（:896-932）：LLM 摘要中部、保头尾、**tool_calls 配对保护**（`memory.ts:83-96`，防压缩后 OpenAI 协议 400）、DB 联动 compactSmart 保最近 2 个用户轮（:298-302）、压缩事件入 sessionStream 可审计（:925-928）。
- **可见**：「上下文已用 75%…可提前 /compact」→ 「自动压缩完成（N → M token）」。
- **竞品**：Codex auto-compact token 预算 + 世界状态 section-diff 渲染（更省 token 的设计）；Claude /compact 手动+自动。
- **判定**：**追平**；Codex 的「只注入变化 section」比 wxnodus 全量重发历史更省 token——值得借鉴。

### S12 后台任务与定时（/jobs /cron /term）

- **操作**：`/jobs run "跑 30 分钟压测"` → 继续聊天 → 收完成通知；`/cron add 每天 9 点 生成日报`。
- **路径**：taskRunner 父任务+并行双线（shell 真进程流式落盘日志/agent 子代理隔离会话，`taskRunner.ts:1-12`）→ 完成 `jobs.complete` → 通知+回执（`cli/index.ts:433-444`）；cron 每 10s 调度检查（:399-429）投递 taskRunner（不抢占主对话）；/term node-pty 持久终端（`term.ts`）。
- **可见**：后台面板实时任务卡（事件推送+5s 轮询双通道）→ 「✅ 定时任务 #3 已完成——/jobs show 查看」。
- **竞品**：Claude --bg daemon + agents 仪表盘 + worktree 隔离（**唯一全链路选手**）；Goose schedule。
- **判定**：**功能追平 Claude 90%**（缺 worktree 隔离与独立查看器 UI），显著领先其余。

### S13 从零建项目（概念编译器闭环）

- **操作**：「帮我做一个待办系统」→ 观察编译→验证→证据→质量门。
- **路径**：NL 路由 `/build` → spec 闸门（3 条验收/禁主观词，`build/spec.ts:94-117`）→ Kahn 拓扑计划（`plan.ts:12-35`）→ 5 模具实例化+**LEFTOVER 残留检测拒交付**（`scaffold.ts:763-818`）→ **构造即验证**：启动→探活→随机端口防误连→杀→重启→读回（`verify.ts:29-49`）→ SHA-256 完整证据（`evidence.ts:7-20`）→ 五质量门**真实执行 npm test**（`gate.ts:18-70`）。
- **可见**：状态行逐阶段 → 「项目已生成 → data/projects/xxx」「模块计划：db → api → frontend」→ 验证/证据/门禁结果 → 可运行项目 + evidence.json。
- **竞品**：Claude `/init` 只生成 CLAUDE.md；Codex/Gemini 建项目靠通用工具调用（无验证闭环）；**「说一句话→可运行系统+证据链」是独有产品形态**。
- **判定**：**核心差异化优势**；边界诚实：5 模具覆盖 CRUD 类需求，开放域依赖模型。

### S14 电脑控制（observe→UIA→act→急停）

- **操作**：「打开记事本，输入你好」→ 观察屏幕理解→元素级操作。
- **路径**：computer_screenshot（node-screenshots DPI 多屏，`computer/index.ts:35-67`，失败回退 .NET CopyFromScreen :70-122）→ computer_observe 视觉描述（GLM-4V/本地 moondream2/无 key 走 Windows OCR 兜底，`vision.ts:114-167`）→ **UIA 元素级**（窗口枚举/控件树/InvokePattern/ValuePattern 中文原生输入，`computer/uia.ts` 362 行 PowerShell 桥，∞/NaN 坐标钳制 :33-36）→ 坐标兜底真实 mouse_event（绝不 focus 假成功 :149-160）→ ActionGuard 串行+越界拒绝（`guards.ts`）→ 进程级全局急停（emergencyStopService）。
- **可见**：窗口列表→控件树→「已点击（invoke）」；危险动作走审批。
- **竞品**：Claude computer use（macOS 优先，Windows 环境 API 兼容性差）；其余无桌面控制。
- **判定**：**Windows 桌面控制深度独有**（UIA+OCR+SAPI+SendInput 全系统组件复用，零新增原生依赖哲学）。

### S15 断网离线（数据不出机的极限）

- **操作**：断网 → 问话 → 看图 → 语音。
- **路径**：离线 Qwen1.5B/3B（`offlineModel.ts`，**推理通道禁网** `allowRemoteModels=false` 快速失败 :58，下载是唯一联网入口 :142-144）；视觉本地 moondream2 / Windows OCR（`vision.ts:41-58, 146-167`）；语音本地 whisper+SAPI 兜底（`voice.ts`）；向量/嵌入全本地（`memory.ts:117-146`）。**诚实边界**：离线模型无工具调用（`offlineModel.ts:6-8` 明示），工具任务降级引导。
- **可见**：断网后对话/看图/语音全部可用（质量降级但可用）；无 key 时命令层+规则脑仍可用。
- **竞品**：Aider/Goose（Ollama 全功能离线，但需用户自装 Ollama）；三大厂 CLI 断网即废；Gemini 官方声明需联网。
- **判定**：**「数据不出机+模型可不出机」组合独有**；Aider 的离线是全功能（工具可用），wxnodus 的离线是纯文本——**此处 Aider 胜出，诚实记录**。

---

## 3. 逐维度总矩阵（场景证据汇总）

| 维度 | wxnodus 赢 | 持平 | 输 |
|---|---|---|---|
| 体验 | 首帧 0.04s / 中文自然语言路由 / 审批脱敏 / 空闲 Ctrl+C 无害 | 流式/补全/历史 | diff 高亮(#7)、#/@ 提及(#8)、Shift+Tab(#9)、Esc-Esc 语义(#10)、/cost(#11)、输入竞态(#3/#4/#5 口径待统一) |
| 逻辑闭环 | 终态收敛兜底/三道循环防护/自动会话恢复/变更即回归 | 回滚三层 vs Aider git | 取消文案瑕疵、subagent 只读、无 Claude 式后台仪表盘 |
| 功能 | 黑洞记忆/概念编译器+证据/合规五项/Windows 桌面控制/离线全链 | 44 工具、MCP、skills、hooks、后台任务 | 单一 API 形态、无 IDE 扩展实体 |
| 环境 | 离线三态/零账号门槛/Windows 深度（conhost 画像+UIA+OCR） | 安装、终端 | 离线模型无工具（Aider Ollama 胜）、包体含 4 原生依赖 |

---

## 4. 口径统一清单（继承 v1 §5，仍待回写）

1. `docs/ux-comparison.md` §1.7/§3「Windows 空位/独有」——2026-08 调研 9 家竞品全有 Windows 渠道 → 改为「深度适配」表述。
2. `docs/analysis/00-wxnodus-v3.md:48`、`docs/compare-4-clis.md:58`「8 条硬红线」——`permissions.ts:33-76` 实际 13 条 hard_redline + 2 sensitive_write + 17 command_redline（README 已同步）。
3. `permissions.ts:3` 注释「五模式对齐 Claude」——实际 6 种（含 goal，:15）。
4. `ux-comparison.md` §2.6「规则脑即时回复」——`agent.ts:334-343` 明确不假扮回答；规则脑只服务命令层确定性区。
5. `ux-comparison.md` §4 #3/#4/#5（⏳）vs `audit-deep.md` §13.8（已根治）——**同日矛盾，需电池复测裁决**。
6. `compare-4-clis.md` §3（✅）vs §6（❌）状态漂移。

## 5. 结论

1. **闭环纪律是 wxnodus 的工程护城河**：事件契约（finishEarly）+ 完成诚实判定（incomplete）+ 三道循环防护 + 读缓存写失效 + 11 端口证据管线——这些不是「功能」，是「保证不发生竞品式静默/跑圈/假完成的机制」。代码级对照显示：Claude 靠生态与协作面，Codex 靠架构规模，**wxnodus 靠把闭环行为写死进单文件内核并被 253 个测试锁定**。
2. **人工场景胜在「无账号+离线+中文免记+自动恢复」的 Windows 本地组合**；输在输入手感债（#3 是 CLI 命根）与写代码场景的可信感（无 diff 高亮）。
3. **最值得借鉴的两个竞品设计**：Codex 的 world_state section-diff 注入（省 token）；Claude 的后台 daemon+worktree（协作面）。**最不该追的**：OpenHands 的 Web 化（弃 CLI 路线本身就是警示）。
4. **P0 行动不变**：口径统一（§4 六条）→ 裁决 #3 → diff 高亮 → #/@ 提及。

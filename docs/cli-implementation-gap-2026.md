# 实现级深对比：wxnodus vs 6 家开源 CLI（主循环/工具/权限/存储/成本）

> 二轮深挖（2026-08-18）：4 个专案代理逐文件读了 6 家克隆源码与 wxnodus 对应模块，所有结论附 file:line 证据。
> 配套文档：`docs/cli-comparison-2026.md`（功能面总览）。本文只谈**实现差距与落地方案**。
> 克隆位置：`Desktop\cli-compare\{codex,gemini-cli,opencode,kimi-cli,crush,aider}`。

## 0. 四模态全离线（wxnodus 现有实现，代码实证）

| 模态 | 模型 | 实现位置 |
|---|---|---|
| 文本生成 | Qwen2.5-1.5B/3B Instruct q4（transformers.js） | `src/kernel/offlineModel.ts`（settings.model = `offline:Qwen2.5-*`） |
| 向量嵌入 | all-MiniLM-L6-v2 384 维 | `src/kernel/memory.ts:117`（sqlite-vec KNN，失败降级纯 FTS） |
| 视觉理解 | moondream2 q8 image-to-text（~1.7GB） | `src/kernel/vision.ts:41-57` |
| 语音转写 | whisper.cpp 本地（ffmpeg 采集→wav→转写） | `src/kernel/voice.ts:1-2` |

四者全部本地执行、数据不出机；下载一次（`/offline pack download`）后断网可用。竞品对照：codex 只覆盖文本（ollama/lmstudio 拉取，`codex-rs/ollama/src/pull.rs`）；gemini/opencode/kimi/crush 无本地模型；aider 无。**这是 wxnodus 相对 6 家最硬的差异化能力，任何瘦身都不能动它。**

## 1. 主循环与上下文装配

### 各家机制速览（证据见括号）

| | 防失控 | 压缩触发 | 工具结果回灌 |
|---|---|---|---|
| codex | 无硬上限；加权 token 软预算+分级提醒（`rollout_budget.rs:46-91`） | 双口径 token 阈值+comp_hash/降档触发（`context_window.rs:23-91`）；压缩输入 20k 上限（`compact.rs:57`） | 全量进历史，靠压缩兜底 |
| gemini | 硬 100 轮 + 签名 5 次 + 内容重复 10 次 + **LLM 辅助**（30 轮后，置信 0.9）+ count==1 给恢复机会（`client.ts:747-763`） | 50% 触发/30% 保留；**安全切分点保配对**；反向 50k 预算（`chatCompressionService.ts`） | **蒸馏（超阈值二级模型摘要）+ 掩码（50k 保护/30k 触发 FIFO）** |
| opencode | maxSteps 可配置 + 最后一步强制总结提示词（`prompt.ts:1178-1281`） | **基于模型真实窗口 − min(20k, maxOut)**（`overflow.ts:14-34`）；收尾按 token 预算 25%×usable（`compaction.ts:115-120`） | 默认 2000 行/50KB 截断**落盘**+续读提示（`truncate.ts:14-15`） |
| kimi | 1000 步+3 重试；**每步 checkpoint**；重复 3/5/8 提醒、12 硬停（`toolset.py:153-156`） | 0.85 比例 **或** +50k 输出预留（`compaction.py:60-76`） | 全量；MCP 100k 共享预算 |
| crush | 签名**含工具输出** SHA-256，窗 10 重复 >5（`loop_detection.go:45-71`）；压缩后原 prompt 重入队续跑（`agent.go:1192-1207`） | 大窗剩 20k/小窗剩 20% 触发（`agent.go:56-59`） | 全量 |
| wxnodus | 硬 32 轮+连败 5+签名窗 8 重复≥3 硬停（`agent.ts:1106-1115`） | 0.85×**硬编码 64k**（`agent.ts:953,961`）；head3+tail3（`memory.ts:80`） | **全量回填不截断**（`agent.ts:1124`） |

### 差距与落地（按优先级）

1. **工具输出回灌是命门**：wxnodus `msgs.push({role:'tool', content: e.out})` 全量（`agent.ts:1124`）——一次大 grep 打满 64k。方案：opencode 式「超 50KB/2000 行 → 落盘 `dataDir/truncations/` + 头尾预览 + `…[已截断]` 续读提示」；再叠 gemini 式「最新轮保护、旧轮掩码」（50k 保护窗/30k 触发，`toolOutputMaskingService.ts:52-66`）；蒸馏（二级模型摘要）设为开关默认关。fs_read/读类豁免（复用 `READ_TOOL_CACHE` 名单，`agent.ts:906`）。
2. **压缩触发失真**：64k 硬编码对 128k/200k 窗口模型全错。改 opencode 式「模型真实 limit − 输出预留」双条件（对齐 kimi 的 +50k reserved 思路），且压缩输入加总 token 预算（对齐 codex 20k）。
3. **循环检测分级**：3 次直接硬停误杀合法轮询。改 gemini 式「3 次注入提醒再跑 1-2 轮 → 5 次硬停」；签名并入输出短哈希（crush `loop_detection.go:45-71`）；加 gemini 式内容重复（chanting）检测。
4. **每步 checkpoint + 压缩后原 prompt 重入队续跑**（kimi `kimisoul.py:1034-1037`；crush `agent.go:1203`）——wxnodus 目前中途死循环只能整回合作废。
5. `MAX_TURNS` 32 → `settings.maxTurns` 可配置（opencode `agent.steps`）；AGENTS.md 改 findUp 到 worktree（opencode `instruction.ts:122-132`）。

## 2. 工具系统与代码编辑

### apply_patch（三家实现要点）
- **codex**：Lark 语法（`apply_patch.lark:1-19`）多文件多 hunk + `@@` 上下文锚定 + Move/End of File；流式解析（`streaming_parser.rs`）；**校验-应用分离**（先对真实文件系统全量 `verify_apply_patch_args_with_mode`，失败 `RespondToModel` 整段回给模型，绝不写一半，`handlers/apply_patch.rs:380-446`）；换行双模式。
- **opencode**：同语法 TS 复刻，单参数 `patchText`（`apply_patch.ts:18-20`）；先算完 `fileChanges` 再写（:72-191 vs :220-258）；写完 format + LSP 诊断回注（:253-293）。
- **aider**：正则解析容忍 5-9 个 fence 字符；`perfect_or_whitespace` 缩进容错 + `...` 分块 + `did_you_mean` 相似行提示 + 「只重发失败块」（`editblock_coder.py:84-124`）。
- **wxnodus 现状**：fs_edit 单文件单处 indexOf，多出现即拒绝（`tools.ts:210-212`），失败只给 80 字附近内容。

### 落地：新增 apply_patch 工具
1. 语法取 codex lark 子集（Add/Update/Delete/Move + `@@` 锚定 + End of File）。
2. 全量校验通过才落盘 + undoShadows 快照（已有 `tools.ts:214-217`）。
3. 匹配容错抄 aider 缩进容忍 + gemini flexible（trim+重缩进，`edit.ts:179-237`）。
4. 失败聚合逐块报行号+原因，附 did_you_mean。
5. 保留 fs_edit（小改动仍最快）；apply_patch 用于多文件批次。

### 并行工具调度
- gemini 判定（`scheduler.ts:472-483,561-578`）：编辑类强制串行，其余缺省并行；两阶段（校验+审批 Promise.all → 执行 Promise.all）。
- codex 用 RwLock 读写门（`parallel.rs:153-157`）：并行能力工具读锁并发、串行工具写锁互斥。
- wxnodus 严格串行（`agent.ts:1052-1072` 逐个 await）。
- **落地**：wxnodus 已有 danger 分级（`tools.ts:95`）可直接做读写门——`danger:false`（fs_read/grep/find_files/web_search/browser_snapshot）并行、`danger:true`（fs_write/fs_edit/bash）串行+同 path 互斥；审批阶段先行、执行后聚合失败计数与循环检测。

### 工具输出
- 见 §1 第 1 条；另把 `wrapDanger` 8000 硬截（`tools.ts:104`）接入 labelTruncate + offload 路径提示，补齐「截断→存盘→续读」闭环（最小改动、全局受益）。

## 3. 权限与沙盒

### 各家本质
- codex：hooks > **Guardian 自动审查**（转录重建+strict JSON+fail closed，`guardian/prompt.rs:176-177`）> 用户；execpolicy 首词索引+forbid>prompt>allow（`policy.rs:402-411`）；**三平台 OS 沙盒**（Windows `CreateRestrictedToken(WRITE_RESTRICTED)+capability SID+deny-read ACE+WFP`，`windows-sandbox-rs/src/token.rs:448-506`）。
- gemini：分层优先级规则表（Admin>User>Workspace>Extension>Default，`yolo.toml:1-29`）+ 危险命令启发式 + 重定向只降不升；**Windows 沙盒 = Restricted Token + Low IL + Job Object(KILL_ON_CLOSE)+断网限速**（`GeminiSandbox.cs:247-306`）。
- kimi：`approve_for_session` 按 action 名会话授权 + 扫尾 pending（`approval.py:354-379`）；无沙盒无规则引擎。
- crush：白名单+hook 预批准+(SessionID,Tool,Action,Path) 持久授权 + 首个裁决者胜（`permission.go:158-171`）。
- wxnodus：模式判定门（红线 regex 不可绕过 + 持久规则 + bash 四分类 + wx_cmd 四级 + autoReview 预审 + untrusted 包裹）——**策略层已不低于竞品**；但：
  1. **执行层裸 spawn 无 OS 隔离**（`tools.ts:269-273` `spawn(powershell.exe…)`）；
  2. `/sandbox L0-L3` 只是 setMode 别名（`handlersExt.ts:1621-1642`），插件沙盒自认 crash-isolation 且 fs/network/process/credential 全 false（`processIsolationSandbox.ts:10-20`）；
  3. 会话授权 `ApprovalCache` 注释自认「只是 UI 去重不是授权」（`permissions.ts:243-245`）。

### 落地
1. **Windows OS 沙盒**（最大安全差距，抄 gemini 最简路径）：Node 侧 spawn 前经一个 C#/原生助手进程 `CreateRestrictedToken(DISABLE_MAX_PRIVILEGE) + SetTokenInformation(Low IL S-1-16-4096) + CreateJobObject(KILL_ON_CLOSE) + 无网时 JobObjectNetRateControlInformation=1B`，再用 `CreateProcessAsUser(restricted token)`。L0=read-only+断网 profile，L1/L2=workspace-write capability，L3=撤写限制保留红线。进阶路线 codex 的 elevated 后端+WFP。
2. **execpolicy 式规则**：bash pattern 从朴素正则升级为 first-token 索引 + `PrefixPattern(first+rest, 支持 Alts)` + `Decision` 取 max（forbid>prompt>allow）；新增 `network_rule(host, protocol)`（禁通配符禁 scheme，`rule.rs:156-212`）；「批准即持久化」advisory-lock 单行追加（`amend.rs:65-125`）替代会话内存态。
3. **approve_for_session 真实授权**：键 = (session, tool, 命令前缀|path)，优先级置 permissions.json 之上（对齐 gemini Always-Allow 4.95 层），deny 级联拒绝同会话 pending（opencode `index.ts:129-138`）。

## 4. 存储 / 回滚 / 成本

### 各家本质
- codex：不可变追加 JSONL+序号（事件溯源），sqlite 只做索引（`rollout/recorder.rs:86-105`）。
- gemini：每项目 chats/*.jsonl + 每次工具调用前 shadow git 提交，回滚=git restore+历史重载（`gitService.ts:196-221`）。
- opencode：**消息/部件逐行入库 + 影子 gitdir tree-hash 快照 + patch 部件**——唯一做到消息级回滚且可 unrevert（`snapshot/index.ts:235-347`）。
- kimi：单 JSONL 埋 `_checkpoint` 行，回滚=文件轮转截断（`context.py:123-167`）。
- crush：全 sqlite 含按版本文件内容快照（`files` 表 `UNIQUE(path,session_id,version)`）。
- wxnodus：单 SQLite 多表（FTS5+向量+审计哈希链，`db.ts`）+ **全量 JSON 会话快照（10 份）+ 文件级全量影子快照（50 份）**——工程扎实但「全量复制」，无 diff/增量/血缘。

### 落地
1. **快照增量化**：checkpoints 改存 `{prev_id, 消息 id 上界}`（kimi `_checkpoint` 思想），恢复按上界归档而非全删全插（顺带消灭 FTS/sequence 坑，`db.ts:254-273`）；中长期引入 opencode 式影子 gitdir（tree-hash 快照，/undo fs、/snapshot、/versions 三命令共用）。
2. **成本五维 + Decimal**：usage_stats 加 reasoning/cache_read/cache_write 列 + message_id（SCHEMA_VERSION 6→7 走 `runDbMigrationsTo`）；`estimateCost` 原生浮点改 Decimal 链（对齐 opencode `session.ts:396-402`）；价目结构支持 tiers 阶梯与缓存费率（aider 1.25×/0.10×，`base_coder.py:2094-2097`）；保留诚实口径（unknownCount/「起」/unmeasured——这是相对 crush/aider 的优点）；补 crush 式 fallback：无 usage 元数据但确有输出时按 `(len+3)/4` 估算并打 estimated 标记。
3. **会话体验**：fork 记血缘（`forked_from_id`，codex `protocol.rs:2869`）；会话列表带 first_user_message 摘要（gemini `sessionUtils.ts:90-121`）。

## 5. 落地优先级总表（投入/收益）

| 优先级 | 事项 | 抄谁 | 证据锚点 |
|---|---|---|---|
| P0-1 | 工具输出 offload 截断+续读 | opencode | `truncate.ts:14-15` |
| P0-2 | 压缩触发改真实窗口+输出预留 | opencode/kimi | `overflow.ts:14-34`、`compaction.py:60-76` |
| P0-3 | apply_patch 多文件补丁 | codex/opencode | `apply_patch.lark:1-19` |
| P0-4 | Windows OS 沙盒 | gemini | `GeminiSandbox.cs:247-306` |
| P1-1 | 并行调度（danger 读写门） | gemini/codex | `scheduler.ts:472-483`、`parallel.rs:153-157` |
| P1-2 | 循环检测分级+输出哈希签名+内容重复检测 | gemini/crush | `loopDetectionService.ts`、`loop_detection.go:45-71` |
| P1-3 | 每步 checkpoint+压缩后原 prompt 续跑 | kimi/crush | `kimisoul.py:1034`、`agent.go:1192-1207` |
| P1-4 | approve_for_session 真实授权 | kimi/opencode | `approval.py:354-379` |
| P2-1 | 快照增量化+血缘 | kimi/codex | `context.py:123-167` |
| P2-2 | 成本五维+Decimal | opencode | `session.ts:338-407` |
| P2-3 | execpolicy 首词规则+网络域+批准持久化 | codex | `policy.rs:402-411`、`amend.rs:65-125` |
| P2-4 | 输出蒸馏/掩码（开关默认关） | gemini | `toolDistillationService.ts:52-81` |
| P3 | maxTurns 可配置、AGENTS.md findUp、会话浏览器、vim、主题 | 各家 | 见各节 |

## 6. 一句话结论

> wxnodus 的策略层（红线/分级/规则）已经追上甚至超过多数竞品；**真正的实现差距集中在「执行层」四件事**——工具输出回灌、真实窗口压缩、多文件补丁、OS 沙盒——每件都有现成抄法（文件级证据齐全）。存储/成本层差距是精度与效率问题（全量快照→增量、两维成本→五维），不急但方向明确。四模态离线与合规链路是护城河，任何改造都不得退化。

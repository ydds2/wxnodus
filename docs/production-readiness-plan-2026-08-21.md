# WxNodus V3 全面源码审计与 100% 实战可用更新方案（2026-08-21）

> **审计口径（用户指定）**：仅源码——wxnodus `src/` + `packages/` 全量，与 6 家竞品本地源码克隆（`Desktop\cli-compare\{codex,gemini-cli,opencode,kimi-cli,crush,aider}`）；不参考本仓 docs/ 任何历史文档，避免「文档声称已修」造成盲区。
> **方法**：5 路并行深审（kernel / 应用·命令层 / UI 全链 / 基础设施·持久化·发布链 / 竞品机制差距），每条结论带 `文件:行号` 源码锚点；多处经本机实证（Node 22.18 / win32）与多路交叉验证。
> **基线**：构建 tsc 零报错；全量测试 413 文件 / 3158 用例全绿（11 skipped）。工作区另有 99 文件 / +9276 行未提交的可靠性增强（RunContext 上下文传播、llmStream 结构化重试、serve 会话所有权等）——本方案已将其视为基线的一部分。
> **约束（AGENTS.md）**：借鉴竞品仅限「机制与语义」，实现一律按本仓架构与命名重写；互通性契约（OpenAI/LSP/补丁语法）不算抄袭；每项注明参考锚点 + 本仓落点 + 差异。

---

## 1. 总体判断

**架构质量显著高于实现完成度**。正面（护城河，任何改动不得退化）：
- `safeWorkspaceFs.ts` Windows 句柄级 TOCTOU/重解析点防护——全仓工程标杆；
- 11 端口工具管线（releaseUnapplied/settleAppliedUnverified 补偿顺序）教科书级；
- `market.ts` SRI 校验+安全解压、`ssrf/blockedHosts` 覆盖 IPv6 映射/NAT64、`winSandbox.ts` 双态令牌、`sessionRunCoordinator` FIFO 所有权+六终态、serve 的 Bearer/CSRF/幂等；
- 事件闭环纪律（finishEarly 契约、终态诚实判定）被 3158 测试锁定。

**「100% 实战可用」不成立的四大根因**（本次审计核心结论）：

| # | 根因 | 实证 |
|---|---|---|
| 1 | **精心设计的安全/预算机制被接线层短路** | 预算做成终身配额（S-1）、system-touch 确认被 mark 秒过（S-3）、apply_patch 绕过敏感写（A-22） |
| 2 | **中文 Windows 高频路径系统性缺陷** | bash GBK 乱码三连（A-1）、fs_edit 零 CRLF 容错（S-6）、HTTP body 中文损坏（A-8）、「加密」意图劫持（A-17）、单字中文搜索必空 |
| 3 | **运行时工程（编码/超时/状态作用域/启发式）弱于安全工程** | 重试丢弃成功响应（A-3）、「失败/异常」子串误杀（A-5）、120s 全程超时（A-7）、预算标志跨会话污染（B-1）、离线每次推理全量哈希 GB 权重（A-21） |
| 4 | **渲染链架构缺口被补丁累积掩盖** | 三写路径 × 两屏幕模式 × 三能力档的矩阵只有 cmd+alt-screen 一格被认真测试；INLINE 坐标错位、vim Esc 接线死代码证明其它格子持续烂掉 |

**修复总原则**：先止血（S 级）→ 再修高频路径（bash/编辑/流式）→ 再补鲁棒性机制（竞品对照）→ 最后收敛架构债。每波次结束跑全量门禁（§6）。

---

## 2. S 级缺陷（实战不可用 / 数据丢失 / 安全洞）——波 0 止血

### S-1 工具预算终身配额永不重置，「用着用着全坏了」的单一最大根因
- **锚点**：`src/infrastructure/sqlite/authorizationUnitOfWork.ts:52-55`（reserve 扣减）+ `:91-99`（commit 不回补，语义正确）+ `src/infrastructure/sqlite/securityProvisioning.ts:40-46`（仅 budget id/limits 变化才轮换重置）+ `src/bootstrap/cliComposition.ts:205`（id 恒为 `budget-cli-v1` 常量）。
- **后果**：累计成功 50 次 bash / 100 次网络 / 200 次文件写后对应工具类返回 `BUDGET_EXCEEDED` 永久瘫痪；**重启无效**（used_json 跨启动持久），无命令可清零，唯手改 SQLite。用户正常使用数日内必然触发。
- **修复**（推荐 ①+③ 组合，半天）：
  1. `budget.id` 加代际后缀（如 `budget-cli-v1-<yyyymmdd>` 或启动会话 id）——provisioning 现有「换代即重计」逻辑自动生效，改动一行级；
  2. `/perm budget status|reset` 命令 + `/status`、`/doctor` 显示剩余额度（读 budget_snapshots.used_json）；
  3. 单测：启动两次同 id 不重置、id 变化重置、撞上限后 reset 恢复。
- **语义定位**：CLI 单机场景 limits 应为「并发护栏」而非「终身配额」——与 reserve/commit/release 的设计意图对齐。

### S-2 bash 分级不按换行符 / 单 `&` / `$()` 切分——破坏性命令伪装只读自动放行
- **锚点**：`src/kernel/permissions.ts:220`（split 正则缺 `\n`、`&`、`$()`）+ `:206-215`（`BASH_READONLY` 前缀匹配）+ `:273-275`（smart/auto/goal/plan 模式 readonly 直接 approve）。
- **后果**：模型提交 `cat file\nRemove-Item -Recurse -Force src` 或 `echo $(del C:\x)`——整段以 `cat `/`echo ` 开头被判只读，**无审批执行**。硬红线只拦 `rm -rf /` 级目标，`./src` 不在内。
- **修复**（1 天）：
  1. 切分正则补 `\r?\n`、单 `&`、管道 `|`（现只 `||`）；对 `$(`、反引号段提取后**递归 classifyBashSingle**，任一子命令非只读则整体非只读；
  2. 只读白名单加严：仅当命令为「单行、无 `$(`、无管道、无重定向」时才可判 readonly，否则降为 `unknown`（走审批）；
  3. 单测矩阵：多行伪装 ×8、`$()` 嵌套、`|` 管道尾接删除、既有合法只读命令不回归。

### S-3 system-touch 强确认被无条件 mark 短路 + grep/ls 无工作区边界——零确认越权读取链
- **锚点**：`src/application/tools/agentToolSurface.ts:259`（execute 前无条件 `bridge.mark(correlationId, ...)`）+ `src/bootstrap/cliComposition.ts:206-211`（approver 对一切 `agent:*` 前缀直接 consume）+ `src/kernel/tools.ts:503,520`（`ls`/`grep` 的 path 仅 `resolve(ctx.cwd, path)`，无 pathBoundary 校验）。
- **后果**：管线 decide 阶段的系统路径强确认（`toolExecutionWiring.ts:139-142` → `SYSTEM_TOUCH_REQUIRES_CONFIRMATION`）被刚打上的 mark 秒过；grep/ls 又是 `danger:false`，smart 模式前置链也放行。提示注入可零确认执行 `grep {pattern:'password|secret', path:'C:/Users/<user>'}`，敏感内容回流模型。仅 `mcp:*`/`plugin:*` 前缀享受完整确认。
- **修复**（1 天）：
  1. approver 对 `reasonCode === 'SYSTEM_TOUCH_REQUIRES_CONFIRMATION'` 的请求**强制走 bridges.approver 真弹窗**（consume 的 mark 仅对非 system-touch 的 require_approval 生效）；
  2. `grep`/`ls`/`find_files` 的 path 过 `validateWorkspaceTarget`（pathBoundary），工作区外直接拒绝或升 system-touch 确认；
  3. 单测：agent 工具命中系统路径必须弹窗、grep 工作区外路径被拒、既有 agent 低危工具流不回归。

### S-4 view_image 无工作区边界——任意本机图片可被读取外发云端视觉 API
- **锚点**：`src/kernel/tools.ts:1428-1450`（`resolve(ctx.cwd, path)` + `readFileSync` 直读，schema 还明示「或绝对路径」）+ `src/kernel/agent.ts:1410-1412`（图片 base64 注入请求发云端端点）。
- **后果**：`../..` 与绝对路径均放行，`danger:false` 不触发审批。提示注入可诱导读取密码管理器窗口截图等敏感图片外发。
- **修复**（2 小时）：`view_image.run` 复用 `safeWorkspaceRead`；工作区外路径返回显式错误引导（或加 `danger:true` 走审批）。单测：越界路径拒绝 ×3 形态。

### S-5 replaceSessionMessages 无事务边界——undo/checkpoint 恢复中崩溃 = 整个会话消息永久丢失
- **锚点**：`src/store/db.ts:258-277`（DELETE 全量 + FTS 清理 + sequence 重置 + N 条 INSERT，全部独立 autocommit）；两个调用方 `src/commands/ext/sessionCommands.ts:636`（/checkpoint restore）与 `src/presentation/tui/tuiPresentationAdapter.ts:207`（/undo、rollback.restore）均无外层事务。
- **后果**：DELETE 已提交、重插未完成时进程崩溃/断电 → 全会话消息永久丢失（增量快照只存上界，救不回被删行）。undo 是高频操作。
- **修复**（半小时）：函数体整体包 `db.transaction(() => { ... })()`（better-sqlite3 同步事务）。单测：mock 中途抛错断言消息原样保留。

### S-6 fs_edit 零 CRLF/空白容错——Windows 编辑最高频失败点，且同仓已有正确实现未回灌
- **锚点**：`src/kernel/tools.ts:190-236`（`content.indexOf(needle)` 精确匹配，零行尾归一/空白弹性）；对照 `src/kernel/applyPatch.ts:156-168,227`（已实现 exact→trimEnd→reindent 三级容错 + eol 探测保真）。
- **后果**：LLM 默认输出 LF、Windows 文件是 CRLF → 「未找到要替换的文本」高频失败，模型反复重试浪费轮次。
- **参考机制**（不抄代码）：aider `aider/coders/editblock_coder.py:134-187` 四级降级（精确→空白弹性→丢首空行→省略号匹配）；opencode `packages/opencode/src/tool/edit.ts:23-27,126-128`（`detectLineEnding`/`convertToLineEnding` 归一匹配、按原行尾写回）。
- **修复**（1 天）：把 applyPatch 的 blockMatches 三级匹配思想搬进 fs_edit：探测文件 eol → oldText/newText 行尾归一到文件 eol 再匹配 → 失败降 trimEnd/reindent → 写回保持原 eol。单测：CRLF/LF/混合行尾 × 精确/缩进漂移/尾空白 6 组。

### S-7 /gateway 与 /a2a 本地监听零认证零 CSRF——恶意网页可静默驱动任意命令
- **锚点**：`src/commands/handlersExt.ts:1128-1213`（/gateway 仅判 method+url，`command` 直接 `runInvocation.invoke` 任意命令）+ `:1286-1337`（/a2a 同款，端口 8787）。对照同仓 `src/cli/serve.ts:419-464`（Bearer+CSRF+会话所有权三重防护，command 白名单仅 3 条）——**无认证的通道反而全命令开放，安全设计倒挂**。
- **后果**：CORS simple request（`Content-Type: text/plain`）无需预检即可跨站 POST `/rpc {"method":"command","input":"/perm yolo"}`——用户浏览恶意网页期间 agent 被驱动执行任意命令/改权限。
- **修复**（半天）：复用 serve.ts 的 Bearer（生成随机 token 打印一次）+ `evaluateCsrf` 预检；至少强制 `Content-Type: application/json` + Origin 白名单。单测：无 token 401、text/plain 拒绝、带 token 通过。

### S-8（并入 A-1 的系统性表述）bash 工具在中文 Windows 上三连缺陷
见 A-1/A-2——因其「目标用户最高频路径」属性，执行优先级按 S 级对待。

---

## 3. A 级缺陷（高频场景显著错误）——波 1 高频路径

### 输入/命令执行路径

**A-1 bash PowerShell 编码三连**：`src/kernel/tools.ts:381-385,395`（stdout 按 UTF-8 解码，PS 5.1 重定向输出实为 OEM/GBK——`dir` 中文文件名全乱码）+ `-Command` 直传 CJK 受 argv 编码影响（可能空/损坏→挂死）。**同仓已掌握正确修法未回灌**：`hooks.ts:37-43` 已实测改 `-EncodedCommand`、`winSandbox.ts:63` 显式 `[Console]::OutputEncoding=UTF8`。→ 修：主路径改 `-EncodedCommand`（UTF-16LE base64）+ 命令前缀设 OutputEncoding + `TextDecoder` 流式增量解码（`llmStream.ts:190` 已是正确写法）。单测：mock 进程 GBK 字节流解码正确、CJK 命令往返。

**A-2 bash 硬编码 60s 超时**：`tools.ts:321,370`。npm install/测试套件必死，且超时不可配。**参考**：opencode `tool/shell.ts:540-564`（timeout 是 schema 参数，超时提示「retry with a larger timeout」）。→ 修：schema 加可选 `timeout_ms`（默认 60s、上限夹取 10min，settings.bashTimeoutMs 覆盖默认）；超时返回语引导重试或转 /jobs。

**A-3 重试成功后 continue 丢弃已成功响应**：`src/kernel/agent.ts:1232-1242`（catch 内重试成功 `break` 后落到外层 `continue`，跳过本轮 res 处理）。→ 修：重试成功后不再 continue，落入正常 `res.type` 处理。单测：mock 第一次失败第二次成功，断言不发起第三次调用、响应被处理。

**A-4 流中断重试无「丢弃半截输出」信号——屏幕重复拼接**：`agent.ts:1225-1240`（重发前零事件）+ `src/wxnodus-ui/runtime/presentationReducer.ts:212-213`（delta 无条件累加）。**参考**：gemini-cli `geminiChat.ts:76-105`（`StreamEventType.RETRY`，注释明言 UI should discard partial content）。→ 修：重发前 emit `stream.retry` 事件 → gateway 翻译为带 reset 标志的 message.delta → reducer 收到即清空 streaming 段。与 A-3 同一改造面。

**A-5 「失败/异常」子串启发式驱动连续失败终止**：`agent.ts:1327,1353-1356`（`out.includes('失败')||out.includes('异常')` → 连续 5 次硬停）。中文项目 grep「异常处理」、读含「失败」字样的日志即误杀；退出码 0 也算。**参考**：gemini-cli `tool-error.ts:14-106`（结构化 ToolErrorType：recoverable 模型自纠 / 仅系统级 fatal 才终止）。→ 修：anyFail 改用 `lastToolOutcome === 'failed'`（agent.ts:685 已有管道级确定性结局却未用）；字符串启发式仅作 MCP/外部工具兜底且标注来源。**交叉验证**：kernel 审计与竞品扫描独立发现同一条。

**A-6 serve 端口占用假启动**：`src/cli/serve.ts:858`（listen 无 error 监听）+ `src/cli/index.ts:594`（同步打印「已启动」先于 error 事件）→ 屏幕显示已启动、实际未监听、错误只进日志文件。→ 修：startServeServer 改 Promise 等待 listening/error，失败打印「端口占用」并 `process.exit(1)`（同文件 /gateway 的正确形态在 `handlersExt.ts:1207-1211`）。

**A-7 HTTP body 逐 chunk 转 utf8——中文长请求高概率损坏**：`serve.ts:100-117` + `handlersExt.ts:1133-1134`（`data += chunk` 每个 Buffer 独立 toString，多字节序列跨 TCP 分包截断成不可逆 U+FFFD）。→ 修：收集 Buffer 数组 end 时 `Buffer.concat().toString('utf8')`，两处同改。单测：把多字节字符切在字节边界模拟分包。

**A-8 「加密…」开头的任意中文句子被劫持为 base64**：`src/commands/deterministic.ts:26-28`（`[\s\S]+` 贪婪匹配 + deterministic 层先于 NL 守卫执行）。「加密一下这个文件夹」→ 得到 base64 乱码。→ 修：正则收紧为短 token 形态（`[A-Za-z0-9+/=_-]{2,256}`），deterministicRun 增加与 NL 相同的长句守卫。

### 模型交互路径

**A-9 llmStream 120s 全程超时杀长流式**：`llmStream.ts:390-391`（timeout 覆盖整个 fetch+读流；TimeoutError 不匹配 isAbortError 被误判 premature-eof 再重试 3×120s = 8 分钟假死）。→ 修：改**空闲超时**（距上一 chunk 间隔，如 60s），全程上限单独放大并可配。

**A-10 断网不重连——Wi-Fi 闪断 1 分钟 = 跑了几十轮的任务整轮报废**：`llmStream.ts:5-8`（MAX_ATTEMPTS=4/退避 10s 封顶）+ agent 层再 3 次 ≈ 合计几十秒。**参考**：codex `responses_retry.rs:58-83`（连接类失败无限重试 5s→60s 封顶，UI 显示 "Reconnecting... waiting for network"）。→ 修：`connect` 类失败（排除 4xx/abort）升级「等待网络」模式：指数退避 60s 封顶、持续重试至可配上限（默认 10min），Esc 随时中止；同时发 `system.notice`（「网络中断，第 n 次重连…」）解决 A-11 假死观感。llmStream 已有 abortableWait/重试骨架，改判定与上限即可。

**A-11 重试/退避全程零用户可见信号**：429 高峰期只见长时间无输出。**参考**：codex `responses_retry.rs:110-122`（每次重试 notify，避免 staring at a frozen screen）。→ 修：attempt 循环 emit `system.notice`（「限流中，Ns 后第 n 次重试」）。与 A-10 同一改造面。

**A-12 工具参数 JSON 坏被静默吞成 `{}`**：`agent.ts:1694-1696`（safeJson catch → `{}`，模型收不到「JSON 坏了」信号，以空参执行报误导错误）。**参考**：opencode `tool/invalid.ts:13-27`（InvalidTool 伪工具把解析错误作为工具结果回模型自纠）；codex `function_call_error.rs`（RespondToModel 而非致命）。→ 修：解析失败不执行，直接回「参数 JSON 无效：<错误片段>——请重发合法 JSON」的工具结果。

**A-13 上下文超限错误不触发自动压缩**：`agent.ts:1159-1164`（85% 阈值用字符估算，代码/JSON 偏差大）+ `providers.ts:293`（413/context-length 只提示手动 /compact）。**参考**：opencode `session/processor.ts:475-481`+`overflow.ts`（真实 usage 对 usable 窗口判定 needsCompaction）；codex `turn.rs:1387-1391`（ContextWindowExceeded 专门分支）。→ 修：① 每轮用真实 `usage.promptTokens`（agent.ts:501 已拿到）校准估算系数；② 捕获 413/含 context-length 语义的 400 → 强制 compactMessages → 自动重发一次。

**A-14 coder 子代理拿不到任何写工具**：`src/kernel/subagentTypes.ts:50-54`（无 tools 白名单 → 默认排除分支剔除 fs_write/fs_edit/bash/apply_patch）+ 提示词却指示「用 apply_patch 修改、bash 验证」→ 反复撞「未知工具」。→ 修：coder 显式声明 `tools: [...READONLY_SUBAGENT_TOOLS,'fs_write','fs_edit','apply_patch','bash']`。

**A-15 离线模型每次推理前全量 SHA-256 校验 GB 级权重**：`src/kernel/offlineModel.ts:322-327,234-238`（每次调用 isOfflineModelReady 逐文件 sha256，1.2~2.5GB）→ 离线模式每条消息固定卡数秒。→ 修：清单校验按 mtime+size 缓存（进程内或 state 文件），仅启动/显式 verify 全量哈希。

### 应用/服务路径

**A-16 PowerShell 每次工具调用同步 spawn——性能墙**：`src/infrastructure/fs/windowsPathClassifier.ts:162-188`（工作区内已存在文件也走 `spawnSync('powershell.exe', …)`，150-800ms/次且阻塞事件循环，流式输出呈脉冲卡顿）。**双路交叉验证**。→ 修：① 属性探测改 `attrib`（毫秒级）或 Node stat 可得字段；② 结果按 path+mtime LRU 缓存；③ 读类工具跳过属性探测（仅写类 system-touch 启用）。

**A-17 系统路径分类器被 8.3 短名/尾点/正斜杠三类别名绕过**（已实证）：`windowsPathClassifier.ts:106,134-143`（norm 仅小写+去尾斜杠）——`C:\Windows.\system32\x`、`C:\PROGRA~1\...`、全正斜杠均逃过 system-touch 强确认。→ 修：分类前 `fs.realpathSync.native`（展开 8.3/尾点）+ `path.win32.normalize` + 统一正斜杠再比对；`other` 但工作区外的绝对路径默认升确认。单测：三类别名 × 实文件。

**A-18 安装器产物缺根 package.json——版本恒 0.0.0 + Node<22.7 装上即崩**：`scripts/package-installer.ts:44-47`（staged 树无根 package.json）+ `src/kernel/version.ts:9`（读不到回退 '0.0.0'）+ install.ps1:71 预检 ≥18 与 engines >=22 矛盾 + 无 `"type":"module"` 时低版本 Node 按 CJS 解析 SyntaxError。→ 修：打包时合成最小根 package.json（name/version/type）加入 staged 树；install 预检改 ≥22.7 硬门槛（或产物 .mjs）。

**A-19 taskkill 失败无兜底 + 无 deadline——工具调用永久挂起**：`src/infrastructure/process/processSupervisor.ts:117-123,140-144`（不看 taskkill 退出码；exit await 无 deadline，timeout 只触发一次）。对照同文件 `:76-78` 正确检查了 code===0。→ 修：taskkill 非零 → `proc.kill('SIGKILL')` 兜底；exit await 加硬 deadline（timeout+5s）后按 `PROCESS_TERMINATION_FAILED` 返回。

**A-20 spec 前向依赖被误判「未知模块」**：`src/build/spec.ts:85-88`（循环内先 add 再校验——`[a(deps:[b]),b]` 合法 DAG 被拒，llmSpec 返回 null，用户只见「AI 规格化失败」误导且重试无效）。→ 修：两轮循环（先收集全部模块名，再校验 deps）。

**A-21 每事件 appendFileSync + events.jsonl 无限增长**：`src/kernel/events.ts:75`（对所有事件同步落盘，`agent.token` 每个 SSE delta 一次——长回复数千次同步 open/write/close，单日可涨数百 MB）。→ 修：token/reasoning.delta 高频事件不落盘或 250ms 缓冲合并写；jsonl 加大小上限+轮转（保留重放所需的低频事件全量）。

**A-22 apply_patch 整类绕过敏感文件写保护**：`permissions.ts:268-270`（SENSITIVE_WRITE_MATCHERS 仅 fs_write/fs_edit 检查 path；apply_patch 审批只看补丁文本，可 `*** Update File: .env`；bash `echo x > .env` 同漏）。→ 修：敏感路径匹配下沉 executeTool 层，对「所有产生文件写入的工具」统一检查（apply_patch 解析后逐目标路径、bash 重定向目标）。

### UI 路径（UI 审计五点实战风险）

**A-23 vim 模式整体不可用（Esc 接线死代码）**：`src/wxnodus-ui/components/textInput.tsx:1005-1012,1521-1533`——pass-through 谓词含 `key.escape` 永远提前 return，1015-1021 的 insert→normal 切换不可达；vimCore.ts 836 行纯函数本身完好，断在 UI 接线层。→ 修：vim 分支上移到 pass-through 之前；useKeyBindings 双 Esc 取消（:685）前加 vim 门控（vim 用户连击 Esc 是肌肉记忆，busy 时会误触发 interruptTurn）。补 handler 接线层集成测试（纯函数单测已好，接线层零覆盖是盲区）。

**A-24 pendingApproval/pendingClarify 单槽无超时且覆盖不解决旧 Promise**：`src/wxnodus-ui/wxGateway.ts:98-99,2615-2637,1874-1882`（单字段直赋，被覆盖的 Promise 永不 resolve → 内核工具 await 永久挂起 → 回合卡死 busy）。同文件 `pendingSecrets/pendingForms`（1218-1269）已是正确形态（Map+timer+id 路由）。→ 修：改造成 secrets/forms 同款；`approval.request` 事件带 request_id，respond 按 id 路由，超时 fail-closed；顺带消除 `clarifyRespond` 跨通道兜底误答审批的危险死代码（1884-1896）。`cancelForeground`（:182）补清 pendingClarify。

**A-25 INLINE 主屏模式 CUP 绝对坐标错位**：`packages/wxnodus-ink/src/ink/log-update.ts:812-832`（`moveCursorTo` 参数显式改名 `_viewportY` 弃用——viewportY>0 后所有脏行 CUP 偏移、被 clamp 到最后一行，中部增量更新堆到底行）。→ 修：CUP 行号减 viewportY，`y - viewportY < 0` 跳过（对齐非 conhost 路径 scrollback 跳过语义）。

**A-26 任意 RPC 异常全局广播为 error 并强制复位 busy**：`wxGateway.ts:454-464` + `bridge/eventAdapter.ts:920-938` + `runtime/flowController.ts:553-564`——busy 期间任何后台 RPC 失败（补全轮询/switcher 1.5s 轮询）→ UI 提前 ready、流式段丢失、转写插入无关 error 行（「错误刷屏」用户报告同源）。→ 修：error 事件加 scope（rpc/transient）；UI 仅对 prompt.submit/agent.error 来源走 recordError，其余降级 pushActivity 不动 busy。

---

## 4. B 级缺陷精选（边角错误/体验损伤/机制差距）——波 2

### 数据与状态
| # | 缺陷 | 锚点 | 修复 |
|---|---|---|---|
| B-1 | undoShadows 目录级恢复落盘**最旧**版本（数据回退方向错误） | `kernel/undoShadows.ts:141-156`（ts 降序逐份覆盖，最后写=最旧） | 按 path 分组只写 ts 最大份 |
| B-2 | 预算告警/硬停标志跨会话污染（A 会话超限 → 切到 B 直接硬停/永无水位提示） | `kernel/agent.ts:245,361-376,1127-1130`（实例级标志经 setSessionId 复用） | 改按 sessionId 的 Map（参照 sessionClocks） |
| B-3 | 快照「消息只增不删」前提被自家代码违反（compactSmart 原位改写/物理删行） | `kernel/memory.ts:367-368` + `store/db.ts:313` | 压缩改新增摘要行不覆写；或快照存内容 |
| B-4 | WAL 残留：restore/重建主库不删 -wal/-shm（SQLite 明列损坏路径）；rename 失败吞掉后无限递归 | `migrations/db/backup.ts:52-56` + `store/db.ts:52-55` | restore 前 rmSync wal/shm；rename 失败明确报错终止 |
| B-5 | 审计哈希链多进程并发分叉 + 无校验器 | `kernel/audit.ts:19-27`（SELECT prev + INSERT 非原子） | 单语句 INSERT...SELECT COALESCE 表达式哈希；补 verifyAudit |
| B-6 | 授权 commit/release 不迁移 grant.status（双花窗口：commit 后可再 release） | `infrastructure/sqlite/authorizationUnitOfWork.ts:91-120` | commit 置 committed、release 置 released，入口校验旧值 consumed |
| B-7 | /backup 直接 cpSync 活动 SQLite（含 wal/shm 非同时刻快照） | `commands/handlers.ts:1031-1043` | 改 `db.backup()` 在线备份或先 `wal_checkpoint(TRUNCATE)` |
| B-8 | /diff revert 单 hunk 回写把 CRLF 文件整体翻成 LF | `kernel/hunkApply.ts:66,98,108` + `commands/ext/sessionCommands.ts:308-312`（join('\n') 直写） | applyHunkToText 按原文 eol 恢复（applyPatch.ts:227 已有正确做法） |
| B-9 | BOM 保真缺失：fs_write 覆盖时静默去 BOM | `kernel/tools.ts:165-183` | safeWorkspaceWrite 层检测保留原 BOM；fs_read 给模型前剥 |

### 工具与协议
| # | 缺陷 | 锚点 | 修复 |
|---|---|---|---|
| B-10 | tool_search 热重载丢失（/mcp add、/plugin reload 后懒加载入口失效） | `kernel/agent.ts:614-626,1592-1612`（tool_search 只在 createAgent 手工注入，updateTools 重建即丢）**双路交叉验证** | 注册移进 assembleTools 装配逻辑 |
| B-11 | 子代理白名单工具激活写错作用域（改了父 agent 的 activeToolNames） | `kernel/agent.ts:585-588` | 移入子代理构造参数 presetActiveTools |
| B-12 | MCP stdio 逐 chunk toString('utf8')——CJK 跨 chunk 边界损坏、随机丢帧 | `kernel/mcp.ts:383-384`；bash appendOut（tools.ts:392-396）同款 | 统一 TextDecoder 增量解码 |
| B-13 | MCP server 崩溃后无自愈（此后调用持续失败，需手动重连） | `kernel/mcp.ts:409-417`。**参考** crush `lifecycle.go:28-80` reconcile 状态机 | lazy-respawn：调用时发现已关闭自动重连一次（30s 冷却防风暴），失败才诚实回模型 |
| B-14 | browser_navigate 只做首跳 SSRF 校验，浏览器自动跟随重定向不再校验 | `kernel/browser.ts:178-185` | 订阅 framenavigated 对每次导航重跑 authorizeOutboundUrl，内网目标 abort |
| B-15 | term PTY 注入完整 process.env（含全部密钥），与他处 sanitizedEnv 不一致 | `kernel/term.ts:110` | 传 sanitizedEnv() |
| B-16 | cron dom/dow 同受限时取 AND（标准 vixie 语义是 OR）——定时任务少跑 | `kernel/cronExpr.ts:98-106` | 两字段都非 * 时 `dom.has(d)||dow.has(d)` |
| B-17 | `data: [DONE]` 后无空行的兼容端点被判 malformed-sse 白烧 4 次重试 | `kernel/llmStream.ts:331` | 循环结束先尝试 processFrame 再判定 |
| B-18 | 请求体恒带 temperature:0.7（o 系/gpt-5 及严格网关 400） | `kernel/providers.ts:257-262` | 目录 thinking/o 系模型省略或可配 omitTemperature |
| B-19 | 429 限额状态不解析不展示（用户分不清额度尽 vs 网络故障） | llmStream.ts 只认 Retry-After。**参考** codex `turn.rs:1392-1398` update_rate_limits | 解析 x-ratelimit-*/reset 子集，会话级缓存，状态栏显示「额度 HH:mm 重置」 |
| B-20 | 中断恢复不回放工具结果（「继续完成」名不副实——tool 消息被重建过滤） | `agent.ts:1046-1052`（重建只放行 user/assistant/摘要）vs `:1057-1061`（注入继续注记）。**参考** gemini `geminiChat.ts:736-756`（functionResponse 跨轮可见+占位符保协议形态） | 被打断回合的 tool 消息（或摘要）纳入回放窗口（有界最近 N 条） |
| B-21 | 编辑后无 LSP 诊断自动回灌（写错看不到类型错误，无编辑-编译内环） | `tools.ts:1407-1411` lsp_diagnostics 是模型可调但不自动接线。**参考** opencode `tool/edit.ts:197-205`（touchFile + diagnostics 随结果回灌） | fs_edit/apply_patch 成功后异步拉诊断，非空截断附结果尾部；settings.lspFeedback 可关 |

### 命令与生命周期
| # | 缺陷 | 锚点 | 修复 |
|---|---|---|---|
| B-22 | /plugin install 以 utf8 字符串往返复制——二进制文件必损坏 | `commands/handlersExt.ts:526-535` | Buffer 直拷或 cpSync |
| B-23 | /goal 以裸 `✅` 出现判完成 + 验证「任意最新旧项目」→ 假完成 | `handlersExt.ts:2073-2094` | 移除裸 includes；记录任务前基线，仅验证本轮新建项目 |
| B-24 | Ctrl+C 单击 300ms 后无条件退出（「中断任务」语义实际不存在） | `cli/index.ts:1014-1019` | 第一次只中断 Run 并提示「再按退出」；退出放第二次或空闲态 |
| B-25 | kernel 组合阶段中途失败 MCP 子进程不清理（孤儿） | `bootstrap/cliComposition.ts:175,216-219,396-408`（resources 事后 push） | phase 内 try/catch 先 closeAllMcp；或资源即时注册 |
| B-26 | /jobs follow 轮询 120s 不检查取消信号 | `handlersExt.ts:1561-1584` | 循环条件加 !aborted，sleep 可被 abort 打断 |
| B-27 | /import 非 JSON 兜底写入硬编码 'default' 会话（与提示语矛盾） | `handlersExt.ts:2201` | 改 ctx.mem.append(sid,...) |
| B-28 | /warp 有处理器但不在 SLASH 目录（-p 模式被当聊天发给模型） | `commands/registry.ts:5-28` + `kernel/commandLevels.ts:97-108` | 入 SLASH 或 ALIASES 映射 |
| B-29 | inferTextCompletion 以「不可用/未找到/无法」前缀正则误判终态（CI 退出码错） | `app/CommandBus.ts:50-63` | 仅 handler 显式 completion 才携带非成功终态；删信息词启发式 |
| B-30 | /computer click modern 路由 `Number(x)||0`——非法坐标静默点击屏幕左上角 | `handlersExt.ts:177`（legacy 分支 :282 有校验） | modern 分支同校验，非法返回用法 |
| B-31 | 管线 timeoutMs 声明但全链路无执行超时（挂死只能靠外部取消） | `domain/tools/toolDescriptor.ts` + `toolExecutionPipeline.ts` | pipeline execute 端口包 Promise.race(timeout) |
| B-32 | hooks/UIA 桥同步 spawnSync 阻塞主线程最长 10s/25s（TUI 冻结） | `kernel/hooks.ts:53-59` + `computer/uia.ts:274-275` | 改异步 execFile/spawn（HookRunner 已 async 签名） |

### UI 渲染
| # | 缺陷 | 锚点 | 修复 |
|---|---|---|---|
| B-33 | conhost 末列永不重绘（滚动条 thumb 在 cmd 上冻结；末列保护过度防御到 w-1） | `log-update.ts:682-740`（maxWritableX=w-2；行尾已每次 \r 收尾，担心的 pending-wrap 漂移实际已被复位） | maxWritableX 恢复 w-1（段尾 \r 保底）；或末列非空脏行强制整屏重置兜底 |
| B-34 | overlay 每次按键触发整屏 ERASE+重绘（pager 每个方向键全屏白闪；擦除在 BSU/ESU 保护窗外） | `ink.tsx:1220-1236` + `runtime/promptStore.ts:26-52` | ERASE 并入下一帧 diff patch 序列首部（受同步输出保护）；纯位移 overlay 改 invalidatePrevFrame |
| B-35 | 补全开着时 ↑↓ 双消费（多行输入+尾部补全时光标与高亮同时动） | `useKeyBindings.ts:596-610` + `textInput.tsx:1125-1137`（useInput 多播无消费协议） | TextInput ↑↓ 分支加「补全打开跳过」；长期引入 key 消费标记 |
| B-36 | 主屏同尺寸 resize 不重绘（conhost 改字号字形残留） | `ink.tsx:486-498` | 主屏补同尺寸重绘兜底（alt-screen 已有） |

### 发布链
| # | 缺陷 | 锚点 | 修复 |
|---|---|---|---|
| B-37 | 依赖闭包取打包机当时 node_modules，与冻结 candidate 零绑定；原生 ABI 无校验 | `scripts/package-installer.ts:44-47` | SBOM 作闭包版本断言输入；install 预检 ABI 比对 |
| B-38 | VSCode 扩展：Windows .cmd bin 无 shell 必 EINVAL + dataDir 默认落扩展目录（更新即清库）+ 并发 spawn 无互斥 | `packages/vscode-ext/src/extension.ts:29,33-39,139-146` | win32 shell:true/显式处理；dataDir 改 globalStorageUri；spawn 互斥 |
| B-39 | scaffold title 未转义进 HTML/JSX（LLM 标题注入脚本/破坏语法）+ `join(dataDir,title)` 无清洗 | `build/scaffold.ts:686,695-704` + `forge.ts:29,35` | esc() 同款转义；title 过滤 `[^\w\u4e00-\u9fff-]` |
| B-40 | evidence fingerprint 不含文件名（改名/同内容增删不变）；complianceCheck 读永不产出的 audit.json 恒告警 | `build/evidence.ts:7-20,72-79` | 对齐 hashDistTree 的 path+content；改查 audit 表 COUNT |
| B-41 | verify.ts kill 不等退出即同端口 respawn（EADDRINUSE 假阴性）+ 固定 1200ms 启动等待 | `build/verify.ts:37-47` | await exit 后 respawn；探活轮询 200ms×40 |
| B-42 | 迁移备份 VACUUM INTO 全量追加永不清理 | `migrations/db/runner.ts:35` + `backup.ts:14-20` | 保留最近 N 份或按 migrationId 去重 |

---

## 5. C 级工程债清单（波 3，按簇归并）

- **消息/FTS 一致性**：messages_fts 非外部内容表且 deleteMessage 不清 FTS（db.ts:188-199,308-315，注释与实现相悖）；imageHistory UPDATE 后不刷新 FTS（imageHistory.ts:50-52）。
- **中文检索**：bigramZh 单个 CJK 字符完全不索引、尾字符丢弃（bigramZh.ts:9-24）——单字中文查询必空。
- **编码统一**：uia.ts `-Command` 内嵌 CJK（同 hooks 已修问题）；uiaRead PS 手拼 JSON 未转义。
- **execPolicy 语义**：bash 规则 pattern 前缀匹配不锚定结尾（permissions.ts:144）——`npm*` 规则放行 `npm install && rm -rf x`（用户自配规则的静默放大面）。
- **注入面**：grep pattern 以 `-` 开头当选项（tools.ts:530，应 `-e pattern --`）；plugins NL 触发器不筛 trusted/enabled（ReDoS 面）；skills installSkill meta.name 未清洗可逃出目录；deterministicTools /sql 放行全部 PRAGMA。
- **会话/统计**：curator 只统计 default 会话；/memory 概览硬编码 default；-p --json usage 会话错位；acp sessions Map 只增不减。
- **杂项**：voice.ts 设备枚举回退正则把 `\s*` 写成字面 `s*`（死代码）；loopJudge 子串判定（"not a loop" 判 loop）；execServer 远端临时文件不清理；browser headless 回退对 playwright-core 无效（不可达分支）；processProbe 首次 spawnSync 5s；MCP HTTP 配置无鉴权头；mcp.ts 对 notification 回包违反 JSON-RPC；config.ts 原子写 tmp 名固定（多进程互踩）+ rename 无瞬态重试（AV 占用）；DNS rebinding TOCTOU 残留（业界通病，记录不修）；wxGateway 2737 行巨类（协议方法再增即拆）；zip 无 ZIP64；trace/reservations Map 失败路径不清理；evidence/grants/journal 无轮转；spec v2 声明 test 脚本但零测试文件（npm test 空转通过）。
- **竞品参考（B 级价值）**：版本更新检查（crush update.go——启动后台单次查 release，失败静默）；编辑后自动格式化（opencode format.file，随 B-21 LSP 接线顺带，settings.formatAfterEdit）；模型可查上下文余量（codex get_context_remaining 工具，数据源 lastPromptTokens+水位线）；会话流轮转（kimi context.py 超数轮转，sessionStream.ts 改异步+5MB 轮转）；取消后兜底文案与「已取消」不符（agent.ts:1445-1446，`st.interrupted` 单独文案）。

---

## 6. 分波实施计划与验证门禁

### 波 0：止血（S-1~S-7 + A-3/A-4，约 2-3 天）
数据不丢、不越权、不瘫痪。全部为一行级~一天级改动，风险低。
顺序：S-5（半小时）→ S-4（2 小时）→ S-1（半天）→ S-2 → S-3 → S-6 → S-7 → A-3/A-4。
**验收**：每项所列单测 + 全量回归；S-2/S-3 附加红队用例（多行伪装 ×8、注入读敏感路径被拒）。

### 波 1：高频路径（A-1/A-2/A-5/A-7/A-8/A-12/A-16 + B-8/B-10/B-22，约 1 周）
「每一次对话、每一条命令、每一次编辑」的体验与正确性。中文 Windows 实测为主。
**验收**：真实 cmd.exe 会话实测——中文文件名 dir/git log 输出正确、`npm install` 全程、CRLF 文件编辑一次成功、30+ 轮工具任务无中断；A-1 附 GBK 字节流单测。

### 波 2：鲁棒性机制（A-6/A-9/A-10/A-11/A-13/A-24/A-26 + B-13/B-19/B-20/B-21/B-23/B-24，约 1-2 周）
断网/限流/超限/崩溃的自愈与诚实反馈；UI 挂起与刷屏根除。每项注明竞品机制锚点（见上文），实现按本仓事件总线/TUI 架构重写。
**验收**：断网 60s 恢复后任务继续；429 期间状态栏可见重试信号；上下文超限自动压缩重发一次成功；并发审批不挂起；busy 期间后台 RPC 失败不打断直播。

### 波 3：性能与工程债收敛（A-15/A-17/A-18/A-19/A-20/A-21 + B 级其余 + C 级，约 2 周）
**渲染架构收敛专项**（UI 审计系统性结论）：把「三写路径 × 两屏幕模式 × 三能力档」矩阵的坐标系语义（内容行 vs 终端行）、写入策略、能力档位收敛成显式不变式，给矩阵每格上测试——否则第 6 个 conhost commit 只是时间问题。具体：① moveCursorTo 恢复 viewportY 补偿（A-25）；② 虚拟光标信任模型集中治理——四个带外写入源（textInput 直写回显、forceRedraw 裸 ERASE、终端 clamp、ConPTY 吞帧首）建立「帧首锚定」统一不变式；③ React 19 脏传播的三个 PATCH(wxnodus) 全树扫描收敛为契约测试。
**发布链闭环**：A-18 + B-37/B-38——「装上能不能跑对」纳入 W6 管线自校验（版本号非 0.0.0、Node 门槛、ABI、干净机冒烟）。

### 验证总门禁（每波次收口必跑）
`npx tsc --noEmit` → 波次新增单测 → 全量 `npx vitest run`（含 known-failures gate）→ `npm run ci`（本地九命令）→ 真实 cmd.exe 手动场景（波 1 起）：启动/中文输入/bash 中文输出/编辑 CRLF/会话切换/undo/diff/断网重连。每波次收口提交，工作区现存 +9276 行未提交工作先行整理入库（分主题拆 commit）再开工，避免混流。

### 工作量与风险摘要
| 波 | 规模 | 高风险项（需额外回归面） |
|---|---|---|
| 波 0 | 8 项，全低风险 | S-2/S-3 触及权限链——跑全部权限/审批回归用例 |
| 波 1 | 9 项 | A-1 改 bash 主路径——真实 cmd + Windows Terminal 双终端实测 |
| 波 2 | 13 项 | A-10 重试语义——mock 断网/429/慢端点三类端到端 |
| 波 3 | 渲染收敛 + 发布链 | 渲染矩阵每格测试先行，否则不动写入策略 |

---

## 7. 附录：审计覆盖与方法

- **kernel 层**：47 文件精读（agent/llmStream/llmOnce/tools/permissions/applyPatch/memory/mcp/skills/plugins/market/ssrf/taskRunner/term/winSandbox/execServer/acp/a2a/subagentTypes/loopJudge/toolTrim/computer 全套/vision/voice/browser/search 等）。
- **应用/命令层**：47 文件精读（tools 管线 6 件 + application 21 子目录 + commands + domain + app + bootstrap + cli + protocol）。
- **UI 全链**：packages/wxnodus-ink 渲染核心 + src/wxnodus-ui 全部（wxGateway 2737 行、textInput、useKeyBindings、eventAdapter、flowController、presentationReducer、promptStore）；核实 src/ui/ 实为空目录。
- **基础设施**：store/migrations/infrastructure/build/forge/release/policy/compliance/scripts/vscode-ext 全量。
- **竞品差距**：6 家 × 3-5 机制，全部 file:line 锚点；wxnodus 侧逐项源码核对「无/有但不彻底」。
- **交叉验证**：PowerShell 性能税（B+D 两路）、tool_search 热重载（A+B 两路）、bash 60s 超时（A+E 两路）、字符串启发式误杀（A+E 两路）、fs_edit/hunkApply 行尾分裂（E 对照同仓 applyPatch）。
- **基线**：tsc 零报错、413 文件/3158 用例全绿——本方案全部缺陷均在该绿基线上发现，属「测试没覆盖的实战面」，非回归。

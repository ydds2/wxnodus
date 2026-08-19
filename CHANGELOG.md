# Changelog

本文件记录 wxnodus 的用户可见变更。格式参考 Keep a Changelog，版本遵循 SemVer。
内部工程/审计细节见 `docs/audit-deep.md`（§13.x 按轮实录）。

## [Unreleased]

### Added
- **vim 语法感知（2026-08-19）**：括号文本对象扫描跳过字符串内字符——`say("a (b")` 里选 `di(` 得到外层调用括号而非字符串里的假括号（转义感知的引号配对即语法边界）。
- **`/diff turn` 全文件集（2026-08-19）**：`/diff turn`（无文件参数）一次输出本会话编辑过的全部文件的「编辑快照 → 当前」聚合差异（无变更文件自动省略）；`/diff ./turn` 保留单文件路径。
- **会话浏览器展开预览（2026-08-19）**：会话列表选中历史行按 `→` 展开尾部消息预览（惰性加载、`←`/移动收起）——codex resume picker 对标。
- **用户主题（2026-08-19）**：`dataDir/themes/*.json` 放入自定义主题（`{name, base, trio}` 与内置预设同构）即被 `/theme` 识别并切换；非法文件诚实警告跳过、内置同名内置优先；未知主题名不再假报「已切换」。
- **CI Node 版本矩阵（2026-08-19）**：测试 job 按 Node 22.18 + 24.x 双版本 × 3 分片运行（engines >=22 支持面前向兼容验证）。
- **vim 引号对象边界补齐（2026-08-19）**：引号文本对象（`di"`/`vi'` 等）重写为「行内多对引号逐一配对 + 转义感知 + 最小包围候选」——`\"` 转义不再误判闭合、光标在第二对引号时正确选第二对（此前直接失效）。
- **`/diff` branch merge-base 语义（2026-08-19）**：`/diff <文件> branch [分支名]` 改为与目标分支**共同祖先**对比（只看本分支相对主干变更，主干自身新提交不再混入）；分支名缺省时自动探测默认主干（origin/HEAD，无 remote 诚实报用法）。
- **CI actions v5 + SHA 固定（2026-08-19）**：checkout/setup-node/upload/download-artifact 从浮动 v4 tag 固定到 v5 精确 SHA（防供应链漂移），并消除 Node 20 弃用告警。
- **反虚假全量审计（2026-08-19）**：四路审计（生产代码/测试质量/门禁诚实性/竞品对标）+ 全命令运行时冒烟（新增常驻测试 `tests/command-runtime-smoke.test.ts`——117 条命令全部经别名解析真实可执行、无假失败、无挂起）。修复 11 项「看似能用实则没做」：CLI `/clear` 真实归档清空（此前假「已清空」）、`/model` 无参诚实回退文案（此前空输出）、`/sessions` 删除假「打开选择器」分支、MCP 生成物占位工具诚实报错（此前 `ok:true` 回显）、配置面板 display 读真实 settings（此前 7 键写死）、PDP 决策如实标记 requiresApproval、`/fortune` 双注册去重；4 处虚假测试（无断言/恒真断言）改为真断言或诚实跳过。
- **门禁反恒绿加固（2026-08-19）**：CI gate 步骤 7 条命令逐条退出码传播（此前仅末条生效——typecheck/lint 失败可被吞）；test 分片 vitest 失败不再被 known-failures 覆盖；`check-cycles` 新增陈旧条目检测（修复环必须同步清理登记，防「登记即消音」）。
- **Kimi 式一行命令安装（2026-08-19）**：`packaging/install.ps1`（iex 兼容无参数、env 配置、TLS 1.2 兜底、GitHub API/gh CLI 双版本解析、公开资产直连 + gh 私有回退、PK 签名校验、代理 HTTP/2 兼容）；`scripts/publish-release.mjs` 一键发布；v3.1.0 已发布私有 Release——授权成员 `gh api repos/ydds2/wxnodus/contents/packaging/install.ps1 -H "Accept: application/vnd.github.raw" | iex` 一行装，转公开后同脚本切 `irm … | iex`。
- **TUI 风险确认（2026-08-19）**：danger 级斜杠命令（/webhook add、/gateway、/acp server 等）在 TUI 直输时强制审批桥确认（与工具审批同面板、同脱敏）；`-p` 直输与 AI 通道维持既有裁决链。
- **配置面板（2026-08-19）**：`/config` 在 TUI 打开交互面板——真实 settings 清单（密钥掩码、未知键警示）、↑↓ 导航、布尔键 Enter 一键切换；非布尔键指引 `/config set`。
- **一键安装（生产级阶段 1 分发闭环，2026-08-19）**：自包含 zip 安装包内置 `install.bat` 双击向导（解压即装：Node 18+ 预检含国内镜像指引、PATH 自动注册、`wxnodus.cmd` 命令、数据目录 `%LOCALAPPDATA%\wxnodus`、sha256 全量校验、原子切换 + journal 卸载）；`packaging/install-bootstrap.ps1` 三源下载（本地/URL https 强制/私有 GitHub Release 走 gh，Token 不落盘）；首启四步清单（模型/密钥/代理/离线）+ GitHub 连通探测；`/update` 识别 zip 渠道并可探测远程版本；CI 新增 install-smoke job（真实安装→运行→卸载闭环）。
- **vim 模态编辑（波 3 ②，2026-08-18）**：`/vim` 开启输入框 NORMAL/INSERT 双态（h/j/k/l、w/b/e、0/$/^、dd/yy/cc、d/c/y+移动、p/P、u 撤销、`.` 重复、双击 Esc 清空）。
- **完整 diff 查看 + 逐 hunk 回滚（波 3 ③，2026-08-18）**：`/diff <文件>` 查看快照与当前内容的完整差异；`/diff <文件> revert <hunk序号>` 只回滚选中的那处变更（自动留快照，`/undo fs restore` 可再滚回）——六家竞品均无的逐 hunk 操作。
- **跨会话语义召回（波 3 ⑪，2026-08-18）**：`/hole --all <关键词>` 本地向量+全文检索所有会话的记忆（数据不出机——六家竞品均无本地跨会话向量召回）。
- **@补全（波 2 ②，2026-08-18）**：输入 `@` 弹出文件/子代理双源补全（分层排序：精确文件名优先，常用项随接受次数前移）；斜杠补全接受即执行（Enter 双语义）；`@文件#L1-L5` 提及只取行区间。
- **词级 inline diff + hunk 跳转（波 2 ③，2026-08-18）**：diff 回显升级词级红绿分段（相似度过低自动整行降级）；分页器（回滚 diff 等）按 `[`/`]` 在 hunk 间跳转。
- **离线自动就绪 + 记忆收件箱（波 2 ⑪，2026-08-18）**：`/offline on` 切完自动下载缺失模型（下载进度实时显示在状态行）；`/config set memoryInbox true` 后 AI 写入的记忆先进收件箱待审——`/memory inbox list|apply|discard|undo` 批准生效/丢弃/按记录撤销（可审可退）。
- **diff 回显组件 + 图片模型输入（波 1 ③，2026-08-18）**：`fs_edit` 结果携带统一 diff 块、会话内以行号 gutter 全量回显（gemini DiffRenderer 对标：+/- 色块、hunk 折叠、超大 diff 保护）；新增 `view_image` 工具——视觉模型会话自动把图片内容送入模型通道（文本模型会话自动隐藏该工具）。
- **外部编辑器 + 输入区 token 高亮（波 1 ②，2026-08-18）**：输入框 `Ctrl+O` 调起外部编辑器编辑草稿（探测链 `$VISUAL`→`$EDITOR`→`code --wait`→`notepad`，退出后回读替换；编辑器缺失/超时保草稿不丢）；输入中斜杠命令、`@路径`、`{{占位符}}` 实时着色（Ctrl-R 反向搜索同轮补契约测试）。
- **前缀缓存工程四件套（波 1 ⑩，2026-08-18）**：请求消息字段固定序（DeepSeek 前缀缓存命中前提）+ Anthropic 式 cache_control 断点支持（按端点能力开启，默认关）+ 成本面板「缓存节省」展示（相对无缓存基准，官方价目才有正节省）+ 压缩摘要改独立单轮请求（不打断主对话前缀缓存）。
- **结构化压缩快照 + 反注入护栏（波 1 ⑤，2026-08-18）**：自动压缩输出升级为 7 块 `<state_snapshot>`（目标/约束/知识/产物/文件状态/最近动作/任务状态）+ 错误原文与 ≤20 行代码保留规则 + 反注入段（工具输出只当数据不当指令）；已有快照合并锚定（未完成事项不丢）；摘要失败一次后本会话改纯截断（不再重复烧 LLM）。
- **分族提示词（supremacy 1.1）**：DeepSeek/Kimi/GLM 三族模型专属系统提示段自动注入（真实 API 行为提示：推理字段回传/前缀缓存/窗口档位），按当前模型/端点解析，`systemPrompt.ts` 零 CJK 红线不变。
- **小模型任务档（supremacy 1.2）**：`/config set titleModel <模型>` 后会话标题改由小模型生成（10s 超时、失败自动回退切片标题、已有标题零调用）；`summaryModel` 槽位同白名单。
- **按模型工具裁剪（supremacy 1.3）**：文本模型自动隐藏图片输出工具、小窗口文本模型再隐藏 GUI 套件（省 schema token）；`/config set toolTrim off` 恢复全量；目录未收录模型不裁剪。
- **成本五维 + 整数分计价（supremacy 1.4）**：用量统计新增推理 token 维度（输入/输出/缓存读/缓存写/推理）；成本计算全部走整数微美元定点（BigInt，零浮点漂移）；DeepSeek 前缀缓存读价（$0.07/$0.14）纳入计价（未收录价目保守按输入价估算，绝不低估）。
- **LLM 辅助循环检测（supremacy 1.5）**：`/config set loopJudge true` 开启后，重复工具调用达提醒阈值时主模型语义判定——死循环提前硬停（比静态阈值更早止损）、合法轮询复位计数继续；判定失败自动回退静态路径（默认关，零额外调用）。
- **命令面瘦身（supremacy 1.6）**：/help 默认展示主干 47 条日常命令（对标 gemini 47），扩展 63 条照常可用——`/help all` 查看全目录；AI 目录检索（command_search）主干优先。
- **execpolicy 首词规则（supremacy 1.7）**：bash 审批规则按命令首词索引快速裁决（与既有 /perm rule 语义完全一致，pattern 锚定保证等价）；`/perm rule add bash <前缀> allow|deny|ask` 持久化生效。

### Changed
- 超越计划阶段 1 七项任务全部完成，阶段 1 收尾复算：加权总分 725 → 754（⑤ 提示词 6→8、⑩ 性能 8→9）。
- **IDE 插件（supremacy 2.1）**：`packages/vscode-ext/`——VS Code 伴侣插件（`--wire` 桥接 + 对话面板 + 审批/澄清/密码原生模态），本地 vsix 可装（marketplace 上架需后续发布通道）；连带修复 wire 协议审批广播缺口（`approval.request` 等四事件现真实广播 request_id）。
- **远程执行 ssh 通道（supremacy 2.2）**：`/remote ssh://user@host` 设置目标后 bash 工具经 ssh 转发执行（输出恒带「远端未沙盒」诚实标注）。
- **用户文档三件套（supremacy 2.3）**：`docs/getting-started.md` / `docs/troubleshooting.md` / `docs/examples.md` + README 链接（命令-注册表对账测试）。
- **--serve 协议加固（supremacy 2.5）**：`sessions` RPC 返回结构化会话列表（首问摘要/消息数/分支数/血缘，与 `/sessions --json` 同源）；`/events` SSE 新增 `session.changed` 会话变更广播（事件驱动刷新，无轮询）；`docs/serve-protocol.md` 桌面端契约。
- **GitHub Actions CI 备件（supremacy 2.4）**：`.github/workflows/ci.yml`（npm run ci 全门禁 + vscode-ext 独立门禁 + vsix 工件）——本地校验通过，推送待仓库 remote 配置。
- **键位配置层（supremacy 3.3）**：`/config set keymap '{"pagerClose":"ctrl+x"}'` 式 JSON 覆盖键位（pager 关闭/导航热生效；非法配置自动回退默认，绝不崩 UI）——诚实口径：不宣称伪 vim。
- **diff hunk 折叠（supremacy 3.3）**：超长 diff hunk 默认折叠（只显 @@ 头 + 「…N 行已折叠」），补丁完整保留可经 apply_patch 应用。
- **工程门禁扩展（supremacy 3.5）**：`npm run ci` 七步 → 九步——新增结构性 lint（debugger/内核层 exit 红线）与循环依赖门禁（madge + allowlist，未知新环即失败）；修复 2 处运行时循环依赖（db→memory 再导出环、ssrf↔outbound 互指环）。`npm run bench` 微基准（四项基线）。
- **Windows 双态沙盒提权分支（supremacy 3.2）**：管理员环境运行时自动切换受限令牌（禁用 Administrators/LocalSystem + Medium IL，L0 只读）——标准用户仍走已实测校准的 Low IL 路径；探测如实报告双态（提权分支实测待管理员环境）。
- **阶段 3 收尾复评（supremacy 3.6）**：加权总分 754 → 790（② 输入 5→6、③ diff 4→5、⑦ 场景 8→9、⑨ 工程 7→8）——距 gemini 812 差 22；超越 codex（≥870）仍待 git remote（发布/市场/CI 绿）与管理员环境实测。
- **④⑤ 补轮（supremacy 补轮）**：子代理分型（delegate kind=explore/coder/review——只读型白名单）+ 结构化输出（/build 规格化请求 json_object，宽容解析兜底）+ 工具 schema 规范排序（前缀缓存跨重启稳定）。复算 790 → **814**：反超 gemini 升至第 3/7，①④⑪ 三维度七家第一。
- **长驻 exec-server（S-04 完整版）**：`/remote server`（HMAC 派生 token + 远端 OS 沙盒 profile 复用，不可用即拒绝绝不降级）+ `/remote connect` 接入——bash 工具与 `/remote run` 优先走 exec-server（远端可沙盒），回退 ssh 通道（未沙盒诚实标注）。复算 814 → **825**（⑦ 满格）。
- **双态沙盒提权分支真机实测修复（两轮）**：管理员终端实测暴露 v3 报 87（SidsToDisable 裸 SID 指针 + LocalSystem 不在令牌组）→ v4（TokenGroups 只禁用存在 SID、Attributes=0）；v4 探测 OK 但启动报 1314（受限令牌经令牌复制失去「调用方令牌受限版」豁免）→ v5（从本进程令牌直接构建 + SeIncreaseQuotaPrivilege + 探测加真实进程启动冒烟——OK-ELEVATED=全链路实测）；`scripts/probe-elevated.cmd` 重写为 CRLF + 纯 ASCII（修复双击即退）+ 失败路径可见化。
- **双态沙盒提权分支实测收官（⑥ 9→10）**：管理员终端第三轮全绿——OK-ELEVATED（含进程启动冒烟）+ L0 拒写 + L1 可写，Windows 双态沙盒全链路真机验证；复算 825 → **835**（第 3/7，⑥=10 七家第一，第一维度增至四项）。
- **第三方插件接收（S-02 接收侧）**：`/plugin install <目录|本地 zip|https URL>`——SSRF 防护下载（复用 /download 逐跳授权）、包结构校验、`--sha256` 完整性校验（未提供时诚实提示）、staging 原子落位、启用失败自动回滚；装后自动走 modern 生命周期 enable（沙箱门/owned scope）。
- **远程 CI 首绿（⑨ 8→9）**：GitHub Actions 十五轮收官全绿（9 命令门禁 + 插件独立门禁 + vsix 工件）——11 类「本地绿≠远程绿」缺陷全修（junction 临时目录、locale/Node 版本漂移、Defender 进程扫描、空目录 git 不跟踪、Server 2025 真 sudo 挂死诚实拒绝等）；复算 835 → **843**，**反超 opencode 升至第 2/7**。
- **git remote 配置（发布通道解锁）**：origin → github.com/ydds2/wxnodus（私人仓库），master 全史推送；公开前清理 drill 空库与夹具构建产物出库（.gitignore 补 `.wxnodus/*.db`）。winget/scoop 上架仍需公开下载 URL（私人仓库资产不可公开拉取）。
- **内部测试分发（B 方案）**：W6 发布管线首跑——wxnodus-3.1.0.zip（自校验安装包：manifest 全量 sha256 + 安装前校验 install.ps1，可卸载）上传私有 GitHub Release **v3.1.0-rc.1**（仅授权成员可下载）；顺带修复生产 dist 泄漏 test.tsx（vitest/ink-testing-library 混入安装闭包，被打包门禁拦截）。

## [3.1.0] - 2026-08-18

### Added
- **/model 开放兼容**：模型选择器内「＋ 添加自定义接口」四步表单，接入任意 OpenAI 兼容端点；`/model add` / `/model set-key` / `/model key` 子命令（`/key` 彻底移除，全部密钥操作并入 /model）。
- **stdin 管道模式**：`cat 文件 | wxnodus -p "指令"`（无 -p 时 stdin 即提问；1MB 封顶、50k 字超限诚实标注）。
- **--stream-json**：`--wire` 事件流别名（gemini/kimi 命名对齐）；`docs/wire-protocol.md` 完整 schema + `examples/wire-events.mjs`、`examples/wire-approval-responder.mjs` 可运行示例。
- **ACP 接入文档**：`docs/acp-zed-jetbrains.md`（`wxnodus -p "/acp server"` 零代码接入 Zed/JetBrains，协议面方法表 + printf 自测）。
- **`npm run ci` 一键本地门禁**：typecheck×2 + 全量测试 + known-failures + 发现/覆盖检查 + build，七步全绿。
- **`/update` 更新检查**：安装渠道探测（git/npm/winget/scoop）+ 版本与仓库状态如实报告（详见 README 协议与集成节）。
- **版本单一事实源**：`WXNODUS_VERSION` 读 package.json（8 处接线），`--version`/banner/ACP 等恒一致。
- **发布打包**：`packaging/winget` + `packaging/scoop` manifest 生成器（`npm run gen:manifests`，含 installer zip sha256 校验）。
- **OS 内核沙盒（Windows）**：`/sandbox os L0|L1|L2|L3|off|status|probe`——L0=Low IL 只读+断网，L1=Job 遏制+断网，L2=Job+限速 10KB/s，L3=Job 遏制（防孤儿）；bash 命令经沙盒执行，能力探测失败诚实降级并提示（绝不假装沙盒；标准用户可用，实测校准）。
- **apply_patch 结构化补丁**：一次调用改多个文件（Add/Update/Delete/Move + `@@` 锚定，codex 语法子集）；三级匹配容错 + 全量校验后才落盘（失败绝不写一半，逐块报错带相似行提示）+ /undo fs 可回滚。
- **并行工具调度**：同回合纯只读工具批并行执行（含写工具的批次整批串行保证顺序与审批链）。
- **工具输出工程**：超 50KB/2000 行输出自动落盘 + 头尾预览 + 续读路径（bash 完整输出不丢尾）；早前工具输出掩码（上下文保护窗）；蒸馏开关（`/config set toolDistill true`，默认关）。
- **LSP 集成**：`lsp_diagnostics` / `lsp_hover` / `lsp_definition` 三工具；`settings.lsp.servers` 可配任意语言服务器，内置 typescript-language-server 探测（缺失时诚实给安装指引）。
- **硬编码清零**：压缩阈值/包裹面/轮次上限等全部改为模型真实窗口派生 + settings 可覆盖（`maxTurns` / `ctxOutputReserve` / `untrustedWrapLimit` / `toolOutput*` 等 12 个新配置键）。
- **循环检测分级**：重复工具调用先注入「换策略提醒」再硬停（不再 3 次直停误杀合法轮询）；签名并入输出指纹；goal 模式相同结论空转自动终止——阈值全部 settings 可调（`loopRemindAt`/`loopHardStopAt`/`chantStopAt`/`maxConsecutiveFail`/`retryDelayMs`/`maxGoalRounds`/`maxSubagentDepth`/`toolCacheSize`/`fsReadLimit`/`bashOutputCap` 等）。
- **会话血缘与结构化会话列表**（桌面端数据面）：`/fork` 记录 `forked_from_id` 血缘 + `/fork lineage` 祖先链；`/sessions --json` 结构化列表（首问摘要/消息数/分支数/血缘），与 serve 网关共用单一数据出口。
- **approve_for_session 会话授权**：`settings.approveForSession=true` 后批准一次，本会话内同键自动放行（持久化，跨重启生效）；`/perm session-allow|deny|revoke|list` 管理；deny 级联直拒、红线永远优先。
- **/share 离线加密打包分享**：`/share export|import`——单文件 `.wxnshare`（会话全量 + sha256 防篡改；`--encrypt` AES-256-GCM 口令加密，数据不出机）。另新增 `docs/defect-register-2026.md`（缺陷寄存器全表）与 `docs/ide-remote-share-roadmap-2026.md`（IDE 插件/远程执行路线图）。
- **OS 沙盒三平台门面**：Linux（bubblewrap：L0 只读+断网/L1 断网/L3 遏制）与 macOS（Seatbelt profile）实现 + `/sandbox os status` 按平台探测——诚实口径：L2 限速需 root/无 Seatbelt 原语故降级；mac/Linux 实机校准完成前不宣称三平台满分（Windows 路径已实测校准）。

### Changed
- **/build 单通道化**：AI 规格化成为唯一编译通道（规则脑删除后）；无 key 明确报错引导 `/model set-key`，绝不假装编译。
- **README 大幅瘦身**（~157 → ~75 行）：去夸大宣传字样，保留诚实背书与契约表；新增「协议与集成」小节。
- **/sandbox 双层语义**：`/sandbox L0-L3` = 策略层权限模式（原语义）；`/sandbox os ...` = 执行层真实 OS 沙盒。
- **评分文档复评**：11 维加权 6.14 → 7.25（第 4/7 名，`docs/cli-deep-analysis-score-2026.md` §0.1 逐维理由）。

### Fixed
- **image_url 400 终极闸门**：`buildChatRequest` 装配层第四道防御——纯文本模型请求体中任何漏网 `image_url` parts 序列化前一律文本化（对标 deepseek-v4-pro `unknown variant image_url` 事故）。
- **/key 残留清零**：13 处旧 `/key set` 指引统一为 `/model set-key`（状态/体检/档案/learn/fdr/encrypt/ACP）。
- **typecheck:tests 归零**：修复 3 处既有测试类型错误（UiaElement/PromptZone/llmStream 失败变体窄化）。
- **向导白名单双注册**：新 CLI flag 须在首启向导同步注册（--stream-json 曾被 CONFIG_UNKNOWN_FLAG 拒绝，已修复并留防再犯注释）。
- **诚实截断**：工具输出/召回注入/面板摘要统一 `labelTruncate` 口径（绝不静默截断）；fs_edit 行号换算 O(n+k·log n)；taskRunner 日志刷盘后置终态竞态根治。

### Removed
- **规则脑**（对话 ruleBrain + /build 确定性规格引擎）：无 key 时不再有确定性假装输出，一律明确引导配置。
- **vim 薄层死代码**（未接线的 41 行纯函数）。

## [3.0.0] - 2026-08（基线）

Windows 本地 AI agent CLI 首个完整版本：黑洞引擎三层记忆 + 需求编译 /build + 模型接入 + 44 工具 + 安全红线（权限模式/AES-256-GCM 密钥加密）。

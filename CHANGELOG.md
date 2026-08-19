# Changelog

本文件记录 wxnodus 的用户可见变更。格式参考 Keep a Changelog，版本遵循 SemVer。
内部工程/审计细节见 `docs/audit-deep.md`（§13.x 按轮实录）。

## [Unreleased]

### Changed
- **首页像素徽标 + 紫金黑主题（2026-08-19）**：撤掉旧的宽字符 ASCII 横幅与带框英雄面板（cmd 经典字体下错位/缺字形、且与 mockup 差距大）——首页改为**居中高精度像素徽标**：黑洞环（椭圆距离场着色器逐格计算、左上高光→右下暗部）＋ WXNODUS 像素字标（5×5 手写字形、金紫交替、O 中心金核奇点）；每字符格 = 一个背景色像素，零字形依赖，任意终端宽度/字体下都精确对齐。会话面板去框扁平化（模型·版本·目录居中单行、可点开选择器，分区折叠不变）。默认主题整体切换为**紫金黑**（深色：紫 #a78bfa × 金 #f0c95a × 纯黑基底；浅色变体：深紫 #6d28d9 × 琥珀金 #b45309 白底）；mockup（`docs/ui-mockup-2026.html`）配色同步。

### Fixed
- **滚动强制拉底（2026-08-19）**：用户向上翻看时不再被强制拉回底部——根因：手动滚动断 sticky 后，虚拟化 clamp 追赶期间 scrollTop 可能瞬间回到 max，下一帧内容增长即被渲染器误判「用户回到底部」而重贴底（流式输出中翻看被反复拉底）。修复：渲染器加**手动滚动重贴底宽限**（`STICKY_REPIN_GRACE_MS=1200ms`，scrollTo/scrollBy 写入 `lastManualScrollAt`，宽限期内抑制位置跟随与 sticky 恢复；宽限过后用户仍停留在底部则自然恢复跟随）。新增回归测试 `packages/wxnodus-ink/src/ink/scroll-sticky-grace.test.ts`（断 sticky 位置保持 / 宽限抑制 / 显式 scrollToBottom 仍生效，3 条全绿）。
- **输出降噪（2026-08-19）**：① 状态栏 📊 点击轮换 token 区间不再向 transcript 注入「token 区间已切换」sys 消息（反馈仅在状态栏段内体现，对话流不再被状态噪声刷屏）；② 工具调用默认从逐条展开改为**折叠单行摘要「▾ Tool calls (N)」**（点击展开逐条，对标同类 CLI 紧凑输出；`/details tools expanded` 或 config 可恢复展开）；③ **Todo 面板默认折叠**为单行「▸ Todo (N/M)」（点击展开逐条——长任务几十条 todo 不再刷屏）；④ **工具调用标签头尾截取**（edgePreview 头 24/尾 20 字符）替代 64 字符全文截断——PowerShell 长单行命令不再整串入行撑爆工具卡片（长命令行首尾信息保留、行宽有界）。
- **`-p` 非交互模式流式输出（2026-08-19）**：此前 `wxnodus -p` 只在 agent.run 结束后一次性打印全文——长任务空屏干等分钟级无反馈；现订阅 agent.token 逐 token 实时写 stdout（对齐 claude -p / gemini -p / codex exec）；`--json` 模式仍输出完整 JSON 对象（不做流式）；`[steer]` 内部干预标记不进 stdout；无流式 token 到达时回退旧路径打印终稿。TUI 流式（16ms 批量渲染）原有链路不变。

- **输出格式全面替换（2026-08-19，对标 Claude Code / Codex / Gemini CLI 同族）**：消息与工具渲染彻底改版——① 用户消息 = dim「❯ 文本」（去底色块/label 着色）；助手 = 纯 markdown（去 Response 徽标与 └─ 标记）；系统/命令输出 = dim 文本。② 工具调用 = 单行 dim「• Name(短参)」（进行中旋转帧）＋ dim 缩进结果（≤6 行截断），失败红色；去边框卡片、✓/✗ 装饰、时长、chevron 折叠（新组件 `peerTrail.tsx`，旧 ToolTrail 停用）。③ Todo 面板不再渲染（清单不占对话流）。④ 移除回合分区展示（TurnSections 模块删除）与吸积盘轮次分隔线。⑤ 工具结果 diff 行内 +/- 着色（无边框）。测试同步改写（ui-tooltrail 全量重写为 PeerToolTrail 契约；Response 徽标断言移除），2884 全绿。

- **输出格式更完善（2026-08-19，同族格式收口）**：① 工具结果由单行塌缩改为**多行 dim 展示**（≤6 行、行宽有界、超行省略提示）；② 工具调用行前缀换 **⏺**（Claude Code 同款，cmd 档自动降级 `•`）；③ **回合结果底行**（approved (auto)/denied 等——拒绝类红色）；④ **finalDetails 推理折叠行 + token 摘要行**（`▸ 推理 (N tokens)` 点击展开 dim 全文 ≤4000 字符、`⏺ 2.5k tokens` 尾行——对标 Claude Code 回合尾部用量）；⑤ 空工具结果文案 `(no output)`。测试 +4（outcome 底行/多行结果结构/推理折叠/token 摘要/空轨迹），2888 全绿。

- **输出格式体系收口（2026-08-19，docs/output-format-spec-2026.md）**：完整体系文档落地（16 表面总表 + 逐表面规范示例 + 实现地图 + 反模式清单）；实现面补齐最后三处边框——① 斜杠命令输出去边框：`lines()` 双 helper（handlers.ts/handlersExt.ts）统一为「标题行 + 两格缩进条目」纯文本（约 40 个命令一次性去框，CJK 宽度对齐逻辑随之删除）；② 助手消息代码块去边框（dim 语言标签行 + 行内语法着色，对标 Claude Code）；③ 对话流内 Panel（/status 结构化结果）去边框。2888 全绿。

- **结构稳定性加固（2026-08-19，「输出卡死 cmd」三面排查修复）**：① `-p` 模式补上 QuickEdit 关闭引导（此前仅 TUI 有——classic cmd 点击窗口即进入选择模式冻结控制台的经典卡死根因）；② `-p` 输出超宽长行按终端宽度软换行（模型输出压缩代码等巨长单行直写 conhost 会卡死；仅 TTY 换行、管道保持原始字节）；③ cmd/conhost 档流式渲染节流：非 full 字形档批量间隔 16ms→80ms（帧数降 5×，现代终端不变）。TUI 渲染层本就由 VirtualScreen 宽度钳制（终端收不到超宽行）、DECSTBM 已按 conhost 能力门控——核查确认无新增风险面。2888 全绿。

- **覆盖面与 mockup 一致性审计（2026-08-19）**：① 命令面 117 条全量核对——桌面调查报告 19 个能力家族全部覆盖（含此前缺位的会话分享 `/share` `/export`）；② mockup 20 场景全部有真实实现；③ 补齐唯一缺口 **Ctrl+T 明暗切换**（mockup 约定、实现缺失——运行时互换紫金黑/浅色基底，注册表同步登记）；④ mockup HTML 同步当前输出格式体系（默认/流式/推理/工具四场景改为 ❯ 用户行 + ⏺ 工具轨迹 + 推理折叠 + tokens 尾行的 peer 格式；修复主题画廊 wxnodus 预设残留旧蓝色）。2888 全绿。

- **报错可见性（2026-08-19）**：① 心跳诊断探针——`WXNODUS_HEARTBEAT=1` 启动时每 2s 向 `logs/heartbeat-<日期>.log` 写心跳（默认关闭；cmd 冻结类卡死不产生 JS 异常，error-*.log 看不到——心跳断档点即卡死发生点）；② 新增 `scripts/watch-wxnodus.mjs` 实时监听器（每 3s 扫描 error-*.log / heartbeat-*.log 并打印增量）。

- **cmd 卡死结构性根因修复（2026-08-19）**：定位到渲染器在经典 conhost 上**逐 cell 光标定位 + 单字符写入**——每帧数百次 CSI+write 系统调用（现代终端快、conhost 慢一个数量级），流式输出必然积压到「卡死」。修复：新增 `isClassicConhost()` 检测（win32 且无 WT_SESSION/TERM_PROGRAM）→ **批量行渲染路径**（每行一次定位 + 整行单次写入 + CR/LF 换行，帧写入数从 ~宽×高 降到 ~高；整行重写天然覆盖删除/清屏/新增行）。diff 契约测试模拟现代终端隔离，新增 conhost 批量路径契约测试。2889 全绿。

- **会话/工具/错误三修复（2026-08-19，用户实战报告）**：① **会话切换 SESSION_START_INVALID**——capabilities 空数组实为合法状态（早期构建会落盘空快照），原校验 length>0 误拒历史工件导致切换失败；改为允许空数组（完整性由 sha256 绑定兜底）+ 服务层自愈（字段级失败按当前端口重生成一次，哈希不匹配仍 fail-closed）；② **工具参数 JSON 直显**——Args 块整串 `{"query":...}` 改为提取关键字段人类化单行（formatToolCall 与 verboseToolBlock 双路径）；③ **模型调用失败刷屏**——appendMessage 统一去重（「模型调用失败：fetch failed」连续重复只显示一条，含 sys/终稿双通道）。2889 全绿。

- **conhost 批量渲染样式错乱/闪屏修复（2026-08-19）**：上一版批量行渲染把空格写满至最后一列——写满末列触发 conhost pending-wrap 行漂移（样式错乱），全宽刷屏造成闪屏。修复：末列永不写；行尾无样式纯空格修剪（有背景色行如状态栏完整保留）；收缩清屏行例外整行覆盖。2889 全绿。

- **conhost 渲染改为「最小重绘」（2026-08-19，闪屏/状态栏覆盖修复）**：整屏行重写方案弃用（conhost 逐行绘制撕裂=闪屏、大范围写入行漂移=状态栏被覆盖）——改为**逐脏行段写入**：只重写有变化的行、只写该行变化区间（一次 CUP 定位 + 段内联样式写入），未变行零写入；末列保护保留；offscreen 变化仍走整屏重置。写入次数保持 ~脏行数（防卡死），重绘面积回到 diff 级（防闪屏/覆盖）。契约测试同步。2889 全绿。

## [3.2.0] - 2026-08-20

（自 3.1.0 起：UI 重构 P0-P2 全谱 + 增强批 + 默认皮肤极简现代 + 代码卫生）

### Changed
- **代码卫生（2026-08-20）**：仓库瘦身（移除入库的 drill 数据库/外部插件状态/184 个 UIA fixture 编译产物/沙盒探针残留，根目录分析文档归位 docs/，磁盘垃圾安全子集清零——data/ 用户数据与竞品研究内容不删）；移除死模块 lib/editorLaunch；22 个无头模块补职责注释；浮层重绘定时器合并与状态栏热力格缓存；21 项依赖核查全部在役。详见 audit §14.00。
- **默认皮肤极简现代（2026-08-20）**：按已选定的 mockup v3 风格重做默认主题——VS Code 风（深色底 + 单一蓝强调 + 1px 细分割线 + 扁平面板）；浅色基底同族；`/theme` 预设与语义色契约不变，选过的自定义主题不受影响。
- **UI 重构 P0 落地（2026-08-19）**：按 `docs/ui-redesign-plan-2026.md` 完成骨架统一——① **栈式浮层**：17 布尔位浮层态重构为 stack+inline（z 序=栈序、Esc 统一出栈）；面板（配置/模型/skills/plugins）与选择器（会话/目录/历史/命令面板）改为**互斥组**（不再同时开两个面板）；skills/plugins 面板补上 Esc 关闭。② **键位注册表**：`/help keys` 在 TUI 内由注册表单一事实源生成完整键位总览（global/prompt/vim/pager/panel 五层分组；Ctrl+P 新增为命令面板别名，与 Ctrl+K 同动作）；注册期同层冲突直接报错。③ **状态栏组件化**：1031 行巨组件拆分为 statusBar/floating/转录 chrome 三个模块（行为零变化）。详见 `docs/ui-refactor-exec-2026.md` 与 audit §13.95。
- **UI 重构 P1 落地（2026-08-20）**：① **双触发裁决**：Ctrl+O 唯一化为模型选择器（外部编辑器保留 Ctrl+G/Alt+G——此前两键双触发）、Ctrl+R 在 vim NORMAL 下让位 redo（此前 redo 与历史搜索同时触发）。② **status/doctor 结构化工作台**：`/status` `/doctor` 不再落文本翻页器——TUI 打开结构化工作台（分节 kv + 语义着色），`w` 键切换状态⇄体检，Esc 统一关闭；体检项为真实检测（数据库完整性/记忆层/全文索引/密钥解密/当前模型，异常如实标红）。③ **会话浏览器搜索**：会话列表按 `/` 进入过滤态，键入即筛可恢复会话（命中计数实时显示）。④ **Esc 栈顶门控**：浮层嵌套时 Esc 只作用于最顶层——修复「一次 Esc 弹两层」与目录选择器/模型选择器内部状态被静默改动。⑤ **面板右分栏**：配置/模型/skills/plugins 面板不再浮层遮住对话——宽窗（≥80 列）渲染为右侧分栏（转录流自动收窄），小窗自动降级为全宽块；状态栏新增 ⚙ 配置入口，会话/模型/目录/余额/语音全部可点击直达（零记忆三连操作达成）。⑥ **增强批**：命令面板「最近动作」（↺ 置顶区，Enter 重放，上限 8 去重提顶）；工作台 w 键三标签统一（status → doctor → sessions，`/sessions` 开工作台标签、Ctrl+X 快切浮层不变）；密度档 compact/cozy（`settings.tuiDensity` 热生效）。详见 audit §13.96–13.99。

### Added
- **`/encrypt` 真实文件加解密（2026-08-19）**：此前仅凭证状态展示——现真实实现：`/encrypt file <路径> --key <口令>` 用 scrypt + AES-256-GCM 加密为 `<路径>.enc`（篡改/口令错即诚实拒绝）；`/encrypt decrypt` 反向还原；口令不落盘不回显。
- **`/render` 真实 Markdown 渲染（2026-08-19）**：此前仅行级前缀变换——现复用与 TUI 同源的成熟解析器真实渲染标题/列表/代码块/表格（列对齐）/引用/公式/分隔线。
- **diff 文件树视图（2026-08-19）**：diff 查看器按 `t` 切换文件树索引（↑↓ 选文件、Enter 跳转到该文件的分节、t 返回 diff）——opencode 树面板的对等形态。
- **/rollback 真实 diff（2026-08-19）**：回滚预览从「两端对贴」改为行级 +/- 真实 diff。
- **diff 多文件视图 + mark-reviewed（2026-08-19）**：`/diff`（或 `/diff turn`）在 TUI 打开多文件结构化查看器（按文件分节 + `[/]` hunk 跳转 + `r` 回滚当前文件当前 hunk）；`m` 键标记 hunk 已审（内容指纹持久化，变更即失效、✓ 标记展示）——opencode mark-reviewed 对标。
- **system 主题（2026-08-19）**：`/theme system` 探测终端前景/背景色（OSC 10/11 查询）实时生成主题——背景亮度自动定明暗基底、前景作主色；conhost 不支持时如实提示不可用（Windows Terminal/xterm/kitty 可用）。
- **`/build` 复杂需求构造能力（2026-08-19）**：复杂/跨域需求不再坍缩进固定模板——AI 规格化自动分解为模块 DAG（≤8 模块 × ≤12 文件），逐模块生成引擎按拓扑序**一次一模块**有界生成（单次输出上限不再约束项目总规模）；路径白名单/尺寸/入口契约三重校验、失败诚实报错不落半成品；进度流逐模块实时汇报；`--dry-run` 预览模块分解与文件清单；简单需求仍走成熟模具模板（零回退变化）。
- **vim 语法感知（2026-08-19）**：括号文本对象扫描跳过字符串内字符——`say("a (b")` 里选 `di(` 得到外层调用括号而非字符串里的假括号（转义感知的引号配对即语法边界）。
- **`/diff turn` 全文件集（2026-08-19）**：`/diff turn`（无文件参数）一次输出本会话编辑过的全部文件的「编辑快照 → 当前」聚合差异（无变更文件自动省略）；`/diff ./turn` 保留单文件路径。
- **会话浏览器展开预览（2026-08-19）**：会话列表选中历史行按 `→` 展开尾部消息预览（惰性加载、`←`/移动收起）——codex resume picker 对标。
- **用户主题（2026-08-19）**：`dataDir/themes/*.json` 放入自定义主题（`{name, base, trio}` 与内置预设同构）即被 `/theme` 识别并切换；非法文件诚实警告跳过、内置同名内置优先；未知主题名不再假报「已切换」。
- **Node 支持面如实收紧（2026-08-19）**：CI 矩阵实验（22.18 + 24.x）实测 Node 24 原生模块 ABI 崩溃（better-sqlite3/sqlite-vec 预编译不兼容）——`engines` 收紧为 `>=22 <24`，CI 维持 Node 22.18 单版本；升原生依赖后重开多版本矩阵（如实入档，不假绿）。
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

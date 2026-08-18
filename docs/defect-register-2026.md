# 缺陷寄存器（2026-08-18，终版盘点）

> 单一事实源：wxnodus 相对 6 家竞品（codex/gemini-cli/opencode/kimi-cli/crush/aider）的**剩余缺陷全表**。
> 状态列：✅ 已落地（commit 可溯）｜◐ 部分落地｜⏳ 未做｜🚫 不可为（缺外部依赖，注明阻塞）。
> 严重度定义：S=用户视角不成立/安全边界；A=能力面子集；B=体验；C=工程债。
> 评分联动：`docs/cli-deep-analysis-score-2026.md`（当前 7.25，第 4/7）；每缺陷标注影响的评分维度与提分预估。

## S 级

| ID | 缺陷 | 对标 | 阻塞 | 影响维度/提分 | 状态 |
|---|---|---|---|---|---|
| S-01 | 真实分发（winget/scoop 上架、installer、更新通道） | opencode 9 渠道 | 已配 remote ✅——剩「公开下载 URL」（私人仓库 release 资产不可公开拉取） | ⑧ 5→6（+9） | ◐ 模板/生成器已备（`packaging/`）；**内部测试分发已落地**（私有 GitHub Release v3.1.0-rc.1，W6 管线自校验安装包 + 门禁拦截 test.tsx 泄漏缺陷，audit §13.70）；公开上架待「转公开」决策后 |
| S-02 | 插件市场/远端技能安装 | codex/opencode 市场 | 公开托管已暂缓（用户决策：第三方接收即可） | ⑧ 6→7（+9） | ◐ **接收侧落地**：`/plugin install <目录|zip|https URL>`（SSRF 防护下载 + 包结构校验 + --sha256 完整性 + staging 原子落位 + 启用失败回滚，10 单测）——第三方插件可装；自建市场托管（可浏览可检索的中央目录）仍无 |
| S-03 | IDE 插件 | gemini companion/codex vscode | 无（协议已备） | ⑦ 8→9（+11） | ◐ **落地**：`packages/vscode-ext`（--wire 桥接 + webview 面板 + 审批/澄清/密码原生模态），typecheck+4 单测+esbuild+vsce 本地 vsix 全绿（supremacy 2.1）；marketplace 上架仍受 S-01 |
| S-04 | 远程执行环境 | codex exec-server | 无（ssh 方案无阻塞） | ⑦ 9→10（+11） | ✅ **完整版落地**：ssh 通道阶段 1（sshRemote.ts + /remote + bash 分支，10 mock 单测）+ **长驻 exec-server**（execServer.ts：HMAC 派生 Bearer + timingSafeEqual、64KB 体限、远端 OS 沙盒 profile 复用（winSandbox 同族，不可用 fail-closed 拒绝绝不降级）、`/remote server|connect|run` 与 bash 工具接入（remoteServer 优先于 ssh）、默认 127.0.0.1 + 非回环诚实警告）——8 本机集成单测（真实 server+client 闭环），supremacy 补轮 |
| S-06 | 沙盒 macOS/Linux 化 | codex/gemini 三平台 | — | — | ❌ **已移除（Windows-only 决策）**——POSIX 实现（bwrap/Seatbelt）保留休眠态，探测诚实返回不适用；⑥ 冲 10 改走 S-07 Windows 双态沙盒 |
| S-07 | Windows 双态沙盒（⑥ 冲 10：提权→受限令牌 / 标准用户→Low IL） | codex windows-sandbox-rs（提权路径） | 管理员环境（提权分支实测） | ⑥ 9→10（+10，Windows 深度口径） | ✅ **全链路实测收官（三测三修）**：v3 报 87 → v4（TokenGroups 只禁用存在 SID、Attributes=0）→ v4 启动报 1314 → v5（从本进程令牌直接构建 + SeIncreaseQuotaPrivilege + 探测加进程启动冒烟）→ **管理员终端实测**：OK-ELEVATED + L0 SBX_WRITE_DENIED + L1 SBX_WRITE_OK（elevated-probe-result.txt 取证，audit §13.66-13.68）；⑥ 9→10（835，七家第一） |
| S-05 | share 云端分享 | opencode/kimi | 需中心服务器 | ⑦ +1 | 🚫 离线变体已落地（/share 打包加密，见 A-08） |

## A 级

| ID | 缺陷 | 对标 | 影响维度/提分 | 状态 |
|---|---|---|---|---|
| A-01 | 命令面臃肿（114 注册/~109 命令，竞品 2~3 倍） | gemini 47/opencode 动态 | 臃肿度原始诉求（不直接加分） | ✅ 两层命令面：主干 47 条 + 扩展 63 条（零删除，契约不变）——/help 默认主干、/help all 全目录、command_search 主干优先（supremacy 1.6） |
| A-02 | 模型分族提示词（deepseek/glm/kimi 定制段） | gemini 分族 | ⑤ 6→7（+11） | ✅ providerPrompts.ts 承载中文段（systemPrompt 零 CJK 红线不破），agent 按 model/端点解析注入，7 用例（supremacy 1.1） |
| A-03 | 小模型任务档（标题/摘要走小模型） | crush large/small | ⑤ 7→8、⑩ +1 | ✅ settings.titleModel/summaryModel 白名单 + 标题小模型路由（10s 超时/无密钥/异常全部回退切片标题，已有标题零调用），9 用例（supremacy 1.2） |
| A-04 | 按模型工具裁剪（48 schema 全量发给所有模型） | codex 按模型 | ⑤/⑩ | ✅ toolTrim.ts 能力驱动裁剪（文本模型裁图片输出工具、小窗口文本模型裁 GUI 套件、视觉模型全保留、未知模型不臆测）+ settings.toolTrim + updateTools 不绕过，11 用例（supremacy 1.3） |
| A-05 | LLM 辅助循环检测（置信度判空转） | gemini | ④ 与 gemini 最后差距 | ✅ loopJudge.ts 语义判定（7 用例，supremacy 1.5）；④ 满格达成（子代理分型 subagentTypes + responseFormat 结构化输出，supremacy 补轮）——④=10 七家第一 |
| A-06 | 成本五维（reasoning/cache_read/cache_write）+ Decimal | opencode | ⑩ | ✅ usage_stats v10 加 reasoning_tokens；五维计价（reasoning 按输出价、cacheMiss 按输入价、cacheHit 走 cacheRead 价）全整数 µUSD BigInt 定点（零浮点漂移）；kf-030/迁移断言同步 10；14 成本用例（supremacy 1.4） |
| A-07 | 快照增量化（消息 id 上界 vs 全量复制） | kimi `_checkpoint` | ⑨ | ✅ **messagesUpTo 上界**（39566cc）：自动/手动 checkpoint 不再全量 SELECT，重建=id≤上界精确（消息只增不删保证）；messagesAtCheckpoint 旧形态数组兼容 |
| A-08 | share 分享 | opencode/kimi | ⑦ 场景矩阵 | ✅ 离线加密打包（kernel/share.ts + /share，AES-256-GCM+sha256）——云端版受 S-05 阻塞（对照 opencode opncd.ai 云分享见 docs/cli-cloud-vs-local-2026.md） |
| A-09 | 本地 bash 沙盒探测失败 fail-open | codex/gemini 沙盒必开 | ⑥ | ✅ **fail-closed**（dd02d5f）：沙盒请求但不可用→拒绝执行绝不静默裸跑；settings.sandbox.failOpen=true 显式逃生门（降级每次标注）；/sandbox os failopen on|off |

## B 级

| ID | 缺陷 | 对标 | 状态 |
|---|---|---|---|
| B-01 | vim 无接线 / keymap 不可配 | codex 真 vim+config | ✅ 键位配置层（keymap.ts 命名动作→KeySpec 解析/匹配/覆盖合并，settings.keymap 经 config.get→applyDisplay 水合热生效，pager 关闭/导航已接线，10 单测）——诚实口径：不宣称伪 vim（全模态编辑如接入再如实标注；pager 既有 vim 风格 j/k/b/g/G 键位已可配，supremacy 3.3） |
| B-02 | @文件选择器、diff hunk 折叠/apply | opencode 双布局 | ✅ diff hunk 折叠已接线（diffHunks.ts 分节/hunk/默认折叠/切换模型 + messageLine 超长 hunk 默认折叠渲染，6 单测）+ extractPatchText 还原补丁供 apply_patch（apply 数据路径）；@文件引用机制已有（resolveAtRefs）——交互式折叠切换与一键 apply UI 动作留后续 |
| B-03 | 会话浏览器 UI（列表+预览） | codex resume_picker/gemini SessionBrowser | ◐ 数据面已备（listSessionsStructured + --json），UI 面待桌面端 |
| B-04 | 主题系统 | opencode 33 套 | ✅ **10 套命名预设**（5befc4b，诚实口径非 33）：THEME_PRESETS（nord/dracula/tokyo-night/monokai/gruvbox/solarized/one-dark/catppuccin/everforest/synthwave）+ themeByName 三元组覆盖（语义色继承基底保可读性）+ theme.changed 事件适配 + /theme 列预设 |
| B-05 | 配置分层（项目级 .wxnodus/config 继承） | gemini 四层 | ✅ **projectConfig.ts**（fda5c95）：.wxnodus/config.json settings 键级覆盖全局（浅合并），mtime 缓存零解析，agent getSettings 动态分层，/config 三态诊断——4 单测 |
| B-06 | execpolicy 首词前缀规则 | codex first-token 索引 | ✅ execPolicy.ts 首词索引（pattern 锚定保证与全量 applyRules 数学等价——安全等价断言在测）；审批持久化复用 permissions.json（/perm rule，P0-2 存储面不新增）；agent bash 规则经索引裁决，8 用例（supremacy 1.7） |
| B-07 | 会话列表 first_user 摘要/血缘 | gemini/codex | ✅（79c3226） |
| B-08 | approve_for_session 真实授权 | kimi | ✅（79c3226） |

## C 级

| ID | 缺陷 | 状态 |
|---|---|---|
| C-01 | 无远程 CI（GitHub Actions）+ 无 lint + 无 perf 基准 | ✅ lint（scripts/lint.mjs：debugger 红线/内核层 process.exit 红线，ci 挂载）+ madge 环检查（scripts/check-cycles.mjs + allowlist——**修复环 13/17 两处运行时环**：db.ts 移除 searchMessages 再导出、ssrf↔outboundTargetPolicy 提取 blockedHosts 叶子），ci 九步挂载；**远程 CI 绿**（2026-08-18 十五轮收官——11 类远程独有缺陷全修，audit §13.71） |
| C-02 | 巨文件残留（wxGateway 等） | ◐ handlersExt 已拆（3718→2180），wxGateway 待拆 |
| C-03 | 无 perf 基准目录 | ✅ `scripts/bench/run-bench.mjs`（gemini perf-tests 对齐：shortHash/diff 管线/bigramZh/diffLines 四项确定性微基准，`npm run bench`；基线 2026-08-18 首跑记录） |

## 下一档优先级（按提分/成本）

1. ⑧ 5→9（+36）仍卡公开决策（私有仓库已备，rc.1/rc.2 内测包已发）——转公开即解锁 winget/scoop；
2. 波 3 全部落定后剩余零碎（P3）：vim VISUAL 已落（audit §13.76）→ **评估轮全量清零**：vim 文本对象/`/` 搜索/Ctrl-R redo（ee6c318/c517524）、git 三源 diff viewer（e941840）、ACP session/load 全量（3f717cc）均已落——见 §P3 评估轮；剩余：B-03 会话浏览器 UI（数据面已备）、C-02 wxGateway 巨文件拆分。
4. 波 3：vim（gemini vim.ts）、完整 diff 查看器/逐 hunk 应用（差异化）、ACP 接收 + 本地语义搜索；
5. ⑧ 5→9（+36）仍卡公开决策（私有仓库已备，rc.1/rc.2 内测包已发）。

## 波 1 落定（2026-08-18：②③⑤⑩ 四维齐升——843 → 878，反超 codex 登顶第 1/7，证据 score §9.16 / audit §13.73）

| 维度 | 波 1 前 | 波 1 后 | 落定内容（对标锚点） |
|---|---|---|---|
| ③ diff/媒体 | 5 | 6 | diff 回显组件（gemini DiffRenderer 移植）+ fs_edit diff 块（codex RespondToModel）+ view_image 图片输入（kimi read_media） |
| ② 输入/编辑器 | 6 | 7 | Ctrl+O 外部编辑器（kimi editor.py 探测链 + crush 临时文件往返）+ token 高亮（gemini highlight.ts）+ Ctrl-R 补测试（codex） |
| ⑩ 性能/token | 9 | 10 | 字段固定序 + cache_control 断点（crush）+ 缓存写价/节省展示（aider）+ 摘要独立请求（gemini/kimi） |
| ⑤ 提示词/适配 | 9 | 10 | 7 块结构化快照 + 反注入段（gemini snippets.ts）+ 保留规则（kimi compact.md）+ 合并锚定 + 失败护栏（gemini） |


## 波 2 落定（2026-08-18：②③⑪ 三维齐升——878 → 900，稳居第 1/7，证据 score §9.17 / audit §13.74）

| 维度 | 波 2 前 | 波 2 后 | 落定内容（对标锚点） |
|---|---|---|---|
| ② 输入/编辑器 | 7 | 8 | @补全（crush 分层排序 + opencode frecency + kimi enter 双语义 + #L 行区间） |
| ③ diff/媒体 | 6 | 7 | 词级 inline diff（kimi 六家独有移植）+ pager hunk 跳转（opencode 独有） |
| ⑪ 差异化 | 8 | 9 | 离线缺模型即拉取（codex ollama）+ AI 记忆收件箱（gemini .inbox） |

## 波 3 落定（2026-08-18：②③⑪ 三维齐升——900 → 922，三波路线全部落定，证据 score §9.18 / audit §13.75）

| 维度 | 波 3 前 | 波 3 后 | 落定内容（对标锚点） |
|---|---|---|---|
| ② 输入/编辑器 | 8 | 9 | vim 模态（gemini vim.ts 纯 reducer 直搬 + /vim 开关热生效） |
| ③ diff/媒体 | 7 | 8 | 完整 diff 查看 + per-hunk 选择性回滚（六家皆无差异化，取证确认） |
| ⑪ 差异化 | 9 | 10 | 本地跨会话语义召回（六家独有）+ ACP stdio 接收入档 |

## P3 评估轮落定（2026-08-18：A 级清零 + B 级三落 + 沙盒 fail-closed，证据 audit §13.77）

| 项 | 前 | 后 | 落定内容（对标锚点） |
|---|---|---|---|
| vim 文本对象 | 无 | ✅ | di(/da(/ci(/yi(/vi( 等（codex vim.rs:229-264 括号栈深度计数）——ee6c318，13 单测 |
| vim / 搜索 + Ctrl-R redo | 无 | ✅ | / ? 增量搜索（回绕/Backspace/Enter/Esc）+ redo 信号 + undo/redo 历史纯函数——c517524，10 单测 |
| /diff git 三源 | 快照单源 | ✅ | git/branch/turn 三源（opencode diff-viewer.tsx:46 对标；revert 仅 turn 源诚实边界）——e941840，真实 git 集成 3 测 |
| ACP session/load | stdio 单会话 | ✅ | store 注入：new 落库/load 校验/load_history 真历史/cancel 诚实报错——3f717cc，协议子进程 2 测 |
| 沙盒探测失败 | fail-open 降级 | ✅ | fail-closed 拒绝执行 + failOpen 显式逃生门（A-09）——dd02d5f，8 单测 |
| 主题系统 | ⏳ | ✅ | 10 套命名预设（B-04）——5befc4b |
| 配置分层 | ⏳ | ✅ | 项目级 .wxnodus/config.json（B-05）——fda5c95 |
| 快照增量化 | ⏳ | ✅ | messagesUpTo 上界（A-07）——39566cc |

**评分口径（诚实）**：② 冲 10 论据已齐（VISUAL 六家皆无 + 文本对象 codex 对标 + / 搜索 + redo + 既有 Ctrl-R 历史/键位/@补全）——是否 9→10 留七评复核 codex 8 种文本对象覆盖后定，本轮不预支。云端独占面取证见 docs/cli-cloud-vs-local-2026.md。

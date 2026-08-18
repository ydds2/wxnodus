# 缺陷寄存器（2026-08-18，终版盘点）

> 单一事实源：wxnodus 相对 6 家竞品（codex/gemini-cli/opencode/kimi-cli/crush/aider）的**剩余缺陷全表**。
> 状态列：✅ 已落地（commit 可溯）｜◐ 部分落地｜⏳ 未做｜🚫 不可为（缺外部依赖，注明阻塞）。
> 严重度定义：S=用户视角不成立/安全边界；A=能力面子集；B=体验；C=工程债。
> 评分联动：`docs/cli-deep-analysis-score-2026.md`（当前 7.25，第 4/7）；每缺陷标注影响的评分维度与提分预估。

## S 级

| ID | 缺陷 | 对标 | 阻塞 | 影响维度/提分 | 状态 |
|---|---|---|---|---|---|
| S-01 | 真实分发（winget/scoop 上架、installer、更新通道） | opencode 9 渠道 | 无 git remote → 无发布 URL | ⑧ 5→6（+9） | ◐ 模板/生成器已备（`packaging/`），发布日零改动 |
| S-02 | 插件市场/远端技能安装 | codex/opencode 市场 | 同 S-01（需托管） | ⑧ 6→7（+9） | ⏳ |
| S-03 | IDE 插件 | gemini companion/codex vscode | 无（协议已备） | ⑦ 8→9（+11） | ◐ **落地**：`packages/vscode-ext`（--wire 桥接 + webview 面板 + 审批/澄清/密码原生模态），typecheck+4 单测+esbuild+vsce 本地 vsix 全绿（supremacy 2.1）；marketplace 上架仍受 S-01 |
| S-04 | 远程执行环境 | codex exec-server | 无（ssh 方案无阻塞） | ⑦ 9→10（+11） | ◐ **ssh 通道阶段 1 落地**：`sshRemote.ts` + `/remote` + bash 工具远程分支（远端未沙盒诚实标注），10 mock 单测（supremacy 2.2）；完整版 exec-server（远端沙盒复用）留后续 |
| S-06 | 沙盒 macOS/Linux 化 | codex/gemini 三平台 | — | — | ❌ **已移除（Windows-only 决策）**——POSIX 实现（bwrap/Seatbelt）保留休眠态，探测诚实返回不适用；⑥ 冲 10 改走 S-07 Windows 双态沙盒 |
| S-07 | Windows 双态沙盒（⑥ 冲 10：提权→受限令牌 / 标准用户→Low IL） | codex windows-sandbox-rs（提权路径） | 管理员环境（提权分支实测） | ⑥ 9→10（+10，Windows 深度口径） | ⏳ 标准用户分支已实测校准（1ec26e1）；提权分支待实现+实测 |
| S-05 | share 云端分享 | opencode/kimi | 需中心服务器 | ⑦ +1 | 🚫 离线变体已落地（/share 打包加密，见 A-08） |

## A 级

| ID | 缺陷 | 对标 | 影响维度/提分 | 状态 |
|---|---|---|---|---|
| A-01 | 命令面臃肿（114 注册/~109 命令，竞品 2~3 倍） | gemini 47/opencode 动态 | 臃肿度原始诉求（不直接加分） | ✅ 两层命令面：主干 47 条 + 扩展 63 条（零删除，契约不变）——/help 默认主干、/help all 全目录、command_search 主干优先（supremacy 1.6） |
| A-02 | 模型分族提示词（deepseek/glm/kimi 定制段） | gemini 分族 | ⑤ 6→7（+11） | ✅ providerPrompts.ts 承载中文段（systemPrompt 零 CJK 红线不破），agent 按 model/端点解析注入，7 用例（supremacy 1.1） |
| A-03 | 小模型任务档（标题/摘要走小模型） | crush large/small | ⑤ 7→8、⑩ +1 | ✅ settings.titleModel/summaryModel 白名单 + 标题小模型路由（10s 超时/无密钥/异常全部回退切片标题，已有标题零调用），9 用例（supremacy 1.2） |
| A-04 | 按模型工具裁剪（48 schema 全量发给所有模型） | codex 按模型 | ⑤/⑩ | ✅ toolTrim.ts 能力驱动裁剪（文本模型裁图片输出工具、小窗口文本模型裁 GUI 套件、视觉模型全保留、未知模型不臆测）+ settings.toolTrim + updateTools 不绕过，11 用例（supremacy 1.3） |
| A-05 | LLM 辅助循环检测（置信度判空转） | gemini | ④ 与 gemini 最后差距 | ✅ loopJudge.ts 语义判定（loop 提前硬停/progress 复位计数/unknown 回退静态），settings.loopJudge 默认关，7 用例（supremacy 1.5）；④ 满格还需子代理分型+结构化输出（阶段 3） |
| A-06 | 成本五维（reasoning/cache_read/cache_write）+ Decimal | opencode | ⑩ | ✅ usage_stats v10 加 reasoning_tokens；五维计价（reasoning 按输出价、cacheMiss 按输入价、cacheHit 走 cacheRead 价）全整数 µUSD BigInt 定点（零浮点漂移）；kf-030/迁移断言同步 10；14 成本用例（supremacy 1.4） |
| A-07 | 快照增量化（消息 id 上界 vs 全量复制） | kimi `_checkpoint` | ⑨ | ⏳（血缘已 ✅，见 79c3226） |
| A-08 | share 分享 | opencode/kimi | ⑦ 场景矩阵 | ✅ 离线加密打包（kernel/share.ts + /share，AES-256-GCM+sha256）——云端版受 S-05 阻塞 |

## B 级

| ID | 缺陷 | 对标 | 状态 |
|---|---|---|---|
| B-01 | vim 无接线 / keymap 不可配 | codex 真 vim+config | ⏳ |
| B-02 | @文件选择器、diff hunk 折叠/apply | opencode 双布局 | ⏳ |
| B-03 | 会话浏览器 UI（列表+预览） | codex resume_picker/gemini SessionBrowser | ◐ 数据面已备（listSessionsStructured + --json），UI 面待桌面端 |
| B-04 | 主题系统 | opencode 33 套 | ⏳ |
| B-05 | 配置分层（项目级 .wxnodus/config 继承） | gemini 四层 | ⏳ |
| B-06 | execpolicy 首词前缀规则 | codex first-token 索引 | ✅ execPolicy.ts 首词索引（pattern 锚定保证与全量 applyRules 数学等价——安全等价断言在测）；审批持久化复用 permissions.json（/perm rule，P0-2 存储面不新增）；agent bash 规则经索引裁决，8 用例（supremacy 1.7） |
| B-07 | 会话列表 first_user 摘要/血缘 | gemini/codex | ✅（79c3226） |
| B-08 | approve_for_session 真实授权 | kimi | ✅（79c3226） |

## C 级

| ID | 缺陷 | 状态 |
|---|---|---|
| C-01 | 无远程 CI（GitHub Actions）+ 无 lint + 无 perf 基准 | ◐ npm run ci 本地门禁代替；其余 ⏳ |
| C-02 | 巨文件残留（wxGateway 等） | ◐ handlersExt 已拆（3718→2180），wxGateway 待拆 |
| C-03 | 无 perf 基准目录 | ⏳（gemini perf-tests/aider benchmark 对齐） |

## 下一档优先级（按提分/成本）

1. A-02+A-03（⑤ 6→7→8，+11~22）——提示词分族与小模型任务档，纯内核改动零外部依赖；
2. S-03 IDE 插件（⑦ 8→9，+11）——协议已备，工程量中；
3. A-01 命令面瘦身（原始诉求，不直接加分但消臃肿）;
4. A-06 成本五维（⑩，中）；
5. S-04 远程执行 ssh 通道（⑦，中）；S-01 发布（有 remote 即解锁）。

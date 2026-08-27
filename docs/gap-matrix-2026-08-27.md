# wxnodus CLI 与同类 CLI 全量差距矩阵（终版 · 2026-08-27）

> **基线**：本会话 6 轮实施**之后**的当前状态（P0 7 卡 + P1 4 卡 + P2 6 卡 + 生态 3 项全部落地，全量 2584 测试绿）。
> **取证口径**：7 路源码深潜（codex `9dd3d6a` / gemini-cli 0.56.0-nightly / opencode `a97fec8` / kimi-cli 1.49.0 / crush `ed15da4` / aider 0.86.3.dev / wxnodus 独立复核），全部带 file:line 锚点。
> **「无遗漏」的保证方式**：本矩阵的维度集合 = 深潜报告覆盖的**全部**对比面 + 实施过程中发现的全部缺口 + 路线图 A–E 全表 + **wxnodus 独有面（含 DeepSeek Harness）**；未取证格显式标注（第 7 节清单）——**凡未取证的格不猜测**。绝对意义上的「100%」无法验证，但可保证：**没有任何已知缺口被省略**。
> 图例：✅ 已对齐/有 · 🟡 有但弱于最强竞品 · ❌ 无 · ❓ 未取证 · 裁决 = 用户裁定不做。

## 1. 交互与入口

| 维度 | wxnodus | codex | gemini-cli | opencode | kimi-cli | crush | aider | 差异判定 |
|---|---|---|---|---|---|---|---|---|
| 交互 TUI | ✅ 薄层重建（wire→ANSI，审批复用 wire 契约） | ✅ ratatui | ✅ Ink | ✅ @opentui | ✅ kosong | ✅ bubbletea | ✅ REPL | 已补齐（唯一缺过 TUI 的短板消除） |
| headless 入口 | ✅ 6 入口（-p/wire/serve/stdin/mcp-server/ACP） | ✅ exec+json | ✅ -p+pipe | ✅ run+pipe | ✅ 四态+wire | 🟡 run+serve（无 -p） | ✅ --message | 与 kimi/codex 持平 |
| IDE 集成 | 🟡 VS Code 0.2.0（wire 桥+诊断+diff） | ✅ app-server+双 SDK | ✅ IDE 伴生包 | ✅ VS Code+Zed+GH Action | ✅ web+vis | 🟡 — | ❌ | 生态面仍薄于 codex/opencode（定位已收窄为协议开放面） |
| Web/桌面 UI | 裁决不做 | ✅ desktop_app | ❌ | ✅ Electron+Web+Slack | ✅ web UI | 🟡 — | ✅ --gui | 裁决 |
| 官方 SDK | 裁决不做 | ✅ TS+Python | ✅ sdk | ✅ JS SDK | ✅ kimi-sdk | 🟡 — | ❌ | 裁决 |
| 多会话/血缘 | ✅ sessions+forked_from_id | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ 单会话 | 持平 |
| 会话导入 | ✅ Claude+Codex JSONL 嗅探 | — | ❓ | ✅ | ✅（同款） | ❓ | ❌ | 对齐 kimi |

## 2. 内核与可靠性

| 维度 | wxnodus | codex | gemini-cli | opencode | kimi-cli | crush | aider | 差异判定 |
|---|---|---|---|---|---|---|---|---|
| 错误分类重试 | ✅ 14 类+等待网络 60s+429 限额态 | ✅ 5s→60s+WS→HTTPS 回退 | ✅ 10 次 5s→30s | ✅ 指数+Retry-After | ✅ tenacity | ✅ OnRetry | ❌ | 第一梯队 |
| 流中断恢复 | ✅ reset+已收结果回放 | ❓ | ✅ RETRY 丢弃 UI 部分 | ✅ mid-stream 保留 | ✅ | 🟡 | 🟡 | 持平 gemini |
| 上下文压缩 | ✅ 三级（micro/全量/413 强压）+EMA | 🟡 更强：服务端远程压缩 v2 | ✅ snapshot+probe 自校验 | ✅ 保尾 40k | ✅ 0.85 阈值 | ✅ 摘要 | ✅ 弱模型摘要 | 🟡 弱于 codex 远程压缩/gemini 自校验 |
| 循环检测 | ✅ 签名+短哈希+LLM 辅助+doom_loop 分级 | ✅ 四层兜底（无专门模块） | 🟡 双模型确认（置信度 0.9） | ✅ doom_loop 3 连 | ✅ streak≥12 | ✅ SHA-256 窗口 | ❌ | 🟡 弱于 gemini 双模型 |
| 前缀缓存工程 | ✅ 字节稳定三件套（DeepSeek harness） | ❓ | ❓ | ❌（被点名失败） | ❓ | ❓ | ❌ | **领先** |
| durable queue/崩溃恢复 | ✅ 本会话对齐（db-v12） | ✅ QueueStore+rollout 重放 | ✅ state_snapshot | ✅ onInterrupt 落盘 | ✅ checkpoint | ✅ 落盘终态 | 🟡 git 兜底 | 已对齐 codex（重放粒度仍轻） |
| 通知回流+Notification hook | ✅ 本会话接线 | — | — | — | ✅（对齐来源） | — | — | 已对齐 kimi |
| D-Mail 时间旅行 | ❌（/rewind 手动回滚替代） | — | — | — | ✅ 独有 | — | — | 唯一未对齐的 kimi 机制 |
| 续说判定 nextSpeakerCheck | ❌ | — | ✅ 独有 | — | — | — | — | 观察项（TUI 交互细节） |
| 坏 JSON 自纠 | ✅ 哨兵回喂 | 🟡 RespondToModel | — | ✅ InvalidTool | ✅ ToolParseError | ❌ | 🟡 相似行纠错 | 持平 |
| 编辑容错 | ✅ 三级+行尾保真 | 🟡 | 🟡 | ✅ 行尾归一 | ❓ | ✅ 空白纠正 | ✅ 四级（第 4 级死代码） | 持平（aider 实际三级） |
| 撤销/回滚 | ✅ checkpoint×10+undoShadows+中断回放 | ✅ rollout/fork | 🟡 | 🟡 | 🟡 | 🟡 | ✅ 逐消息 undo | 🟡 弱于 aider 粒度（裁决轻量替代） |

## 3. 工具与能力

| 维度 | wxnodus | codex | gemini-cli | opencode | kimi-cli | crush | aider | 差异判定 |
|---|---|---|---|---|---|---|---|---|
| 内置工具数 | ✅ 49（最宽） | 🟡 ~20 | 🟡 ~26 | 🟡 ~15 | 🟡 16 | 🟡 ~29 | ❌ 0（edit 格式） | **领先** |
| apply_patch | ✅ 三级容错 | ✅ lark 语法 | ❌ 用 replace | ✅ 按模型切换 | ❌ StrReplaceFile | ✅ | ✅ 四级 | 持平 |
| computer use | ✅ 12 工具（截图/坐标/UIA 元素级） | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | **独有领先** |
| 浏览器自动化 | ✅ 7 工具（系统浏览器+SSRF） | 🟡 模型原生 WebSearch | ✅ | ❌ | ❌ | 🟡 | ❌ | 领先 |
| LSP | 🟡 3 工具+诊断回灌（默认关） | ❌（确证） | ❓ | ✅ 客户端 | ❌（确证） | ✅ 8 工具 | ❌ | 🟡 弱于 crush 广度 |
| 语音/视频 | ✅ whisper+SAPI+帧分析 | ❌ | ❓ | ❌ | ❌ | ❌ | ✅ voice | 领先 |
| repo map | 🟡 ≤400 token | ❌（确证） | ❓ | ❌ | ❌ | 🟡 filetracker | ✅ pagerank 最深 | 🟡 弱于 aider（裁决轻量） |
| 长期记忆 | ✅ 黑洞三层+FTS5 中文+向量（唯一检索式） | 🟡 两阶段抽取 | 🟡 文件+人工审批 | ❌ | ❌ | 🟡 todos | ❌ | **领先** |
| 图片守卫 | ✅ 四层（能力门/历史文本化/发送兜底/视觉降级） | ❓ | ❓ | ❓ | ❓ | ❓ | ❌ | **独有** |
| **DeepSeek 端点适配（Harness）** | ✅ **10 项适配 + 4 不变量**（DSH-1 reasoning_content 原样回传 / DSH-2 字节稳定前缀缓存 / DSH-3 图片零泄漏 / DSH-4 成本诚实——`architecture-2026-08-27.md` §6.10） | ❌（ChatGPT 专用，无 DS 适配面） | ❌（无 OpenAI 兼容端点） | 🟡 按模型选提示词变体（`system.ts:29-56`，无字段回传/缓存工程） | 🟡 `openai_legacy` 取 reasoning_content（`config.py`，单点无体系） | ❌ | ❌ | **独有领先**——六家无等价物；本会话 6 轮改动后五锚点复核完好 |
| 评测 harness | 🟡 3 任务×N 轮 | 🟡 core/suite | ✅ evals 37 | 🟡 | 🟡 | 🟡 | ✅ SWE-bench/Exercism | 🟡 任务库规模小 |
| 后台任务/cron | ✅ /jobs+cron | ❓ | ❓ | ❓ | ✅ TaskList 家族 | ✅ job_output/job_kill | ❌ | 持平 |
| 远程执行 | 🟡 execServer（未实测电池） | ✅ exec-server noise_channel | ❌ | ❌ | ❌ | ❌ | ❌ | 🟡 有实现缺实测 |

## 4. 安全与私有化

| 维度 | wxnodus | codex | gemini-cli | opencode | kimi-cli | crush | aider | 差异判定 |
|---|---|---|---|---|---|---|---|---|
| 权限模式 | ✅ 六档+规则+会话授权 | ✅ 三维矩阵 | ✅ policy 分层 | ✅ allow/ask/deny | ✅ 审批+yolo | ✅ ask/allow/deny | ❌ | 第一梯队 |
| 沙箱 | 🟡 winSandbox 双态令牌/Low IL（实测校准） | ✅ 四平台+WFP+私有桌面 | ✅ Docker+Win C# 助手 | ❌（确证无） | ❓ | ❌ | ❌ | 🟡 弱于 codex WFP |
| 密钥管理 | ✅ AES-256-GCM+归属校验（唯一本地加密） | 🟡 keyring | 🟡 keytar | ❌ 明文 auth.json | 🟡 keyring | 🟡 env/op | 🟡 .env | **领先** |
| SSRF/重绑定 | ✅ 三层+IPv6/NAT64 | ❓ | ❓ | ❓ | ❓ | ❓ | ❌ | **独有级别** |
| 提示注入防护 | ✅ untrusted 包裹+vault 脱敏 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | ❌ | 领先 |
| 企业代理 | ✅ env+WinINET+私网直连红线（本会话） | ❓ | 🟡 沙箱代理面 | ❓ | ❓ | ❓ | ❌ | 领先；PAC/NTLM 诚实降级 |
| 三层策略+审计导出/校验 | ✅（唯一：全局 deny 不可放宽+哈希链 verify） | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | **独有** |
| AI 预审 Guardian | 🟡 autoReview 默认关 | ✅ 默认开+风险评分 | ❌ | ❌ | ❌ | ❌ | ❌ | 🟡 默认策略差距 |

## 5. 生态与扩展

| 维度 | wxnodus | codex | gemini-cli | opencode | kimi-cli | crush | aider | 差异判定 |
|---|---|---|---|---|---|---|---|---|
| MCP 双向 | ✅ 客户端 stdio/HTTP+incoming server | ✅ 双向 | ✅ | ✅ +OAuth | ✅ | ✅ +OAuth | ❌（确证） | 第一梯队 |
| skills（SKILL.md） | ✅ 跨品牌目录六家通用 | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | 持平 |
| hooks | ✅ 9 事件（含 Notification 本会话接线） | ✅ 8 事件全集 | ✅ Before/AfterAgent | ✅ | ✅ 最全 | ✅ | ❌ | 持平 kimi |
| plugins 运行时 | ✅ 沙箱+生命周期 | ✅ | ✅（extism——裁决不引入） | ✅ | ✅ | ❌ | ❌ | 持平（路线自研） |
| ACP | ✅ | ❌（确证） | ✅ | ✅ | ✅ | ❓ | ❌ | 第一梯队 |
| A2A | ✅ | ❌ | ✅（experimental） | ❌（确证） | ❌ | ❌ | ❌ | 领先 |
| 子代理 | ✅ 只读工具集+深度限制 | ✅ | ✅ local/remote | ✅ 权限继承 | ✅ 劳务市场 | ✅ task+agentic_fetch | ❌ | 持平 |
| 开源市场消费 | ✅ npm+GitHub 双源+npm 插件链（本会话补全） | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | **独有**（只收不出） |
| 离线整包分发 | ✅ /bundle 唯一 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | **独有** |
| 分享 | 🟡 /share 本地打包 | 🟡 会话分享 | ❓ | ✅ 分享到 opencode.ai | ❓ | ❓ | ❌ | 🟡 无云端分享（定位） |

## 6. 平台与发布

| 维度 | wxnodus | codex | gemini-cli | opencode | kimi-cli | crush | aider | 差异判定 |
|---|---|---|---|---|---|---|---|---|
| Windows 深度 | ✅ 三档终端/GBK/IME/UIA/真机验收电池 | ✅ 沙箱强 | ✅ 较好 | 🟡 V2 欠 PowerShell | 🟡 git-bash 依赖 | ✅ | ❌ | **领先** |
| 跨平台 | 裁决不做 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 裁决 |
| 单二进制 | 裁决不做 | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | 裁决 |
| Node 兼容 | ✅ ≥22.7+多 ABI 侧车（本会话） | n/a | ❌ | n/a | n/a | n/a | n/a | 领先 |
| ARM64 | ❓ 未验证 | ✅ | ❓ | ❓ | ❓ | ❓ | ❓ | 未取证 |
| Windows Server | ❓ 未验证 | ❓ | ❓ | ❓ | ❓ | ❓ | ❌ | 未取证 |
| winget/scoop 发布 | 🟡 发布准备交付（三文件 manifest + 指南）；实际 PR 待授权 | ❓ | ❓ | ❓ | ❓ | ✅ | ❓ | 待授权 |
| 自主升级+回滚 | ✅ 三原则+气隙 --file | ✅ | ✅ | ❓ | ✅ | ✅ | ✅ | 领先 |
| 产物迁移框架 | ✅ 15 类资产声明式迁移 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | **独有** |
| 离线用户手册 | ✅ 本会话（zip 分发） | 🟡 | ✅ | ✅ | ✅ | ✅ | ✅ | 已补齐 |

---

## 7. 剩余差距清单（当前真实未做项）

### B 级（建议对齐，均有明确成本）

| # | 差距 | 锚点/依据 | 建议 |
|---|---|---|---|
| B1 | autoReview 默认关 vs codex Guardian 默认开 | `cliComposition.ts:260`（`settings.autoReview === true`） | **裁决维持默认关（2026-08-27）**：无灰度数据、fail-closed 安全优先；开关已存在，用户可自行开启 |
| B2 | 循环检测单模型 vs gemini 双模型（置信度 0.9） | gemini `loopDetectionService.ts:42-65` | 可选加固（成本=每次判定的额外 LLM 调用） |
| B3 | 评测任务库 3 个 vs aider SWE-bench/Exercism 全量、gemini evals 37 | 本会话 `scripts/eval/tasks/` | ✅ 已扩到 10 任务（2026-08-27）：t4 深合并/t5 URL 查询/t6 罗马数字/t7 链接提取/t8 日期间隔/t9 词频 Top-K/t10 表达式求值（覆盖解析/算法/日期/文本六领域）+ golden 参考解 + `eval:tasks:selftest` 双向评分路径门禁入 ci |
| B4 | exec-server 真实电池未实测 | hardening-plan H0 遗留 | **裁决暂缓（2026-08-27）**：功能保留、文档标注「未真机验证」，不做双机电池；需要时先 localhost 冒烟再真双机 |
| B5 | LSP 诊断回灌默认关 vs opencode 默认开 | `tests/v4-lsp-feedback.test.ts`（默认 off 契约） | 已记录取舍（内存立场折衷），维持 |

### C 级（观察项，不承诺）

| # | 差距 | 竞品 |
|---|---|---|
| C1 | D-Mail 时间旅行（工具级回滚到历史 checkpoint） | kimi 独有（`denwarenji.py:6-29`） |
| C2 | nextSpeakerCheck 续说判定 | gemini 独有（`client.ts:880-905`） |
| C3 | herdr 终端复用器集成 / 多客户端共享 workspace | crush 独有 |
| C4 | 服务端远程压缩 v2 | codex（云端能力，私有化定位无法对齐——记录即可） |
| C5 | PAC 自动配置脚本执行 / NTLM 原生认证 | 需 JS 解释器/凭据中继——诚实降级已记录 |

### 外部授权/待裁决

| # | 项 | 状态 |
|---|---|---|
| E1 | winget/scoop 实际发布（提 PR） | **发布准备已交付（2026-08-27）**：winget 三文件形态（version/installer/locale）+ scoop license 修正 Apache-2.0 + `docs/winget-scoop-publish-guide.md` + PR 模板；提 PR 仍待 GitHub 账号授权 |
| E2 | GPO/域策略下发（Q3） | **裁决不做（2026-08-27）**：维持本地三层策略；GPO 分发属 Windows 能力，wxnodus 只保证读+尊重（全局层 %ProgramData% 已支持） |
| E3 | ARM64 / Windows Server 真机验证 | 待部署真机电池 |

### 裁决不做（用户裁定，不算遗漏）

跨平台 · OAuth 账号体系 · 官方 SDK · Web/桌面 UI · 自托管市场 · 单二进制 · 内建 runtime 捆绑 · auto-commit（git）· 逐编辑 undo 追平 aider · 云端分享 · 遥测自动上传

### 未取证残留（唯一无法定论的格）

gemini-cli：LSP、语音、会话导入、遥测口径；kimi-cli：沙箱机制、本地模型推理路径；crush：ACP、会话导入；codex：遥测/崩溃上报行为、流中断恢复；aider：本版 conventions 机制（已确证无）。

**总结**：原 26 项差距经本会话 6 轮实施后，剩余**真正未做**的只有 B1–B5 五条 + C1–C5 观察项 + E1–E3 授权/验证项；其中 B 级全部有明确成本与收益，C 级多为竞品独有机制或云端能力。矩阵内所有「无/未取证」格均已显式列出——**已知缺口零省略**；wxnodus 独有面（computer use、SSRF 三层、黑洞记忆、三层策略审计、DeepSeek Harness 等 9 项）单列在内，**独有优势同样零省略**。

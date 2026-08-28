# wxnodus 红线与完善规划 v2（重定义稿 · 2026-08-28）

> **定位**：本稿把散落的历史约束（2026-08-21 四约束、08-21 离线裁撤二次裁决、08-28 数据主权修订、
> 各审计不变量、lint/DSH 红线）归一为**两层红线体系 + 五轨完善规划**，供用户重新定义确认。
> **确认后**：本稿升格为唯一治理事实源，同步折叠进 AGENTS.md 会话注记段；与旧文档冲突处以本稿为准。
> 红线变更规则：A 层（产品红线）仅用户明示裁决可改；B 层（工程红线）由门禁强制，改需同修门禁与测试。

---

## 一、红线体系

### A 层 · 产品红线（用户裁决——变更须明示）

| # | 红线 | 口径（含历次修订后终态） |
|---|---|---|
| **A1 数据主权** | 默认全本地（会话/记忆/密钥/审计）；**出机仅经用户显式动作与用户自有通道**（/bundle publish 推自有 Git remote、用户自行上传 GitHub 等平台、自迭代外发）；wxnodus **绝不自动外发**、绝不建托管/账号体系（08-28 修订终态） |
| **A2 生态只收不出（/market）** | 消费公开源（npm/GitHub topic 聚合+校验）；发布侧=用户 remote（A1）；无中心服务、无发布通道 |
| **A3 CLI 主体对齐同类** | 机制语义参考（codex/gemini-cli/opencode/kimi-cli/crush/aider），**不抄代码/文案/命名**；互通契约（OpenAI 协议/MCP/ACP/AGENTS.md/补丁语法）不算抄；每对齐项三件套：参考锚点+本仓落点+差异如实记录 |
| **A4 独有功能冻结维护** | 黑洞记忆、/build、UIA、winSandbox、ACP/A2A、/jobs+/cron、成本计价——只修缺陷保兼容，不加新独占特性 |
| **A5 用户两大权力** | ①自主升级：检查/跳过/回退/气隙 --file，**绝不自动安装**，失败保持旧版可运行；②产物迁移兼容：破坏兼容的改动必须携带迁移器 |
| **A6 无账号无订阅** | 不引入登录流/订阅/云遥测；密钥走本地 AES-256-GCM |
| **A7 模型开放接入** | 任意 OpenAI 兼容端点（DeepSeek Harness 与未来 GLM-5.3 等特性卡并存）；不锁定厂商 |

### B 层 · 工程红线（代码不变量——门禁强制，PR 违者拒）

| # | 不变量 | 强制点 |
|---|---|---|
| **B1 审批 fail-closed** | 未装配审批=拒绝；一切放行留痕（审计/notice）；敏感路径匹配下沉全写类工具 | permissions/audit 测试 |
| **B2 密钥安全** | AES-256-GCM 机器指纹；明文不落盘/不回显/不进 hook 子进程 env | fileCrypto/redact/env 测试 |
| **B3 图片守卫（DSH-3）** | dataUrl 绝不进非视觉模型请求体（能力门→历史文本化→发送前闸门→视觉通道降级 四层） | kernel-image-guard |
| **B4 提示注入防线** | 外部/危险工具输出必 <untrusted_tool_result> 包裹+包裹面限流；vault 值输出脱敏 | tools/toolOutput 测试 |
| **B5 事件闭环与诚实标注** | 回合必发 agent.message+agent.end；run.final 恰一次；截断/缓存/蒸馏/中断/合并必带显式标注；ok 不从文本推导 | 事件契约测试 |
| **B6 渲染零猜测** | 颜色/折叠/终态由结构化字段（outcome/severity/scope）决定，渲染层禁内容正则猜态 | lint+矩阵测试 |
| **B7 前缀缓存字节稳定（DSH-2）** | 系统提示会话内冻结、消息固定键序、归一化幂等、tool/tool_calls 永不合并 | historyNormalize/providers 测试 |
| **B8 无死接线** | 安全/预算机制必须真实接线（ESM 禁 require——vitest 垫片教训）；灰度开关失效类缺陷同等对待 | C1 回归测试族 |
| **B9 分层纪律** | 依赖只向下（domain 不 import 上层）；工具执行必经 canonical 管线+RunContext；L1 无 debugger、L2 内核层禁 process.exit | check-cycles + lint |
| **B10 出站纪律** | 全部出站经统一 fetch（SSRF 判定先于代理、私网默认直连）；本地端口只绑 127.0.0.1+token；MCP env: 引用缺失 fail-closed | ssrf/outboundFetch/mcp 测试 |

### 决策点（待用户拍板——当前缺省值如下）

| # | 议题 | 当前缺省 | 待确认 |
|---|---|---|---|
| D-1 | 企业策略深度（GPO 下发） | **不做**（08-28 排除） | 维持？ |
| D-2 | 双机真机电池/真实 feed 升级 e2e | **不做**（08-28 排除）；发布管线证据流留人工 | 发布前是否恢复一次？ |
| D-3 | GLM-5.3 主模型切换 | 迁移计划已立（P0 实测→P1 适配→P2 双轨），未执行 | 何时启动 P0？ |
| D-4 | 云端会话分享（kimi/opencode 云链接形态） | **不做**（A1/A6 推导） | 维持？ |
| D-5 | 通知持久化（P2-C） | 观察项 | 升入哪一轨？ |

---

## 二、完善规划（五轨 · 自 4.0.0 起）

**基线**：4.0.0（commit 28454ee8）——内核可靠性第一梯队 + 薄层 kimi TUI T1-T12 + ci 九命令全绿 + 数据主权修订。

### 轨 A · SDK 成包（最高优先——生态面唯一大缺口）
| 卡 | 内容 | 量级 | 依赖 |
|---|---|---|---|
| A-S1 | `--serve --sdk` 握手（stdout 单行 JSON：port/token/pid/version；随机 token 不落盘）+ PROTOCOL_VERSION | 1 天 | — |
| A-S2 | `@wxnodus/sdk`：spawn-attach + typed client（/rpc+/events/审批应答/取消/kill）+ 真实子进程集成测试 | 2-3 天 | A-S1 |
| A-S3 | MCP surfaces 补齐 build/verify/evidence（browser/computer 维持高危默认关）——多语言 SDK 即得 | 2-3 天 | — |
| A-S4 | `@wxnodus/core` 进程内门面（WxnodusAgent：session/sendStream 迭代器）+ semver 承诺面文档 | 1-2 天 | — |
| A-S5 | CI 配方（Action/预提交示例）+ SDK README + 密钥注入指引 | 1 天 | A-S2 |

### 轨 B · GLM-5.3 迁移（决策 D-3 后启动）
P0 端点实测矩阵（连接/流式/usage/工具/图片/缓存字段，产出特性卡）→ P1 六卡适配（视觉放行表/REASONING_FIELDS/1M 窗口钳制/成本字段/img 技能/文档）→ P2 切换+3 天双轨 → P3 保障（DeepSeek Harness 不删，回滚=改 model id）。

### 轨 C · 质量收尾
| 项 | 说明 |
|---|---|
| C-1 通知持久化（D-5） | 未消费后台通知跨重启不丢（durable queue 同待遇） |
| C-2 剩余 C 级债 | 8-21 审计未消化项（FTS 外部内容表/grep `--` 注入/evidence 轮转等——见 production-plan §5） |
| C-3 H3 backlog | usage 终端图表/bench 竞品同机对照/textInput 拆分收尾（薄层 TUI 后重估） |

### 轨 D · 发布运营
| 项 | 说明 |
|---|---|
| D-1 发布管线人工段 | freeze-candidate→package-installer→干净安装冒烟→finalize（需用户发布决策时执行） |
| D-2 分发面上架 | winget/scoop 三文件（已备）提交；npm publish（@wxnodus/sdk 随轨 A） |
| D-3（可选，D-2 决策点）真机电池 | HC-1 五组/HC-2 真实 feed——恢复与否待拍板 |

### 轨 E · TUI 演进（按需）
| 项 | 说明 |
|---|---|
| E-1 上下文水位段 | 需 gateway usage 查询 RPC（ecosystem-plan G-10/G-11 一并解决） |
| E-2 vim 层评估 | 从 backup 分支按「机制参考」重写（不复原）；需求驱动 |
| E-3 /share --git | 会话级发布变体（gitPublish 模块直接复用） |

### 轨间依赖
A（SDK）独立可启；B 依赖 D-3 决策；D 依赖用户发布意图；C/E 常驻穿插。建议顺序：**A-S1→A-S2 并行 B-P0 → A-S3/S4/S5 → C-1 → 其余按需**。

---

*本稿为重定义草案：用户逐条确认/修订后，替代各历史文档中的约束表述（master-plan §1.1/约束修订块/architecture §1 定位行按此同步）。*

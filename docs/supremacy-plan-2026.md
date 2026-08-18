# 超越计划（Supremacy Plan）——7.25 → 8.7+（总分第一）

> **2026-08-18 修订：Windows-only 版**（用户决策「只做 Windows」）——移除沙盒三平台化（原阶段 3.2），
> POSIX 实现（bwrap/Seatbelt，591cebf）保留**休眠态**（探测诚实返回不适用，零维护），⑥ 冲 10 改走「Windows 深度」路径。

> 2026-08-18 定稿。目标不再是与竞品同档，而是**总分超越 codex（8.69）成为 7 家第一**。
> 本文档是单一事实源：上下文总结 + 现状基线 + 11 维逐维超越路径 + 三阶段执行计划 + 阻塞项。
> 关联文档：评分 `docs/cli-deep-analysis-score-2026.md`、缺陷 `docs/defect-register-2026.md`、
> 路线图 `docs/ide-remote-share-roadmap-2026.md`。执行红线：参考机制不抄袭（AGENTS.md 约束）。

---

## 0. 上下文总结（截至本计划前全部工作）

**三轮评审**（六家克隆于 `Desktop\cli-compare\`，全部结论 file:line 可溯）：
1. `cli-comparison-2026.md`——能力矩阵/臃肿度：wxnodus 44 工具 109 命令 vs 六家；
2. `cli-implementation-gap-2026.md`——五层实现差距 + P0-P3 落地路线；
3. `cli-deep-analysis-score-2026.md`——11 维加权评分，初评 **6.14（第 6/7）**。

**五个落地轮**（每轮 npm run ci 七步全绿 + audit 实录）：
- 基础轮：7-CLI 深评、规则脑删除、/build 单通道、前缀缓存稳定、wire/stream-json、stdin 管道、CHANGELOG//update/manifests、ci 门禁、handlersExt 拆分、分层泄漏修复；
- 补齐轮（1ec26e1）：**OS 内核沙盒**（标准用户实测校准：受限令牌 1314 证伪→Low IL）、**apply_patch**、**并行调度**、**输出 offload/掩码/蒸馏**、**LSP 三工具**、硬编码点名项清零——6.14→**7.25 第 4/7**；
- 深化轮（2a188d1）：循环检测分级（提醒→硬停+输出指纹+chanting）、阈值全量 settings 化（25 键）；
- 生态轮（79c3226）：会话血缘（SCHEMA v9）、approve_for_session 真实授权、结构化会话列表；
- 分享轮（1c1f879）：`/share` 离线加密打包、缺陷寄存器（21 项）、IDE/远程路线图。

**当前基线**（HEAD 1c1f879，工作树干净）：48 内置工具 · 2458+ 测试 · SCHEMA v9 · wire/serve/ACP/A2A/stdin 五协议面 · Windows OS 沙盒 L0-L3 · 评分 **725**。

## 1. 超越的定义（可验收）

1. **总分 ≥ 870**（超 codex 8.69，成为第一）；
2. **≥3 个维度全场第一**（现有 ① 渲染 10、⑪ 差异化 8 已第一；新增 ④ 或 ⑥ 或 ⑩ 并列第一）；
3. **生态有真实消费者**（IDE 插件或桌面端真实跑通 wire/serve 协议——不是纸面协议）；
4. 全程不违反：数据不出机红线、诚实工程口径、参考不抄袭约束。

## 2. 11 维逐维超越路径（现状 → 目标 → 动作 → 对标锚点）

| 维度 | 现状 | 目标 | 关键动作（对标） | 提分 |
|---|---|---|---|---|
| ① 渲染（9） | **10 第一** | 10 保持 | resize 闪烁与 blit O(subtree) 扫描两项残留优化（自身路线） | — |
| ② 输入（9） | 5 | 9 | vim 真模态接线或摘除 + keymap 配置层（codex `keymap.rs` 思想）+ @文件选择器 | +36 |
| ③ diff/媒体（8） | 4 | 8 | diff hunk 折叠/apply 操作（opencode `[`/`]` hunk 跳转）+ 图片渲染路径（is_image 接线）+ which-key | +32 |
| ④ Agent（13） | 9 | **10** | LLM 辅助循环检测（gemini 置信度判空转）+ 按模型工具裁剪（codex）+ 子代理分型（explorer/awaiter 低 effort）+ 结构化输出 | +13 |
| ⑤ 提示词（11） | 6 | 9 | 分族提示词（deepseek/glm/kimi 定制段——新模块承载，kf-029 零 CJK 红线不破）+ 小模型任务档（crush large/small）+ API 级 prompt caching 深化 | +33 |
| ⑥ 安全（10） | 9 | **10（Windows 深度口径）** | **Windows 双态沙盒**（提权→受限令牌 codex 级 / 标准用户→Low IL 已实测）+ execpolicy 首词规则（codex `policy.rs`）+ 审批持久化——Windows-only 产品的满分论据是「目标平台深度第一」，评分表注明口径 | +10 |
| ⑦ 场景（11） | 8 | 10 | IDE 插件（wire 零协议新增）+ 远程执行 ssh 通道 + CI 集成 + 桌面端协议加固（路线图文档） | +22 |
| ⑧ 分发（9） | 5 | 9 | 真实发布（winget/scoop）+ 用户文档三件套（getting-started/troubleshooting/examples）+ 插件市场（需 remote/托管） | +36 |
| ⑨ 工程（8） | 7 | 9 | 远程 CI + lint + madge 循环依赖 + perf 基准目录（gemini perf-tests） | +16 |
| ⑩ 性能（7） | 8 | 9 | 成本五维+Decimal（opencode）+ 任务档路由（标题/摘要走小模型） | +7 |
| ⑪ 差异化（5） | **8 第一** | 10 | 把差异化**变现**：离线四模态+黑洞记忆+Computer Use+桌面端 = 生态闭环（唯一性溢价） | +10 |

理论上限 ≈ 940（10+9+8+10+9+10+10+9+9+9+10 加权）；**超越线 870** 只需完成大部分（见阶段表）。

## 3. 三阶段执行计划

### 阶段 1「内核登顶」（0 外部依赖，本地完成）→ 725 → ~790
| # | 任务 | 缺陷 ID | 对标 | 验证 |
|---|---|---|---|---|
| 1.1 | 分族提示词（新模块 providerPrompts.ts） | A-02 | gemini 分族 | 单测：各 provider 段注入正确 |
| 1.2 | 小模型任务档（标题/摘要路由，settings.titleModel） | A-03 | crush large/small | 单测：路由判定纯函数 |
| 1.3 | 按模型工具裁剪（maxContext/能力门驱动 schema 选择） | A-04 | codex | 单测：裁剪集正确 |
| 1.4 | 成本五维 + Decimal（usage_stats 三列迁移 v10） | A-06 | opencode | kf-030 版本同步+成本测试 |
| 1.5 | LLM 辅助循环检测（置信度判空转，开关默认关） | A-05 | gemini | agent 流测试 |
| 1.6 | 命令面瘦身 109→~45（聚合同能力入口） | A-01 | gemini 47 | 命令契约定向全绿 |
| 1.7 | execpolicy 首词规则（bash 前缀索引+Decision max） | B-06 | codex | 规则匹配单测 |

### 阶段 2「生态上车」（需要 git remote 与桌面端决策）→ ~790 → ~840
| # | 任务 | 缺陷 ID | 前置 | 验证 |
|---|---|---|---|---|
| 2.1 | IDE 插件 packages/vscode-ext（wire 桥接+webview+approval 模态） | S-03 | 无 | typecheck+build+本地 vsix 打包 |
| 2.2 | 远程执行 ssh 通道（settings.remote，bash 转发+诚实标注） | S-04 | 无 | mock ssh 单测（不真连） |
| 2.3 | 用户文档三件套 | S-01 | 无 | 文档链接契约 |
| 2.4 | **git remote + GitHub Actions CI** | C-01 | **用户操作** | workflow 绿 |
| 2.5 | 桌面端协议加固（serve 会话 RPC 面补齐 + SSE 会话变更事件） | — | 用户定接入方式 | 协议测试 |

### 阶段 3「超越收官」→ ~840 → 870+
| # | 任务 | 缺陷 ID | 前置 | 验证 |
|---|---|---|---|---|
| 3.1 | winget/scoop 真实发布 | S-01 | remote | 真实 URL+sha256 |
| 3.2 | ~~沙盒三平台化~~（已移除，POSIX 休眠）→ **Windows 双态沙盒**（提权走受限令牌、标准用户走 Low IL，探测如实报告双态） | ⑥ | 无 | 标准用户分支本机实测；提权分支探测诚实报告 |
| 3.3 | vim/keymap + @选择器 + diff 折叠/apply | B-01/02 | 无 | 输入层测试 |
| 3.4 | 插件市场（托管清单+远端技能安装） | S-02 | remote | 市场安装闭环 |
| 3.5 | perf 基准目录 + lint + madge | C-01/03 | 无 | ci 挂载 |
| 3.6 | 超越复评：重跑 11 维评分 ≥ 870 | — | 全部 | score 文档更新 |

## 4. 超越级差异化（只有 wxnodus 能打的牌）

- **离线四模态 + 黑洞记忆 + Computer Use + 桌面端** 组合是六家无人有的「单机全栈」——阶段 2/3 的桌面端与 IDE 插件把它从「能力」变成「生态」；
- **Windows-only 定位**：六家中 wxnodus 是唯一「Windows 原生深度」产品（渲染/ConPTY/UIA/沙盒双态）——超越叙事的差异化卖点 = 「Windows 最强 agent CLI」，而非「跨平台跟随者」；
- **诚实工程文化**（labelTruncate/探测降级/退出码协议/审计哈希链）是长期口碑资产，任何超越动作不得退化；
- 每阶段收尾都跑 `npm run ci` + 评分复算 + audit 实录——超越必须有分数证据，不靠口号。

## 5. 阻塞与用户前置操作（需用户完成）

1. **git remote**（阶段 2 解锁：CI/发布/市场全部依赖）；
2. **桌面端接入方式决策**：`--serve`（HTTP+SSE，推荐）还是 stdio `--wire`——决定 2.5 的协议面优先顺序；
3. **DeepSeek 密钥**（`/model set-key`）——余额护栏与 LLM 辅助循环检测的真机验证需要；
4. ~~mac/Linux 环境~~（已移除——Windows-only 决策）；改为：**管理员环境**（Windows 双态沙盒的提权分支实测前提，非阻塞）。

## 6. 每轮执行协议（不变）

参考不抄袭（机制+锚点→原创实现）→ tsc 零错误 → 定向测试 → 全量 → `npm run ci` 七步 → 文档同步（gap/score/register/CHANGELOG）→ audit §13.x 如实记录 → commit。任何「已落地」必须有测试与实测证据；做不到如实标注阻塞，绝不虚报。

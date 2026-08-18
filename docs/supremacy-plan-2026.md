# 超越计划（Windows-only 版）——7.25 → 8.7+（总分第一）

> 2026-08-18 定稿（用户决策「只做 Windows」后的完整重写版，替代早期含三平台化的草稿）。
> 定位：**Windows 最强 agent CLI**——不追求跨平台跟随，追求目标平台深度第一。
> 关联文档：评分 `docs/cli-deep-analysis-score-2026.md`（当前 7.25，第 4/7）、缺陷寄存器
> `docs/defect-register-2026.md`、路线图 `docs/ide-remote-share-roadmap-2026.md`。
> 执行红线：参考机制不抄袭（AGENTS.md 约束）、数据不出机、诚实口径（未实测不宣称）。

---

## 0. 上下文总结（全部工作全链路）

**三轮评审**（六家克隆于 `Desktop\cli-compare\`，结论 file:line 可溯）：
1. `cli-comparison-2026.md`——能力矩阵/臃肿度；
2. `cli-implementation-gap-2026.md`——五层实现差距 + P0-P3 路线；
3. `cli-deep-analysis-score-2026.md`——11 维加权评分，初评 **6.14（第 6/7）**。

**六个落地轮**（每轮 npm run ci 七步全绿 + audit §13.x 实录）：
| 轮 | commit | 内容 |
|---|---|---|
| 基础 | 4f424af…22153ad | 7-CLI 深评、规则脑删除、wire/stream-json/stdin、前缀缓存、ci 门禁、handlersExt 拆分、分层修复 |
| 补齐 P0 | 1ec26e1 | OS 沙盒（Windows 实测校准）、apply_patch、并行调度、输出 offload/掩码/蒸馏、LSP、硬编码点名清零 → **7.25** |
| 深化 | 2a188d1 | 循环检测分级、阈值全量 settings 化（25 键） |
| 生态 | 79c3226 | 会话血缘（v9）、approve_for_session 真实授权、结构化会话列表 |
| 分享 | 1c1f879 | /share 离线加密打包、缺陷寄存器、IDE/远程路线图 |
| 沙盒门面 | 591cebf | 三平台门面 + POSIX 实现（bwrap/Seatbelt，**休眠态**） |
| 决策 | 3eef203 | Windows-only 范围收敛（本版计划） |

**当前基线**（HEAD 3eef203）：48 内置工具 · 2469+ 测试 · SCHEMA v9 · 五协议面（wire/serve/ACP/A2A/stdin）· Windows 沙盒 L0-L3（标准用户实测）· 评分 **725**。

## 1. 超越的定义（可验收）

1. **总分 ≥ 870**（超 codex 8.69，7 家第一）——Windows-only 理论天花板 ≈ 940，870 可达；
2. **≥3 个维度全场第一**（① 渲染 10、⑪ 差异化 8 已第一；再夺 ④/⑥/⑩ 任一）；
3. **生态有真实消费者**（IDE 插件或桌面端真实跑通 wire/serve 协议）；
4. 红线不破：数据不出机、诚实口径、参考不抄袭。

## 2. 11 维逐维路径（Windows-only）

| 维度 | 现状 | 目标 | 关键动作（对标锚点） | 提分 |
|---|---|---|---|---|
| ① 渲染（9） | **10 第一** | 10 保持 | resize 闪烁 + blit O(subtree) 两项残留优化 | — |
| ② 输入（9） | 5 | 9 | vim 接线/摘除 + keymap 配置层（codex keymap 思想）+ @文件选择器 | +36 |
| ③ diff/媒体（8） | 4 | 8 | diff hunk 折叠/apply（opencode hunk 跳转）+ 图片渲染接线 + which-key | +32 |
| ④ Agent（13） | 9 | **10** | LLM 辅助循环检测（gemini）+ 按模型工具裁剪（codex）+ 子代理分型 + 结构化输出 | +13 |
| ⑤ 提示词（11） | 6 | 9 | 分族提示词（新模块，零 CJK 红线不破）+ 小模型任务档（crush）+ API 级 caching 深化 | +33 |
| ⑥ 安全（10） | 9 | **10（Windows 深度口径）** | **双态沙盒**（提权→受限令牌 codex 级 / 标准用户→Low IL 已实测）+ execpolicy 首词规则 + 审批持久化 | +10 |
| ⑦ 场景（11） | 8 | 10 | IDE 插件（wire 零协议新增）+ 远程 ssh 通道 + CI 集成 + 桌面端协议加固 | +22 |
| ⑧ 分发（9） | 5 | 9 | winget/scoop 真实发布 + 用户文档三件套 + 插件市场（需 remote） | +36 |
| ⑨ 工程（8） | 7 | 9 | 远程 CI + lint + madge + perf 基准（gemini perf-tests） | +16 |
| ⑩ 性能（7） | 8 | 9 | 成本五维+Decimal（opencode）+ 任务档路由 | +7 |
| ⑪ 差异化（5） | **8 第一** | 10 | 差异化变现：离线四模态+黑洞记忆+Computer Use+桌面端 = Windows 单机全栈生态 | +10 |

**Windows-only 口径**：⑥ 的 10 分论据是「目标平台深度第一」（双态沙盒 + 纵深防御清单），不是平台广度；评分表注明口径，提权分支未经实测前不宣称 10。

## 3. 三阶段执行计划

### 阶段 1「内核登顶」（0 外部依赖）→ 725 → 754（✅ 收尾复算 2026-08-18，七项全绿）
| # | 任务 | 缺陷 ID | 对标 | 验证 | 状态 |
|---|---|---|---|---|---|
| 1.1 | 分族提示词（providerPrompts.ts 新模块） | A-02 | gemini | 单测：各 provider 段注入正确 | ✅ 7 用例 |
| 1.2 | 小模型任务档（标题/摘要路由） | A-03 | crush large/small | 路由纯函数单测 | ✅ 9 用例 |
| 1.3 | 按模型工具裁剪 | A-04 | codex | 裁剪集单测 | ✅ 11 用例 |
| 1.4 | 成本五维 + Decimal（usage_stats v10） | A-06 | opencode | kf-030 同步 + 成本测试 | ✅ v10+14 用例 |
| 1.5 | LLM 辅助循环检测（开关默认关） | A-05 | gemini | agent 流测试 | ✅ 7 用例 |
| 1.6 | 命令面瘦身 109→~45 | A-01 | gemini 47 | 命令契约定向全绿 | ✅ 47 主干+63 扩展（7 用例+103 回归） |
| 1.7 | execpolicy 首词规则 + 审批持久化 | B-06 | codex | 规则匹配单测 | ✅ 8 用例（含安全等价断言） |

### 阶段 2「生态上车」（需 git remote 与桌面端决策）→ 754 → ~840
| # | 任务 | 缺陷 ID | 前置 | 验证 | 状态 |
|---|---|---|---|---|---|
| 2.1 | IDE 插件 packages/vscode-ext（wire 桥接 + webview + approval 模态） | S-03 | 无 | typecheck + build + 本地 vsix | ✅ typecheck+4 单测+vsix 7.6KB（另修复 wire 审批广播缺口 + 4 用例） |
| 2.2 | 远程执行 ssh 通道（诚实标注「远端未沙盒」） | S-04 | 无 | mock ssh 单测 | ✅ 10 用例 + /remote 命令 + bash 远程分支 |
| 2.3 | 用户文档三件套（getting-started/troubleshooting/examples） | S-01 | 无 | 链接契约 | ✅ 4 契约用例（另抓到 /share /balance 注册表缺口已修） |
| 2.4 | **git remote + GitHub Actions CI** | C-01 | 用户操作 | workflow 绿 | ⏳ 待用户提供 remote |
| 2.5 | 桌面端协议加固（serve 会话 RPC + SSE 会话变更事件） | — | 用户定接入方式 | 协议测试 | ⏳ 待用户决策 --serve vs --wire |

### 阶段 3「Windows 收官」→ ~840 → 870+
| # | 任务 | 缺陷 ID | 前置 | 验证 |
|---|---|---|---|---|
| 3.1 | winget/scoop 真实发布 | S-01 | remote | 真实 URL + sha256 |
| 3.2 | **Windows 双态沙盒**（提权受限令牌 + 标准用户 Low IL，探测双态如实报告） | S-07 | 管理员环境（非阻塞） | 标准用户分支实测；提权分支探测诚实 |
| 3.3 | vim/keymap + @选择器 + diff 折叠/apply | B-01/02 | 无 | 输入层测试 |
| 3.4 | 插件市场（托管清单 + 远端技能安装） | S-02 | remote | 市场安装闭环 |
| 3.5 | perf 基准 + lint + madge | C-01/03 | 无 | ci 挂载 |
| 3.6 | 超越复评：11 维评分 ≥ 870 | — | 全部 | score 更新 |

## 4. Windows 深度差异化（超越叙事的核心卖点）

- **「Windows 最强 agent CLI」**：渲染深度第一 + ConPTY/UIA 真机验收 + 沙盒双态——六家无人有的 Windows 原生深度组合；
- **单机全栈**：离线四模态 + 黑洞记忆 + Computer Use + 桌面端（用户自制）= 数据不出机的完整闭环；
- **休眠资产**：POSIX 沙盒实现（bwrap/Seatbelt，591cebf）保留不删——探测诚实返回不适用、零维护，未来改主意即插即用（不在本计划优先级内）。

## 5. 阻塞与前置（需用户操作）

1. **git remote**（阶段 2 全部：CI/发布/市场）；
2. **桌面端接入方式决策**：`--serve`（HTTP+SSE，推荐）或 stdio `--wire`——决定 2.5 协议面顺序；
3. **DeepSeek 密钥**（`/model set-key`）——余额护栏与 LLM 辅助检测真机验证；
4. 管理员环境（阶段 3.2 双态沙盒提权分支实测，非阻塞）。

## 6. 每轮执行协议（不变）

参考不抄袭（机制 + 锚点 → 原创实现）→ tsc 零错误 → 定向测试 → 全量 → `npm run ci` 七步 → 文档同步（score/register/CHANGELOG）→ audit §13.x 如实记录 → commit。任何「已落地」必须有测试与实测证据；做不到如实标注阻塞，绝不虚报。

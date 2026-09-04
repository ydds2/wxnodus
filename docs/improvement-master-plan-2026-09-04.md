# wxnodus 现状完善总方案（2026-09-04）

> 基线：126 条命令 · 219 用例回归绿 · TUI 45+ 真机断言 · `/watch`（视频流+模板任务链）· `/oasis`（status/health/topo）· `/modpack`（兼容矩阵整合包）· `/channel`（snapshot/release 双渠道）全部落地。
> 进度：第一批 A1–A5 已闭环（A4 待官方发布）；**第二批 B1 + B3 已闭环（2026-09-04，3031 用例全绿 + 真机证据）**；第三批 B2、第四批 C 待执行。
> 本方案只列「现状 → 目标」的增量项；每一项带实现点、验收标准与预估成本。已闭环项不重复。

---

## A. 缺陷修复（D1–D6，半小时级/项）

| # | 项 | 方案与实现点 | 验收 | 状态 |
|---|---|---|---|---|
| A1 | **无密钥 `-p` 退出码语义**（D1，唯一中等级） | 非交互分支：无密钥时 exit 3；`--json` 输出 `status:"unconfigured", ok:false, error:{code:"NO_API_KEY"}`；`--wire` 事件流 `agent.error` 同码 + `run.final(status:unconfigured)`；TUI 引导文案不变；判定与内核同谓词（resolveApiKey） | 契约测试 + 实测 `$LASTEXITCODE=3` | ✅ 已落地（真机三态验证；legacy 开关下旧行为保持） |
| A2 | 文案三件套（D2/D3/D4） | `--help` 头 V3→V4（**args.ts 与 i18n cli.usage 双语目录双锁**）+ package.json description；README「算一下」行标注 `WXNODUS_LEGACY_OFFLINE=1`；`--help` 补齐 `--data-dir/--workspace/--output-schema/--ephemeral` | 实测输出 + docs 门禁 | ✅ 已落地（zh/en --help 实测 V4 + 旗标齐全） |
| A3 | `/model` 目录 offline 行治理（D5） | offline 两行标注「legacy——WXNODUS_LEGACY_OFFLINE=1 启用」 | 选择器实测 | ✅ 已落地 |
| A4 | 默认更新 feed（D6） | 官方 Release 发布后 settings.updateFeed 默认指向 version manifest 源 | `update --check` 新装即出远程版本 | ⏳ 待发布（**2026-09-04 用户裁决：不上架 npm**——分发主线 = GitHub Release 直装 + scoop/winget；本项仅待 GitHub Release 发布，与 npm 渠道解耦） |
| A5 | **文案防漂移测试**（治本） | `tests/cli-surface-copy.test.ts`：--help 头（args.ts + i18n 双语目录双锁）、package.json description、README 承诺行、user-guide 行数 = SLASH.length、QUICK desc 计数 | 6 用例绿 | ✅ 已落地 |

## B. 内核完善（P1，各 1–2 小时 + 契约测试）

| # | 项 | 方案 | 验收 | 状态 |
|---|---|---|---|---|
| B1 | 卡死自愈与体检 | `WXNODUS_HEARTBEAT` 默认开启轻量版（2s 心跳成本≈0）；`/doctor` 增「孤儿进程/心跳断档」体检项（扫描 wxnodus/zcode 残留进程树） | 8/30 事故场景复现：体检项检出孤儿；心跳断档可定位 | ✅ 已落地（心跳默认开启 + 行尾 pid；`/doctor` 孤儿进程/心跳探针两项；`src/kernel/processScan.ts` 进程枚举单一事实源；真机证据：模拟 tmp-n9 孤儿 + 120s 陈旧心跳 → doctor 双项如实检出） |
| B2 | 命令执行进程树回收 | bash/工具 spawn 层统一 Job Object（复用 winSandbox Low IL 设施）或 `taskkill /T`；cancel/超时/退出三路径全树终止 + 60s 兜底强杀 | 孤儿复现测试：中断后孙进程零残留 | ✅ 已落地（2026-09-04 第三批：`src/kernel/processTree.ts` 终止单一事实源——win32 `taskkill /T /F`（taskRunner 同族范式）+ posix 诚实降级；bash 普通路径弃 `spawn({signal})` 单杀改 abort 监听全树强杀（用户中止/空闲/硬顶三路径共用 combined signal，即时强杀优于 60s 兜底）；沙盒路径 Job Object 本就全树回收；验收测试 `tests/kernel-process-tree.test.ts` 4 用例——真实 powershell+node 孙进程，中止/超时两路径零残留实测 + 已退 pid 诚实「已不在」+ 非法 pid fail-closed） |
| B3 | MCP 进程治理 | `/mcp list` 增内存/在线状态列（探活复用 /oasis health 链路）+ 闲置自动下线策略（可选开关） | 30 进程 1.3GB 场景可观测可回收 | ✅ 已落地（`/mcp list` 在线/pid/内存/工具/最后调用/错误列；`/mcp status` 未连接条目真实 initialize 探活（项目未信任拒绝探活）；`/mcp idle on 秒(30–3600)` 闲置自动下线——在途豁免、夹取秒级阈值、进程回收优先于工具表同步、清扫异常落 error 日志；真机证据：真实 stdio server 47.3MB 工作集展示 + 闲置 30s 后进程真实消亡（stdin-end→exit）） |
| B4 | PTY 测试进 Windows CI | `smoke:tui`/`e2e:tui`（20 断言）纳入 GitHub Actions windows-latest（AttachConsole 豁免已有） | PR 门禁含交互层回归 | ⏳ 随批次顺带 |
| B5 | wire 协议版本化 | 事件流首帧携带 `protocolVersion`（serve 握手已有——对齐） | IDE 插件侧契约测试 | ⏳ 随批次顺带 |

## C. 体验完善（P2）

| # | 项 | 方案 | 验收 |
|---|---|---|---|
| C1 | OASIS M3 协议桥 | `/oasis bridge export <MCP> --as agent-card`：MCP 工具集 → A2A agent card；反向 `--mcp-server --tools` 白名单发布 | 本地环回：agent card → messages/send → 工具调用闭环 |
| C2 | OASIS M4 全链路追踪 | `/oasis trace <correlationId>`：audit+session-stream+evidence 三源合并投影 | e2e mock 带工具回合 → trace 还原 ≥4 段 |
| C3 | OASIS M5 运行时面板 | 帮助面板第 4 页「运行时」（数据源与 /oasis 同源共享模块——零漂移） | PTY Tab×3 到达，计数与命令面一致 |
| C4 | 模型选择器体验 | 「最近使用」置顶（复用 /model 切换缓存数据）；`/model add` 表单保存时自动 probeEndpoint 一次 | 选择器 PTY 实测 |
| C5 | 黑洞召回时间衰减 | recallHybrid 命中排序加 recency 因子（session scope 不变） | 新旧记忆召回序实测 |
| C6 | ACP 能力补全 | initialize 上报 `supportsEdit: true` 路径（现 false——Zed/JetBrains 编辑级集成差距） | ACP 握手实测 |

## D. 环境补验（条件触发，非代码缺陷）

| # | 项 | 触发条件 | 补验命令 |
|---|---|---|---|
| D-a | ddagrab 真机捕捉 | 换含 D3D11 转换的 ffmpeg 构建或原生 addon | `/watch start --backend ddagrab` → status 显示 ddagrab + 帧数 |
| D-b | moondream2 真机推理 | 网络放行 HF 模型文件路径（API 已通、文件路径被拦） | `$env:WXNODUS_HF_ENDPOINT='https://hf-mirror.com'` → `/watch start --tier l2` |
| D-c | 真机审批点击闭环 | 用户在场批准 | `/watch chain`（click 动作）→ 审批 allow → 点击 → OCR 验证 → `/watch clip` 回放 |

## E. 执行节奏建议

1. **第一批（一次会话）**：A1–A5——文案/语义修复 + 防漂移测试（总量小、风险低、第一印象收益最大）；✅ 已闭环
2. **第二批**：B1 + B3（卡死体检 + MCP 治理——8/30 事故直接教训）；✅ 已闭环（2026-09-04）
3. **第三批（2026-09-04 启动）**：**B2 进程树回收**（bash 非沙盒路径三路径树杀——taskkill /T /F 提炼自 taskRunner 范式 + 孤儿零残留契约测试）+ **Q3 hasDist 静默 skip 治理**（tests/support/distGate.ts 统一门——dist 缺失显式红 + 逃生口）+ **K4a agent.ts 尾部 DSL 纯函数外移 agentShared**（2133 行第一刀机械拆分；K4b 闭包内三段拆分另批专项）；✅ 已闭环（B2 见上行；Q3：`tests/support/distGate.ts` 统一 dist 门——4 个 hasDist 文件接线，缺 dist 显式红 + `WXNODUS_TEST_ALLOW_NO_DIST=1` 逃生口；K4a：agent.ts 2133→2088——WxScript DSL 类型/`substituteVars`/`safeJson`/`isPathWithinCwd`/`ARGS_PARSE_ERROR_KEY` 外移 agentShared 并 re-export 零破坏）；
4. **第四批**：C1→C3（OASIS 收尾）→ C4/C5/C6；
5. B4/B5 随各批顺带；D 项条件具备即补验（每条一个命令）。

> 总原则不变：每一项 = 数据源单一事实 + 诚实失败契约 + 契约测试锁定 + 真机证据；不做清单（离线能力恢复/第二套服务网格/云托管）维持既有裁决。

## F. 清理插队批闭环（2026-09-04，docs/cleanup-batch-plan-2026-09-04.md）

> 评估收尾版 §7 插队建议执行完毕。四步分组（存量→删除→收敛→门禁），净删 **108,133 行 / 548 文件**。

| 项 | 落地 |
|---|---|
| 步骤 0 存量固化 + **修复 master CI** | 根因链三层：① `.gitignore` 无锚定 `migrations//release/` 静默吞源码（git add 跳过）→ 根锚定修复；② build 顺序（swap-dist 后置）在全新 checkout 必红 → 前移；③ typecheck:tests 经 core-facade 依赖构建产物 → paths 映射解耦。另修：新测试 TS 类型 3 处、tui-render 档位同源断言、N2 压缩回归封闭化（CI CRLF checkout 漂移根治）。**master CI 2026-08-29 起连红六天后转绿**（run 33834843578） |
| A2 ink fork 死重 | 四目录 524 文件删除 + README/AGENTS 技术栈文案对齐（官方 Ink 6 + 自研组件层）+ ci.yml ink-dist 工件链三处移除 + vitest/check-cycles 死配置清理；lock 零 diff 核账（fork 不在依赖图证实） |
| A4 双组合根 + hermes-gateway | createApplication + 5 桩 + w1-02 测试 + hermes-gateway/ + 其测试整删（KF-002 retired 台账如实留档） |
| K2 版本解析统一 | selfUpdate/bundle 主三段解析切 semverRange.parseVersion 单一出口；调用方一致性契约锚定 fail 方向语义差异（更新 fail-closed vs 兼容 fail-open 是业务语义非不一致） |
| A5 命令计数防漂移 | registry/tui 文案 SLASH.length 模板派生 + 源码零硬编码测试锁 |
| A7 版本统一 | packages/{core,sdk} → 4.0.2 + publish-local 发布前版本一致性 fail-closed 断言（防再漂移） |
| Q2 registry 审计 | scripts/check-registry-consistency.mjs（126=126=126=126 四表对账）挂 ci |
| Q4 | typecheck:sdk / typecheck:core 入 ci 链 + ci.yml 同源 |
| Q5 | docs-links 死测试复活：三层豁免（历史快照/反引号 token/退役表 /key→/model）对账契约 |
| B4 smoke:tui | 阶段① 本地三连跑绿 ✓；阶段② ci.yml 观察位（continue-on-error）已挂——升格硬门禁条件：连续 ≥5 轮绿或观察一周 |
| 会话副产 | git pushurl 切 SSH-443（本地 7897 代理已死，HTTPS 直连被断——SSH-443 恒通） |

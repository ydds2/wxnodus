# WxNodus 4.0.0-rc.1 → 4.0.0 完善方案（评估驱动 · 2026-08-21）

> **定位**：针对《4.0.0-rc.1 评估报告》（7.6/10）的 A/B/C 缺陷与竞品差异，制订 rc→4.0.0 收口 + 4.1 对齐批的执行计划。
> **战略约束校验（用户四约束，长期有效）**：本方案每卡均经四约束过滤——①市场只收不出（任何「建服务/建仓/账号体系」类提案一律否决）②CLI 主体对齐同类（机制语义不抄代码）③独有功能冻结维护（只修不加）④用户两大权力（自主升级+产物迁移）。
> **基线**：version 4.0.0-rc.1 · 55 提交 · 3,449 测试绿 · ci exit 0 · BENCH_OK。

---

## 第 0 章 总裁决：差异补齐取舍

评估列出的落后差距**不全部补齐**——按约束二「CLI 主体对齐」与约束三「冻结维护」裁决：

| 差距项 | 裁决 | 理由 |
|---|---|---|
| LSP 内联诊断（opencode） | **补**（H2） | 骨架已有（lspClient+feedbackDiagnostics 默认 off），属对齐主体面；成本问题用「可配+低开销默认」解 |
| git 工作流深度（aider auto-commit/逐编辑 undo） | **补轻量**（H2） | /diff+undo-shadows 已有，补「编辑快照挂 git ref」是对齐不是新独占 |
| 真实 feed 升级链实测（kimi） | **补**（H0，A2） | 约束四核心权力，mock 绿≠真链路绿 |
| IDE 扩展/VS Code 插件（codex/gemini） | **不补** | 非 CLI 主体；--serve HTTP 网关已是开放面（第三方可接） |
| 单二进制分发（kimi/crush） | **不补** | Node≥22 硬门槛+zip 安装链（sha256/journal/uninstall）已覆盖 Windows 定位；单二进制工程量大且破坏 npm 生态接入 |
| OAuth 多 provider 登录流（gemini） | **不补** | 「数据不出机+密钥本地 AES-GCM」是定位，OAuth 回调与第三方账号体系违背约束一精神 |
| 插件运行时 extism（gemini） | **不补** | 约束一：消费生态（npm/MCP）不建运行时分发面 |
| 主题生态/skin 市场（crush） | **不补** | 约束一：无分发通道；自定义主题本地能力已有（/theme） |
| 深度 usage 面板（crush/gemini） | **观察**（H3） | /usage//cost//balance 已有，缺的是呈现深度非能力 |
| 崩溃上报 | **本地化替代**（H1） | 不出机约束下做本地 crash 报告（data/crashes/ + doctor 消费），不做遥测服务 |
| 远程 exec 成熟度（codex exec-server） | **不补** | execServer 已有（沙盒远端+token）；补的是实测不是新码——并入 A1 电池 |

---

## 第 1 章 H0 发布收口波（A 级三项 · 4.0.0 前必须 · 3-4 天）

**HC-1 五组手动电池全跑**（A1）· 2 天（真人交互）
- 范围（V4 计划 §5.3 全量）：①中文路径电池（cmd+WT × 启动/中文输入/GBK dir/git log/echo 中文/CRLF 编辑/单字检索）②长任务电池（npm install 全程/30+ 轮任务//jobs 后台+取消）③鲁棒电池（断网 60s 续跑/429 可见/并发审批/Ctrl+C 不退出）④渲染电池（{cmd,WT}×{alt-screen,INLINE}×{cozy,compact,dense} 滚动/resize/overlay/末列）⑤升级电池（装 rc.1→造产物→升级→兼容断言→回退→可用断言）。
- 产出：每电池一份实测记录（docs/ 之外存 release/battery-reports/，不破文档纪律）；发现的缺陷按 S/A 级即时修。
- 验收：五组全过或缺陷登记修复后复过。

**HC-2 真实 feed 升级端到端**（A2）· 1 天
- 步骤：①本地起静态 feed（Python http.server 挂 JSON+zip）②rc.1 环境 `update --apply` 走通下载→sha256→备份→安装→验证→重启③`--rollback` 回退④构造坏 sha256/断网/半包三失败注入——断言旧版可运行⑤`--file` 气隙同链⑥启动 banner 真实触发。
- 验收：六场景全过 + 每步 exit code 与文档一致。

**HC-3 4.0.0 正式打包链**（A3）· 0.5-1 天
- 步骤：①`scripts/package-installer.ts` 实跑产 wxnodus-4.0.0.zip（manifest sha256 闭包+SBOM 断言+ABI 比对）②干净目录装包→`wxnodus doctor` 全绿→`wxnodus -p "hi"` 冒烟③`smoke-installed.mjs` 装上能跑对④freeze-candidate+finalize-release 走完（发布链自校验）⑤版本升 4.0.0、CHANGELOG、tag。
- 验收：虚拟机/干净用户目录装包冒烟绿 + 发布链自校验绿。

---

## 第 2 章 H1 质量收敛波（B 级五项 · 1.5 周）

**HC-4 flaky 根治**（B4）· 1-2 天
- taskRunner「有界终止」/kernel-mcp 超时相位：固定等待改轮询 deadline（仓内既有模式）或时序解耦（子进程 kill 确认后推进）；连跑 5 轮全量零 flaky 为过。

**HC-5 W3 记忆影子收敛决策**（B5）· 2-3 天
- 判据先行：shadowReport 数据（legacy vs modern 计数/召回一致性/失败率）连续会话采样；一致性 ≥99% 且零失败 → 召回切 modern（feature flag settings.memoryRecall='modern' 默认渐进）；不达标 → 修因或回滚影子（双写下线决策同样记录）。
- 验收：决策文档（数据+结论+开关）+ 切换后召回回归测试绿。

**HC-6 S 级修复渗透复验**（B6）· 2 天
- 波 0 的 8 项 S 级（含 S-7 本地端口认证）红队复测：按审计底册锚点逐项构造攻击载荷重放（恶意网页 CSRF 打 /gateway、路径穿越、SSRF 变体、密钥提取尝试）。
- 验收：8 项复测记录全「已防」；发现回归即修即测。

**HC-7 textInput 巨件拆分**（B7）· 2-3 天
- 三步走（每步全量绿+ratchet 降档）：①vim 模态子组件（vim 拦截块+状态 refs 整体抽 vimLayer.tsx ~200 行）②补全弹窗子组件 ③粘贴保护+外部编辑器。1,540 → ≤800（本波）→ ≤400（4.1 目标）。
- 验收：ratchet 条目降档 + vim-wiring/render-matrix 全绿（接线测试是拆分安全网）。

**HC-8 双语覆盖验证+本地 crash 报告**（B8/C 级合并）· 1 天
- ①en 目录全命令面 CJK 扫描（扩 DX-05 测试到 COMMAND_DESC/错误码字典面，缺译补齐）②process 级 uncaughtException/unhandledRejection 落 data/crashes/<ts>.json（不出机）+ doctor 新检查项读取计数。

---

## 第 3 章 H2 对齐补差波（约束二 · 1 周）

**HC-9 LSP 内联诊断对齐（opencode）** · 2-3 天
- 机制参考 opencode edit.ts touchFile+diagnostics；本仓已有 lspClient/discoverServers/feedbackDiagnostics——工作：①lspFeedback 三档化（off/auto/on；auto=仅 typescript-language-server 在场且文件属项目时回灌，300ms 超时）②诊断块进 OutputEvent 新 kind `lsp-diagnostics`（spec v1.1 增量——走 spec diff 评审）③快照矩阵扩格。
- 与竞品差异如实记录：默认 auto 而非 on（gemini 内存警告立场折衷，本仓维持）。

**HC-10 git 编辑快照对齐（aider）** · 2 天
- undo-shadows 快照可选挂 git ref（settings.undoGitRefs=true 时 `git hash-object -w` 入库）→ /undo 恢复跨进程可靠（当前快照在 data/undo-shadows 扇区）+ /diff 增强逐编辑对照。不引入 auto-commit（用户裁决权——只记 ref 不动工作树）。
- 验收：undo 恢复 round-trip + ref 清理策略（GC 保留窗）测试。

**HC-11 文档用户面**（C 级）· 2 天
- README 扩全命令手册（/help 全量导出生成）+ 错误码字典（gatewayError code→人话）落 docs/user-guide.md（此文档属用户手册，经四约束校验后允许第五份 docs）。

---

## 第 4 章 H3 backlog（4.1 · 观察项，不承诺）

- usage 面板呈现深度（/usage --chart 纯终端图）；bench 竞品同机对照脚本（注入/首 token 延迟）；docs-links 文档契约测试重写；双速权限 sandboxFastPath 灰度数据收集与默认值裁决；textInput ≤400 收尾。

---

## 第 5 章 里程碑与门禁

| 里程碑 | 内容 | 出口判据 | 预估 |
|---|---|---|---|
| HC-M0 收口 | H0 三卡 | 五电池全过+升级真链六场景+打包冒烟绿 → **tag 4.0.0** | 3-4 天 |
| HC-M1 收敛 | H1 五卡 | 5 轮全量零 flaky+影子决策落档+渗透复验 8/8+ratchet 降档 | 1.5 周 |
| HC-M2 对齐 | H2 三卡 | spec v1.1 快照矩阵扩格绿+undo git round-trip | 1 周 |
| 4.1 | H3 | 按 backlog 逐项裁决 | — |

- 每卡门禁沿用 V4 §5.1（新增单测→tsc→相关用例绿）；每里程碑沿用 §5.2（ci 九命令+bench）。
- 版本：HC-M0 收口 `4.0.0`；HC-M2 收口 `4.0.1`（补差不破坏兼容）。

## 第 6 章 风险登记

| # | 风险 | 缓解 |
|---|---|---|
| H-R1 | 手动电池发现渲染/中文类深坑扩大战线 | 电池发现按 S/A 即时修，B/C 入 HC-M1；五电池分日跑不并压 |
| H-R2 | 影子数据不足以决策 | 采样窗口可延长一周；期间零行为变化（影子只写不读） |
| H-R3 | textInput 拆分引入 vim/IME 回归 | vim-wiring 真实 ink 驱动测试+render-matrix 18 格是安全网；每步全量绿才降 ratchet |
| H-R4 | LSP 默认 auto 拖慢编辑回显 | 三档默认 off 不变（4.0.1 再评估 auto）；诊断 300ms 硬超时+异步不阻塞 |
| H-R5 | 真实 feed 测试依赖外网 | 本地静态 feed 优先（气隙同链）；外网仅可选补充 |

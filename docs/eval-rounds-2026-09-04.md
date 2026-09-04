# wxnodus 三轮重新评估记录（2026-09-04 · 批次 C/D/E 收尾版）

> 基线：git HEAD `940a22dd`（批次 A-D 全部落地后）。方法：每轮 = 量化复核（行数/巨文件/测试/门禁实测）+ 域级评分 + 竞品差异更新 + **一个完善动作落地**（评估必须伴随完善——不是纯文档）。竞品锚点沿用 docs/eval-vs-competitors-2026-08-27.md + docs/eval-4.0.2-post-cleanup-2026-09-04.md。

## 轮 1：全局量化复核

**实测快照**（HEAD 940a22dd）：src 64,453 行（清理批 60.5k + 面板/VLM/OASIS/proposal 新功能 ≈4k）· 测试 386 文件 · 静态 it 2,784 · ci 链 15→16 命令 · 巨文件 Top6：agent.ts 2088（K4a 后 ↓45）/ tools.ts 1769 / cli/index 1354 / handlers 1202（A5 修剪后）/ profileMemoryBuild 1168 / runtime 1139。

**评分演进**（vs post-cleanup 版）：

| 面 | 前值 | 轮 1 | 依据 |
|---|---|---|---|
| 内核 | A-（构成改善） | **A-** | +B2 进程树（孤儿零残留）/+OASIS C1-C3/+VLM 自研调度（预热/降级链）；−agent.ts 2088 仍居首、K1 仍未修——正负对冲 |
| 全代码/设计 | A- | **A-** | 新模块全部小而专（panelPage 336/panelServer 161/localVision 147/oasisCommands 208）✓ 无新巨类；handlers 1202（↓ 一批） |
| 质量与测试 | A | **A** | 面板 9 契约 + VLM 6 + proposal 4 + B2 4 新用例；**Q3 治理**（distGate 显式红）落地 |
| 竞品站位 | 独有 8 · 差距 3 | **独有 9 · 差距 3** | +第 9 项独有：**HTML 全量配置面板**（127 命令全景/六档模式/插件市场一键装/AI 助手直通/30 天自更新确认制——七家竞品无对应形态：codex/gemini 均无浏览器级配置面板） |

**发现**：Q8（测试计数无 ratchet）成为质量面最后显性缺口——静态 2784 与运行展开数无核账，测试静默删除不可见。

**✅ 完善动作（已落地）**：`scripts/check-test-count.mjs`——静态 it 下限锁 2,720（ratchet 只升不降，删测试须显式改下限说明理由），挂 ci 第 16 命令。实测 2,784 ≥ 2,720 ✓。

## 轮 2：内核域深评（本会话新动域）

| 域 | 评 | 证据 |
|---|---|---|
| 屏幕视觉（⑤） | A-→**A** | 自研 VLM 调度（用户裁决撤 Ollama）：多模型目录/常驻缓存切换不重载/**启动预热**（首帧零冷启动——速度诉求落地）/降级链纯决策表驱动/5s 段节流。真机模型资产 D-b 如实留档（transformers.js v3.8/v4.2 pipeline 均不含 moondream/florence2 任务映射——**代码链路 100% 就绪**，onnxruntime 直载专项另批）——诚实降级不伪装 |
| MCP/OASIS（④） | A-→**A** | B3 治理+C1 协议桥（真实 initialize+listTools→A2A card——绝不从配置猜工具）+C2 三源追踪（events.jsonl correlationId 主源+audit 哈希链 LIKE+evidence 目录——三源独立失败互不掩蔽）+C3 并入 /panel |
| 更新/分发（⑥） | A-→**A** | 30 天确认制（shouldPromptSelfUpdate 纯函数表驱动）+方案 HTML 展示+可关闭推送——「绝不自动安装」哲学升级为「周期提案+用户裁决」完整闭环 |
| 表现层（新增评） | **A-** | panelPage/panelServer：CSP 严格内联/回环+随机 token 恒时比较/SLASH 白名单/`</script>` 注入转义——9 契约含路径探测 404 |

**发现**：user-guide 的 /oasis 行未含新子命令（文档漂移）。

**✅ 完善动作（已落地）**：user-guide /oasis 行同步（bridge/trace/panel 子命令入册），127=127=127=127 四表复核 ✓。

## 轮 3：竞品差异终评 + 总台账

### 差异终评（vs 六家基线 + Claude Code）

**本轮新增独有形态（第 9-11 项）**：
9. **HTML 全量配置面板**——127 命令浏览器全景/六档模式切换/插件市场结构化一键装/AI 助手自然语言直通（全工具面自动编排）/30 天自更新方案确认制。竞品对位：codex/gemini/kimi 均为 TUI 内嵌设置页；无一家提供浏览器级全命令配置面板。
10. **30 天自更新确认制**——周期提案+HTML 方案展示+用户三选（更新/不更新/关闭推送）。竞品均为「自动更新或手动命令」二态，无周期确认制形态。
11. **自研进程内 VLM 调度**（进程树/预热/降级链结构）——竞品的本地视觉均绑定特定运行时（Ollama/自带进程）；wxnodus 的多模型目录+常驻缓存+纯决策降级链是库内形态。

**仍开放差距**（与 post-cleanup 版一致，无恶化）：npm 未上架（用户裁决：GitHub Release 直装+scoop/winget 主线）· 生态广度（SDK/IDE/桌面——Claude Code Agent SDK 生态持续加码的外部压力）· Windows 独占 · 本地 VLM 模型资产真机验证（上游库断层——onnxruntime 直载专项后闭环）。

### 总台账终态

| 项 | 终态 |
|---|---|
| master plan A/B/C 组 | **全部闭环**（A1-A5 · B1-B5 · C1-C6——C6 如实推迟已入册） |
| 清理批 9 项 | ✅（净删 108k） |
| K 组 | K2 ✅ · K4a ✅（K4b 拆分专项待）· K1 记忆衰减 ✅（C5 半衰期落地）· K3 渐进 · K5/K6 渐进 |
| Q 组 | Q1(B4 观察位 2/5 绿) · Q2-Q5 ✅ · Q6 部分（2 处根治）· Q7 渐进 · **Q8 ✅（本轮 ratchet）** |
| 新增裁决落地 | npm 不上架 ✅ · 面板全量放行+危险确认 ✅ · Ollama 撤 ✅ · 30 天确认制 ✅ |

**遗留（按优先级）**：① onnxruntime 直载专项（本地 VLM 真机闭环）② K4b agent.ts 闭包三段拆分 ③ A1 反向穿透 port 化 ④ A6 ALIASES 下沉 ⑤ GitHub Release 首发后 A4/D6 feed 默认值。

### 评分终卡

| 面 | 清理批前 | 三轮终值 |
|---|---|---|
| 内核 | A- | **A-**（K1 已修↑ · agent.ts 巨闭包↓ 对冲——K4b 后冲 A） |
| 全代码/设计 | B+ | **A-** |
| 质量与测试 | A- | **A**（17 门禁链 · ratchet · distGate） |
| 竞品站位 | 独有 7 · 差距 5 | **独有 11 · 开放差距 3**（其中 1 项为用户裁决非缺陷） |

> 证据链：本轮全部完善已提交（940a22dd 前后序列）；CI 远端连续绿（33851188430 起）；ratchet/distGate/registry 四表均可本地复跑验证。

# wxnodus TUI 优化美化记录 与 功能/内核改进建议（2026-09-03）

> 依据：2026-09-02 全场景真机验证（45 项断言）、2937 用例全绿、命令目录完整性审计、卡死处置（24 孤儿进程）、MCP 进程实测（30 进程 1.3GB）。
> 原则：本轮 TUI 改动全部**不触碰钉底布局不变量**（输入框+参数恒落窗口底行、行数预算、i18n 双语对称），改动后 8 个 TUI 测试文件 167 用例 + smoke 全绿。

---

## 1. 本轮 TUI 优化美化（已落地，PTY 实测取证）

| # | 改动 | 位置 | 效果（实测） |
|---|---|---|---|
| 1 | **输入框圆角**：full 档盒角 `┌┐└┘` → `╭╮╰╯`（basic 档保守字形不变，ascii 档 `+` 不变） | `src/tui/termcap.ts` | 与浮层 ink `borderStyle="round"` 视觉统一（截图：`╭──…──╮`） |
| 2 | **斜杠菜单分类符号**：每条命令前显示 registry 分类符号（`◈ ⚙ ▤ ◆ ⛨ ◉ ❖ ⛭ ◍ ☆ ⬡`），**单一事实源取自 COMMAND_CAT**（杜绝再手工复制目录） | `src/tui/commands.ts` + `Composer.tsx` | 菜单行：`▸ ◆ /build 需求编译全流程`、`▸ ⚙ /doctor 全组件自检` |
| 3 | **模型选择器厂商徽章色**：deepseek→青、kimi→品红、zhipu→绿、offline→灰、custom→黄，未知厂商回落 muted | `src/tui/ui/Overlays.tsx` | 一行内模型名+彩色厂商标识，扫一眼识别来源 |
| 4 | **状态栏分隔线模式色头**：下沿细线首字符按当前模式着色（smart 青/plan 紫…），线体改用档位字形 `glyphs().box.h` | `src/tui/ui/StatusBar.tsx` | 模式状态在底栏有第三处视觉锚点 |
| 5 | **占位符扩充教学条目**（4 主题各 +2）：「Tab 补全命令 · Shift+Tab 计划模式」「/keys 键位速查 · Ctrl+↑↓ 翻历史」 | `src/tui/theme.ts` | 3.2s 轮换中穿插键位教学，零成本新手引导 |
| 6 | （上一轮已落地）输入框固定两行 + 安全边距 + `wrap="truncate"` | `src/tui/ui/Composer.tsx` | 任何字体/宽度下输入框恒两行 |

> 回归：build/typecheck 零错、`check:cycles` 绿、8 个 TUI 测试文件 **167 用例全绿**、`smoke:tui` 5/5（钉底不变量在圆角改动后仍成立）。

---

## 2. 功能建议（按优先级）

### P0 —— 半小时级，影响正确性认知

| # | 建议 | 现状证据 | 预期收益 |
|---|---|---|---|
| F1 | **无密钥 `-p` 退出码非零化**：当前无 key 时 exit 0、`--json` 里 `status:"succeeded", ok:true`——脚本无法区分「真答案」与「未配置指引」。建议 exit 3（未配置）+ JSON 内 `ok:false, error:{code:"NO_API_KEY"}`；TUI 内引导文案保持不变 | 2026-09-02 实测（§4/§5.2-3） | CI/脚本/IDE 插件可靠感知配置缺失 |
| F2 | **文案同步三件套**：① `--help` 头「WxNodus V3」→ V4；package.json description 同步 ② README「算一下 2+3*4」行标注「需 WXNODUS_LEGACY_OFFLINE=1」 ③ `--help` 补齐已实现旗标（--data-dir/--workspace/--output-schema/--ephemeral/--lang） | 实测（§6-1/6-2/6-5） | 第一印象与事实一致 |
| F3 | **/model 目录 offline 行治理**：`offline:Qwen2.5-1.5B` 属已裁撤能力仍在目录——隐藏或标注「legacy 开关启用」 | 选择器实测 12 行目录 | 不引导用户走向死路 |

### P1 —— 本轮事故直接教训

| # | 建议 | 现状证据 | 预期收益 |
|---|---|---|---|
| F4 | **卡死自愈与心跳默认化**：`WXNODUS_HEARTBEAT` 探针默认开启轻量版（2s 一次写日志成本≈0），配合 `/doctor` 增加「孤儿进程/心跳断档」体检项；TUI 侧增加事件循环延迟监控（>3s 渲染停顿自动提示） | 9-02 卡死事故：21+3 个 8/30 孤儿空转、TUI 空闲挂起无自愈 | 下次卡死自带诊断证据 |
| F5 | **命令执行层进程树回收**：bash/命令工具超时、中断、退出时必须杀全进程树（job object / taskkill /T），杜绝「脚本已删、进程仍在」 | 8/30 遗留 24 个 ZCode/tmp-n2 孤儿（跨 4 天） | 根除孤儿类资源泄漏 |
| F6 | **MCP 进程治理**：`/mcp list` 增加内存/CPU 列 + 「闲置自动下线」策略；启动时避免无条件 npx 重拉（优先本机缓存包） | 实测 30 个 MCP 进程 ≈1.3GB（全部为当日活跃 ZCode 工具链） | 多前端共存时内存可控 |
| F7 | **更新通道默认配置**：settings.updateFeed 默认指向官方 Release feed（现在未配置→update 诚实报无源） | `update --check` 实测「未配置」 | winget/npm/zip 用户获得升级通知（绝不自动装原则不变） |

### P2 —— 体验增量

| # | 建议 | 说明 |
|---|---|---|
| F8 | 帮助面板可发现性：第 1 页页脚标注「全目录 121 命令 → Tab」，或 `/help all` 直达第 2 页（本轮已确认第 2 页完整可达，只差引导） | 用户反馈「/help 没有预览出全部」的收尾 |
| F9 | 模型选择器「最近使用」分组置顶（/model 切换缓存提示已有——排序利用同一数据） | 高频切换场景少翻页 |
| F10 | `/model add` 表单保存时自动 probeEndpoint 一次（连通性即测，已有现成桥） | 少一步「配完发现连不上」 |
| F11 | 语音/截图/桌面控制等硬件路径的降级原因写入 `/eco` 面板（诚实降级已有，展示层补齐） | 用户自诊断少一轮来回 |

### P3 —— 长期

| # | 建议 | 说明 |
|---|---|---|
| F12 | 首次使用引导模式：前 3 次启动展示键位横幅（占位符教学已铺垫） | 降低学习曲线 |
| F13 | 会话分享（.wxnshare）增加 `--qr` 或拖拽导入；`/export --md` 已有——宣传比新功能重要 | 生态冷启动 |

---

## 3. 内核建议（按优先级）

### P0/P1 —— 稳健性（本轮都有实证）

| # | 建议 | 现状证据 | 预期收益 |
|---|---|---|---|
| K1 | **bash/命令执行进程树级回收**（同 F5 内核侧）：spawn 层统一 Job Object（复用 winSandbox Low IL 基础设施），cancel/超时/退出三路径全树终止 + 兜底 60s 强杀 | 24 个孤儿进程实证；`kernel-bash-encoding` 测试已锁超时杀 | 内核级根治 |
| K2 | **事件循环饥饿防护**：心跳默认化（见 F4）+ runInvocation 层 idle watchdog（回合无事件 30s 告警） | 卡死 TUI CPU 0.02s/3s（空闲挂起而非忙等——挂起类卡死现无检测） | 卡死可观测、可定位 |
| K3 | **wire 协议版本化**：事件流首帧携带 `protocolVersion`（serve 握手已有协议版本，wire 无——IDE 插件侧兼容全靠猜） | `--wire` 实测五事件流无版本字段 | 协议演进不破坏旧前端 |
| K4 | **PTY 测试进 Windows CI**：`smoke:tui`/`e2e:tui` 现标注「CI 不使用」——GitHub Actions windows-latest 有 ConPTY，AttachConsole 噪音已有豁免；把 15+5 断言纳入 PR 门禁 | 本地两脚本已稳定跑通多轮 | 交互层回归不再靠人工 |

### P1 —— 能力深化

| # | 建议 | 说明 |
|---|---|---|
| K5 | 黑洞召回时间衰减加权：FTS5+向量混合检索已强，建议命中排序加入 recency 因子（会话隔离保持） | 记忆越多，旧记忆淹没新事实 |
| K6 | ACP capability 补全：initialize 实测 `supportsEdit:false`——与 Zed/JetBrains 的编辑级集成差距在此 | docs/acp-zed-jetbrains 承诺面 |
| K7 | MCP client 按需懒加载（启动预热已并行化；MCP 客户端可延迟到首次工具调用） | 降低多 server 配置下的启动/内存开销 |

### P2 —— 工程卫生

| # | 建议 | 说明 |
|---|---|---|
| K8 | 硬编码计数注释清理：`kernel/tools.ts:1304`「96 条」为历史修复注释（非用户面，顺手改引用式表述） | 审计脚本化（本轮 .tmp/registry-consistency-audit 可进 CI） |
| K9 | `/doctor` 增加「孤儿进程检测」项（扫描本机 wxnodus/zcode 相关残留进程树并报告） | 本次事故的自动体检化 |
| K10 | no-key `-p` 的「succeeded」语义修正（同 F1 内核侧：completionTransport 增加 unconfigured 终态映射） | 与 F1 互为表里 |

---

## 4. 不做清单（尊重已有用户裁决，勿再议）

1. **离线能力不恢复**：`WXNODUS_LEGACY_OFFLINE=1` 逃生开关保留，市场口不做宣传（V4 裁撤裁决）。
2. **命令零删除只分层**：主干 47/扩展 74 的展示瘦身是 supremacy 1.6 设计——不推翻，只补可发现性（F8）。
3. **市场只收不出**：`/bundle` 发布侧已是用户显式动作，不再扩市场面。
4. **单二进制/跨平台**：Windows 独占 + Node22 门槛是既定战略约束。
5. **输入框盒式风格**：kimi 同款四边框是用户裁决——本轮仅圆角+定两行，不改结构。

---

> 配套证据脚本（可复跑）：`.tmp/tui-beauty-capture.mjs`（美化取证）、`.tmp/composer-two-row-verify.mjs`（两行框终验）、`.tmp/registry-consistency-audit.mts`（目录一致性）。回归入口：`npm run smoke:tui`、`npm run e2e:tui`、`npx vitest run tests/tui-*.test.ts`。

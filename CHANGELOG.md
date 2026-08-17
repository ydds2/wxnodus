# Changelog

本文件记录 wxnodus 的用户可见变更。格式参考 Keep a Changelog，版本遵循 SemVer。
内部工程/审计细节见 `docs/audit-deep.md`（§13.x 按轮实录）。

## [3.1.0] - 2026-08-18

### Added
- **/model 开放兼容**：模型选择器内「＋ 添加自定义接口」四步表单，接入任意 OpenAI 兼容端点；`/model add` / `/model set-key` / `/model key` 子命令（`/key` 彻底移除，全部密钥操作并入 /model）。
- **stdin 管道模式**：`cat 文件 | wxnodus -p "指令"`（无 -p 时 stdin 即提问；1MB 封顶、50k 字超限诚实标注）。
- **--stream-json**：`--wire` 事件流别名（gemini/kimi 命名对齐）；`docs/wire-protocol.md` 完整 schema + `examples/wire-events.mjs`、`examples/wire-approval-responder.mjs` 可运行示例。
- **ACP 接入文档**：`docs/acp-zed-jetbrains.md`（`wxnodus -p "/acp server"` 零代码接入 Zed/JetBrains，协议面方法表 + printf 自测）。
- **`npm run ci` 一键本地门禁**：typecheck×2 + 全量测试 + known-failures + 发现/覆盖检查 + build，七步全绿。
- **`/update` 更新检查**：安装渠道探测（git/npm/winget/scoop）+ 版本与仓库状态如实报告（详见 README 协议与集成节）。
- **版本单一事实源**：`WXNODUS_VERSION` 读 package.json（8 处接线），`--version`/banner/ACP 等恒一致。
- **发布打包**：`packaging/winget` + `packaging/scoop` manifest 生成器（`npm run gen:manifests`，含 installer zip sha256 校验）。
- **OS 内核沙盒（Windows）**：`/sandbox os L0|L1|L2|L3|off|status|probe`——L0=Low IL 只读+断网，L1=Job 遏制+断网，L2=Job+限速 10KB/s，L3=Job 遏制（防孤儿）；bash 命令经沙盒执行，能力探测失败诚实降级并提示（绝不假装沙盒；标准用户可用，实测校准）。
- **apply_patch 结构化补丁**：一次调用改多个文件（Add/Update/Delete/Move + `@@` 锚定，codex 语法子集）；三级匹配容错 + 全量校验后才落盘（失败绝不写一半，逐块报错带相似行提示）+ /undo fs 可回滚。
- **并行工具调度**：同回合纯只读工具批并行执行（含写工具的批次整批串行保证顺序与审批链）。
- **工具输出工程**：超 50KB/2000 行输出自动落盘 + 头尾预览 + 续读路径（bash 完整输出不丢尾）；早前工具输出掩码（上下文保护窗）；蒸馏开关（`/config set toolDistill true`，默认关）。
- **LSP 集成**：`lsp_diagnostics` / `lsp_hover` / `lsp_definition` 三工具；`settings.lsp.servers` 可配任意语言服务器，内置 typescript-language-server 探测（缺失时诚实给安装指引）。
- **硬编码清零**：压缩阈值/包裹面/轮次上限等全部改为模型真实窗口派生 + settings 可覆盖（`maxTurns` / `ctxOutputReserve` / `untrustedWrapLimit` / `toolOutput*` 等 12 个新配置键）。
- **循环检测分级**：重复工具调用先注入「换策略提醒」再硬停（不再 3 次直停误杀合法轮询）；签名并入输出指纹；goal 模式相同结论空转自动终止——阈值全部 settings 可调（`loopRemindAt`/`loopHardStopAt`/`chantStopAt`/`maxConsecutiveFail`/`retryDelayMs`/`maxGoalRounds`/`maxSubagentDepth`/`toolCacheSize`/`fsReadLimit`/`bashOutputCap` 等）。
- **会话血缘与结构化会话列表**（桌面端数据面）：`/fork` 记录 `forked_from_id` 血缘 + `/fork lineage` 祖先链；`/sessions --json` 结构化列表（首问摘要/消息数/分支数/血缘），与 serve 网关共用单一数据出口。
- **approve_for_session 会话授权**：`settings.approveForSession=true` 后批准一次，本会话内同键自动放行（持久化，跨重启生效）；`/perm session-allow|deny|revoke|list` 管理；deny 级联直拒、红线永远优先。

### Changed
- **/build 单通道化**：AI 规格化成为唯一编译通道（规则脑删除后）；无 key 明确报错引导 `/model set-key`，绝不假装编译。
- **README 大幅瘦身**（~157 → ~75 行）：去夸大宣传字样，保留诚实背书与契约表；新增「协议与集成」小节。
- **/sandbox 双层语义**：`/sandbox L0-L3` = 策略层权限模式（原语义）；`/sandbox os ...` = 执行层真实 OS 沙盒。
- **评分文档复评**：11 维加权 6.14 → 7.25（第 4/7 名，`docs/cli-deep-analysis-score-2026.md` §0.1 逐维理由）。

### Fixed
- **image_url 400 终极闸门**：`buildChatRequest` 装配层第四道防御——纯文本模型请求体中任何漏网 `image_url` parts 序列化前一律文本化（对标 deepseek-v4-pro `unknown variant image_url` 事故）。
- **/key 残留清零**：13 处旧 `/key set` 指引统一为 `/model set-key`（状态/体检/档案/learn/fdr/encrypt/ACP）。
- **typecheck:tests 归零**：修复 3 处既有测试类型错误（UiaElement/PromptZone/llmStream 失败变体窄化）。
- **向导白名单双注册**：新 CLI flag 须在首启向导同步注册（--stream-json 曾被 CONFIG_UNKNOWN_FLAG 拒绝，已修复并留防再犯注释）。
- **诚实截断**：工具输出/召回注入/面板摘要统一 `labelTruncate` 口径（绝不静默截断）；fs_edit 行号换算 O(n+k·log n)；taskRunner 日志刷盘后置终态竞态根治。

### Removed
- **规则脑**（对话 ruleBrain + /build 确定性规格引擎）：无 key 时不再有确定性假装输出，一律明确引导配置。
- **vim 薄层死代码**（未接线的 41 行纯函数）。

## [3.0.0] - 2026-08（基线）

Windows 本地 AI agent CLI 首个完整版本：黑洞引擎三层记忆 + 需求编译 /build + 模型接入 + 44 工具 + 安全红线（权限模式/AES-256-GCM 密钥加密）。

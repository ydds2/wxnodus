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

### Changed
- **/build 单通道化**：AI 规格化成为唯一编译通道（规则脑删除后）；无 key 明确报错引导 `/model set-key`，绝不假装编译。
- **README 大幅瘦身**（~157 → ~75 行）：去夸大宣传字样，保留诚实背书与契约表；新增「协议与集成」小节。

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

# WxNodus V3 深度体检报告（2026-08）

> 范围：独立改造化重构（6bea110~46151cf）后的误删审计 + 系统底座审计 + 结构缺口实施。
> 结论：**43 个被删文件零误删、零残留引用**；底座 3 项缺陷已修复；P0 安全三项 + 会话导出已实施；测试 413→426。

## 1. 误删审计（code-reviewer 代理全量核查）

| 批次 | 删除文件 | 核查结论 |
|---|---|---|
| 阶段 B：src/ui/ | 22 个 V2 文件 | ✅ 全部迁移至 wxnodus-ui/（theme/entry/lib/markdown/组件），导出符号逐一对齐，零残留 |
| 阶段 A：wxnodus-ui/app/ | 21 个文件 | ✅ 全部重组至 runtime/bridge/commands/hooks，旧路径字符串全仓库零命中 |
| 阶段 B：src/app/stores | 3 个 zustand 版 | ✅ 同路径替换为自研引擎，消费端（Bridge/flowController/测试）兼容 |

- 400 条相对 import 逐条验证目标存在；package.json 无 zustand/nanostores 依赖
- 引擎 4 项语义差异（函数式 setState 合并/subscribe 参数/atom 立即回调/批处理）均为**潜在未触发**，其中 setState 合并已顺手修复

## 2. 底座修复（B 类）

| 编号 | 缺陷 | 修复 |
|---|---|---|
| B1 | **退出时 MCP 子进程未清理**（SIGINT/SIGTERM/requestExit 直接 exit，closeAllMcp 未调用）| 统一 `shutdown()`（closeAllMcp + closeDB + unmount），SIGINT/SIGTERM/requestExit/常驻服务共用 |
| B2 | **/usage 硬编码 'default' 会话** + 无真实 token 统计 | 新表 `usage_stats` + defaultCallModel SSE 捕获 `j.usage` 异步落库 + /usage 定位当前会话并聚合实际用量（无记录时估算兜底） |
| B3 | **错误日志写 cwd（wxerr.log 污染项目目录）** + 无统一日志目录 | 延迟初始化 `_initErrorLog` → `dataDir/logs/error-<日期>.log`，uncaughtException/unhandledRejection/console.error 统一入日志目录 |

## 3. 结构缺口实施（对照 4 家参考报告 P0-P2）

| 缺口 | 实现 | 对齐参考 |
|---|---|---|
| P0-1 **危险命令检测升级** | `unwrapCommand()` wrapper 解包链（sudo/env/trap/bash -lc/powershell 编码，深度上限 8）+ `OPERAND_AFTER_FLAG`（`rm build/ -rf` 选项置换变体），classifyBashSingle 双通道判定 | Codex wrapper 解包思路（自研） |
| P0-2 **审批规则文件** | `data/permissions.json` 持久化规则（tool + 路径 glob + allow/deny/ask），`/perm rule add|list|remove|clear`，agent executeTool 前置裁决（deny>allow>ask>模式默认），启动加载立即生效 | Codex execpolicy / Claude permissions 规则文件 |
| P0-3 **子进程环境净化** | bash 工具 spawn 传 `sanitizedEnv()`——core 环境白名单（PATH/HOME/SystemRoot 等）+ WXNODUS_* 保留，剥离含 KEY/SECRET/TOKEN/PASSWORD 的变量 | Codex shell_environment_policy |
| S4 **会话导出** | `/export --jsonl [会话ID]` 完整会话 JSONL 导出（一行一条消息，含 archived/tool_call_id，审计友好） | Hermes trace / Codex rollout |

## 4. 卫生修复（审计建议 4 项）

- ✅ dist 构建清理（`npm run clean && tsc`，消除 43+ 死文件入包）
- ✅ README 技术栈去 zustand（自研状态引擎声明一致）
- ✅ 3 处过时注释（zustand → 自研引擎）
- ✅ engine.ts setState 函数形式统一浅合并（zustand 语义对齐）

## 5. 验证

- `tsc` 零错误；**426 测试全绿**（+13：usage_stats/P0-1 解包与变体/P0-2 规则文件往返）
- 测试覆盖：wrapper 解包 4 态、operand 变体、深度上限、规则 save/load/glob 命中、usage 聚合

## 6. 剩余结构缺口（未实施，按优先级标注）

| 缺口 | 优先级 | 说明 |
|---|---|---|
| Hooks 12 类扩充 | P1 | 现 4 类（userPromptSubmit/preToolUse/postToolUse/stop）→ 补 SubagentStop/SessionStart 等 8 类 |
| 退出码协议（0/1/75） | P1 | -p 模式可重试失败区分 |
| 协议错误码体系 | P1 | Hermes 式 4xxx/5xxx 分段，gateway RPC 统一返回码 |
| --wire 双向化 | P1 | 客户端请求帧（approval/clarify 通道复用） |
| 工具延迟加载 | P2 | 大工具集 BM25 检索（Codex tool_search） |
| Flow skills | P2 | SKILL.md 内嵌流程图驱动（Kimi /flow） |
| 配置分层与校验 | P2 | 8 层配置 + strict 校验 + 迁移（Codex/Hermes） |

# 排障手册（Troubleshooting）

> wxnodus 用户文档三件套之二（supremacy 2.3，2026-08-18）。按症状索引——先 `/doctor` 体检，再查下表。
> 新用户先读 `docs/getting-started.md`（快速上手）；场景示例见 `docs/examples.md`。

## 1. 安装 / 启动

| 症状 | 原因 | 处置 |
|---|---|---|
| `npm install` 失败：better-sqlite3/sqlite-vec 编译错误 | 缺 C++ 工具链或 Node ABI 不匹配 | 安装 VS Build Tools（C++ 桌面开发负载）；Node 用 22 LTS；或 `npm install --build-from-source` |
| `wxnodus` 找不到命令 | 未 `npm link` 或 PATH 未含 npm 全局目录 | `npm link`；`npm config get prefix` 确认全局目录在 PATH |
| 启动即报 `DB_MIGRATION_MISSING_TABLE` | 数据目录混用（旧库 + 新版本） | 备份后删除 `data/nodus.db*`（会话记忆会丢）；或回退到创建该库的版本 |
| winpty/终端乱码 | 旧终端不支持宽字符 | 使用 Windows Terminal / VS Code 集成终端（三级能力档见 README） |

## 2. 模型 / 网络

| 症状 | 原因 | 处置 |
|---|---|---|
| 提示 `/model set-key` 引导 | 无密钥或密钥槽为空 | `/model set-key <密钥>`；密钥 AES-256-GCM 加密落盘，明文绝不存 |
| 提示「无法解密」 | 机器指纹变化（重装系统/换机）导致密钥槽无法解密 | 重新 `/model set-key`（这是安全特性不是 bug） |
| 400 / reasoning_content 错误 | 中转站端点不支持推理字段 | 换目录模型；或 `/model add` 自定义端点（`--base`） |
| 429 频发 | 限流 | 内置同 provider 自动降级链 + 单次 429 退避重试；仍频发换高速档（如 kimi-k2.7-highspeed） |
| 联网搜索/抓取失败 | 沙盒断网（L0/L1）或代理未配 | `/sandbox os off` 或 `/sandbox os L2`；代理 `/proxy <URL>` |

## 3. 构建 / 工具

| 症状 | 原因 | 处置 |
|---|---|---|
| `/build` 报「需要模型密钥」 | AI 规格化是唯一编译通道（规则脑已删除） | `/model set-key` 后重试——绝不假装编译 |
| 工具被规则拒绝 | `data/permissions.json` 有 deny 规则 | `/perm rule list` 查看；`/perm rule remove <编号>`；红线不可绕过 |
| bash 执行后提示「OS 沙盒不可用」 | 探测失败（受限环境） | 诚实降级为普通执行并提示——检查 `/sandbox os probe` 详情 |
| LSP 工具报「服务器未找到」 | typescript-language-server 未装 | 按提示安装（`settings.lsp.servers` 可配任意语言服务器） |
| 文件读被截断 | 保护性截断（非 bug） | 用 `offset/limit` 分页续读，或 `bash tail` |

## 4. 会话 / 数据

| 症状 | 原因 | 处置 |
|---|---|---|
| 上下文满被压缩 | 超出模型窗口上限 | `/compact`（有 key 时 LLM 真实总结）；`/context` 查看占用 |
| 会话「丢了」 | 在另一会话里找（/resume 切换过） | `/sessions` 列表；`/resume <id\|标题片段>` 切回 |
| 想撤销改动 | — | `/undo`（最近 N 轮）/ `/versions <文件>`（时间机器）/ `/checkpoint` 快照 |
| 数据库损坏 | 断电/磁盘问题 | `data/nodus.db` 有 WAL；停止进程后重开自动恢复；彻底损坏用 `data/backups`（/backup 产物） |

## 5. 通用排查步骤

1. `/doctor`——健康体检（依赖/配置/数据库/沙盒/网络逐项）。
2. `/status`——运行状态；`/logs`——日志。
3. `wxnodus -p "/sandbox os probe"`——沙盒能力强制重探。
4. 仍然无解：`/audit` 导出审计（哈希链完整），连同 `/versions` 信息提 issue。

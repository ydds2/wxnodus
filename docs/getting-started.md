# 快速上手（Getting Started）

> wxnodus 用户文档三件套之一（supremacy 2.3，2026-08-18）。另见 `docs/troubleshooting.md`（排障）与 `docs/examples.md`（场景示例）。
> 契约：本文件列出的每个命令/开关都真实存在（链接契约测试 `tests/docs-links.test.ts` 校验文件与 README 引用）。

## 1. 安装（Windows 10/11，Node 18+，推荐 22）

### 1.1 一键安装（推荐——其他电脑装完即用）

前置仅一个：Node.js 18+（推荐 22）——官网 <https://nodejs.org/>（国内镜像 <https://npmmirror.com/mirrors/node/>）。**无需构建工具链**（安装包自带全部原生二进制）。

- **源 A（离线/局域网/U盘，最省事）**：拿到 `wxnodus-<版本>.zip` → 解压 → **双击 `install.bat`**（自动校验、安装、写 PATH）→ 新开 cmd 运行 `wxnodus`。
- **源 B（URL）**：`powershell -ExecutionPolicy Bypass -File install-bootstrap.ps1 -Url <https://…/wxnodus-<版本>.zip>`
- **源 C（私有 GitHub Release）**：`powershell -ExecutionPolicy Bypass -File install-bootstrap.ps1 -GitHub <owner>/<repo> -Tag <版本>`（需先 `gh auth login`）。

安装后：数据目录 `%LOCALAPPDATA%\wxnodus`（密钥 AES-256-GCM 本机加密，明文不落盘）；升级 = 下载新 zip 重跑安装（数据保留，`/update` 可探测远程版本）；卸载 = `install.ps1 -Uninstall`（只删安装文件，不删数据）。

### 1.2 开发者安装（源码开发用）

```bash
git clone <仓库> && cd WxNodusV3CLI
npm install && npm run build
npm link            # 全局可用 wxnodus / wxn 两个命令
```

- 此路径需要本机可用的构建工具链：Node 22（better-sqlite3/sqlite-vec 原生模块随 install 编译；失败见 `docs/troubleshooting.md` §1）。分发安装（§1.1）不需要。
- 无需注册、数据不出机；没有 API key 也可以使用离线模型与确定性工具（离线能力见 §4）。

## 2. 三步跑起来

```bash
# 1) 交互 TUI（实时状态行/审批面板/语音 Ctrl+B）
wxnodus

# 2) 非交互单次执行
wxnodus -p "帮我写一个 Python 脚本：统计当前目录各文件行数"

# 3) 配置模型密钥（AI 对话/构建需要；离线工具不需要）
wxnodus -p "/model set-key <你的密钥>"
```

首次使用建议顺序：`/doctor`（健康体检）→ `/model`（选模型/配密钥）→ 直接提问。

## 3. 核心能力速览

| 能力 | 入口 | 说明 |
|---|---|---|
| 黑洞记忆 | `/memory` `/hole` | 三层记忆 + FTS5 中文检索 + 向量召回（会话隔离） |
| 需求编译 | `/build "需求"` | AI 规格化 → 分解 → 脚手架 → 启动验证 → 证据链 |
| OS 沙盒 | `/sandbox os L0-L3` | 受限令牌 + Job 遏制 + 断网/限速（标准用户可用，实测校准） |
| 权限体系 | `/perm` `/sandbox` | 六模式 + 审批规则（`/perm rule`）+ 会话授权 + execpolicy 首词规则 |
| 确定性工具 | `/calc` `/hash` `/sql` `/fs` … | 毫秒级、不走模型（无 key 可用） |
| 远程执行 | `/remote ssh://user@host` | ssh 转发（远端未沙盒诚实口径） |
| 分享 | `/share export\|import` | 离线 .wxnshare 打包（AES-256-GCM 可选加密） |
| 可视化 | `/img` `/computer` | GLM-4V 视觉 + Computer Use 桌面控制 |
| 离线 | `/offline` | 本地 LLM（transformers.js，断网可用） |

## 4. 离线能力（无 key 也有一半世界）

- **确定性工具**：`/calc /hash /base64 /uuid /rand /json /timer /sql /fs /units /csv`——全部本地毫秒级。
- **本地 LLM**：`/offline pack download` 预下载 Qwen2.5 1.5B/3B，之后完全断网可用（`/model offline:Qwen2.5-3B` 切换）。
- **记忆/检索/沙盒/审计**：与 key 无关。
- 需要 key 的能力：AI 对话、`/build`（AI 规格化是唯一编译通道）、视觉（`/img`）、联网搜索。

## 5. 下一步

- 场景示例：`docs/examples.md`（待办系统/调试循环/多会话协作等 10 个可复现场景）。
- 出问题：`docs/troubleshooting.md`（按症状索引）。
- 进阶协议：`docs/wire-protocol.md`、`docs/acp-zed-jetbrains.md`。
- 项目全局说明：根目录 `AGENTS.md`。

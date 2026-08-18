# IDE 插件 / 远程执行 / Share 分享——实现原理、难易度与路线图（2026-08-18）

> 基于六家克隆源码实测（`Desktop\cli-compare\`）对照 wxnodus 现有协议面，给出三块 S 级空白的
> 落地方案。原则：参考机制不抄代码（AGENTS.md 需求约束）；数据不出机红线优先（单机堡垒哲学）。

## 0. 现有地基（wxnodus 已备的协议资产）

- `--wire`：stdio 双向 RPC（8 事件 / 4 请求帧：approval/clarify/secret/form），fail-closed（网关未 ready 回 `WIRE_GATEWAY_NOT_READY`），`docs/wire-protocol.md` + 2 个可运行示例。
- `--serve`：localhost HTTP 网关（Bearer timingSafeEqual / CSRF / SSE 事件流 / 会话级 RPC）。
- ACP stdio（`/acp server`，`docs/acp-zed-jetbrains.md`——Zed/JetBrains 零代码接入）。
- 结构化会话数据面（`listSessionsStructured` / `/sessions --json` / 血缘 / 授权——79c3226）。

## 1. IDE 插件（S-03）——难度：中

### 竞品原理
| CLI | 机制 | 锚点 |
|---|---|---|
| gemini-cli | IDE companion 走 **ACP stdio** 协议（事件/请求帧），编辑器侧 webview 渲染 | `packages/ide-companion/` |
| codex | VS Code 扩展 spawn 本地 `app-server`（HTTP+SSE），会话/审批走 JSON-RPC | `codex-rs/app-server/` |
| opencode | Tauri 桌面 + vscode 扩展，localhost token 认证 | `packages/tui/` |

### wxnodus 落地（推荐：codex 式 spawn + 自研 wire 协议）
1. `packages/vscode-ext/`：extension.ts = spawn `wxnodus --wire --data-dir <vscode-globalStorage>`，stdin/stdout 帧桥接；
2. webview 渲染 agent.message/token/tool 事件；approval 帧 → `vscode.window.showWarningMessage` 模态；clarify/secret/form 帧 → 输入框/密码框；
3. 命令面板：`wxnodus: 新建会话/继续/打开历史`（历史树用 `/sessions --json`）；
4. 打包：esbuild + vsce（发布需 marketplace token——**受 S-01 无 remote 阻塞的部分仅上架，本地 vsix 不受阻**）。
- **零协议新增**（wire 已 fail-closed 就绪）；工程量 ~600-900 行；本仓库可 typecheck/build，运行验证需 VS Code（文档注明诚实口径）。
- 备选：JetBrains 走 ACP（文档已有，插件工程在仓库外）。

## 2. 远程执行（S-04）——难度：中（ssh 通道）/ 高（完整版）

### 竞品原理
- codex `exec-server`：远程机长驻服务（沙盒内执行工具、滚动 token 鉴权），本地 CLI 把工具执行卸载到远端（`codex-rs/exec-server/`）；其余五家无远程执行。
### wxnodus 落地（两阶段）
- **阶段 1（可立即做）**：`settings.remote = "ssh://user@host[:port]"` → bash 工具经 `ssh` 转发执行（execFile 'ssh'，stdout/stderr 流式回传，超时/断线诚实报错）；本地审批链不变（命令先审批后执行）；`--remote` 启动参数。
- **阶段 2（完整版，高）**：长驻 exec-server（`wxnodus -p "/remote server"`）+ HMAC token + 远程 OS 沙盒复用（winSandbox 同族逻辑在远端机上跑）+ 断线恢复/会话续跑——安全面与 codex 对齐后才可宣称「远程执行」。
- 风险注明：阶段 1 无远程沙盒时，远端执行权限=远端用户权限——文档与命令输出必须如实标注「远端未沙盒」。

## 3. Share 分享（S-05/A-08）——难度：低（离线已落地）/ 需服务器（云端）

### 竞品原理
- opencode share：POST 会话至 opencode 云（`packages/opencode/src/share/`），返回 token 链接；kimi share：上传至 moonshot web。**两者都依赖中心服务器**。
### wxnodus 落地
- ✅ **已落地（本批）**：离线加密打包 `/share export|import`——单文件 `.wxnshare`，明文 sha256 防篡改、`--encrypt` AES-256-GCM（scrypt 口令派生）；血缘标记 `share:<源id>`；测试 4 用例（篡改拒绝/错误口令拒绝/往返保真）。
- ⏳ 云端版：自建 share 服务（上传/下载/一次性 token/过期）——受 S-01 无 remote 阻塞，且与「数据不出机」红线冲突，需用户明确决定托管形态后再做（路线：`--serve` 反代模式 + 公网暴露时的速率/过期/删除策略）。

## 4. 与桌面端（用户自制）的关系

用户自研桌面端时：**IDE 插件与桌面端共用同一协议层**（wire/ACP/serve），先做桌面端则 S-03 的 webview 渲染逻辑可整体复用——建议桌面端直接消费 `--serve`（SSE 事件 + 会话 RPC）+ `/sessions --json`，IDE 插件后做或复用桌面端内核。本文件是两者的共同施工图。

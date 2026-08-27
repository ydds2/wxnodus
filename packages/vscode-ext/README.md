# WxNodus — VS Code 伴侣插件（supremacy 2.1 → 0.2.0）

WxNodus CLI 的 VS Code 插件：`--wire` 事件流桥接 + 对话面板 webview + 审批/澄清/密码原生模态
+ **失败诊断列表**（结构化失败工具 ⚠ 分离展示）+ **git diff 视图**（回合终态后自动收集工作区改动，
+/- 行着色；无 git/无改动诚实降级带理由——绝不假装有 diff）。

## 原理

```
VS Code 命令面板 → spawn `wxnodus -p <提问> --wire --data-dir <globalStorage>`
                  stdout JSONL 事件流 → webview 渲染（token 增量/工具状态/终态）
                  approval.request 等 → vscode 原生模态 → stdin responder 帧 → 闭环
```

协议契约：仓库根 `docs/wire-protocol.md` v1（2026-08-18 修订版——`approval.request` 广播）。

## 构建与本地安装

```bash
cd packages/vscode-ext
npm install
npm run all          # typecheck + node:test 单测 + esbuild + vsce 打包
# 产物 wxnodus-vscode.vsix → VS Code 扩展面板「从 VSIX 安装」
```

本地 vsix 不受任何发布阻塞（上架 marketplace 才需要 publisher token——S-01 阻塞项）。

## 配置（settings）

| 键 | 默认 | 说明 |
|---|---|---|
| `wxnodus.bin` | `wxnodus` | CLI 可执行文件（`npm link` 后可用；或填绝对路径） |
| `wxnodus.dataDir` | 扩展 globalStorage | 数据目录（与 CLI 主数据隔离） |
| `wxnodus.mode` | `smart` | 会话权限模式（与 CLI `/perm` 同语义） |

## 诚实边界

- 提问走无头 `--wire` 单发模式（交互 TUI 的键位/语音在 VS Code 内不适用——用内置终端跑 `wxnodus`）。
- 审批模态是真阻塞模态（modal:true）——与 CLI 审批链同一语义（红线/规则/会话授权先行，未放行的才弹模态）。
- diff 视图只读展示（`git diff HEAD` 相对），**绝不自动 commit**（用户裁决权）；非 git 仓库/无 git 时诚实提示不可用。

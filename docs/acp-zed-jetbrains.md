# ACP 接入 Zed / JetBrains（零代码配置指南）

> wxnodus 内置 **Agent Client Protocol（ACP）stdio 服务器**（`src/kernel/acp.ts`，JSON-RPC 2.0
> over stdio）。本页给出启动命令、协议面与 IDE 接入样例。IDE 侧配置字段会随 IDE 版本演进，
> 标记为「样例」的片段以对应 IDE 官方文档为准（本页附链接）。

## 0. 启动命令（唯一事实）

```bash
wxnodus -p "/acp server"
```

- 阻塞式 stdio 会话：stdin 读 JSON-RPC 行，stdout 回 JSON-RPC 行；stdin EOF 即退出（exit 0）。
- 前提：已配置模型密钥（`/model set-key <密钥>`）；未配置时 `prompt` 会诚实返回配置指引而非假装回答。
- TUI 内直接执行 `/acp` 会打印用法说明（不启动服务器）。

## 1. 协议面（当前实现，v1）

| 方法 | 请求 | 响应 |
|---|---|---|
| `initialize` | `{}` | `{protocolVersion:1, capabilities:{config,prompt,resolution:{supportsEdit:false}}, clientInfo:{name:'wxnodus', version}}` |
| `session/new` | `{}` | `{session:{id:"acp-<ts>"}}` |
| `session/load` | `{sessionId}` | `{session:{id}}` |
| `session/load_history` | `{sessionId}` | `{history:[{role,content}]}` |
| `prompt` | `{sessionId, content}` | `{message:{role:'assistant', content}}`（异步执行 agent.run） |
| 未知方法 | — | `{error:{code:-32601, message}}` |

**已知边界（诚实声明）**：`capabilities.resolution.supportsEdit = false`（不支持行内编辑决议）；
会话历史仅进程内保存（重启即失）；无文件系统/权限代理——ACP 会话以当前 agent 实例应答。

## 2. Zed 接入（样例）

Zed 以「context server / agent」接入 ACP 端点。以下为参考样例（字段名以
<https://zed.dev/docs/ai> 当前文档为准）：

```json
// ~/.config/zed/settings.json
{
  "context_servers": {
    "wxnodus": {
      "command": { "path": "wxnodus", "args": ["-p", "/acp server"] }
    }
  }
}
```

注：若 Zed 版本要求 `"protocol": "acp"` 或 `"behavior": {...}` 字段，按 IDE 提示补齐；
启动命令部分（path/args）即本文 §0 命令。

## 3. JetBrains 接入（样例）

JetBrains AI Assistant 通过 ACP 连接外部 agent（配置入口与字段以
<https://www.jetbrains.com/help/idea> 当前文档为准）。核心配置即指向本机命令：

```bash
wxnodus -p "/acp server"
```

（JetBrains 侧配置为「自定义 ACP 命令」时填入上述命令；若 IDE 要求可执行文件绝对路径，
用 `where wxnodus`（cmd）或 `which wxnodus`（Git Bash）获取 npm link 后的真实路径填入。）

## 4. 快速自测（不依赖 IDE）

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"prompt","params":{"sessionId":"t","content":"你好"}}\n' | wxnodus -p "/acp server"
```

预期：两行 JSON-RPC 响应（initialize 的 serverInfo + prompt 的 assistant 消息）。

## 5. 维护锚点

- 服务器实现：`src/kernel/acp.ts`（方法表 §1 逐条对应 switch 分支）。
- 命令注册：`src/commands/handlersExt.ts` `/acp`（交互模式提示用法，`-p "/acp server"` 启动）。
- 协议升级时同步本页 §1 表与 `capabilities` 声明。

# ACP 接入（Zed / JetBrains）

> 版本：V1 · 契约面：`src/kernel/acp.ts`（Agent Client Protocol stdio JSON-RPC 服务器）。
> 定位：编辑器内嵌入口——ACP 是长驻 stdio transport，自身不占用 Agent Run；每个 prompt 经 runInvocation 独立接纳、按 session 精确取消。

## 1. 启动

```bash
wxnodus -p "/acp server"
```

（长驻 stdio JSON-RPC；会话历史由命令层注入 db 装配，缺省降级为内存会话。）

## 2. 编辑器配置

### Zed

在 `.zed/settings.json` 中注册 ACP agent：

```json
{
  "agent_servers": {
    "wxnodus": {
      "command": "wxnodus",
      "args": ["-p", "/acp server"]
    }
  }
}
```

（字段名以 Zed 当期 ACP 支持为准；agent 面板中选择 wxnodus。）

### JetBrains

经 ACP 插件（Zed 同协议）配置同样的 `wxnodus -p "/acp server"` 命令；插件列表中以 wxnodus 呈现。

## 3. 契约要点

- 每个 prompt 独立 Run：`agent.start` → `agent.result` 事件与 wire 六终态语义一致（`src/protocol/runs.ts`）；
- 取消：ACP 层经 `asCancellableExecution` 转发——Ctrl+C/取消请求可中断当前 Run；
- 会话：`AcpStore` 接口（createSession/sessionExists/loadHistory）——命令层注入 SQLite 实现，历史跨进程可续。

## 4. 消费方约束

- 协议帧必须在通用命令分派之前启动（`src/cli/index.ts` 的 ACP 分支先于 stdin 管道），集成方不要额外包装 stdin；
- 审批/澄清在 ACP 宿主内走宿主 UI（与 wire 的 stdin 帧应答是两种通道，不可混用）。

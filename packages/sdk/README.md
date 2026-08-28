# @wxnodus/sdk

wxnodus 官方 SDK——**零云端**的 spawn-attach 本地网关客户端。

## 模型

```
launchWxnodus() ─ spawn `wxnodus --serve --sdk`
              ├─ 子进程：随机端口 + 随机 token（stdout 单行握手 JSON；不落盘/不入 env）
              └─ 父进程：解析握手 → typed client（127.0.0.1:port）
rpc(method, params)  POST /rpc（Bearer）
events(handler)      GET /events SSE 订阅（返回取消函数）
stop()               SIGTERM→SIGKILL 托管退出
```

凭据生命周期 = 子进程生命周期；网关仅绑回环——无任何云端组件。

## 用法

```ts
import { launchWxnodus } from '@wxnodus/sdk';

const wxn = await launchWxnodus();            // 或 { bin: 'wxnodus', args: ['--cwd', 'D:/proj'] }
console.log(wxn.handshake);                   // { 'wxnodus-sdk':1, port, token, pid, version, protocolVersion }

const sessions = await wxn.rpc('sessions', { request_id: 'r1' });

const off = await wxn.events(e => console.log(e.type, e.payload));
await wxn.stop();
```

## RPC 方法面（当前）

`chat` · `command` · `memory.search` · `memory.recall` · `sessions`（白名单外返回结构化 400）。
**审批闭环（G-6 已收口 2026-08-28）**：pending 请求经 `/events` 以 `gateway.request` 事件广播（带 sessionId 所有权过滤）；应答走 `rpc("approval.respond", { request_id, answer: "allow"|"session"|"deny" })`（clarify/secret/form 同族）。

## 版本协商

`handshake.protocolVersion` 与 SDK `PROTOCOL_VERSION_CLIENT` 不匹配时请快失败并升级 SDK。
语义：新增可选字段=兼容；删改字段/鉴权模型=主版本 +1。

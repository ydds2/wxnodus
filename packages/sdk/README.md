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

`chat` · `command` · `memory.search` · `memory.recall` · `sessions` · `identity`（实例元数据：instanceId/codename/serial/createdAt/version——只读，无会话授权需求）
（白名单外返回结构化 400）。
**审批闭环（G-6 已收口 2026-08-28）**：pending 请求经 `/events` 以 `gateway.request` 事件广播（带 sessionId 所有权过滤）；应答走 `rpc("approval.respond", { request_id, answer: "allow"|"session"|"deny" })`（clarify/secret/form 同族）。

## 版本协商

`handshake.protocolVersion` 与 SDK `PROTOCOL_VERSION_CLIENT` 不匹配时请快失败并升级 SDK。
语义：新增可选字段=兼容；删改字段/鉴权模型=主版本 +1。

## 实例身份（T77 · 「网络下载后独一无二」）

每份 wxnodus 首次启动会在 dataDir 生成一次性 `instanceId`（离线随机 UUID，绝不联网登记）
并派生人类可读实例代号；握手行回传 `instanceId` / `codename`（可选字段——旧 SDK 忽略无害）：

```ts
console.log(wxn.handshake.codename);   // 「深空·织网者 7F3A」——本份 wxnodus 的专属身份
console.log(wxn.handshake.instanceId); // 一次性 UUID（审计锚点）
```

私有化部署语义：同一机器多份安装（不同 dataDir）身份互异；`--data-dir` 即隔离边界。

# @wxnodus/core

wxnodus **进程内**嵌入门面（零云端 · 零子进程）——把 kernel 直驱进你的 Node 应用。

## 用法（gemini-cli sdk 同族形态）

```ts
import { WxnodusAgent } from '@wxnodus/core';

const agent = new WxnodusAgent({ cwd: 'D:/proj', mode: 'yolo', settings: { /* 模型配置 */ } });
const session = await agent.session();

for await (const ev of session.send('帮我看看这个项目')) {
  if (ev.type === 'token') process.stdout.write(ev.text);
  if (ev.type === 'tool') console.log();
  if (ev.type === 'final') console.log(ev.ok, ev.turns);
}

// 便捷单轮
const r = await agent.ask('总结一下');
```

## 事件分类学
token / reasoning / tool(start|complete) / notice / final——与 `--wire` stream-json 同族（协议事件直译，无第二套语义）。

## 安全语义
- 工具执行走生产 canonical 管线（与 CLI 同一 11 端口边界）
- 审批缺省 fail-closed（嵌入场景默认 yolo 模式 + 红线/敏感路径硬拒仍生效）
- 数据目录默认进程隔离临时目录（不污染 CLI 用户数据；可显式 dataDir）

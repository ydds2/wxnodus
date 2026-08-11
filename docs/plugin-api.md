# WxNodus 插件 API（开放层）

插件 = `data/plugins/<名称>/` 目录下的 `plugin.json`（清单）+ `index.js`（实现，ESM/CJS 均可）。
通过 `/plugin new <名称>` 生成模板，`/plugin list｜enable｜disable｜reload` 管理。

## 目录结构

```
data/plugins/my-plugin/
  plugin.json    # 清单（名称/描述/版本/工具声明/命令声明/启停）
  index.js       # 实现（export tools / commands / onLoad）
  data/          # 插件私有数据目录（ctx.dataPath 读写，重启保留）
  plugin.log     # 插件日志（ctx.log 追加）
```

## plugin.json

```json
{
  "name": "my-plugin",
  "description": "示例插件",
  "version": "1.0.0",
  "enabled": true,
  "tools": [
    { "name": "my_tool", "description": "工具描述（模型可见）", "parameters": { "type": "object", "properties": { "arg": { "type": "string" } } } }
  ],
  "commands": ["mycmd"]
}
```

## index.js 导出的 API

### 1. 工具（并入 agent 工具表，模型可自主调用）

```js
export const tools = {
  my_tool: async (args, ctx) => {
    // args: 模型传入的参数对象
    // ctx: PluginToolCtx（见下）
    return '工具执行结果（自动 untrusted 包裹防提示注入）';
  },
};
```

### 2. 命令（注册为 `/插件名.命令名`，如 `/my-plugin.mycmd`）

```js
export const commands = {
  mycmd: async (args) => `命令收到参数：${args.join(' ')}`,
};
```

### 3. 事件订阅（`ctx.on`——监听系统事件流，如 agent.token / system.notice / agent.tool）

```js
export const tools = {
  watch: async (_args, ctx) => {
    const off = ctx.on('system.notice', (payload) => {
      // 事件面与 Hooks 一致（12 类）+ 消息流事件
      ctx.log('info', `收到通知：${payload?.text ?? ''}`);
    });
    return `已订阅 system.notice（返回的 off 可取消）`;
  },
};
```

### 4. 配置只读访问（`ctx.getConfig`）

```js
export const commands = {
  cfg: async (_args, ctx) => JSON.stringify(ctx.getConfig('settings', 'model') ?? '未配置'),
};
```

### 5. 日志（`ctx.log`）

```js
ctx.log('warn', '注意：xxx');  // 追加到 data/plugins/<name>/plugin.log
```

## PluginToolCtx 完整字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `cwd` | string | 工作目录 |
| `dataDir` | string | 用户数据目录（data/） |
| `dataPath` | string | 插件私有数据目录（data/plugins/<name>/data/） |
| `on(type, cb)` | (string, fn) => off | 订阅系统事件（agent.start/token/message/tool/end/error、system.notice、reasoning.delta 等） |
| `getConfig(partition, key?)` | (string, string?) => any | 只读查询配置（settings 等分区） |
| `log(level, msg)` | (info\|warn\|error, string) => void | 插件日志 |

## 安全边界

- 插件工具输出统一 `untrusted` 包裹（提示注入防护）
- 插件子进程不继承密钥类环境变量（env.ts 净化策略）
- 插件无网络特权——与主进程同一权限面，请仅安装可信插件

## 完整示例（/plugin new 生成的模板）

```js
// data/plugins/demo/index.js — WxNodus 插件模板（可编辑）
export const tools = {
  hello: async (args, ctx) => {
    ctx.log('info', `hello 被调用：${JSON.stringify(args)}`);
    return `你好，${args?.name ?? '世界'}！（数据目录：${ctx.dataPath}）`;
  },
};

export const commands = {
  hello: async (args) => `插件命令 /demo.hello 收到：${args.join(' ')}`,
};
```

## 开放兼容扩展（V3 插件 API 增强）

### 4. onLoad 生命周期（index.js 导出 `onLoad(ctx)`——加载成功时调用）

```js
export const onLoad = (ctx) => {
  ctx.log('info', `插件已加载（dataDir: ${ctx.dataDir}）`);
  // 可在此做初始化；异常不会阻断加载
};
```

### 5. 自然语言触发注册（plugin.json 的 `nlTriggers`——新意图词直达命令）

```json
{
  "name": "my-plugin",
  "nlTriggers": [
    { "re": "/帮我(?:倒|泡)杯咖啡/i", "cmd": "/my-plugin.brew" }
  ]
}
```

输入「帮我泡杯咖啡」时直接触发 `/my-plugin.brew`（与内置意图词同通道）。

### 6. 工具危险声明（plugin.json 的 `danger` 字段）

插件工具默认 `danger: true`（外部代码恒需确认）。声明 `"danger": false` 的只读工具
获得只读语义（smart/manual/plan 模式不再恒需审批）：

```json
{ "name": "my_reader", "description": "只读查询", "danger": false }
```

### 7. 命令热更新

`/plugin reload` 现在完整重载：工具表重建 + 命令重注册（bus.register 同名覆盖）+ NL
触发注册——编辑插件后无需重启进程。

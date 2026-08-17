# WxNodus V3

Windows 本地 AI agent CLI：数据不出机，无 key 也有离线能力（本地离线模型 + 确定性工具 + 本地记忆）。

## 快速开始

```bash
npm install && npm run build
npm link            # 全局安装 wxnodus / wxn 命令
wxnodus             # 交互 TUI
wxnodus -p "帮我做一个待办系统"   # 非交互单次执行
wxnodus -p "你好" --json         # agent 结果 JSON
wxnodus -p "你好" --wire         # 总线事件流 JSONL
```

全量门禁（typecheck + 全量测试 + known-failures + 发现/覆盖检查 + 构建）：`npm run ci`

## 常用命令

| 命令 | 作用 |
|---|---|
| `/model` | 模型与密钥统一入口（选择器｜`/model add <模型ID> --base <URL>` 添加任意 OpenAI 兼容接口｜`/model set-key <密钥>` 配置密钥｜`/model key` 状态） |
| `/build` | 自然语言需求 → 可运行项目（AI 规格化 + 启动级验证 + 证据） |
| `/hole` `/memory` | 黑洞引擎记忆检索（FTS5 中文 + 向量，会话隔离） |
| `/calc` `/hash` `/sql` … | 确定性工具（毫秒级，不走模型） |
| `/cost` `/usage` `/balance` | 成本估算 / token 用量 / 余额监控（状态栏 💰📊$） |
| `/doctor` `/help` | 体检 / 命令总览 |

> 黑洞引擎记忆容量 ≠ 模型上下文窗口：每轮送入模型的上下文受 64k token 上限约束，超压自动压缩。

## 模型接入（接口开放）

任意 **OpenAI 兼容端点**（厂商直连 / 中转站）皆可接入：

- 模型选择器内「＋ 添加自定义接口」（四步表单：名称 → 地址 → 模型ID → 密钥可选），或命令：`/model add <模型ID[,ID2]> --base <URL> [--name 名称] [--key 密钥]`
- `/model set-key <密钥> [--provider <档案id>]` 密钥 AES-256-GCM 加密落盘（原 `/key` 已并入 `/model`）
- `/profile list|add|use|rm` 多档案管理；`/model <档案模型名>` 直达切换

## 自然语言免记命令

| 你说 | 触发 |
|---|---|
| 「帮我做一个待办系统」 | 生成可运行项目 + 证据链 |
| 「搜一下我之前说的黑洞」 | 黑洞引擎检索 |
| 「算一下 2+3*4」 | 确定性计算（毫秒级不走模型） |
| 「体检」 | 系统健康检查 |
| 「成本多少 / 花了多少钱」 | 成本估算（/cost） |
| 「余额还有多少」 | 余额查询（/balance status） |
| 「换个模型 / 加个接口」 | 模型选择器（/model） |

（以上路由有契约测试锁定，`tests/commands-intent.test.ts`）

## 键位与交互

| 键位/语法 | 行为 |
|---|---|
| `Tab` / `Shift+Tab` | 补全接受 / 权限模式循环 |
| `Ctrl+R` | 历史反向搜索 |
| `Ctrl+Shift+P` | 截图即问（视觉模型看图 / 文本模型 GLM 先识别） |
| `@路径` | 文件提及（Tab 补全 + 提交时展开） |
| 忙碌时 `Esc Esc` | 确认中断 → 指路 `/undo` 回滚 |

## 支持的终端（三级能力档）

| 档 | 终端 | 体验 |
|---|---|---|
| modern | Windows Terminal / VS Code / WezTerm / mintty / ConEmu | 全量：真彩 + 鼠标 + emoji |
| cmd | 经典 conhost（Win10 1511+） | 自动开 VT；256 色 + 键盘优先 |
| no-vt | VT 不可用 | 诚实行模式，绝不输出乱码 |

## License

Apache-2.0

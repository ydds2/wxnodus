# 规格：AI 接入层开放 + 余额监控 + UI 简约趣味改版（2026-08-17）

> 状态：设计已获用户确认（2026-08-17）· 竞品 UI 参考已提取（Claude Code / Codex / Kimi CLI 官方构造 digest）
> 范围：三个子系统，一个发布周期，三个提交步独立验收。

## 1. 子系统 A：接入层开放（协议范围 = 仅 OpenAI 兼容）

### 1.1 数据模型（settings.json）

```jsonc
settings.providers = [
  { "id": "deepseek", "name": "DeepSeek 官方", "baseURL": "https://api.deepseek.com/v1",
    "models": ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash", "deepseek-v4-pro"],
    "key": "enc1:…", "balanceUrl": "https://api.deepseek.com/user/balance" },
  { "id": "kimi", "name": "Moonshot Kimi", "baseURL": "https://api.moonshot.cn/v1", "models": ["kimi-k2.7", "kimi-k3"], "key": "", "balanceUrl": "https://api.moonshot.cn/v1/users/me/balance" },
  { "id": "zhipu", "name": "智谱 GLM", "baseURL": "https://open.bigmodel.cn/api/paas/v4", "models": ["glm-4-flash", "glm-4v-flash"], "key": "", "balanceUrl": "" },
  { "id": "relay1", "name": "我的中转站", "baseURL": "https://relay.example.com/v1", "models": ["gpt-4o-mini"], "key": "enc1:…", "balanceUrl": "", "balancePath": "" }
]
settings.activeProvider = "deepseek"
settings.balanceMonitor = { "enabled": true, "url": "", "jsonPath": "" }   // 空 url = 跟随当前档案 balanceUrl
settings.usageRange = "today"
```

- 迁移：首次加载把旧 `apiKeyEnc/apiKeys/model/baseURL` 迁入 providers[0]（备份旧 settings.json → settings.backup-<ts>.json），旧行为不变。
- 内置三家预置档案（deepseek/kimi/zhipu，含离线条目不建档——离线模型保留在 MODEL_CATALOG）。

### 1.2 内核改造

- `providers.ts`：MODEL_CATALOG 降级为「内置快捷项+能力徽标+离线条目」；新增 `resolveProviderProfile(settings)`（activeProvider → 档案；无档案时回退 catalog 推断的虚拟档案）；模型名校验放开——`settings.model` 任意非空字符串可用，仅空/缺失时回退档案默认（改 `agent.ts:352-353`、`cli/index.ts:190-200` 两处强制回退）；`resolveApiKey` 扩展档案 key 槽（档案 id 匹配 > apiKeys > 遗留单槽）与 env `WXNODUS_<档案ID大写>_KEY`。
- 档案键加解密复用 `encryptKey/decryptKey`（AES-256-GCM 机器指纹）。

### 1.3 命令面（对齐 ZCode/Kimi Code 便捷度）

- `/profile list|use <id>|add <名称> <baseURL> [--models a,b,c]|rm <id>|set-key <id>`；`use` 同步 settings.model 为档案默认模型并热生效（applyModel）。
- `/key set <key> [--profile <id>]`（缺省=当前档案，写档案 key 槽）；`/key import <file>`（.env 逐行 WXNODUS_*/KEY= 批量导入，逐条归属档案或建档案，回显导入计数）。
- `/model [modelId]`：当前档案内设置任意模型名（不再限定 catalog）；Ctrl+O 选择器混排「档案组 + 内置快捷组」。
- `/config export [--redact]`、`/config import <file>`（JSON；import 合并校验后写 settings + 热重载提示）。
- 命令分级（commandLevels.ts）：`/profile`=confirm（含子命令 set-key=confirm）、`/key import`=confirm、`/config export`=safe、`/config import`=confirm。

## 2. 子系统 B：余额接口适配库 + 子系统 C：状态栏监控

### 2.1 适配器（kernel/balance.ts，一家一纯函数 + 注册表）

| 适配器 | 端点 | 提取 | 取证状态 |
|---|---|---|---|
| deepseek | GET /user/balance | `balance_infos[]` 取 currency 匹配 CNY>USD 的 `total_balance` | ✅ 官方文档 |
| kimi | /v1/users/me/balance | `data.available_balance` + `data.voucher_balance` | ⚠️ 形状已知 (R) |
| siliconflow | /v1/user/info | `data.balance`/`data.totalBalance`/`data.chargeBalance` 任一 | ⚠️ (R) |
| openrouter | /api/v1/credits | `data.total_credits` | ⚠️ (R) |
| generic | 任意 | 键名启发式（balance/余额/available/cash/credit/total）+ `jsonPath` 兜底（自研 `a.b[0].c` 解析，零依赖） | 中转站主力 |

- 认证：按 URL host 选密钥（档案 key 槽 → env）；401/403/429/网络归因复用 `mapHttpError` 中文映射；**失败诚实降级**（状态栏 ⚠ 保留上次成功值+时间，`/balance status` 展示原因）。
- TTL 5 分钟缓存 + `/balance refresh` 强制。
- 合规：抓取成功 `appendAudit('balance.fetch',{ok,source,ms})`（不含密钥）；`/balance set` 写 ConsentLedger（scope=host、method=balance_monitor、grantor=user）。
- 无密钥可查余额的厂商（智谱/OpenAI/Anthropic）：档案 balanceUrl 留空 → 状态栏不显示该段，`/balance status` 诚实说明「该厂商未提供密钥可查余额接口」。

### 2.2 token 消耗（kernel/usage.ts）

- `usageSummary(db, range)`：usage_stats 跨会话聚合（today=本地零点；7d/30d 滚动窗口），返回 {input, output, total, calls}。
- 命令：`/usage range <today|7d|30d>`（白名单校验，safe 级）；`/usage` 原命令不变。

### 2.3 状态栏与 RPC

- RPC：`balance.status`（TTL 缓存）、`usage.range`、`profile.list|use`、`config.export|import`。
- UI：`useBalanceMonitor` 60s 轮询（对齐 useBatteryMonitor 模式）；usage 随 `agent.end` 事件刷新 + 60s 兜底。
- 状态栏两段：💰 余额（点击=强制刷新；失败 ⚠+旧值）· 📊 token（点击循环 today→7d→30d）；`statusSegmentsFor` 断点渐进披露；数字缩写（12.3k/1.2万）。

## 3. 子系统 D：UI 简约 + 动效/趣味（黑洞主题深化）

### 3.1 竞品参考（已提取，采纳项）

- **Kimi**：模式徽章着色（yolo 黄/auto 绿/manual 蓝/plan 紫）→ 状态栏；数字键 1-4 审批快速选择；启动欢迎卡片。
- **Codex**：角落小宠物（pets.rs）→ 黑洞情绪小宠物。
- **Claude Code**：状态行极简（模型+上下文+时间）、/tui 简单模式思路 → `settings.tuiSimple` 档位。

### 3.2 动效系统（lib/motion.ts 纯函数帧序列 + 现有 16ms 帧调度）

| 动效 | 位置 | 帧序列确定性（可单测） |
|---|---|---|
| 吸积盘旋转 | 启动欢迎卡片（~1.5s，`WXNODUS_NO_INTRO=1` 跳过） | ASCII 环逐帧 |
| 星尘粒子 | 状态栏背景 1 行 | 随机游走（种子确定） |
| 黑洞呼吸 | 状态栏品牌图标 | 256 色亮度脉动循环 |
| 流光 shimmer | 新消息首帧 | 一次性扫过 |
| 超新星 | 任务成功庆祝 | 字符爆发→消散 |
| 工具拟态 | bash=字符雨 / fs_write=尘埃 / web_search=星图 | 2-3s 自然消散 |

- 降级：`terminalTier` 三级——modern 全动效；cmd 纯 ASCII 静态+极简闪烁；no-vt 无。全局 `WXNODUS_NO_ANIM=1`。皮肤 `motion: off|subtle|full`。
- 性能红线：只写 damage 矩形内单格；与流式渲染共享 16ms throttle；不与 23k 节点虚拟化历史争帧。

### 3.3 简约改造

- 状态栏默认 `[模型 · ⚡上下文% · 模式徽章 · 时间]`，sessions/elapsed/battery 折叠为图标进 /status。
- 工具 trail 历史收进 thinking 面板折叠区（复用 details_mode collapsed）。
- 消息排版：行距呼吸感、回复首行结论加粗。
- 审批面板：数字键 1-4 快速选择（Kimi 同款）。

### 3.4 趣味

- 黑洞情绪小宠物（空闲眨动/忙时旋转/出错坍缩红移）——Codex pets 同款定位。
- 完成庆祝：超新星 + 随机趣味文案（扩展 LONG_RUN_CHARMS 语料）。
- 彩蛋：`/warp`（星际跳跃动画）、`/fortune` 扩展（完成时随机触发，settings.fortuneOnComplete 可关）。

## 4. 测试与验收

- 单测新增：档案迁移/模型名放开回归（含「catalog 外模型名不被强制回退」断言）、适配器 fixture（deepseek/kimi/siliconflow/openrouter/generic jsonPath）、usage 区间边界（零点/7d 滚动）、命令参数校验（/profile /balance /usage range 白名单）、motion 帧序列确定性、降级矩阵。
- 已知失败口径更新：MODEL_CATALOG 计数断言改为「catalog ⊆ 可用模型集合」。
- 回归：npm test 全绿；CLI 冒烟（/profile add 中转站 → /model 自定义名 → 对话成功）。

## 5. 边界（不做）

- OAuth 登录（需厂商客户端注册，第三方不可行；密钥直配是对齐「便捷」的诚实上限）。
- Anthropic/Gemini 原生协议（本期仅 OpenAI 兼容；经中转站覆盖）。
- 余额历史曲线、价格折算、图片渲染/音效/渐变背景。

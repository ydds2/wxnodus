# WxNodus 完善方案（基于上限测试与代码审计）

> 依据：2026-08-09 上限测试（63 项 61✓/2🔑/0崩溃）+ 能力审计（/build 编译链、记忆闭环、工具链、启动路径）
> 原则：每项方案都有实锤证据；实施后必须真实验证（cap-probe 复测 + vitest + tsc + build），拒绝占位与伪装完成。

---

## P0 —— 核心能力短板（证据确凿，直接影响「正常 coding 工具水平」）

### 1. /build 概念编译「LLM 开放域」从未实现（最严重）

**证据**：`src/build/spec.ts:62` 的 `makeSpec(input, _opts)` 中 `_opts.key` **从未被使用**；两个调用方（`handlers.ts:400`、`tools.ts:428`）都传了 `key`，但代码里没有任何 LLM 分支。规则脑 RULES 仅 5 条（ledger/todo/note/anim/generic），`/build 做一个计算器` **即使配置密钥也返回「需求无法编译」**（`handlers.ts:401`，scaffold=unknown）——因为「计算器」不在 5 条规则内，而 generic 兜底要求命中「系统/网站/应用/工具/页面/管理」关键词。

**目标**：`/build` 从「5 类模板匹配」→「任意自然语言可编译」。

**实现要点**：
1. `makeSpec` 增加 LLM 分支：`_opts.key` 存在时，调 agent 单轮生成 Spec IR（title/summary/scaffold/acceptance，JSON schema 约束，失败降级规则脑）——复用 `providers.ts` 的 `buildChatRequest`，不新增依赖
2. 规则脑 RULES 扩充高频需求词：计算器/爬虫/博客/图表/问卷/聊天室/短链/天气/翻译/文件管理 等 15-20 条，覆盖无密钥兜底
3. `scaffold: 'unknown'` 的错误信息改为分诊：`规则脑未命中——/key set 后可 AI 编译；或 /build --dry-run 查看规格诊断`
4. 验证：`/build 做一个计算器`（有/无密钥两态）、`/build 记账本 --dry-run`、单测 makeSpec 规则扩充

**预估**：1-2 个提交。

### 2. 记忆「删改」缺失——联网增删改查闭环不完整

**证据**：`tools.ts` 只有 `memory_search`（查）与 `memory_write`（增）；`memory.ts` 无 update/delete 接口。用户诉求「AI 主动自行联网增删改查」——增/查已闭环，删/改无入口（记忆只增不改，错误记忆无法纠正）。

**目标**：记忆四操作闭环。

**实现要点**：
1. `memory.ts` 新增 `updateMemory(id, content)`（改写 + 重索引）与 `deleteMemory(id | tag)`（删除 + 从 FTS5/向量索引移除）
2. `tools.ts` 新增 `memory_update`、`memory_delete` 工具（danger 标注，删除需确认）
3. `/memory` 子命令补 `update`/`delete`（list 已有 id 展示）
4. 验证：写→改→查（新旧内容均不残留旧文）→删→查（空）

**预估**：1 个提交。

### 3. /search 结果缓存（重复搜索防抖）

**证据**：上限测试 /search 主路径已提速到 8.9s；但同词重复搜索（AI 多轮调用 web_search 常见）会再次等 8s+。`web_search` 工具调用 `searchWeb` 无任何缓存。

**目标**：同查询 5 分钟内存缓存，重复搜索 <10ms。

**实现要点**：`search.ts` 内加 Map 缓存（key=query+maxResults，TTL 5min，上限 64 条防内存膨胀）；/search 命令与 web_search 工具共享同一缓存；缓存命中标注 `（缓存）`。

**预估**：半小时改动。

---

## P1 —— 稳定性与可靠性

### 4. 首次命令延迟（冷启动 11s）

**证据**：cap-probe 实测 `/hole` 11.1s、未知命令 11.0s——记忆库 FTS5/向量索引与 agent 初始化都是懒加载，首个相关命令才触发。

**目标**：启动后后台预热，首次命令 <2s。

**实现要点**：CLI 装配完成后 `setTimeout(0)` 后台执行：`mem` 索引 warmup + agent 工具表预构建（不发起任何网络/模型调用）；失败静默不阻断启动。

**预估**：半小时改动。

### 5. 错误归因分诊标准化

**证据**：`/build 做一个计算器` →「需求无法编译（…）——换个说法」误导用户（真因是规则脑未命中）；`/flow` 无密钥提示「未配置模型密钥」正确但分散在各自 handler。

**目标**：AI 依赖类命令统一分诊：`未配置密钥 → 规则兜底状态 → 需求问题`。

**实现要点**：`kernel/errors.ts` 或共享 helper 提供 `aiGateHint(action)`；/build /flow /learn /self-evolve /compact /digest /vision 等统一接入；cap-probe 加断言（需密钥类命令必须含「/key」指引）。

**预估**：1 个提交。

### 6. Git Bash MSYS 路径转换陷阱

**证据**：`-p "/help"` 在 Git Bash 下被转换为 `C:/Program Files/Git/help` → 路由到 AI 层（实测复现）。用户使用 Git Bash 运行 CLI 时 `-p` 参数以 `/` 开头必然踩坑。

**目标**：参数以 `/` 开头且含 `C:/Program Files/Git` 前缀时，给出明确提示。

**实现要点**：`args.ts` parseArgs 后检测 `prompt` 含 `Program Files/Git` 前缀 → stderr 提示 `疑似 MSYS 路径转换：请用 MSYS_NO_PATHCONV=1 或 MSYS2_ARG_CONV_EXCL="*" 运行`，exit 2。

**预估**：半小时。

---

## P2 —— 上限扩展（有密钥环境收益最大）

### 7. web_search 引擎参数与来源标注
- `web_search` 支持 `engine: 'duckduckgo' | 'bing' | 'auto'`；结果带 `来源：bing/duckduckgo` 便于模型引用可信度判断

### 8. /gate 质量门与 /build 自动联动
- 构建完成后自动跑 gate（当前 /build 已调 runGate——补「未通过门禁则构建标记 failed」的严格模式 `/build --strict`）

### 9. cron 秒级触发与结果回执
- 当前分钟级轮询（`index.ts:259` setInterval 60s）；补 `every Ns` 格式 + 任务完成 bus 事件（`jobs.complete` 已存在，补 cron 标签回执）

### 10. /term 管道输出
- `/term pipe <id> <文件>` 把 PTY 输出落盘（配合 /script 做长任务日志）

### 11. TUI 会话侧栏折叠
- 已实施的 UI 升级（c3650f9：语音开关/后台展示/目录选择器/特色页）基础上：会话列表支持分组折叠 + 搜索过滤（参考 zcode 双栏）

---

## 验证闭环（每项合入前必须）

1. **单测**：`npx vitest run` 相关用例（新增/更新 fixture）
2. **类型**：`npx tsc --noEmit` 零错误
3. **构建**：`npm run build`
4. **真实复测**：cap-probe 模式复跑受影响命令（真实进程，验证行为与归因）
5. **无伪装**：任何失败如实报（如 /build LLM 分支失败 → 降级规则脑并明示「AI 规格化失败，已用规则模板」）

## 建议执行顺序

```
P0-1 /build LLM 化   → 直接决定「coding 工具水平」名不副实与否
P0-2 记忆删改闭环    → 补齐「增删改查」原话承诺
P0-3 搜索缓存        → 半小时快赢
P1-4 冷启动预热      → 消除 11s 首命令
P1-5 错误归因分诊    → 全 AI 命令一致体验
P1-6 MSYS 提示       → 半小时快赢
P2-7~11             → 有密钥环境迭代
```

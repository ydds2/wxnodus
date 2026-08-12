# WxNodus 架构级剖析（诚实回答「套壳」批评）

> 承认：wxnodus 目前是「自研模块堆叠」——97+ 命令、33 工具、833 测试证明了广度与稳定性，
> 但缺少竞品级**统一设计骨架**。功能清单 ≠ 先进。本文件对比竞品的设计核心，列出结构性不足与重构路线。

## 一、竞品的设计骨架（为什么它们先进）

| 竞品 | 设计核心 | wxnodus 对应物 | 结构性差距 |
|---|---|---|---|
| **Claude Code** | 会话 = 可重放 JSONL 事件流（resume/fork/审计靠事件流） | messages 平表 + bus 通知事件 | 事件是「通知」不是「数据流」——无统一可重放会话 |
| **OpenCode** | MessageV2 parts 模型（逐 part 状态：compacted/tool/error）+ Effect 服务化 | messages 表（role/content/archived） | 消息粒度粗——无法表达「部分压缩」「消息内错误状态」 |
| **Codex** | 沙箱第一公民（read-only/workspace-write/danger）+ 独立评审代理 + granular 审批 | modeVerdict 六模式 + autoReview | 沙箱缺 OS 级；评审代理此前递归主 agent（已修） |
| **Cline** | 影子 git checkpoint（runCount 跨压缩寻址）+ 任务依赖链 | 表级快照 + 无跨压缩寻址 | 压缩后 checkpoint/undo 定位不稳定 |
| **Aider** | repo map 图算法 + git 原生集成（每编辑 commit） | 正则符号 + mtime 缓存 | 图排序/个性化未达 |
| **OpenCode** | 工具参数 schema 校验中介层（AI SDK） | 工具内部防御 | 已补（toolArgs.ts） |

## 二、wxnodus 结构性不足（已确认，非功能缺失）

### 已修复（本轮）
1. **autoReview 递归主 agent**（严重）：executeTool 内触发评审 → `agent.run()` 递归同一实例
   → turn 状态覆盖、同 sessionId 消息污染、轮次计数错乱。→ 改为 callModelOnce 独立单轮
2. **工具参数无校验**：模型传错参数靠各工具内部防御（错误信息不一致）。→ toolArgs.ts 统一中介层

### 仍未解决（重构路线）
3. **消息模型粗粒度**（最大架构债）：messages 平表无 parts 概念——工具输出/摘要/错误
   都是 content 字符串。影响：流式渲染（UI 无逐 token 状态）、逐 part 压缩标记、
   消息级 token 成本核算。重构：messages 表加 `parts` JSON 列（渐进式，不动现有行）。
4. **压缩与 undo/checkpoint 断裂**：compactSmart 置 archived 后，「轮次」语义漂移——
   压缩前 /undo 10 轮 vs 压缩后 5 轮。Cline 用 runCount 跨压缩寻址。重构：
   messages 表加 `run_no` 列（用户轮次递增），/undo 与 checkpoint 按 run_no 定位。
5. **会话不可重放**：bus 事件落盘 events.jsonl 但无统一会话流——/resume 只加载 messages
   表（工具执行/审批/压缩历史不可回放）。重构：会话 JSONL 事件流（Claude Code 对齐，
   渐进：新增事件写入 session-<id>.jsonl，resume 时重放）。
6. **LLM 层与 agent 循环耦合**：defaultCallModel 内嵌 SSE 解析/降级链在 agent.ts 内部。
   OpenCode 是独立 LLM service。重构：抽 `src/kernel/llmStream.ts`（SSE 解析/降级/用量
   统计独立模块）——agent 循环只消费结果。
7. **TUI 双状态**：gateway RPC 桥导致 UI store 与内核状态两套——事件丢失/轮询补偿。
   重构：UI 消费统一事件流（结合 #5 的会话流）。

## 三、重构路线（按风险/收益排序，渐进不破坏）

```
P0（已做）：autoReview 独立化 + 工具参数校验
P1：messages 表加 run_no（压缩寻址稳定）→ /undo、/checkpoint 按 run_no 定位
P2：llmStream.ts 独立（LLM 服务化）——agent.ts 瘦身
P3：会话 JSONL 事件流（可重放/可 fork）→ /resume 重放 + UI 消费同一流
P4：parts 消息模型（渐进列扩展）——流式渲染/逐 part 压缩
```

## 四、结论
「套壳」批评成立的部分：模块堆叠缺骨架（#3-#7）；不成立的部分：核心机制
（黑洞记忆/概念编译/SSRF/合规链）是自研且有深度。方向：**骨架补齐**而非更多功能——
先让「会话/消息/事件」成为统一数据流，所有子系统（压缩/undo/UI/审计）都消费它。

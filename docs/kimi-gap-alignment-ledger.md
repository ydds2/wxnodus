# kimi-cli 差距对齐台账（活文档）

> 起因：原差距清单随 `ee63a5b2`（UI 删除提交）一并丢失（kernel-eval-2026-08-27 §5 建议持久化）。本台账为唯一权威记录，对齐项落地时同步更新。
> 机制参考·实现原创：每项注明 kimi 锚点与本仓实现差异。

| # | 差距项 | kimi 锚点（语义） | 本仓落点 | 状态 |
|---|---|---|---|---|
| B | 后台通知回流（jobs 完成 → 主线注入） | `kimisoul.py:1135-1164` deliver_pending(limit=4)+Notification hook | `agent.ts` noticeQueue 回流 | ✅ 已合入（f88e3b10）；**通知 hook 事件仍未对齐**（见下） |
| C | 输出 token 钳制 | `kimisoul.py:1348-1387` max_completion_tokens=窗口−输入估算−余量 | `agent.ts:1285-1294` / `providers.ts:274-278` | ✅ 已合入 |
| D | 历史归一化（相邻 user 合并） | `dynamic_injection.py:58-84`（仅 user 合并+跳过通知消息） | `historyNormalize.ts`（user+user 与 system+system 合并——**本仓更宽**，不合并 tool 与带 tool_calls 的 assistant） | ✅ 已合入 |
| E | 工具去重 | `toolset.py:184-202,365-423` canonical 参数+同批合并 | `agent.ts` cacheable 声明式+回合缓存+批内 inflight | ✅ 已合入 + **C3 canonical 化补全（2026-08-27）** |
| — | 流式中途派发（on_tool_call） | 未取证（kimi soul 层为收集完整后执行模型） | `llmStream.ts` index-advanced + `agent.ts` earlyRuns（仅 cacheable 只读先行，fail-closed） | 🔶 批次2 未提交；**C2 标注传播已修（2026-08-27）** |
| — | 通知 hook 事件（Notification） | kimi hooks 引擎 Notification 事件 | **接线补齐（2026-08-27）**：hooks.ts 契约早已存在（HookRunner.notification）但 agent 从未调用（死接线同类）——noticeQueue 注入前触发 `hooks.notification('jobs', text)`，hook 异常不阻断注入 | ✅ 2026-08-27 |
| — | 旁路问答（/btw） | kimi `soul/btw.py:1-13`（保缓存/不入主上下文） | **已有实现（核对更正 2026-08-27）**：`handlersExt.ts:2111`——只读子代理隔离问答（隔离上下文不打断主对话）；机制形态与 kimi 不同（子代理隔离 vs 同提示单调用），用户价值等价——原差距评估「无等价」有误，已更正 | ✅ 已存在 |
| — | 参数 canonical 化（已并入 E） | `toolset.py:184-202` | `agent.ts` `canonicalToolArgs`（递归键序排序，数组顺序保持语义；环引用诚实回退） | ✅ 2026-08-27 |

## 已修复缺陷链（同日）

- **C1**（kernel-eval 3-1）：`agent.ts:676` 与 `permissions.ts:302` 双层 `require()` 死接线——sandboxFastPath 静默永不生效；且 vitest 注入 require 垫片使绿测试掩盖生产死接线（已取证：Node ESM `typeof require === undefined`）。修复：惰性 `await import` + 静态导入；agent 级接线测试（manual 模式判别器）。
- **C2**（kernel-eval 3-2）：提前执行标注随缓存传播——修复：缓存入库裸结果，标注仅本轮回填。
- **C3**（kernel-eval 3-5）：缓存 key 键序敏感——修复：三消费点共用 canonical 形态。
- **P1-4 附带**：`applyRules` 判定裁决精化——原注释宣称「deny>allow>ask」但排序只比 priority（同 priority 下 deny 被 allow 抢跑）；精化为 **priority → 具体度（有 pattern 先）→ decision（deny>ask>allow）**，B-06「收编兜底 deny 不遮蔽具体 allow」语义保持（kernel-exec-policy 回归锁定）；跨层 deny 不可放宽改由合并层信任序加权实现（global +2000 / user +1000 / project +0）。

## 更新纪律

对齐项合入必须：①更新本表状态列 ②注明 kimi 锚点复核状态（✅ 亲验 / ⚠️ 未复核）③本仓落点 file:line。本台账随仓库提交，禁止仅存在于提交信息与注释中。

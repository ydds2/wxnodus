# TUI 恢复与 kimi 风格完善方案（2026-08-28 · 终局记录）

> **目标（用户 2026-08-28 裁决）**：恢复/完善 kimi code 风格 TUI；排除企业策略深度（GPO 下发裁决）与双机真机电池。
> **终局**：本方案原计划「从 backup/pre-tui-removal 整档恢复重栈 UI（217 文件 wxnodus-ui + 自研 ink 渲染器）」。恢复执行完毕且全门禁验证通过后，发现并行会话在同一时间窗内已将产品方向定为**薄层 TUI**（b8fee082 薄层重建 + f28ef5e5 kimi 风格化，均已提交）——两栈冲突，且重栈恢复会回退并行线已提交的共享文件改动。经裁决对齐：**完整回滚重栈恢复，在薄层 TUI 上做增量补缺**。本文档保留全程真相供审计。

## 一、已执行与已回滚（审计记录）

| 阶段 | 动作 | 结果 |
|---|---|---|
| 重栈恢复 | backup 分支整档恢复 467 文件面（wxnodus-ui/ink/app 遗骸/适配器/61 测试/共享文件）+ package.json 合并 + npm install + build:ink | 全门禁绿（typecheck 0 / 全量 3601 / lint / cycles——含断掉备份期即存在的 thinking↔accordion 运行时环） |
| 冲突发现 | HEAD 期间前移 9 提交（ac16be37/5cb04bbe/b8fee082/f28ef5e5/1f55e7b0 等）——薄层 TUI 已成产品方向 | 重栈恢复 = 与已提交工作冲突 + 回退共享文件新版 |
| 完整回滚 | 共享文件 checkout HEAD；恢复文件按清单精确清除（59 未跟踪测试逐一比对删除清单；ink 目录整体移除）；npm install 复位 | 树 = HEAD + 本文档（薄层 TUI 测试 30/30 复验绿） |

## 二、薄层 TUI 增量补缺（实际交付）

并行线 T1–T7（思考折叠动画/Markdown 增量提交/Using-Used 工具行/severity 通知/底栏/主题令牌/Ctrl+C）已覆盖 kimi 风格主体。本轮审计出的两项真实缺口并落地：

| # | 缺口 | 实现 | 测试 |
|---|---|---|---|
| **T8 工具编辑 diff 红绿渲染** | output-spec 十类事件含 diff，薄层未消费；kimi 编辑回显核心视觉。数据源缺口：agent.tool complete 事件原无输出文本 | ① 内核 agent.ts complete 事件新增有界 preview（600 字，低频事件落盘可接受）；② ansiRenderer.hasUnifiedDiff/renderDiffPreview（@@ 青/+绿/-红/上下文 dim，非 diff 行收口，12 行上限）；③ interactiveLoop complete 分支消费 | 渲染器 3 用例（含 colors:false 纯文本）+ 回环 2 用例（渲染/不误判）+ 内核 1 用例（600 截断） |
| **T9 底栏会话 token 段** | kimi 底栏用量展示；薄层底栏无 token 信息 | ToolbarParts.sessionTokens dim 段（参与降级链：tip 先让位→token 随后→bare 档让净；bare 因 columns≥20 钳制实际不可达，如实测）+ interactiveLoop 每回合收口累计 | 渲染器 3 用例（可见/缺省不占宽/降级序） |

台账同步：docs/kimi-gap-alignment-ledger.md T8/T9 两行。

**方向校准增录（用户裁决「重新写而非复原」后第二批原创）**：T10 词级 diff 高亮（splitCommon 前后缀剥离 + 配对中段加粗，连续删/增行按位配对）· T11 Tab 斜杠命令补全（slashCompleter 纯函数 + registry SLASH 候选源 + cli 装配）· T12 反斜杠续行多行输入（… 提示符/偶数豁免/收口合并）。全部新写代码，零备份引用；+9 用例。

## 三、排除项（用户裁决，未触碰）

- 企业策略深度（GPO 下发裁决与实现）
- 双机真机电池（五组手动电池/真实 feed 升级端到端）

## 四、验证

- 定向：tui-ansi-renderer + tui-interactive-loop 23/23；kernel-agent T8 断言 1/1
- 全套门禁：typecheck / typecheck:tests / lint / cycles / 全量 vitest（见本轮收口输出）

## 五、遗留与建议

1. 未提交：本轮 T8/T9 + 测试 + 文档（建议与并行线协调后一并入库——共享文件无冲突，纯增量）
2. TUI 真机交互冒烟（TTY 手动）仍属排除项；建议用户日常使用中反馈视觉问题回填台账
3. 重栈能力如有回捞需求（vim 层/主题市场/DiffRenderer 词级 diff），backup/pre-tui-removal 分支永久可查——按「机制参考·实现原创」逐项移植，不再整栈恢复

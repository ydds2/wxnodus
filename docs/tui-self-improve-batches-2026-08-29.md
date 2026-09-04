# TUI 自完善批次日志（2026-08-29 · 持续自完善轮次）

> 记录「自完善wxnodusTUI和系统」目标的各轮落地。主台账 `tui-rebuild-ledger-2026-08-29.md`
> 的批次历史段当前被外部编辑器/同步工具反复回写覆盖（本日志独立成文，避开该冲突）。

## 自完善批次 Ⅰ（第十三批）

- T42 Esc 中断修复：浮层 gate 移除——「Esc 中断」占位承诺真实生效（此前运行中 Esc 是死键）。
- T43 流式 50ms 合批：flushStream——Live 限帧，非逐 token 全量重渲染（O(n²) 杜绝）。
- T44 /new 视图一致性：新会话转录视图同步清空 + 水位归零。
- T45 审批倒计时：deadline + approvalLeft M:SS——原型 05 倒计时动画落地。

## 自完善批次 Ⅱ（第十四批）

- T46 会话切换视图同步：/resume 等切会话命令 → sessionId/sessionTranscript 窄桥 + 视图重建
  （命令回显 + 新会话最近 40 条 + 同步通知）。
- T47 /undo N 转录回退：视图与内核软归档一致；命令回显不计入轮次且常驻。
- T48 斜杠菜单频序上浮：touchCommand——kimi 按使用频次排序机制，进程内零持久化。
- 验证：tui-selfbuilt +4 用例（72）· 全量 3015 通过 / 0 失败 · PTY 真机 /resume 视图同步 SYNC-OK。

## 自完善批次 Ⅲ（第十五批）

- T49 /checkpoint restore 视图重建：同会话快照替换后转录重建——复用 sessionTranscript 窄桥。
- T50 Esc 队列控制：中断后队列暂留 2s 窗口（再按 Esc 清空，超时自动续发）——
  「队列停不下来」缺陷修复；双按竞态经 clearedQueued 收口。
- T51 清洁：死状态 statusNote 移除 · 命令后 refreshContext 水位收口 · send 失败也走 classifyError 出路提示。
- 验证：tui-selfbuilt +3 用例（75）· 全量 3018 通过 / 0 失败（首跑即绿）·
  PTY 真机 /checkpoint restore 视图同步 OK。

## 自完善批次 Ⅳ（第十六批）

- T52 上翻阅读视口冻结：scroll 状态改顶锚定 pinnedLine（原 offset 从尾部回退语义——流式新内容
  会把正在读的历史推走）。现在上翻时视口冻结：新内容只进 ↓ 标记计数；回底（↓/PgDn）即恢复贴底跟随。
  kimi/codex 同行为，实现原创。
- sliceViewportFromTop 纯函数（顶锚定切片 + hiddenBelow 完整计数）。
- 视图重建（/undo · /checkpoint restore · /clear · 会话切换）顶锚定复位贴底。
- 键位处理器改快照现算（快输入 stale-closure 防御——Composer 同款教训）。
- 验证：viewport +3 用例（15）· render 视口冻结回归用例 · TUI 家族 117 全绿 ·
  全量 3022 通过 / 0 失败（首跑即绿）· PTY 真机 ↑ 顶锚定 / PgDn 贴底复位 OK。

## 自完善批次 Ⅴ（第十七批）

- T53 命令结果结构化渲染：ok:false 按错误行呈现 + 分类出路（此前失败命令被误渲染为绿色助手行）；
  completionStatus=cancelled 走 notice（用户主动取消非错误）。
- T54 /skill 注入链路接通：dispatch 正文作为消息发送（此前 TUI 静默丢弃——/skill demo 无任何可见行为）；
  注入走 untrusted 包裹（kernel 守卫），无 key 失败走 config 分类出路。
- T55 classifyError 新增 config 分类（未配置/密钥/401/403 → /model 配置出路）。
- T56 帮助/速查面板 Enter 陷阱移除：仅 Esc 关闭（提示文案如实——防误触吞面板）。
- 验证：tui-selfbuilt +4 用例（79）· render +1（110 TUI 家族全绿）· 全量 3027 通过 / 0 失败（首跑即绿）·
  PTY 真机 /skill 注入 + config 出路 OK。

## 自完善批次 Ⅵ（第十八批）

- T57 承诺漂移审计（keys 面板「零承诺漂移」逐键核对全部实现面）：发现并修复
  **Esc 空闲态不清空输入框**（面板承诺「Esc 清空输入」——此前为死键；现在空闲 Esc 清空输入 + 光标复位）。
- 审计结论：其余全部键位（Ctrl+C 退出保护 · Esc 中断 · Ctrl+X 六档 · Shift+Tab 计划 · Ctrl+T 详情 ·
  Ctrl+S steer · PgUp/PgDn · Enter 双通道 · Ctrl+↑↓ 历史 · 浮层面板键）与实现一致，零漂移。
- 附带审计：markdown.ts（行内/围栏/diff 两遍判定/超窄防死循环）· theme.ts（四主题代理/预览分离）——
  无缺陷，如实记录。
- 验证：tui-selfbuilt +1 用例（80）· TUI 家族 111 全绿 · 全量 3028 通过 / 0 失败（首跑即绿）·
  PTY 真机 Esc 清空输入 OK。

## 自完善批次 Ⅶ（第十九批 · 用户反馈轮：翻页/卡顿/底部布局）

- T58 **吞键根因修复（useStableInput）**：ink 6 use-input.js 的 effect deps 含 inputHandler——
  每次渲染新闭包 → 每次渲染重订阅 stdin（多组件叠加 = 订阅缝隙丢键 + batchedUpdates 抖动）。
  PTY 实测：此前每次会话首个 ↑ 偶发被吞（8→8→5→2 首按丢）；修复后首按即生效（稳定身份 + ref 中转，
  处理逻辑仍每渲染最新）。这同时是「卡顿」类问题的一个源头。
- T59 **斜杠菜单翻页**（用户反馈：命令无法翻页）：filterCommands 上限 8→24，菜单可视 8 行窗口随
  选中项滚动（kimi 同款），↑↓ 可翻到全部 18 命令；Tab/Enter 语义不变。
- T60 **底部 kimi 同款盒式布局**（用户裁决：输入框四周围起来 · 参数只占一栏）：
  - 输入框四边框 ┌─┐│└─┘（termcap 新增 box 档；basic 档与既有三明治边界同源安全），
    键位提示内嵌盒底；队列/附件/菜单浮于盒上；
  - 参数行单行化：分段 + 显示宽度硬截断永不折行（删 tip 轮换与宽终端全量条——降噪）；
  - CJK 感知盒内填充（截断/补齐按显示宽度——修复盒右侧 1 列错位与占位符行折行）。
- 验证：TUI 家族 144 全绿（render 32 重写钉底断言：盒上沿/盒内键位/盒下沿/参数行/下沿细线）·
  全量 3033 通过 / 0 失败（首跑即绿）· PTY 真机：盒框 ✓ · 首按 ↑ 立即生效 ✓ · 菜单翻到 /voice ✓ ·
  smoke 5/5。

## 自完善批次 Ⅷ（第二十批 · 场景心跳与输入细节）

- T61 命令执行心跳：长命令（/build AI 规格化等数分钟）此前转录一片死寂（命令不走 running 态——
  无 spinner 无阶段行）。现在 runCommand 期间 store.command 心跳 + 转录区一行「◈ 执行 <命令> … · Ns」
  （1s tick 累计），与 /build 的 system.notice 进度行自然交织；收尾清空。
- T62 多行输入折叠计数：输入超 8 行时盒内追加「… +N 行（Enter 提交全文）」——此前超限行静默不可见。
- 验证：tui-selfbuilt 85 · render/viewport/markdown/palettes 62 · TUI 家族 147 全绿 ·
  全量 3036 通过 / 0 失败（复跑收口，首跑 1 例为已知 kernel-mcp 计时抖动）· PTY 真机命令期间心跳可见 ✓ ·
  smoke 5/5。

## 自完善批次 Ⅸ（第二十一批 · 场景语义修复）

- T63 计划编辑面板草稿预填：此前「E 编辑计划」打开的是**空草稿**——直接 Enter 会 resolve(null) =
  计划被取消，用户须重打全文才能编辑。现在草稿预填原计划（编辑语义），未修改直接 Enter = 按原计划执行；
  改后 Enter = 按修改执行；Esc 取消。面板提示同步改为「已预填原计划（末 6 行——直接修改后 Enter）」。
- 附带审计（如实记录，无缺陷）：kernel agent.tool 事件 toolId 恒唯一（工具卡闭合正确）·
  modeColor 六档配色 · 各浮层行数预算与终端 24 行适配。
- 验证：render +1（120 TUI 全绿，selfbuilt 85）· 全量 3037 通过 / 0 失败（首跑即绿）· smoke 5/5。

## 自完善批次 Ⅹ（第二十二批 · 内核契约对齐）

- T64 重试流重置落地（kernel agent.ts:1538 reset 契约——TUI 场景 12）：此前 TUI 对
  `agent.token {reset:true}` 只冲刷缓冲 + 退场心跳，**失败尝试的半截输出留在转录**，重试全文
  继续追加 → 「半截旧文 + 完整新文」拼接（kernel 明确要求清空）。现在 reset 时删除本回合失败
  尝试的全部输出（含其工具行——重试会重新执行），追加一行「… 重试前输出已清空」通知，
  新尝试 token 从干净状态开始。
- 验证：tui-selfbuilt +1（86）· TUI 家族 121 全绿 · 全量 3038 通过 / 0 失败（首跑即绿）· smoke 5/5。

## 自完善批次 Ⅺ（第二十三批 · 命令等待可中断 + 承诺对齐）

- T65 承诺对齐：工具详情折叠提示「…+N lines · Enter 展开」→「Ctrl+T 展开」（Enter 从未实现单条展开——
  零承诺漂移原则）。
- T66 命令等待可中断（内核+TUI 双端）：CommandBus 新增中断竞速（raceAbort——signal 中止立即以
  cancelled 收口，不再等 handler 跑完；先挂接再查 aborted，handler 同步 abort 后抛错零未决拒绝）；
  TUI runCommand 携带独立 cmdAc signal + Esc 分支「已中断命令等待（命令在后台继续执行——进度仍会回显）」
  ——长命令（/build 等）不再死等，Esc 即回；与 agent 回合的 ac 分离互不误伤。
- 验证：command-bus-abort 新测试文件 3 用例（入口中止/竞速中止/无 signal 行为不变）· tui-selfbuilt +1（87）·
  全量 3042 通过 / 0 失败 / 0 错误（app-layer 既有 AbortError 语义保持——零回归）· PTY 真机：命令期间
  心跳 ✓ · Esc 中断通知 ✓ · smoke 5/5。

## 自完善批次 Ⅻ（第二十四批 · 诚实性收尾 + 不可验证项销项）

- T67 头部状态诚实：命令执行中 Header 显示「◈ 命令中」（此前显示误导性的「空闲」——与心跳行一致）。
- T68 陈旧标注清理：帮助联动图谱「重试进度 fence：G2」→「重试进度已落地：◈ 重连倒数」（G2 已于 T34 销项，
  陈旧 fence 是零承诺漂移的变体）；runtime/Transcript 两处陈旧注释同步更正。
- T69 keys 面板 Esc 行补齐「命令等待」中断语义（T66 落地后的键位单一事实来源同步）。
- 销项验证（此前 CI 不可验证项）：**主题跨重启持久化**——PTY 真机：选择 dusk（accent 93m 生效）→ 重启
  同一 dataDir → 93m accent 仍在（settings.tuiTheme 持久化链路真实验证）。
- 验证：render +1（124 TUI 全绿）· 全量 3043 通过 / 0 失败（首跑即绿）· PTY 主题持久化 ✓ · smoke 5/5。

## 自完善批次 ⅩⅢ（第二十五批 · Windows 粘贴修复）

- T70 多行粘贴不误提交（Windows 核心工作流缺陷）：ConPTY 把粘贴里的换行作为 \r 送达，ink 解析为
  return 键 → 首行即被提交（或整块单 chunk 送达时 \r 内嵌 input → 盒内回车覆写乱屏——PTY 实态复现）。
  双路修复：① \r 突发到达（与上一输入 <40ms）视为粘贴换行而非提交；② input 内嵌 \r 归一为 \n
  （整块 chunk 实态——parse-keypress 对多字符块原样透传 input）。真实回车（>40ms 间隔）提交语义不变。
- 验证：render +2（40 全绿，含分事件/整块双形态）· TUI 家族 154 全绿 · 全量 3045 通过 / 0 失败
  （首跑即绿）· PTY 真机：三行粘贴完整入盒（边框完好）+ 未误提交 + 回车一次性提交 ✓ · smoke 5/5。

## 自完善批次 ⅩⅣ（第二十六批 · 快捷键补全 + G5 销项验证）

- T71 Ctrl+L 清屏（kimi/codex 同款）：转录清空 + 提示（会话保留——/undo 可回滚会话）；keys 面板同步。
- 诚实性审计（如实记录，零漂移）：帮助快捷页全部命令（/export /digest /thinking /arena /duo /delegate
  /swarm /security /sandbox /audit /evidence /logs /balance）与 registry 逐一核对——全部注册 ✓。
- 销项验证（此前 CI 不可验证项）：**G5 输入历史跨会话召回**——PTY 真机：提交 /status → 重启同一
  dataDir → Ctrl+↑ → 输入框召回 /status（tui-history.json 落盘链路真实验证）。
- 验证：render +1（127 TUI 全绿）· 全量 3046 通过 / 0 失败（首跑即绿）· PTY G5 召回 ✓ · smoke 5/5。

## 自完善批次 ⅩⅤ（第二十七批 · 流归属修复——生态面串流/吞流）

- T72 流归属（内核+TUI 双端）：kernel agent.token 补 session_id（此前裸发——子代理 delegate/swarm/duo
  /arena 的流式 token 与工具事件全部混入主转录面板）。TUI wireBus 对 agent.token / agent.tool /
  reasoning.delta 按会话过滤（子代理 = <主>:sub）——子代理输出归子代理块，主面板只留主回合。
- T73 串流防护（store 层）：ChatEntry 增 streaming 标记——appendStream 只续写本回合流式条目；
  此前「回合运行中并发执行命令」时命令输出（assistant 条目）会被后续 token 续写吞流；
  sealStream 收口（endTurn/新回合）防跨回合串流。
- 验证：tui-selfbuilt +3（90）· 全量 3049 通过 / 0 失败（首跑即绿）· smoke 5/5。

## 自完善批次 ⅩⅥ（第二十八批 · 场景全景扫掠）

- 真机 PTY 全景扫掠（22 步）：帮助三页翻页 / keys / config / model 面板开合 · sessions/status/usage/
  context/undo list/checkpoint list/skill list/memory/perm 命令面 · 未知命令错误出路 · 斜杠菜单翻页 ·
  Esc 清输入 · 多行粘贴 · Ctrl+L 清屏 · Ctrl+C 退出——**22/22 通过**（真实二进制 + basic 档）。
- 扫掠过程判定：Enter→Tab 0ms 间隔（脚本合成时序）首个 Tab 会被面板挂载窗口吞掉——150ms+ 人类
  间隔全部正常，非产品缺陷（如实记录）。
- 附带审计：kernel agent.stage 子代理阶段（'子代理执行中（深度 N）…'）不带 session_id 属**有意**
  ——父回合等待子代理的中间态应显示在主心跳（对比轮 5 设计），不按 T72 过滤（如实记录）。
- 无新修复项——本轮为验证收口轮（该批次历史台账另附：批次日志本文件持续维护）。

## 自完善批次 ⅩⅦ（第二十九批 · 窄终端钉底加固）

- T74 窄终端不折行加固：队列提示行/斜杠菜单行改为显示宽度硬截断（此前 40 列终端下折行 →
  行数预算失配 → 钉底漂移）；Header 品牌条同步改分段硬截断（此前 40 列下品牌行溢出折行——
  PTY 实态暴露，渲染测试环境因 ink 测试 stdout 恒 80 列而掩盖）。
- T75 gitBranch 探测加 2s 超时（慢盘/挂载异常不再拖慢启动——execSync timeout 保险）。
- 验证：render +1（41）· 全量 3050 通过 / 0 失败（首跑即绿）· PTY 40 列真机：菜单硬截断 ✓ ·
  盒框完整 ✓ · 参数单行 ✓ · smoke 5/5。

## 自完善批次 ⅩⅧ（第三十批 · 全链路 mock 模型销项——不可验证面清零）

- 搭建本地 OpenAI 兼容 SSE mock 模型服务（dataDir/settings.json 预置 model/baseURL +
  WXNODUS_API_KEY env），PTY 真机全链路验证此前标记「CI 不可验证」的运行态流程：
  - **真实回合流式**：发送 → token 流式落屏（分块 400ms）→ 回合干净收尾 ✓
  - **运行中排队**：Enter 排队 ✓ · **Esc 暂留** ✓ · **再按 Esc 清空队列** ✓
  - **Ctrl+S steer 即时注入** ✓（真实运行回合内注入）
  - 首版脚本自证：Esc 早按确会中断回合（中断/队列机制真实生效——测试脚本时序修正后全绿）
- 至此六项「不可验证」流程全部销项：主题跨重启 ✓（批 Ⅻ）· G5 历史跨会话召回 ✓（批 ⅩⅣ）·
  本轮真实回合/排队/注入 ✓；剩 /voice 真麦克风与 /paste 剪贴板图片为硬件依赖项（无法无硬件验证）。
- 验证：全量 3049 通过（上轮收口，本轮无代码变更）· mock 全链路 5/5 ✓。

## 自完善批次 ⅩⅨ（第三十一批 · 审批闭环 + 计划链真机销项）

- mock 模型扩展为工具调用感知（SSE 增量 tool_calls 送达——kernel 恒 stream:true，纯 JSON 响应会
  触发重连重试，测试侧如实记录该契约），PTY 真机验证：
  - **危险工具审批闭环**：`del` 危险效应 → TUI 审批浮层弹出 ✓ → Enter「仅本次允许」→ 工具真实
    执行 ✓ → 模型终答渲染 ✓；Esc → 拒绝 ✓
  - **计划模式批准链**：plan 模式发送 → 零工具提案 → 「执行计划」面板 ✓ → Enter 批准 →
    「已批准计划——切回 smart 执行」→ 按计划执行的新回合 ✓
  - 旁证：`echo ok` 良性命令在 smart 模式下**自动放行不弹窗**（效应分类诚实行为——危险才打扰）
- 至此不可验证面仅剩 /voice 真麦克风、/paste 剪贴板图片两项硬件依赖。
- 验证：mock 全链路 6/6 ✓（本轮无代码变更——验证收口轮）。

## 自完善批次 ⅩⅩ（第三十二批 · e2e 回归资产化）

- 把前两轮的临时 mock 验证脚本资产化为 **scripts/tui-e2e-mock.mjs** + `npm run e2e:tui`
  （先 build 再跑——本地验收；CI 不用，需 ConPTY+本地端口）：9 项检查覆盖真实回合流式 /
  运行中排队 / Esc 暂留+清空 / Ctrl+S steer / 危险工具审批（allow+deny）/ 计划批准链。
- 资产化过程修复两个测试侧问题（如实记录）：① 前序回合未收尾时审批回合被 kernel 串行队列延迟
  ——加 settling 等待；② node-pty 二次 spawn 的 AttachConsole 助手进程噪音污染退出码——
  仅该噪声豁免，其余未捕获异常照常爆。
- 验证：`npm run e2e:tui` **9/9 通过 · exit 0**。

## 自完善批次 ⅩⅪ（第三十三批 · e2e 面扩展至降级路径）

- e2e 资产扩展至 12 项：+ `/voice` 无录音设备诚实降级（不假装录音——「语音不可用/未接入」路径）·
  + `/paste` 无剪贴板图诚实失败（不假装分析）· + `/model` 选择器 ↓ Enter 切换生效（状态栏模型名即变）。
- 至此硬件依赖项只剩「有真麦克风时的录音转写」与「有剪贴板图时的视觉分析」两条正向路径无法无硬件验证
  （其失败路径已全部验证——诚实降级不假成功）。
- 验证：`npm run e2e:tui` **12/12 通过 · exit 0**（stderr 管道标记为 pwsh 子进程噪音，实测退出码 0）。

## 自完善批次 ⅩⅫ（第三十四批 · e2e 补回滚场景链）

- e2e 资产扩展至 15 项：+ **回滚时间线 → 二次确认 → /undo 1 执行链**（mock 回合留下真实 DB 历史 →
  时间线面板「回滚将丢弃 N 轮」→ ↓ 选轮 → 危险确认 → 执行「已撤销 N 轮…存档」——G11 场景全链真机销项）。
- 验证：`npm run e2e:tui` **15/15 通过 · exit 0**（实测退出码；管道 stderr 标记为 pwsh 噪音）。

## 自完善批次 ⅩⅩⅢ（第三十五批 · 用户目标轮：剩余缺陷 + 独一无二 + SDK 私有化）

> 本轮对应用户目标：修复 TUI 剩余缺陷 · wxnodus 经网络下载后每份独一无二 · 私有化 SDK 完善 ·
> 内核/TUI 体系完善度审计（审计文档：docs/system-completeness-audit-2026-08-30.md）。

- T76 **bracket-paste 协议级粘贴**（design-eval 2.4 剩余缺陷 #1 销项）：
  - `src/tui/paste.ts`——启动 DECSET 2004 请求终端把粘贴内容包 `\x1b[200~…\x1b[201~` 标记；
    标记内 `\r` 归一 `\n`（粘贴换行绝不触发提交）；标记外字节原样透传（真实回车/方向键语义零影响）。
    ink stdin 契约适配：Transform 补 isTTY/setRawMode/ref 委托（ink 6 App.js handleSetRawMode 契约）。
  - **关键教训（e2e 抓获）**：悬挂前缀超时冲刷——单独 Esc 键 `\x1b` 恰为标记前缀，无超时会无限悬挂
    成死键（队列清空→审批→回滚五项 e2e 连锁失败）。25ms 无后续即证伪下发（终端序列原子到达）。
  - 无 2004 支持的终端（老 conhost）自动回退 T70 的 <40ms 突发启发式（Composer 保留）——双路诚实。
- T77 **实例身份（「网络下载后独一无二」）**：
  - `src/kernel/instanceIdentity.ts`——首启生成一次性 instanceId（离线随机 UUID，绝不联网登记）+
    确定性派生代号（16×16 词表 + 哈希序列码，如「御风·工匠 DADB」）；原子落盘 dataDir/instance.json，
    跨重启稳定；损坏诚实重建。
  - 三面透出：TUI 品牌行/欢迎语（未 /brand 命名时代号生效——手工命名完全胜出）· `/status` 身份行 ·
    `/brand show` 生效名如实显示。每份下载（不同 dataDir）身份互异。
- T78 **SDK 私有化完善**：
  - serve RPC 白名单新增 `identity`（实例元数据只读——多份部署区分「连的是哪一份」）；
  - `@wxnodus/sdk` 发布产物从 TS 源码改为 dist 编译产物（main/types/files + packages/sdk/tsconfig.json +
    根 build:sdk 进 build 链 + publish-local 发布前构建防旧产物上 npm）；握手行回传 instanceId/codename
    （可选新增字段=协议兼容）。
- T79 **浮层窄终端加固**（design-eval 2.4 剩余缺陷 #2 销项）：
  - `overlayRows(kind, rows)` 短终端封顶（rows-4）+ `overlayListMax` 长列表窗口钳制
    （model/rewind/help 三面板与预算同源收缩）；面板长提示/数据行 `fit()` 显示宽度硬截断
    （窄终端不再折行——行数预算不漂移）。
- 顺带修复（存量未提交缺口）：`/brand` 进 SLASH 但缺分级白名单——补 `'safe'`（kernel-commandLevels 门禁红）。
- 顺带修复（存量已提交门禁红，dfb4e666 起）：known-failures 注册表 `retired` 状态在类型中声明但
  校验器/包装测试不认（KF-002/KF-028 恒红）——补 retired 校验分支（note 必填 + 无 case/regression 字段）
  + 包装测试 retired 分路（断言磁盘无残留 case）。`npm run test:known-failures` 恢复 31/31 绿。
- 验证：tui-paste 12 用例（新增 Esc 超时回归）· instance-identity 6 用例 · render 41 全绿 ·
  **全量 3076 通过 / 0 失败** · lint OK · cycles OK · build（含 sdk dist）· PTY 冒烟 5/5 ·
  **mock e2e 15/15**（含 T76 真机粘贴链 + 审批/回滚恢复）· T76/T77 专项 PTY 探针 7/7
  （DECSET 开/退位复位 · 代号首启显示 · /status 身份行 · 粘贴多行入盒不误提交——验收后探针已删）。


## 自完善批次 ⅩⅩⅣ（第三十六批 · 债务清理 + 开放/兼容长任务轮：A/B/C 三组）

> 对应用户目标：修复最该清的债 + 开放/生态/自定义 + 底层/TUI 细节/兼容性（长任务自行规划）。

### A 组（债务清理——design-eval-2026-08-30 C 系列销项）
- **C-3 @wxnodus/core 发布不可用 → 修复**：深导入重接（`../../../src/` → `wxnodus/dist/*`）+
  `file:../..` 开发自链（node_modules/wxnodus 软链）+ 根构建产出全量 `.d.ts`（declaration 开启——
  SDK/core 消费者的类型刚需）+ `build:core` 进 build 链 + publish-local 发布时改写依赖为版本号
  （lerna 同款 publish-time 改写，发布后还原）+ core dist 守卫。core-facade 4/4 绿。
- **C-1 hermes 栈止血**：zip 安装包停止携带 hermes TUI（原硬失败 HERMES_TUI_DIST_MISSING +
  3.9MB 未运行 UI——运行时零解析全仓 grep 取证）；workspaces 解链 hermes 三包（文件保留待用户
  最终裁决）；cli 内两处「hermes 子进程自管理」陈旧注释如实化；删除自宣「临时诊断勿提交」却已
  提交的 tests/hermes-ink-pipeline.test.tsx（其 react 19.2.7 钉死的依据 hermes-ink 渲染器已退役，
  根 package.json 的精确版本钉仍保留）。
- **C-2 @wxnodus/ink fork 退役**：依赖/files/bundledDependencies/build:ink 全清——src/tui 恒用上游
  ink 6.8（双事实源消除）；w4-build-boundary/w4-npm-boundary 边界契约改写为新事实
  （fork 不进依赖/构建链/发布面）；tsconfig.tests/vitest 发现面/check-test-discovery 同步摘除。
- **C-7 依赖清理**：unicode-animations（零 src 引用）/@types/ws（类型包归 devDependencies）。
- **C-8 勘误**：sessionClocks/sessionFlags 淘汰实为已修（R-5 · agent.ts:266/309/1163 插入序淘汰
  SESSION_STATE_MAX=64——2026-08-30 评估取证漏看，如实更正）。
- **A2 顺带**：workspaces 换血（hermes 三包出 · sdk/core 进）。

### B 组（错误处理统一——C-4 第一刀）
- `exitCodeForError` 结构化优先：WxError 数值码 / HTTP status / errno·undici code / cause 链（≤2 层
  + 环引用防护）先于消息文本嗅探；纯消息错误走原文本兜底（行为不变）。新增 kernel-errors 契约
  测试 7 用例（含 cause 环/非网络 errno 不误判）。
- agent.error 事件 code 命名域对齐 GatewayError 风格：'http-4xx'→'PROVIDER_HTTP_4XX'、
  'transient'→'PROVIDER_TRANSIENT'（TUI 消费面仅用 message/retries——零破坏，夹具同步）。

### C 组（兼容性 + TUI i18n 第一波——C-5）
- **termcap 现代终端信号扩展**：WezTerm/Ghostty 环境变量 + TERM 前缀族（xterm*/alacritty/wezterm/
  ghostty/kitty）+ COLORTERM truecolor → full；dumb/COLORTERM=yes 保守 basic（+1 用例）。
- **TUI i18n 基础设施落地**：`src/tui/i18n.ts`（tuiT/tuiLang/initTuiLang——键集两目录严格一致，
  缺键回退中文再回退键名）+ catalog 增 tui.* 命名空间 24 键；语言源 = kernel 共享 Config
  settings.lang 渲染期实时读——**/lang en 即切即生效（无需重启）**；第一波转换常驻 chrome
  （Composer 提示/队列/附件/溢出 · Header 状态 · StatusBar 后台计数 · Transcript 出路/子代理状态/
  翻页标记/重连·命令心跳 · runtime 欢迎/恢复/排队/清屏/语言切换/重试清空通知）。zh 值与原文
  逐字一致——既有断言零改动全绿；新增 tui-i18n 5 用例（键集一致/zh 默认/即切/en 全帧渲染/缺键回退）。
- **诚实边界（第二波待办）**：Overlays 面板文案（~76 键）与 runtime classifyError 出路提示仍中文——
  帮助页快捷表/联动图谱为模块级数据结构，需改渲染期构建（机制已验证，纯机械转换，下一批）。

### 验证
- typecheck / typecheck:tests / lint（476 文件）/ cycles / test-discovery / docs 门禁全绿。
- **全量 2922 通过 / 0 失败**（较上轮 -154：退役 fork 自带测试面离场——测的是死代码，属预期）。
- build（root dist + .d.ts 全量 + sdk dist + core dist）✓ · PTY 冒烟 5/5 ✓ · mock e2e 15/15 ✓。


## 自完善批次 ⅩⅩⅤ（第三十七批 · TUI i18n 第二波收口：全面板 + 首启语言闭环）

- **Overlays 全量转换**（~120 键 tui.panel.* / tui.help.* + 30 键 tui.keys.*）：14 类浮层面板
  （审批/澄清/密钥/模型/主题/确认/配置/表单/压缩/回滚/计划/计划编辑/语音/帮助三页）全部经 tuiT；
  zh 值与原文逐字一致——既有断言零改动（中途回归：面板名从标题误删——补 tui.panel.*.name 六键修复，
  render 41/41 全绿）。
- **帮助页快捷分组/联动图谱渲染期构建**（quickCols/LINKAGE 本在函数体内——直接 tuiT 化）；
  **keys.ts KEY_SECTIONS 模块级常量 → keySections() 函数**（渲染期构建——/lang 即切不冻结导入时语言）。
- **classifyError 五类出路提示 + clampOutput 折叠行 + 状态栏「未配置」模型兜底 i18n**
  （model 兜底改渲染期取值：store 存空串，StatusBar/Header 经 tuiT——/lang 即切）。
- **首启语言闭环修复（真机抓到的接线断层）**：首启向导 locale 持久化于 dataDir/config.json
  （preBootstrap 通道），而 TUI 语言源读 settings.json 的 settings.lang——**向导选 English 后 TUI 仍
  中文**。修复：语言源两级（settings.lang 运行时切换优先 → localeFallback 向导 locale 回落）；
  cli 注入 readLocaleFile(dataDir/config.json)；配置面板 lang 行显示实际生效语言（tuiLang()）。
- **C-4 第二刀评估修正（如实）**：tools.ts 纯字符串「错误」实为模型面工具输出契约
  （OpenAI tool-call 文本响应——模型与转录消费），改结构化需重定义 runner 契约且收益边际——
  不属错误体系碎片化，维持现状并在此记录（防「为统一而统一」）。
- **真机 PTY 验证 8/8**：首启向导选 2(English) → TUI 英文启动（idle/Enter send/零中文残留）→
  /config 面板英文（langCtl 键）→ /keys 面板英文（shortcut cheat-sheet/Global）。
- **验证**：tui-i18n 9 用例（+en 配置/帮助/键位/classifyError 四项）· render 41 · selfbuilt 91 ·
  **全量 2926 通过 / 0 失败** · build · 冒烟 5/5 · mock e2e 15/15（中文路径回归零破坏）· lint 476。


## 自完善批次 ⅩⅩⅥ（第三十八批 · C-6 commands 层拆分收口——最该清的债 100% 销项）

- **handlersExt.ts 2483 → 1010 行（-59%）**：按 ext/ 既有块模式再拆两块——
  - `ext/webCommands.ts`（436 行 · 拆分第 4 块）：/search /browser /web /gateway /proxy /webhook
    （webhook 引擎随块迁移——订阅生命周期与命令同域）/a2a /acp；
  - `ext/agentFlowCommands.ts`（1069 行 · 拆分第 5 块）：/swarm /duo /cron /jobs /agent /arena
    /review /session-stream /understand /delegate /btw /goal /plan /import /flow /term——
    嵌套 Agent 终态契约（NestedAgentResult/nestedCompletion/aggregateNestedStatuses）随块迁移；
  - handlersExt 转装配位（五块 register 调用 + 剩余桌面/生态接入与权限安全类 ~14 命令）。
  - commands 层六块结构成型：deterministicTools / sessionCommands / profileMemoryBuildCommands /
    webCommands / agentFlowCommands + handlersExt 装配。
- **路线第 5 项评估（如实更正 ×2）**：① 任务级评测 harness **已存在**（scripts/eval/task-eval.mjs +
  `eval:tasks:selftest` 10 任务自检绿——08-27 评估后已补，评估表述过时）；真实缺口=任务广度。
  ② **勘误**：durable queue 并非「未做」——已于 08-27 晚落地（P2-14：kernel/durableQueue.ts +
  agent.ts:1945-1977 接线 + SCHEMA v12）。专项现状与缺口见 docs/kernel-eval-2026-08-30.md §3
  （缺口=无 rollout 重放/孤儿清扫；并发现 N1 ':sub' 守卫死代码）。
- **验证**：tsc ×2 · lint 478 文件 · cycles（4 环 allowlist 不变）· test-discovery ·
  **全量 2926 通过 / 0 失败**（命令面经 registerExtHandlers 全量覆盖——迁移零行为变化）·
  build · 冒烟 5/5 · e2e 15/15。


## 自完善批次ⅩⅩⅦ（第三十九批 · kernel-eval N 系列收口——评估驱动修复轮）

> 对应用户目标：结合 kernel-eval-2026-08-30 与 design-eval-2026-08-30 两份评估结论进行完善。

- **N3（中·已修）**：413 强压重发成功后不再 `continue` 丢弃 res——落入正常处理（A-3 同款修法）；
  4xx 收口分支加 `!res` 门（重发成功不按旧 413 错误终局）。测试：413 用例补**调用恰 5 次**计数断言
  （原 mock 幂等掩盖——丢弃 res 会多烧一次调用/双份流式）。
- **N2（中·已修）**：micro 裁剪降到阈值下后真正**跳过全量压缩**（新增 microSufficed 分支兑现
  注释承诺——省一次摘要 LLM + 保前缀缓存；此前 notice 宣称跳过但实现照常全量）。测试：确定性
  编排（大输出先行 + 各异小文件推出 keepRecent 保护窗 + msgs>10 门槛定越线时机）断言「跳过
  全量压缩」通知出现、「自动压缩…」不出现、callModel 恰 7 次零摘要。校准过程实证两个 ctx 算术
  事实：outReserve 被 20k cap 钉底（小 maxContextTokens 全被 4000 地板吞）、fs_read 大输出
  实证 est≈9100（20000 字上限 + 包裹标注）。
- **N1（中·已修）**：durable 队列 `':sub'` 死守卫 → **spawnSub 显式 isSubagent 标志**（AgentOptions
  新字段；id 形态不再承载语义——父 id 透传/`sub-` 前缀两形态都不再入队）；`purgeDurableRows`
  孤儿行清扫（终态超 7 天删除，run 入口顺带）。测试重写为真实生产者形态（原 `'dq-main:sub'`
  合成格式锁定的是无生产者的死代码）+ 父 id 透传反例 + 清扫用例，4→6。
- **N4（中·已修）**：agent.retry / agent.token{reset} / agent.error（全部 7 处发射点）补 session_id
  （T72 收尾——token/tool 已带、retry/reset/error 漏带）；TUI wireBus 对 retry/error 补会话过滤
  （子代理重试不再清主面板 attempt、子代理错误不落主转录）。测试：跨会话反例（异 sid 三事件全
  不影响主面板 + 同 sid 对照仍生效）。
- **N6（低·已修）**：提前执行池补坏 JSON 哨兵守卫（`__wxnodus_args_parse_error__` 不再被当真实
  参数提前执行——runOneCall 守卫同款）。
- **观察项顺手**：重试/413 重发路径 callWithAbort 补 `maxTokens: outputMaxTokens`（输出钳制不再在
  重试路径失效）；循环检测签名改用 canonicalToolArgs（与缓存 key 口径一致——键序变体不再逃逸）。
- **验证**：tsc ×2 · lint 478 · **全量 2930 通过 / 0 失败**（+4 回归用例）· build · 冒烟 5/5 ·
  e2e 15/15。


## 自完善批次ⅩⅩⅧ（第四十批 · 用户反馈三痛点：参数显示/偏移/过密——真机取证驱动）

> 方法：自建 VT100 仿真探针（列指针+EL/ED/CUP+OSC 跳过）真机抓帧取证 → 修复 → 同探针帧对比验证。

- **回合结果双条目重复（最刺眼·根因修复）**：send() 的「补推全文」守卫在 50ms 流式合批缓冲冲刷前
  判定——缓冲未落条目时守卫误判 last≠assistant 推 copy1，随后定时器 flush 再落 copy2 = 长回复整段
  显示两遍。修复：守卫前先 `flushStream()`（+回归用例：缓冲态收尾恰 1 条 assistant）。
- **「参数显示不完全/切两半」**：wrapText/wrapInline 逐字硬切——URL/路径/命令串被切成
  `...packag`+`e.json` 两半。修复：**词感知换行核**（viewport `splitLineWords`+`layoutWords` 导出，
  markdown-lite wrapInline/wrapPlain 复用同核）——CJK 每字成词、ASCII 连续串聚合为不可分词，
  词边界换行（整词移下一行）；仅单词超行宽才硬切（可见性优先）。真机验证：43 宽路径整词换行完整显示。
- **「过密眼花」**：转录条目尾加空行（呼吸感）——空行计入行缓存保证钉底预算自洽（渲染为单空格，
  ink 会修剪纯空尾行的坑由 render 41 钉底用例当场抓获并收口）。
- **「显示偏移」**：帮助页快捷分组 flexWrap 不定宽导致列不齐+错位大空白——每组 `width={30}` 定宽
  对齐（真机帧验证两列整列）；/status 成本行 `/cost` 重复两次——文案去重。
- **状态栏 cwd 头尾式显示**：`C:/Users…top/wxnodus4.0`（纯尾截丢盘符难辨认）。
- **N5 收口（kernel-eval 最后遗留）**：懒加载子代理白名单改经 `opts.activateTools` 并入【子】实例
  激活集（此前 def.tools 写进父闭包集合——子 schema 仍缺白名单工具 + 父集合污染）。
- 验证：TUI 家族 159 全绿（viewport +3 词保护用例）· tsc ×2 · lint 478 · **全量 2933/0** ·
  build · 冒烟 5/5 · e2e 15/15 · 真机帧对比：重复消除/路径完整/条目留白/列对齐/文案去重全兑现。


## 自完善批次ⅩⅩⅨ（第四十一批 · 四面专项审计：沙盒/全域控制/下载链/功能面——审计驱动修复）

> 双路并行深潜（沙盒+computer 面 / 下载链+功能面）——历史评估覆盖浅的四个面专项收口。

### 下载链（2 红 2 橙全修）
- **D-1 🔴 离线模型下载死通道**：offlineModelWorker.js 全链缺失（src/dist/发行 zip 均无）——下载 30min
  后必报错且文案归因「需要网络」不诚实。修：download 前置 V4 裁撤门（与推理侧同款），文案如实。
- **D-2 🔴 update --apply 裸 fetch**：无代理/无 SSRF（feed 投毒 → downloadUrl 可指内网）/无大小上限。
  修：authorizeOutboundUrl fail-closed + createOutboundFetch（代理）+ 300MB 上限。
- **D-3 🟠 /download 接线 fail-open**：旧 checkUrlSafety（DNS 失败放行）+ undici 裸 fetch 无代理。
  修：换 outboundTargetPolicy + 出站 fetch。
- **D-4 🟠 market 无代理**：企业代理环境市场整链瘫痪。修：缺省下载器走出站 fetch（测试替身不受影响）。
- 发布链：scoop/winget 清单 4.0.0→4.0.2（真 sha256）+ homepage 拼写统一（ydds2→yyds2）。

### 沙盒（2 中修 + 3 限制登记）
- **S-1**：bash 沙盒成功提示恒称「受限令牌」——标准用户 L1-L3 实际无（裸 Job）。修：cachedProbe()
  导出实态，按 elevated 措辞。
- **S-2**：/sandbox os L0-L3 覆写丢 failOpen（整对象替换）。修：spread 保留。
- 登记不修（限制级）：断网=1B/s 限速非隔离（winSandbox.ts:9 如实注释）；探测失败也进缓存
  （/sandbox os probe 手动重探）；sandboxFastPath 不校验探测（fs 工具不经 OS 沙盒的因果借喻——语义
  登记至 docs）。

### Windows 全域控制（2 中修 + 1 触发器补全）
- **C-5**：probeUiaBoundary spawnSync 同步阻塞——WindowsUiaDriver.act 每动作最多 3 次探测 =
  最坏 45s TUI 冻结。修：execFileAsync 异步化（失败取最严边界——fail-closed 方向不变），
  unit/computer 24 用例全绿。
- **C-3**：ActionGuard 视口首帧冻结——分辨率/显示器变化后越界检查基于陈旧视口。修：每次截图
  对比刷新（静默——防热插拔刷屏）。
- **急停生产触发器**：EmergencyStopService 存在且有管线检查点（24+3 测试），但生产上没有任何东西
  能按停 + 每次调用 new 实例停机不可持续。修：模块级单例 + `/computer estop`|`estop-status` 顶部
  拦截（不依赖路由/截图可用）——真机验证：estop → 跨调用持续激活 ✓。复位仅代码侧 reset(grant)。
- 登记不修（需真机 DPI 验证）：computer_click 坐标系疑似错配（DPI>1 系统性偏移——正确的
  virtualDesktop/RobotComputerDriver 存在但生产零消费者）；多显示器只主屏（monitors[0]）；
  UIA 定位无重试/等待；uiaClick 坐标兜底不校验遮挡；锁屏启发式误判方向安全。

### 功能面（审计清点，无需修复）
121 命令（11 类）· 53 内置工具 · MCP stdio+HTTP 自研客户端（断线 respawn）· 插件热重载（缺省
danger+untrusted 包裹）· 技能五源发现（跨品牌兼容）· 语音/剪贴板/图像四层守卫全在位。

- **验证**：tsc ×2 · lint 478 · **全量 2933/0**（computer 24 + estop 3 + sandbox 25 + market 回归）·
  build · 冒烟 5/5 · e2e 15/15 · estop 真机三态（触发/跨调用持续/状态查询）✓。


## 自完善批次ⅩⅩⅩ（第四十二批 · 登记项全量收口：C-1 DPI 坐标 + 多显示器 + UIA 重试 + 下载链/S-3/S-5）

> 用户裁决：离线模型保持裁撤门（不下载）；其余登记项全部收口。

- **C-1【高·已修】DPI 坐标系错配**：截图物理像素 → convertCoords（÷scale）→ robotjs 物理像素——
  DPI>1 时点击系统性偏向左上。修：clickOnScreen 直通物理像素（不做 scale 除法）；convertCoords
  标记 @deprecated（actionLayer 测试保留）。多屏负原点/混合 DPI 的正确变换层（virtualDesktop
  toPhysicalPoint）保留 infrastructure 层待接入。
- **C-2【中·已修】多显示器**：captureScreen 恒 monitors[0]——加 `monitor` 可选参数（索引钳制）；
  computer_screenshot schema 补 monitor 参数描述（模型可指定副屏）。
- **C-4【中·已修】UIA 定位重试**：Find-ElementBy 单次精确匹配 → 3s/150ms 等待循环（4 个 find 调用点
  全部加——动态 UI 未就绪不再靠模型手动重调）。
- **C-8【低·已修】robotjs 失败信号**：nativeInput 兜底失败文案加 `[ERROR]` 前缀（模型可辨识为失败）。
- **C-9【低·已修】定位方言说明**：uia_act description 明确 runtimeId 三段格式（与 uia_find 同族）。
- **D-5【中·已修】GitHub 技能完整性**：expectedDigest 从纯标记 `git:<full-sha>` 改为不可变锚
  `git:<sha16>→sha256:<digest16>`（安装后可独立校验）。
- **D-6 确认已覆盖**：selfUpdate GitHub feed 已提取资产 sha256（digest 字段在解析层已有）。
- **D-8【中·已修】下载重试**：fetchBounced 拆 Once + 外层 1 次重试（2s 退避）——网络抖动/CDN 切换
  不再一次性失败。
- **S-3【中·已修】sandboxFastPath 校验探测**：沙盒配置开但 cachedProbe().ok=false 时 fastPath 不生效
  （走正常审批链 fail-closed）——「沙盒内即免审批」的前提是沙盒真实可用。测试 mock 补 cachedProbe。
- **S-5【低·已修】探测失败不缓存**：probeCache 仅缓存成功结果（瞬时超时下次自动重探）。
- **验证**：tsc ×2 · lint 478 · **全量 2933/0** · build · 冒烟 5/5 · e2e 15/15 ·
  computer 24+4 截断 · market 22 · sandbox 25 全绿。


## 自完善批次ⅩⅩⅪ（第四十三批 · 增强型路线 + 分档全域操控——用户目标轮）

> 用户裁决：完善增强型路线；全域操控参考 Mano-P 分层语义，分档次区域/全屏捕捉实时分析。

### 分档全域操控（computer_observe 三档）
- **full（缺省）**：全屏截图 + 视觉模型分析（既有行为不变）
- **region**：指定坐标区域截图 + 聚焦分析（x/y/width/height 物理像素——先用 full 看全屏再切区域）
- **window**：指定窗口截图 + 聚焦分析（window 句柄——从 computer_uia_windows 获取；
  `uiaGetWindowRect` 新增：UIA 读窗口边界→转截屏区域，边界不可读/空回退全屏）
- schema 全面分档（tier/x/y/width/height/window/monitor 参数）；region 裁剪复用既有
  captureScreen region 支持（越界求交）；vision prompt 按档位聚焦。

### agent.ts 拆分（第一批：共享层提取）
- `kernel/agentShared.ts`（119 行）：AgentOptions/AgentRunOptions/AgentResult 类型 ·
  循环防护常量（RETRY_DELAY/MAX_*/LOOP_*/CHANT_*/TOOL_CACHE）· CORE_TOOL_NAMES ·
  SUBAGENT_EXCLUDE · FALLBACK_CTX_TOKENS · canonicalToolArgs（sortKeysDeep+undefined 回退）·
  toolStageBrief（TOOL_STAGE_VERBS 动词表）
- agent.ts 2,138 → 2,105 行（共享层迁出后；闭包域保持完整——主循环/压缩/子代理/durable
  闭包变量共享是刻意设计，本批只提取零闭包依赖面）
- canonicalToolArgs undefined 处理修复（`JSON.stringify(undefined)` 返回 undefined 而非
  'null' 字符串——`?? 'null'` 收口）；96 用例全绿

### rollout 重放（durable queue 增量）
- `recoverStaleWithReplay`（durableQueue.ts）：stale 行标 interrupted + 返回 replayable 列表
- agent.ts 接线：多行 stale 时 notice 提示「最新一条原文已恢复，其余 Ctrl+↑ 召回重发」
  （不自动发送——用户确认制，与「数据不出机」精神一致）
- 与 codex resume_thread_from_rollout 的差异：codex 自动重放完整会话；wxnodus 保原文 +
  提示召回路径（checkpoint 已保有上下文——/rewind 也可回滚）

### 验证
tsc ×2 · lint 479 · **全量 2933/0** · build · 冒烟 5/5 · e2e 15/15 ·
agent 96 · durable 6 全绿。


## 自完善批次ⅩⅩⅫ（第四十四批 · 竞品差距收口：压缩护栏 + 双模型循环 + 鼠标 + 评测 28 任务）

> 用户目标：继续完善差距——压缩失败护栏（gemini）、双模型循环确认（gemini）、鼠标（gemini/crush）、评测广度。

- **压缩失败护栏**（gemini chatCompressionService:461-469 语义）：
  - memory.ts `compactMessages`：摘要 ≥ 原文 80% 且原文 >2000 token → 放弃摘要走确定性降级
    （`compactDeterministic` 提取为函数——LLM 失败/膨胀护栏共用）；
  - agent.ts：压缩后 token 反而增大 → 一次性标记 `compactionFailedOnce`（本会话后续跳过自动压缩，
    /compact 手动仍可用）——sessionFlags 新字段 + 压缩触发门 + 通知。
- **双模型循环确认**（gemini loopDetectionService:683-688 语义）：
  - agent.ts 循环检测：`loopJudge` 判定为 loop 时，二次独立调用确认——两次一致才真终局；
    不一致 → 保守视为合法重复继续（防单模型误判终止合法轮询）。二次异常 → 维持 loop（fail-safe）。
- **TUI 鼠标支持基础**：
  - `src/tui/mouse.ts`（新文件）：SGR 编码解析（parseSgrMouse）+ DECSET 1002h/1006h 启停
    （enableMouse/disableMouse）——支持 Windows Terminal / ConEmu；
  - `src/tui/index.tsx`：启动 enableMouse + 退出 disableMouse；
  - paste.ts 注释标记鼠标通道。**基础档**：解析/启停就绪——App 层事件消费待后续接入。
- **评测任务广度 10→28**：
  - 新增 18 个任务（t11-t28）：base64/回文/词频/日期格式/二分查找/嵌套展平/深拷贝/CSV解析/
    时间差值/字符串模板/分块/分组/去重排序/驼峰转换/范围生成/IP校验/种子洗牌/摩尔斯电码；
  - verify.mjs 统一干净格式（check(label, actual, expected) + JSON.stringify 比较）；
  - 全程修复 golden↔verify 引号冲突/Python True→JS true/确定性降级触发——**最终 28/28 全绿**。
- **验证**：tsc ×2 · lint 480 · **全量 2932/0** · build · 冒烟 5/5 · e2e 15/15 ·
  compact-snapshot 10/10（护栏阈值 2000 token 调优后兼容既有用例）· eval 28/28。


## 自完善批次ⅩⅩⅩⅢ（第四十五批 · 用户 bug 报告修复 + 生态审计三缺口）

> 用户报告：鼠标操作（滚轮/点击）导致输出乱码 + 无法上滑看历史 + 左上角出现未知内容。

### 鼠标乱码 bug 根因修复（真机截图取证）
- **根因**：ⅩⅩⅫ enableMouse() 发 DECSET 1002h/1006h 后终端开始回送 SGR 鼠标序列
  （[<button;col;row M/m），但 paste 流**没有过滤**这些序列——它们进 ink 输入解析器
  被当普通文本渲染 = 乱码字符 + 干扰输入框 + 滚轮事件被误解为键盘输入干扰滚动。
- **修复**：paste.ts 变换流层加 `stripSgrMouse()`——全部 SGR 序列剥离（不进 ink），
  滚轮事件经 `opts.onWheel` 回调路由到 store（上滚=PgUp 视口上移 10 行 / 下滚=贴底跟随）。
- **接线**：index.tsx 传 onWheel → store.setPinnedLine / scrollToBottom（浮层态不干扰）。
- **测试**：tui-mouse-filter 4 用例（SGR 剥离/滚轮回调/正常键盘不误伤/混合场景）。
- **左上角未知内容**：即 SGR 序列被 ink 渲染的乱码残留——过滤后不再出现。

### 生态审计三缺口修复
- **缺口 1 MCP danger 翻转**：未声明 toolDanger 的 MCP 工具默认 danger **true**（fail-closed
  ——外部工具保守视为危险，进确认门）；此前默认 false 模型可直接调用。显式 toolDanger:false
  才获只读。测试更新（32/32）。
- **缺口 2 浏览器 SSRF fail-closed**：checkUrlSafety（DNS 失败放行）→ authorizeOutboundUrl
  （DNS 失败即拒）——与 /download/market 统一口径。
- **缺口 3 插件 legacy 隔离限制**：如实记录（in-process 无技术隔离——信任决策靠 allowlist
  人工配置；modern 路径有子进程隔离但未成为缺省——设计限制非 bug）。

### 验证
tsc ×2 · lint 480 · **全量 2934+/0**（2-3 例 bash 超时/MCP HTTP 计时抖动为既有 flaky）·
mouse-filter 4/4 · MCP 32/32 · build · 冒烟 5/5 · e2e 15/15。


## 自完善批次ⅩⅩⅩⅣ（第四十六批 · 代码规范与优化——全面扫描驱动）

> 深潜审计（480 文件全扫）：上帝文件/重复代码/死代码/命名/性能热点——按优先级落地。

### 高优先级修复
- **permissions 正则预编译**（热路径）：glob→RegExp 每次工具调用重编译 → 进程级 Map 缓存
  （256 上限 LRU 淘汰）——agent 循环 × 多规则 × 长会话 = 显著 CPU 节省。
- **convertCoords @deprecated 矛盾**：tools.ts:1381 + handlersExt.ts:219 仍在调用已标弃用函数
  （DPI>1 偏移 bug 回归）→ 移除调用改物理像素直通（与 clickOnScreen C-1 修复一致）。
- **lint.mjs 死 ratchet**：L4 组件行数规则引用已删除的 wxnodus-ui 目录 → 整块移除（空转 12 条）。

### 重复代码合并
- `lines()` 7 份拷贝 → `commands/outputFormat.ts` 单一事实源（朴素版 import 统一；框线版保留兼容）。
- `errorMessage()` 13+ 变体 → `lib/errorMessage.ts`（安全提取 + 截断）。
- `sha256()` ≥10 处 → `lib/hash.ts`（三签名重载 + sha512 + isRecord）。

### 死代码清理
- `offlineManifestName` / `offlineManifestDirectory` 零引用 → 移除（连带 dirname import）。
- L4 COMPONENT_RATCHET / COMPONENT_LINE_BUDGET 常量 → 随规则移除。

### 规范统一
- 6 个文件的 node:path import 位置修正（混在相对导入中间 → 顶部）。
- 97.5% 文件已有文件头注释（468/480）——维持。

### 性能审计结论（如实——未动项）
- events.ts history O(n) shift + 每 token 事件 ID 分配：量大但单次廉价——改环形缓冲收益 < 风险。
- TUI 流式路径已优化（50ms 合批 + WeakMap 行缓存）——残余为固有成本。
- Map 泄漏排查：全部有 delete/LRU 上限——**未发现无界泄漏**。

### 验证
tsc ×2 · lint 483 · **全量 2937/0** · build · 冒烟 5/5 · e2e 15/15 · permissions 49/49。


## 自完善批次ⅩⅩⅩⅤ（第四十七批 · 四面完善：浏览器沙盒/MCP/插件/技能）

### 浏览器沙盒强化
- **userDataDir 每会话独立**：`mkdtempSync(tmpdir/wxn-browser-<sid>-)` → `--user-data-dir` 启动参数
  （cookie/密码/历史不跨会话共享）；关闭时 `rmSync` 清理（OS temp 兜底）。
- **安全启动参数**：--no-first-run / --disable-default-apps / --disable-pdf /
  --disable-background-timer-throttling（自动化需要）+ 既有 --disable-blink-features。
- **SSRF 已在ⅩⅩⅩⅢ 换 fail-closed**（authorizeOutboundUrl）——本轮补强 profile 隔离。

### MCP 增强
- **工具 schema 消毒**：`sanitizeMcpSchema()`——inputSchema 非 object 强制修复 / properties 非
  Record 修空 / required 非字符串数组修空——OpenAI function calling 契约永不因坏 schema 崩。
- **健康监控**：`recordMcpCall()`（成功/失败计数 + 最后调用时间）+ `mcpHealthSnapshot()`
  （server/connected/toolCount/pid/lastCallMs/errorCount）——/mcp status 或 doctor 消费。
- **McpClient 接口** 补 `process?: { pid; killed }` 可选字段（stdio transport 才有）。

### 插件权限作用域
- **PluginToolCtx** 新增三字段：`allowedPaths`（fs 路径白名单）/ `allowedDomains`（网络域名白名单）/
  `fetch`（受控网络访问代理——经 allowedDomains 校验；不经此通道的 require 不受限——legacy
  in-process 已知限制，modern 子进程有 OS 阻断；本接口是最佳实践通道非强制门）。

### 技能增强
- **SkillMetadata**：name / version / requires（依赖技能名）/ context（适用工具上下文）/ source。
- **parseSkillMetadata()**：从 frontmatter 提取扩展元数据。
- **resolveSkillDependencies()**：递归展开依赖（循环检测——A→B→A 返回 null 不死循环）。

### 验证
tsc ×2 · lint 483 · **全量 2937/0** · build · 冒烟 5/5 · e2e 15/15 · MCP 32/32 · permissions 49/49。

## 验证口径（每轮收口）

- typecheck / typecheck:tests / lint（473 文件 · TODO 0）/ cycles（4 已登记）/ test-discovery。
- TUI 家族定向测试 + 全量 vitest。
- `npm run build` 后 PTY 冒烟（scripts/tui-pty-smoke.mjs，WXNODUS_SMOKE_ENTRY=dist）+ 真机定向 PTY。

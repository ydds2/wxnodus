# wxnodus 4.0 全代码设计评估（2026-08-29 更新版）

> **取证基线**：wxnodus4.0 仓库（HEAD 05274b34 + 39 个未提交文件——TUI 重建与自完善 34 项 T42–T75）；
> 6 家竞品克隆于 `Desktop\cli-compare\`（codex/gemini-cli/opencode/kimi-cli/crush/aider）。
> **方法**：本报告是 `docs/eval-vs-competitors-2026-08-27.md` 的更新版——3 路并行源码深潜（内核安全/生态接入/质量记忆）+ TUI 面由 16 轮重建工程直接取证；全部结论带 file:line 锚点，未取证处明写。
> 与 08-27 版的关键差异：**当时七家中唯一的「无 TUI」形态缺口已由 TUI 重建补齐**——本报告在旧评估基线上复核全部缺陷、新增 TUI 面评估与竞品 TUI 机制对比。

（子代理报告待合并：内核安全面 / 生态接入面 / 质量记忆面）

---

## 1. 规模快照（2026-08-29 独立复核）

| 项 | 08-27 基线 | 08-29 现状 |
|---|---|---|
| src | 466 文件 4.7 万行 | **466 文件 5.91 万行**（+TUI 17 文件 3521 行等） |
| 测试 | 335 文件 · 字面 2235 it() | **369 文件 4.5 万行 · 字面 2463 it()**（+TUI 11 文件 2971 行） |
| TUI | **无（七家中唯一）** | **完整 TUI：17 文件 3521 行 + 11 测试文件** |
| 验证资产 | 微基准 + Windows 验收电池 | + PTY 冒烟（5 项）+ **mock 模型 e2e（15 项）** |

## 2. TUI 面评估（16 轮重建直接取证）

### 2.1 架构判断

- **框架定型**：官方 ink 6.8 + React 19.2（曾自研 fork 后废弃——用户裁决用成熟组件，`05274b34`）。
- **布局**：三明治边界 + 钉底固定区（盒式输入框四边框 `src/tui/ui/Composer.tsx` + 参数恒一行硬截断 `StatusBar.tsx`）——「输入框和参数固定在 cmd 底部」的用户裁决由行数预算 + 底部填充保证（渲染测试钉住绝对行位）。
- **状态**：自研轻量 store（getSnapshot/subscribe/patch，`src/tui/store.ts`）——因官方 ink 6 + React 19 下 `useSyncExternalStore` 渲染挂起，改订阅强制重渲（实测教训留档）。
- **分层**：TUI 零直连 DB/网络——全部经 cli 窄端口（modelCatalog/sessionMessages/sessionTranscript/contextUsage/voice 等 12 个 bridge）。

### 2.2 与竞品 TUI 机制对齐表（机制参考·实现原创——AGENTS.md 约束）

| 机制 | wxnodus 实现 | 竞品锚点 |
|---|---|---|
| 行配额/视口裁剪 | 条目粒度 sliceViewport + CJK 宽度硬换行（`src/tui/viewport.ts`） | codex `render.rs:33-34` 行配额 |
| 已确认块落屏 | appendStream 只动最后流式条目（50ms 合批） | kimi `_blocks.py:275` |
| 双通道（排队+注入） | Enter 排队 / Ctrl+S steer / Esc 暂留 2s→清空 | kimi 双通道 |
| 斜杠菜单频序 | touchCommand 使用频次上浮 + 8 行滚动窗口 | kimi 菜单按频次 |
| 顶锚定视口冻结 | pinnedLine（上翻时新内容只进 ↓ 计数） | kimi/codex 同行为（机制自证） |
| 阈值变色 | 上下文 ≥85% 参数行变紫 | gemini `ContextUsageDisplay.tsx:26` |
| 主题预览 | 左列表右预览改即存 | gemini `ThemeDialog.tsx:341` |
| 历史召回 | Ctrl+↑↓ 跨会话落盘（500ms 防抖） | gemini keyBindings 历史 |
| 危险项二次确认 | 默认否防手滑 | crush `quit.go:20` |
| 工具参数 canonical | 递归键序排序缓存 key | kimi `toolset.py:184-202` |

### 2.3 TUI 修复档案（34 项 T42–T75——「几十处缺陷」的实证）

按根因分类（详见 `docs/tui-self-improve-batches-2026-08-29.md`）：
- **接线层短路**（品类惯性缺陷在 UI 层的重现）：Esc 死键、/skill dispatch 静默丢弃、reset 契约未消费（半截拼接）、Enter 展开承诺漂移、help 面板 Enter 陷阱、失败命令渲染为绿色助手行。
- **框架陷阱**（ink 6 特有）：useInput 每次渲染重订阅 stdin → 首按吞键（useStableInput 稳定身份修复）；ConPTY 粘贴 \r 整块送达 → 盒内回车覆写乱屏。
- **视图一致性**：/resume//undo//checkpoint restore//新会话 boot 恢复——转录与内核状态同步重建。
- **性能**：流式 50ms 合批（非逐 token 重渲染）、命令心跳、git 探测 2s 超时。

### 2.4 TUI 剩余缺陷（诚实清单 · 2026-08-30 批次ⅩⅩⅢ 复核）

1. ~~无 bracket-paste（粘贴靠 <40ms 突发判定）~~ **已落地 T76**：DECSET 2004 协议级粘贴
   （标记内 
 归一 
 绝不误提交）+ 25ms 悬挂超时（单独 Esc 不被前缀卡死——e2e 抓获修复）；
   老终端自动回退突发启发式（双路）。残余：无鼠标支持（键位驱动，记录在案）。
2. ~~浮层行数预算静态估计（极窄终端可能超窗）~~ **已落地 T79**：overlayRows 按 rows 封顶 +
   长列表面板窗口钳制（与预算同源收缩）+ 面板长行显示宽度硬截断（窄终端不折行）。
3. Enter→Tab 0ms 合成时序首个 Tab 被面板挂载窗口吞掉（人类间隔 >150ms 不受影响——非缺陷，记录在案）。
4. `/voice` 录音与 `/paste` 剪贴板图两条正向路径依赖真硬件（失败路径已 e2e 验证诚实降级）。
5. 2026-08-30 新增销项：T77 实例身份（「网络下载后独一无二」——首启代号/命令面/SDK 三面透出）、
   T78 SDK 私有化（dist 产物链 + identity RPC）——审计见 docs/system-completeness-audit-2026-08-30.md。

1. 无鼠标/无 bracket-paste（粘贴靠 <40ms 突发判定——已够用，但非协议级方案）。
2. 浮层行数预算为静态估计（`overlayRows`）——极窄终端下个别面板可能超窗（24 行实测通过）。
3. Enter→Tab 0ms 合成时序首个 Tab 被面板挂载窗口吞掉（人类间隔 >150ms 不受影响——非缺陷，记录在案）。
4. `/voice` 录音与 `/paste` 剪贴板图两条正向路径依赖真硬件（失败路径已 e2e 验证诚实降级）。

（生态/内核/质量面评估待子代理合并后补全 → 总分与结论）

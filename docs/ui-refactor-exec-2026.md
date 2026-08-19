# WxNodus CLI UI 重构执行计划（2026-08-19 · P0 全量）

> **执行状态（2026-08-19 当日收口）**：P0 四步全部落地并推送——P0-1 键位注册表 `d2112ed`、P0-2 栈式浮层 `bc97655`、P0-3 appChrome 拆分 `88f4bd7`、P0-4 /help keys + Ctrl+P `3a98fef`；全量 2877 用例零回归、tsc 干净；行为变化点与缺陷证据如实入 audit §13.95。
> **P1 进展（2026-08-20）**：P1-1 双触发裁决完成 `6d31401`（Ctrl+O 唯一化模型选择器、Ctrl+R vim NORMAL 门控、RESOLVED_OVERLAPS 裁决标注）；P1-2 status/doctor 结构化工作台完成 `320debe`（workspace overlay kind + adapter.doctor 真实体检端口 + workspace.status/.doctor RPC + w 键切换 + Esc 统一出栈收编 workspace）。**P2 批（2026-08-20）**：面板右分栏完成 `a26fac2`（≥80 列右侧分栏 min(40, cols-50%) 不遮转录流；小窗全宽块诚实降级；RightPanelPane 单一渲染源）；状态栏零记忆入口全覆盖完成 `e74db38`（⚙ 配置入口新增，会话/模型/目录/余额/语音既有）。**P0/P1/P2 三阶段全部收口**（三阶段验收对照见 audit §13.95–13.98；「聚合最近动作」为可选增强未做，如实不冒充完成）。

> 上级规划：`docs/ui-redesign-plan-2026.md`（诊断 D1–D5 / 四层布局 / 栈式浮层 / 键位注册表）。
> 本文件是**可直接施工的执行计划**：逐文件改动、实施顺序、风险门、测试与验收。
> 原则延续：收编而非推翻（34 组件 / diff 工作台 / vim / 主题契约 / 审批桥全保留）；诚实降级不破。

## 1. 范围

| 阶段 | 内容 | 本计划 |
|---|---|---|
| P0-1 | 键位注册表（单一事实源 + 冲突注册期报错） | ✅ 全部 |
| P0-2 | 栈式 Overlay（17 布尔位 → stack + inline；Esc 统一出栈；互斥组） | ✅ 全部 |
| P0-3 | appChrome 拆分（1031 → 转录 chrome + 状态栏独立组件） | ✅ 全部 |
| P0-4 | `/help keys` 键位总览（TUI 本地拦截，注册表生成） | ✅ 全部 |
| P1 | status/doctor/sessions 工作台化、右分栏面板 | 后续（本计划给出文件接口，不动） |
| P2 | Ctrl+P 聚合面板、状态栏固定入口 | 后续 |

## 2. 现状事实（施工依据，2026-08-19 实测）

- `OverlayState`：17 字段布尔/可空位（`bridge/interfaces.ts:93`）；`patchOverlayState` 调用点 **93 处 / 13 文件**。
- `promptStore.ts` 75 行：`$overlayState` atom + `$isBlocked` + 全量/流程重置；流程重置手工保 5 个用户态布尔。
- `appOverlays.tsx` 397 行：8 个 FloatBox 条件渲染 + 补全弹窗 + PromptZone（6 种行内提示）——互斥/z 序靠渲染顺序约定。
- `useKeyBindings.ts` 856 行：pager 键位走 `config/keymap.ts`（settings.keymap 覆盖层已落地），其余键位内联散落。
- `appChrome.tsx` 1031 行：StatusRule（状态栏核心，~430 行）+ FloatBox + StickyPromptTracker + TranscriptScrollbar + 指示器/热力条工具函数。
  - 外部引用仅 3 处：`appLayout.tsx`（StatusRule/GoodVibesHeart/StickyPromptTracker/TranscriptScrollbar）、`appOverlays.tsx`（FloatBox）、`appChrome-indicator.test.ts`（renderIndicator）。
- `src/app/stores/overlayStore.ts`：legacy zustand 层，注释明示**未接线**（真实状态在 promptStore）——本计划不触碰。
- 浮层组件自带 Esc 处理实测：modelPicker/configPanel/historySearch/commandPalette/agentsOverlay/dirPicker/activeSessionSwitcher 均有；
  skillsHub/pluginsHub **无**（目前只能 Ctrl+C 或鼠标关）；pager 由 `km.pagerClose`（含 escape）关闭。

## 3. 目标架构

```
src/wxnodus-ui/
├── keymap/
│   ├── registry.ts            [新] 键位单一事实源：KeyBinding 清单 + 冲突检测 + keymapDocs()
│   └── (config/keymap.ts      既有配置覆盖层——不改语义，注册表引用其动作名)
├── runtime/
│   ├── overlayStack.ts        [新] 纯函数栈模型：OverlayEntry 联合 + 互斥组 + push/close/pop/update
│   ├── promptStore.ts         [改] atom 绑定：stack + inline；pushOverlay/closeOverlay/popOverlay/
│   │                                toggleOverlay/updateOverlay/setInline；$isBlocked 派生
│   └── (其余 runtime 不动)
├── bridge/interfaces.ts       [改] OverlayState → { stack: OverlayEntry[]; inline: InlineState;
│                                    agentsInitialHistoryIndex }（类型移至本文件，栈逻辑在 overlayStack）
├── components/
│   ├── statusBar.tsx          [新] StatusRule + 状态栏工具函数（自 appChrome 迁出，行为零漂移）
│   ├── floating.tsx           [新] FloatBox（共享浮层容器）
│   ├── appChrome.tsx          [改] 1031 → ~130：TranscriptScrollbar + StickyPromptTracker + re-export 兼容
│   ├── appOverlays.tsx        [改] 由 stack 自底向上渲染（每 kind 一个 case）；PromptZone 读 inline
│   └── （其余 30 组件不动，仅 onCancel/onClose 路由改 closeOverlay）
└── hooks/useKeyBindings.ts    [改] overlay 读取改 helper；Esc 统一出栈（见 §4.2 风险项）；Ctrl+P 别名
```

### 3.1 OverlayEntry 联合（kind 全集 = 现 17 位收编）

```ts
type OverlayEntry =
  | { kind: 'pager'; pager: PagerState }
  | { kind: 'sessions' } | { kind: 'agents'; initialHistoryIndex: number }
  | { kind: 'configPanel' } | { kind: 'modelPicker' }
  | { kind: 'skillsHub' } | { kind: 'pluginsHub' }
  | { kind: 'commandPalette' } | { kind: 'dirPicker' } | { kind: 'histSearch' }

interface InlineState { approval?; clarify?; confirm?; sudo?; secret?; form? }  // 行内提示，附着消息行，非栈
```

**互斥组**（push 时同组旧项自动出栈——替换而非叠加，行为变化点 1）：
- `panel` 组：configPanel / modelPicker / skillsHub / pluginsHub
- `picker` 组：sessions / dirPicker / histSearch / commandPalette
- `pager` 独占；`agents` 独占。

### 3.2 键位注册表

```ts
interface KeyBinding { id: string; keys: string[]; scope: 'global'|'workspace'|'prompt'|'vim'|'panel'|'pager'; action: string; help: string }
registerBindings(): void   // 同 scope + 同键 → throw（注册期冲突报错）
keymapDocs(): string[]     // 分组生成 /help keys 文本
```

- 清单 = **代码实测**（useKeyBindings/textInput/keymap.ts 逐一核对，不凭空写键位）。
- 与既有 `config/keymap.ts` 的关系：注册表管「文档 + 冲突检测」；`settings.keymap` 覆盖层管「运行时匹配」——pager 动作条目标注「可覆盖」。两层动作名对齐，不双写逻辑。

## 4. 实施顺序与风险门

每步结束跑门禁（`npm run typecheck`-等价 + 相关测试 + 全量），绿了才进下一步；每步独立 commit。

### 4.1 步骤 0：计划文档（本文件）+ CHANGELOG 占位

### 4.2 步骤 1：P0-1 键位注册表（自包含，零侵入）
- 新 `keymap/registry.ts` + `tests/keymap-registry.test.ts`（冲突 throw / 跨 scope 允许 / docs 分组全 / 与 parseKeySpec 兼容）。
- 清单核对来源：`useKeyBindings.ts`（Ctrl+K/Ctrl+O/Ctrl+R/Ctrl+X/Shift+Tab/Esc 族/vim `i`/语音）、`keymap.ts` DEFAULT_KEYMAP（pager 7 动作）、textInput（Tab 补全/Enter 双语义/@）。

### 4.3 步骤 2：P0-2 栈式 Overlay（核心迁移，分 5 小步）
1. 新 `runtime/overlayStack.ts` 纯函数 + 契约测试（push 替换同 kind / 互斥组 / popTop / updateKind 不变式）。
2. `interfaces.ts` 类型换新；`promptStore.ts` 重写为栈绑定（导出 pushOverlay/closeOverlay/popOverlay/toggleOverlay/updateOverlay/setInline/patchInline/reset*/$isBlocked）。
3. 13 文件 93 调用点机械迁移：
   - `{ x: true }` → `pushOverlay({kind})`；`{ x: false }`/`{ x: null }` → `closeOverlay(kind)`；
   - `{ pager: {...} }` → `pushOverlay({kind:'pager', pager})`；`{ pager: null }` → `closeOverlay('pager')`；
   - 函数式 `prev => ({...prev, pager: ...})` → `updateOverlay('pager', fn)`（useKeyBindings 内 8 处滚动/树视图/hunk 逻辑逐个改写）；
   - `{ approval/… }` → `patchInline({ approval })`；流程重置 → 栈按 kind 过滤。
4. `appOverlays.tsx` 改栈渲染（自底向上 map kind→FloatBox；PromptZone 改读 inline）。
5. `useKeyBindings.ts` 改读 helper；Esc 语义（风险项）：
   - **删除**全局 `escape && sessions` 分支（activeSessionSwitcher 自带 Esc，避免双关一次 Esc 弹两层）；
   - **新增**统一出栈：isBlocked 且栈非空且顶 kind ∈ `ESC_NOT_COMPONENT_OWNED = { skillsHub, pluginsHub }` 时 Esc popTop——这两个组件实测无 Esc 处理，是「Esc 统一出栈」的真实增量；其余 kind 由组件自身 Esc 关闭（P1 再收编进统一协议）。
   - `cancelOverlayFromCtrlC` 优先级链收编为「inline 先（顺序不变）→ popTop」。
- 行为变化点（如实记录进 audit）：① panel/picker 互斥替换（此前可同时开两个面板）；② skillsHub/pluginsHub 新增 Esc 关闭；③ 栈序决定 z 序（此前渲染顺序决定）。
- 风险门：全量单测 + `tests/overlay-stack.test.ts` 新增契约测试 + 手工 smoke（typecheck 兜 93 处漏改）。

### 4.4 步骤 3：P0-3 appChrome 拆分（纯搬运，零行为变化）
- `statusBar.tsx` 接收：StatusRule + FaceTicker + ctxBar/ctxGradientCells/ctxBarColor + statusRuleWidths + statusBarSegments + SpawnHud + SessionDuration/IdleSince + modelLabel 族 + GoodVibesHeart + StatusRuleProps。
- `floating.tsx` 接收 FloatBox。
- `appChrome.tsx` 保留：TranscriptScrollbar + StickyPromptTracker + **re-export 全部迁出符号**（3 个外部引用点零改动；P1 再清理 re-export）。
- 风险门：`appChrome-indicator.test.ts` + 全量回归（验证 re-export 与行为一致）。

### 4.5 步骤 4：P0-4 `/help keys`
- `commands/slash/conversation.ts` 本地拦截 `/help keys` → `keymapDocs()` → pager（TUI 内真实总览；-p 模式内核 `/help keys` 维持现状「TUI 本地」提示——不跨层 import，架构方向不变）。
- 同步骤补 `Ctrl+P` 别名（palette toggle，与 Ctrl+K 同动作不同键；若 textInput 占用则放弃并如实记录）。
- 测试：`tests/help-keys.test.ts`（拦截文本含全部 scope 分组）。

### 4.6 步骤 5：收尾
- `npm run ci` 本地 9 门全绿 → commit → push → 远程 CI 盯绿。
- CHANGELOG（用户可见：互斥组 / Esc 统一 / /help keys / 状态栏组件化）+ audit-deep.md §13.95（参考来源、行为变化点、遗留债）。

## 5. 测试策略

| 层 | 新增 | 既有 |
|---|---|---|
| 键位 | `tests/keymap-registry.test.ts`（冲突/分组/兼容 ~8 用例） | keymap 既有测试不动 |
| 栈 | `tests/overlay-stack.test.ts`（纯函数契约 ~10 用例）+ `tests/ui-presentation-wiring.test.ts` 扩展（reset 语义） | 300+ 全量回归 |
| 拆分 | 无新增（纯搬运） | `appChrome-indicator.test.ts` 保绿即证 |
| 帮助 | `tests/help-keys.test.ts` | docs-links / command-runtime-smoke 保绿 |

## 6. 验收标准（对照上级规划 P0 验收）

1. ✅ 新增浮层仅改 2 处：`OverlayEntry` 加一个 kind + `appOverlays` 加一个 case（栈/互斥/关闭语义免费获得）。
2. ✅ `/help keys` 列出全键位（TUI 内由注册表生成，分组展示）。
3. ✅ appChrome ≤ 200 行（1031 → 转录 chrome + re-export）。
4. ✅ 34 组件回归全绿；行为变化点（互斥/Esc）如实进 audit。
5. ❌→P1：status/doctor/sessions 结构化工作台、面板右分栏、Ctrl+P 聚合（本计划不掺假提前）。

## 7. 诚实边界

- 不触碰 legacy `app/stores/overlayStore.ts`（未接线，注释已明示）。
- 不迁移「组件自带 Esc → 统一协议」收编（P1）；本计划只补无 Esc 组件的统一出栈。
- 不动 ink fork 渲染内核；不改主题 token 契约。
- 键位清单只登记**代码实测存在**的键位——`/help keys` 无「计划中」条目（防虚假总览）。

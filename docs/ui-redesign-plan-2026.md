# WxNodus CLI UI 重设计规划（2026-08-19）

> 依据：当前 UI 资产盘点（34 组件全接线 / 17 位浮层态 / 856 行键位钩子 / 1031 行 appChrome）。
> 原则：**收编而非推翻**——已落地的 diff 工作台、vim、@补全、主题、审批桥全部保留；
> 本次规划解决的是「浮层各自为政、内容全靠 pager、键位分散」三个结构性问题。
> 约束（诚实）：Windows-only、conhost 无 OSC/图片协议、@wxnodus/ink 渲染器、离线优先。

## 0. 现状诊断（真问题清单）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| D1 | 浮层模型是 15 个布尔位，互斥/z 序在 appOverlays 硬编码 | `promptStore.ts:31-33` 17 位、`appOverlays.tsx` 逐一条件渲染 | 新增浮层要改 4 处；组合态（pager+confirm）靠约定不靠模型 |
| D2 | 一切内容型输出都进 pager 文本流 | `/help /status /doctor /diff` 全部 `page(text)` | 状态/诊断无法结构化交互（diff 是唯一例外，已有分节元数据） |
| D3 | 键位分散三处、无集中注册表 | `useKeyBindings.ts` 856 行 + 各组件 `useInput` 各自拦截 | 冲突靠测试兜底、用户无法全局总览 |
| D4 | appChrome 1031 行巨组件（状态栏+徽章+宠物+提示混合） | `appChrome.tsx` | 与 C-02 同类工程债 |
| D5 | 会话浏览器/配置面板/模型选择器是「一次性弹出」 | 三组件各自独立状态 | 高频操作无固定入口（靠 slash/快捷键记忆） |

**保留的资产**（重设计前提）：keymap 配置层、主题 token 契约（10 预设+用户+system+双变体）、
vim 全语义、@双源补全、Ctrl+O 编辑器、审批桥+脱敏、diff 结构化工作台（分节/树视图/r 回滚/m 审阅）、
会话惰性预览、pager 的 [/] hunk 跳转。

## 1. 设计原则

1. **键盘优先、鼠标可达**：一切动作有键位（可配置），行可点击（既有 onClick 模式延续）。
2. **四层布局、永不动摇**：状态栏 / 转录流 / 输入区 / 浮层——任何浮层不得遮蔽状态栏（全局状态可见性）。
3. **工作台化**：结构化数据不再降级成 pager 文本——diff/status/doctor/sessions 各有工作台渲染。
4. **栈式浮层**：浮层 = 压栈/出栈（LIFO + 显式互斥组），替代 15 布尔位。
5. **诚实降级**：conhost 无协议、无 key 无模型——UI 永远如实展示能力边界（既有纪律延续）。
6. **主题契约**：一切颜色走 token；新增组件不得硬编码色值（lint 门禁候选）。

## 2. 布局架构（四层模型）

```
┌─────────────────────────────────────────────┐
│ L1 状态栏（appChrome 精简后）：会话·模型·模式·成本·后台任务·宠物 │ ← 常驻 1 行
├─────────────────────────────────────────────┤
│ L2 转录流（turnSections/messageLine）：消息·diff 回显·内联工具卡 │ ← 滚动区
│     ↑ 行内弹层（inline）：审批/确认/表单——附着在触发消息行     │
├─────────────────────────────────────────────┤
│ L3 输入区（textInput）：@补全/斜杠补全/键位徽标/思考开关/vim 徽标 │ ← 常驻
├─────────────────────────────────────────────┤
│ L4 浮层（栈式）：确认窗 / 工作台 / 面板 / 选择器                 │ ← 压栈渲染
└─────────────────────────────────────────────┘
```

- L1 只读状态，任何 L4 浮层不得覆盖（D5 修：会话/配置入口进状态栏可点击区）。
- L2 行内弹层（审批/confirm/clarify/form）与消息行绑定渲染——上下文不丢。

## 3. 浮层体系归类（栈式模型，替代 15 布尔位）

`OverlayState` 重构为：

```ts
interface OverlayState {
  stack: OverlayEntry[]          // LIFO 压栈
  // 行内（非栈）：附着消息行
  inline: { approval?; confirm?; clarify?; form? }
}
type OverlayEntry =
  | { kind: 'confirm'; ... }                       // 模态确认
  | { kind: 'workspace'; ws: 'diff'|'status'|'doctor'|'sessions'; payload: unknown }  // 全屏工作台
  | { kind: 'panel'; panel: 'config'|'model'|'skills'|'plugins'; payload: unknown }   // 右侧面板
  | { kind: 'picker'; picker: 'session'|'dir'|'history'|'command'; payload: unknown } // 选择器
```

| 类 | 现有成员 | 渲染方式 | 互斥规则 |
|---|---|---|---|
| 行内（inline） | approval/confirm/clarify/form | 附着消息行 | 同屏至多 1 个 |
| 模态确认 | confirm(danger) | 居中卡片 | 栈顶独占输入 |
| 工作台 | pager(diff)/新 status/doctor/sessions 结构化 | 全屏（保留状态栏） | 栈内可叠加 confirm |
| 面板 | configPanel/modelPicker/skillsHub/pluginsHub | 右侧分栏（不遮转录流） | 与工作台互斥 |
| 选择器 | sessions/dirPicker/histSearch/commandPalette | 全屏或面板内 | 按上下文 |

**迁移收益**：新增浮层只写 1 个 entry 类型 + 1 个渲染器；Esc 统一出栈；z 序由栈序决定（删除 appOverlays 的条件链）。

## 4. 导航与快捷键体系（集中注册表，D3 修）

```
src/wxnodus-ui/keymap/registry.ts   —— 单一事实源
  { id, keys: ['ctrl+x'], scope: 'global'|'workspace'|'prompt'|'vim'|'panel:config', action, help }
```

| 分层 | 现有键位（保留） | 本规划新增 |
|---|---|---|
| 全局 | Ctrl+X 会话 / Ctrl+O 编辑器 / Ctrl+R 历史 | **Ctrl+P 命令面板**（聚合一切动作——D5 补入口） |
| 工作台 | Esc 关 / [/] hunk / r 回滚 / m 审阅 / t 树 | w 切换工作台标签（diff↔status↔doctor） |
| 输入区 | Tab 补全 / Enter 双语义 / @ | / 斜杠目录（已有） |
| vim | 全语义（NORMAL/INSERT/VISUAL） | 不变 |
| 面板内 | ↑↓/Enter 切换 | Esc 统一出栈 |

- 注册表生成 `/help keys` 与状态栏 F1 提示；冲突在注册期报错（lint 门禁）。
- keymap 配置层（settings.keymap）继续覆盖注册表默认值——配置语义不变。

## 5. 视觉系统（token 契约扩展）

1. **现有三元组保留**（primary/accent/border）+ 语义色沿用基底——不破既有主题。
2. **新增 token**（诚实最小集）：`panelBg`（面板底色，基底派生）、`workspaceHeaderBg`（工作台头）、`inlineBorder`（行内弹层边）——全部由基底派生，主题文件可选覆盖。
3. **密度档**：`compact`（现有）/ `cozy`（+行距）——settings.tuiDensity，状态栏宽高联动。
4. **面板分栏宽度**：`min(40, cols-50%)`——小窗自动降级为全屏（诚实，无假自适应）。

## 6. 分阶段实施路线

### P0 骨架统一（D1/D4 修，估计 3-5 人日）
- [ ] OverlayState 栈式重构（迁移 15 位 → stack+inline；Esc 统一出栈）
- [ ] appChrome 拆分（1031 → 状态栏核心 ≤500 行 + 徽章/宠物/提示独立组件）
- [ ] 键位注册表落地（全量键位移入 registry；冲突检测测试）
- 验收：34 组件回归全绿；`/help keys` 可列出全键位；新增浮层仅改 2 处

### P1 工作台化（D2 修，估计 3-5 人日）
- [ ] status/doctor 结构化工作台（复用 diff 的分节+树视图模式：w 键切换标签）
- [ ] sessions 工作台（列表+惰性预览+搜索——activeSessionSwitcher 逻辑收编）
- [ ] 面板分栏（config/model/skills/plugins 右分栏，不遮转录流）
- 验收：/status /doctor /sessions 不再落 pager 文本；小窗（<80 列）自动全屏降级

### P2 生产力增强（D5 补，估计 2-4 人日）
- [ ] Ctrl+P 命令面板（聚合 slash/键位/最近动作；@补全同源排序）
- [ ] 状态栏会话/配置固定入口（点击直达，不靠记忆）
- [ ] `/help keys` 分组帮助页
- 验收：新用户零记忆完成「切会话→改模型→查状态」三连操作

### 诚实边界（不做）
- 不引入 WebView/远程渲染（数据不出机、离线优先不变）
- 不做 conhost 图片内联/真彩色兜底协议（终端协议碎片化——既有结论）
- 不推翻 ink fork（渲染器稳定，UI 层重构不触碰渲染内核）

## 7. 验收总则

1. 每阶段：既有 300+ 用例零回归 + 新增该阶段契约测试（栈行为/键位冲突/面板降级）。
2. 文档同步：audit §13.9x 每阶段实录 + CHANGELOG 用户可见条目。
3. 评分联动：① UI 渲染引擎已 10 满格——本规划为**维持满格的工程化保障**（不升分）；⑨ 随 appChrome 拆分与键位注册表落地获得加固。

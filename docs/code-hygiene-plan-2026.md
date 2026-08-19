# WxNodus 代码卫生计划（2026-08-20：清无关文件 + 规范 + 优化）

> 目标：仓库只装 wxnodus 自己的东西；代码规范统一；优化有界可测。
> 原则：不重写 git 历史（不 force-push）；不删运行数据目录（data/、.zcode/、.wxnodus 用户态）；竞品引用标注约束（AGENTS.md）不破；每步全量回归 + 九步门禁 + 远程 CI。

## 0. 事实清单（2026-08-20 实测证据）

| # | 事实 | 证据 | 处置 |
|---|---|---|---|
| F1 | **运行时数据库入库**：`.wxnodus/wave2-gate.db`、`.wxnodus/wave2-migration-drill.db` 被 git 跟踪（各 4KB，drill 产物） | `git ls-files '.wxnodus/*'` | untrack + 磁盘删除 |
| F2 | **外部插件状态入库**：`.superpowers/sdd/progress.md`（superpowers 插件的 SDD 进度文件，非 wxnodus 源） | `git ls-files '.superpowers/*'` | untrack + 磁盘删除 |
| F3 | **编译产物入库**：`tests/fixtures/windows/uia/*/bin|obj` 共 **184 个** .NET 构建文件（DLL/EXE/PDB，数百 KB 级）被跟踪——.gitignore 已有排除但先于规则入库 | `git ls-files` 计数 184 | untrack（保留源码/工程文件与 gitignore 规则） |
| F4 | **根目录散装分析文档**：architecture-audit.md、capability-report.md、code-compare-report.md、competitive-analysis.md——属 wxnodus 研究文档但位置不规范 | 根目录 ls | 移入 docs/（不删——是竞品分析的证据资产） |
| F5 | **本地磁盘垃圾（已 ignore，未入库）**：cs.log、cv*.log、wxdbg.log、.tmp-fc/、.tmp-osbx-probe/、artifacts/、dist-installer/、dist/ | `git check-ignore` 全命中 | 安全子集删除（见 §2.2） |
| F6 | **死模块**：`src/wxnodus-ui/lib/editorLaunch.ts` 在 src 内零引用（P1-1 裁决后 textInput 分支已移除；composer 外部编辑器走 lib/editor.ts 独立实现）——仅 tests/editor-launch.test.ts 引用 | grep 全库 | 删除模块 + 测试（能力由 composer.openEditor 承接，无回退） |
| F7 | **legacy 未接线 store 层**：`src/app/stores/overlayStore.ts`（注释明示未接线）另 turnStore/uiStore 需逐一确认引用面——engine.ts 是真实引擎（wxnodus-ui 全量使用） | overlayStore 头注释 | 未接线者删除（先 grep 确认零生产引用与测试依赖） |
| F8 | **TODO/FIXME 2 处**（lint 报告项） | `scripts/lint.mjs` 输出 | 逐条收口：修复或升级为明确注释（不留悬空 TODO） |
| F9 | 依赖表 21 项（transformers/robotjs/playwright-core/node-screenshots/undici 等） | package.json | 逐项核对 src 引用——无用依赖移除（lock 同步 npm ci 验证） |

## 1. 阶段划分

### 阶段 1：无关文件清除（仓库卫生）
1.1 `git rm --cached`：F1 两个 .db + F2 progress.md + F3 全部 184 个 uia bin/obj 文件（一次性提交）。
1.2 磁盘删除安全子集（已 ignore 的垃圾）：cs.log、cv*.log、wxdbg.log、.tmp-fc/、.tmp-osbx-probe/、artifacts/、dist-installer/、dist/。
   - **不删**：data/（用户会话数据）、.zcode/（运行环境）、.playwright-mcp/.superpowers（外部工具状态——仅移除入库文件，目录保留）、node_modules/。
1.3 根目录文档归位：F4 四个 md → docs/（保留内容与引用锚点；audit 引用路径同步检查）。

### 阶段 2：代码规范
2.1 死模块移除：editorLaunch.ts + editor-launch.test.ts（F6，先复核 composer 路径确无引用）。
2.2 legacy stores 处置：grep 确认 turnStore/uiStore/overlayStore 引用面——未接线且无测试依赖者删除；有测试依赖者升级注释为「迁移锚点」并保留。
2.3 TODO/FIXME 收口（F8）：markdown.tsx:398 与另 1 处——修复或改为明确 backlog 注释（`// P3：…`），lint 计数归零或如实登记。
2.4 模块头注释一致性：抽查 20 个无头注释模块，补「文件职责 + 日期」一行式头（既有风格）。

### 阶段 3：代码优化（有界、可测、不赌行为）
3.1 **promptStore 重绘定时器合并**：每次 overlay 变更 2 个 setTimeout（0ms + 120ms forceRedraw）→ 模块级共享尾沿定时器（一次变更只挂 1 个 timer，保留双帧保障语义）。风险门：TUI 渲染回归不可单测——以全量回归 + 手工 smoke 把关；若出现渲染停摆即回滚（诚实标注）。
3.2 **状态栏热路径分配消减**：`ctxGradientCells` 每帧新建数组（FaceTicker 100ms tick 驱动 StatusRule 重渲染）→ 模块级缓存（w≤10 固定宽度预计算表）；`statusBarSegments` 结果缓存（cols 不变不重算）。纯函数可单测。
3.3 **依赖表核查**（F9）：21 依赖逐项 grep 引用；确认零引用者移出 dependencies（devDeps 如适用），`npm ci` 全量验证。

## 2. 执行顺序与风险门

| 步 | 内容 | 门 |
|---|---|---|
| S1 | 阶段 1 全部（一次提交） | git status 干净 + 全量单测（fixture 测试不受影响——bin 为运行时产物）+ docs-links 门禁 |
| S2 | 阶段 2 全部（一次提交） | tsc + 全量单测 + lint |
| S3 | 阶段 3 全部（一次提交） | tsc + 全量单测 + 手工 smoke（S3 前必须） + 九步门禁 + 远程 CI 盯绿 |
| S4 | 收尾文档：audit §14.00 + CHANGELOG | docs-links + 推送 |

## 3. 验收

1. `git ls-files` 不再含 .db/.superpowers/uia bin|obj/editorLaunch；磁盘垃圾安全子集清零（不碰 data/、.zcode/）。
2. 根目录只余仓库级文件（AGENTS/README/LICENSE/CHANGELOG/package*.json 等）。
3. lint TODO/FIXME 归零或如实登记；新增/修改代码风格与既有一致。
4. 全量 2900+ 用例零回归；九步门禁 + 远程 CI 全绿。
5. audit 如实记录每步证据与取舍（不假绿、不掩盖）。

## 4. 诚实边界

- 不做 git 历史重写（历史体积不动，只清 HEAD 起的状态）。
- 不删竞品研究文档内容（只挪位置——AGENTS.md 引用约束要求证据锚点可查）。
- 不确定归属的文件（如 .wxnodus/agents/code-reviewer.md——kernel 引用，确认保留）一律保留并注明。

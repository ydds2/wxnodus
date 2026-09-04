# wxnodus 清理插队批执行计划（2026-09-04）

> 依据：docs/eval-4.0.2-comprehensive-2026-09-04.md（4.0.2 综合评估收尾版）§6 缺陷总台账 / §7 建议路线 + 2026-09-04 本地实证复核（本表锚点全部现场重验）。
> 用户裁决（2026-09-04）：① 下一批次 = **清理插队批**（B2 进程树回收留待单独批次）；② 三套 ink fork **彻底删除**（git 历史保留，不归档）；③ 组织方式 = **方案一四步分组**（存量 → 删除 → 收敛 → 门禁），每步门禁验证后独立提交。
> 修订 v2（2026-09-04，并入外部评审 4 条补强 + 二次复核 3 项新发现）：B4 观察模式过渡 / Q5 豁免三层设计 / K2 旧语义快照 / lock 无 diff 检查与 ci.yml 注释清理；新发现——**master CI 自 2026-08-29 连续红**（未跟踪源码所致，见 §0）。
> 报告勘误（实证复核后从本批剔除）：评估 §5.4 TOP10 #1 durable queue（P0）**已落地**（src/kernel/durableQueue.ts，P2-14 2026-08-27，agent.ts/flowPage.ts 已接线）；#2 评测 harness **已起步**（scripts/eval/ 28 任务 + eval:tasks:selftest 已入 ci 链）——两项不再是待办。
> 本批性质：结构债清偿，**零功能变更**；总原则与 master plan 一致——单一事实源 + 诚实失败契约 + 契约测试锁定 + 真机证据。

## 0. 实证基线（2026-09-04 复核锚点）

| 台账项 | 实证锚点 | 本批处置 |
|---|---|---|
| A2 ink fork 死重 | packages/{hermes-ink,hermes-tui,wxnodus-ink,hermes-shared} 共 **106,229 行**；README.md:7-8 技术栈双重过时（「V4.0 已移除」/「V4.1 零 React/Ink 依赖」vs 实际官方 Ink 6）；AGENTS.md 技术栈摘要同漂移 | 步骤 1 删除 + 文案修正 |
| A2-CI 联动（评审确认+锚点细化） | ci.yml 三处引用 ink-dist：:9 头注释、:83-88 gate 上传（`if-no-files-found: error`，路径 packages/wxnodus-ink/dist）、:121-122 test 分片下载。**该 dist 为本地 esbuild 产物、git 不跟踪**（fork 不在 workspaces——仅 sdk/core），且消费者 entry-exports.js 全仓零引用（:83 步骤注释过时）——删除 fork 后无测试面会红，仅需清 CI 工件链三处 + 过时注释 | 步骤 1 清理 |
| A2 已知引用残留点位（二次复核） | vitest.config.ts:13-14（exclude 模式）、check-cycles.mjs:3/20（注释+过滤）——删除后成死配置需同步清理；w4-npm-boundary.test.ts:31/55、w4-build-boundary.test.ts:25 为 **not-contain 反向断言**——删除后更真，保留不动 | 步骤 1 清扫 |
| A4 双组合根 | src/bootstrap/createApplication.ts 生产零调用（仅 tests/wave1/w1-02-bootstrap.test.ts 引用）；五个 bootstrap* 阶段文件为恒等桩；hermes-gateway 无生产调用 | 步骤 1 已删除 |
| K2 版本解析 3 套 | selfUpdate.isNewerVersion 与 bundle.bundleVersionOk 各自实现解析；semverRange.parseVersion 生产未用（模块经 versionInRange 被 modpackCommands.ts:12 使用——报告「孤儿模块」说法不准确，但 parseVersion 出口未统一属实） | 步骤 2 统一出口 |
| Q5 死测试 | tests/docs-links.test.ts:12 describe.skip（文件头 V4-M0 迁移注释在案） | 步骤 3 重写 |
| A5 魔数漂移 | registry.ts:49 与 tui/commands.ts:6 硬编码「126」；handlersExt.ts:1 注释写死「108」 | 步骤 2 派生 + 测试锁 |
| A7 版本漂移 | package.json 4.0.2 vs packages/{core,sdk}/package.json 4.0.1 | 步骤 2 统一 |
| Q2 registry 审计未挂 ci | 三表对账脚本散在 .tmp/（guide-vs-registry.mts 等），scripts/ 无正式版 | 步骤 3 正式化挂 ci |
| Q4 sdk/core 无独立 typecheck | packages/{core,sdk}/tsconfig.json 已存在（未跟踪）但 ci 链无对应命令 | 步骤 3 挂 ci |
| B4 smoke:tui 未进 CI | package.json:26 ci 链无 smoke:tui；.github/workflows/ci.yml windows-latest 已具备 ConPTY 条件 | 步骤 3 挂 ci |
| （新发现①）存量未提交 | git status 实测 **183 条** = 88 M + 1 D + **94 未跟踪**；未跟踪含 **~26 个 src/ 源文件**（src/migrations/ 整目录、kernel 9、tui 8、commands 7、lib 2——modpackCommands/oasisCommands/watchCommands/instanceIdentity/agentShared 等命令与内核面）+ **~15 个 tests/ 文件**（semver-range.test.ts 等）+ docs/scripts/eval/packages tsconfig | 步骤 0 固化 |
| （新发现②）**master CI 红** | `gh run list` 实测：ci.yml 自 2026-08-29 起连续 4+ 轮 failure（~1m 即死）；根因 = committed 树缺 src/migrations → typecheck TS2307 ×7（marketMigrations/securityMigrations/store/db）；**工作区（含未跟踪）typecheck 实测绿（exit 0）**——修复即「提交缺失源码」，属步骤 0 | 步骤 0 修复 |

## 步骤 0：存量验证与提交（基线固化 + **修复 master CI**）

**前提**：master CI 已红（2026-08-29 起，根因=源码未提交）——本步不只是整理成果，**是远端门禁的修复动作**；不固化绿基线，后续每一步的「门禁绿」都不可归因。

1. 全量门禁实证：`npm run ci`（typecheck×2 + build + test:all + known-failures + 发现/覆盖/lint/环/docs 双检 + eval selftest）——评估报告称 3031 用例全绿，提交前现场复核（工作区 typecheck 已实测绿）。
2. 未跟踪 94 条三级分类处置：
   - **① 编译/测试必需源码（最高优先，master CI 红的直接根因）**：src/migrations/ 整目录、src/kernel 9 文件、src/tui 8、src/commands(+ext) 7+3、src/lib 2、tests/ ~15 文件 → 全部提交；
   - **② 成果物**：docs/*.md（评估/计划文档）、scripts/eval/（28 任务 + runner）、packages/{core,sdk}/tsconfig.json（步骤 3-Q4 前置）、examples/watch-pack-demo/（核实内容后）→ 提交；
   - **③ 会话工作区**：.tmp/ 等 → 不提交。
3. 提交分组（建议 3-4 个 commit，逻辑序）：① 缺失源码+测试（`fix: 补齐未提交源码修复 master CI`——远端红的修复）② B1/B3/A 批已跟踪文件改动 ③ docs + scripts/eval ④ 其余成果物；若耦合难拆可合并，message 分段说明。
4. **推送并确认远端 CI 转绿**（本批第一个远端验收点）——若仍红，定位修复后再继续后续步骤。

**验证**：`npm run ci` 全绿 + `git status` 干净（除忽略项）+ **远端 ci.yml 绿** + 记录批次起点 commit hash。

## 步骤 1：删除类（A2 + A4）

**A2 ink fork 删除（用户裁决：彻底删除）**：
1. `git rm -r packages/hermes-ink packages/hermes-tui packages/wxnodus-ink packages/hermes-shared`；
2. 引用残留清扫（逐一 grep 确认零引用）：package.json workspaces（实测仅 sdk/core，无 fork）、tsconfig*.json、vitest.config.ts、scripts/、tests/——**已知点位**：vitest.config.ts:13-14 exclude 模式与 check-cycles.mjs:3/20 注释/过滤删除后成死配置，同步清理；w4-npm-boundary:31/55、w4-build-boundary:25 为 not-contain 反向断言，保留不动（删除后更真）；
3. **CI 联动（评审确认的关键风险，锚点已细化）**：删除 ci.yml 三处 ink-dist 引用——:9 头注释（「复用 dist/ink-dist」句）、:83-88 gate 上传步骤（if-no-files-found: error）、:121-122 test 分片下载步骤；:83 步骤名内「ui 测试解析 entry-exports.js」注释一并移除（消费者已零引用，注释过时）。**无测试面会因缺工件红**——风险仅剩 CI 配置残留；
4. **lock 无 diff 核账（评审补强）**：`npm install --package-lock-only && git diff --exit-code package-lock.json`——fork 不在 workspaces 与依赖图，删除后 lock **必须零变化**；非零 diff = 存在意外引用，停下排查；
5. 文案修正：README.md:7-8 技术栈改为「官方 Ink 6 + 自研组件层」的事实表述；AGENTS.md 技术栈行同步（AGENTS.md 为 `/init` 生成摘要 + 手工注记段，只改技术栈行、不动手工注记）；
6. `check:docs-links` / `check:release-surface` / `check:cycles` 兜底复扫。

**A4 双组合根删除**：
1. 删 `src/bootstrap/createApplication.ts` 与五个恒等桩阶段文件（删除前逐一确认零生产引用）——已删除；
2. `tests/wave1/w1-02-bootstrap.test.ts`：仅测 createApplication 则整删（已删除——实测仅测 createApplication）；若混测 cliComposition 则保留后者断言；
3. hermes-gateway：确认无生产调用后随批删除（已删除——src/hermes-gateway/ + hermes-gateway-interactive.test.ts；knownFailures KF-002 为 retired 历史台账条目如实保留）。

**验证**：typecheck + build + test:all + check:cycles + check:docs-links 全绿；`git diff --stat` 净删 ≈10.6 万行。

## 步骤 2：收敛类（K2 + A5 + A7）

**K2 版本解析统一**：
1. **旧语义快照（评审补强）**：切换前先全量跑 selfUpdate/bundle 现有测试套并确认绿——即「旧实现行为基线」；统一出口后同套复跑，**零漂移**才允许提交；
2. `selfUpdate.isNewerVersion`、`bundle.bundleVersionOk` 内部解析改调 `semverRange` 统一出口（parseVersion 或导出 compare 语义）；
3. semver-range.test.ts 补「两调用方行为与统一出口一致」契约用例（等价类：major/minor/patch/前缀不等长/**0.x 边界/预发布号**/非法输入）。

**A5 魔数派生**：
1. registry.ts:49、tui/commands.ts:6 的「126」改为 `SLASH.length` 模板串派生；
2. handlersExt.ts:1 注释去写死数字（表述为「与 SLASH 长度同步」）；
3. tests/cli-surface-copy.test.ts 增源码文案计数锁（A5 防漂移测试既有框架扩展——user-guide 行数锁已有，本项补源码侧）。

**A7 版本统一**：
1. packages/{core,sdk}/package.json version → 4.0.2；
2. scripts/release/publish-local.mjs 检查并补统一 bump（主仓与 packages 版本同步推进，杜绝再漂移）。

**验证**：typecheck + test:all（含新增契约用例）全绿；`--help`/TUI 手册实测计数随 SLASH 长度自动正确。

## 步骤 3：门禁类（Q5 + Q2 + Q4 + B4）

**Q5 重写死测试**：tests/docs-links.test.ts 按 V4-M0 注释重写为 V4 文档集契约，替换 describe.skip 恢复活性——**豁免三层设计（评审补强 + 二次复核新增一层）**：
- ① **历史快照豁免**：复用 check-docs-links.mjs HISTORICAL 机制先例（:44 整体豁免）——带日期后缀的评估/审计快照文档不入对账；
- ② **token 口径收窄**：只对账「反引号包裹的 `/cmd`」token，散文提及不抓；
- ③ **退役命令豁免表（新发现第三类误报源）**：当前态文档存在合法的退役命令散文引用——实例：README:77「原 `/key` 已并入 `/model`」；豁免表显式登记（`/key → /model`）并注明去向，豁免表本身即文档；
- 对账范围 = **当前态文档白名单**（README.md + docs/user-guide.md），断言「反引号 /cmd ∈ SLASH ∪ 豁免表」。

**Q2 registry 审计正式化**：.tmp/ 三表对账逻辑（SLASH = handlers = TUI 菜单）迁为 `scripts/check-registry-consistency.mjs`（本批待建产物）；package.json 增 `check:registry-consistency` 并入 ci 链；ci.yml 与 npm run ci 同源同步。

**Q4 sdk/core typecheck**：package.json 增 `typecheck:core` / `typecheck:sdk`（tsc -p 对应 tsconfig）并入 ci 链与 ci.yml。

**B4 smoke:tui 进 CI（观察模式三段过渡——评审补强，防 flake 卡门禁）**：
- flake 根源在案：tui-pty-smoke.mjs:57-58 ConPTY 输入 2.5s 防抖 + :30 60s 启动预算，共享 runner 时序不稳——本地绿 ≠ CI 绿；
- **阶段①**：挂 ci.yml 前先 `gh workflow run` 手动连跑 ≥3 轮全绿；
- **阶段②**：以 ci.yml 独立 step + `continue-on-error: true` 挂观察位（**不进 package.json ci 链**——脚本链无法按命令容错，观察期失败不阻塞）；
- **阶段③**：连续 ≥5 轮绿（或观察一周）后升硬门禁：去 continue-on-error + 并入 npm ci 链；升格时点记录于本计划文档。

**验证**：`npm run ci` 全链（净增 3 项硬门禁：check:registry-consistency / typecheck:core / typecheck:sdk）全绿；smoke:tui 观察位以 `gh run view` 确认执行且不阻塞。

## 验收与提交纪律

- **每步**：typecheck + build + test:all + 受影响 check:* 全绿才提交；预计 4-7 个 commit（存量 3-4 + 步骤 1/2/3 各 1）；步骤 0 完成后记录批次起点 commit hash（终验 diff 基线）。
- **远端验收两点**：① 步骤 0 推送后 master CI 必须转绿（修复 2026-08-29 起的红）；② 步骤 1 改动 ci.yml 后必须 `gh workflow run` 实跑验证（含 ink-dist 步骤移除无残留红灯）。
- **终验**：
  1. `npm run ci` 全链绿（门禁数量净增：check:registry-consistency / typecheck:core / typecheck:sdk；smoke:tui 处观察位）；
  2. `git diff <批次起点>..HEAD --stat`（步骤 0 记录的 hash）复核净删 ≈10.6 万行、零功能面 diff（文案/版本号/门禁除外）；
  3. registry 三表 126=126=126 复核（正式化脚本输出）；
  4. `npm install --package-lock-only` 后 lock 零 diff 复核。
- **文档收尾**：docs/improvement-master-plan-2026-09-04.md E 节记录清理批闭环；本计划文档随批归档。

## 缺陷台账闭环对照（评估 §6 → 本批）

| 台账编号 | 状态（本批后） |
|---|---|
| A2 / A4 / K2 / Q5 / A5 / A7 / Q2 / Q4 / Q1(B4) | ✅ 闭环（2026-09-04 执行完毕——B4 处观察位阶段②，升格条件见 ci.yml 注释） |
| B2 进程树回收 | ⏳ 下一批次（单独执行，回归面最大） |
| K1/C5 记忆时间衰减 | ⏳ 第四批（master plan 既定） |
| A1 分层解耦 / A3 handlers 拆分 / K3 单例 reset / K4 agent 拆分 / Q3 hasDist / Q6 脆断言 / K5 MCP transcript / K6 错误形状 / Q7/Q8 | ⏳ 渐进项（不属本批） |
| 评估 §5.4 TOP10 #1/#2（P0） | ✅ 已落地/已起步（报告勘误，实证见 §0） |

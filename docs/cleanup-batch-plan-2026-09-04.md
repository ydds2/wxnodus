# wxnodus 清理插队批执行计划（2026-09-04）

> 依据：docs/eval-4.0.2-comprehensive-2026-09-04.md（4.0.2 综合评估收尾版）§6 缺陷总台账 / §7 建议路线 + 2026-09-04 本地实证复核（本表锚点全部现场重验）。
> 用户裁决（2026-09-04）：① 下一批次 = **清理插队批**（B2 进程树回收留待单独批次）；② 三套 ink fork **彻底删除**（git 历史保留，不归档）；③ 组织方式 = **方案一四步分组**（存量 → 删除 → 收敛 → 门禁），每步门禁验证后独立提交。
> 报告勘误（实证复核后从本批剔除）：评估 §5.4 TOP10 #1 durable queue（P0）**已落地**（src/kernel/durableQueue.ts，P2-14 2026-08-27，agent.ts/flowPage.ts 已接线）；#2 评测 harness **已起步**（scripts/eval/ 28 任务 + eval:tasks:selftest 已入 ci 链）——两项不再是待办。
> 本批性质：结构债清偿，**零功能变更**；总原则与 master plan 一致——单一事实源 + 诚实失败契约 + 契约测试锁定 + 真机证据。

## 0. 实证基线（2026-09-04 复核锚点）

| 台账项 | 实证锚点 | 本批处置 |
|---|---|---|
| A2 ink fork 死重 | packages/{hermes-ink,hermes-tui,wxnodus-ink,hermes-shared} 共 **106,229 行**；README.md:7-8 技术栈双重过时（「V4.0 已移除」/「V4.1 零 React/Ink 依赖」vs 实际官方 Ink 6）；AGENTS.md 技术栈摘要同漂移 | 步骤 1 删除 + 文案修正 |
| A4 双组合根 | src/bootstrap/createApplication.ts 生产零调用（仅 tests/wave1/w1-02-bootstrap.test.ts 引用）；五个 bootstrap* 阶段文件为恒等桩；hermes-gateway 无生产调用 | 步骤 1 删除 |
| K2 版本解析 3 套 | selfUpdate.isNewerVersion 与 bundle.bundleVersionOk 各自实现解析；semverRange.parseVersion 生产未用（模块经 versionInRange 被 modpackCommands.ts:12 使用——报告「孤儿模块」说法不准确，但 parseVersion 出口未统一属实） | 步骤 2 统一出口 |
| Q5 死测试 | tests/docs-links.test.ts:12 describe.skip（文件头 V4-M0 迁移注释在案） | 步骤 3 重写 |
| A5 魔数漂移 | registry.ts:49 与 tui/commands.ts:6 硬编码「126」；handlersExt.ts:1 注释写死「108」 | 步骤 2 派生 + 测试锁 |
| A7 版本漂移 | package.json 4.0.2 vs packages/{core,sdk}/package.json 4.0.1 | 步骤 2 统一 |
| Q2 registry 审计未挂 ci | 三表对账脚本散在 .tmp/（guide-vs-registry.mts 等），scripts/ 无正式版 | 步骤 3 正式化挂 ci |
| Q4 sdk/core 无独立 typecheck | packages/{core,sdk}/tsconfig.json 已存在（未跟踪）但 ci 链无对应命令 | 步骤 3 挂 ci |
| B4 smoke:tui 未进 CI | package.json:26 ci 链无 smoke:tui；.github/workflows/ci.yml windows-latest 已具备 ConPTY 条件 | 步骤 3 挂 ci |
| （新发现）存量未提交 | 工作区 89 文件 +9964/-7388（B1/B3/A 批成果）+ ~30 未跟踪文件（docs/scripts/eval/packages tsconfig） | 步骤 0 固化 |

## 步骤 0：存量验证与提交（基线固化）

**前提**：不固化绿基线，后续任何步骤的「门禁绿」都不可归因。

1. 全量门禁实证：`npm run ci`（typecheck×2 + build + test:all + known-failures + 发现/覆盖/lint/环/docs 双检 + eval selftest）——评估报告称 3031 用例全绿，提交前现场复核。
2. 未跟踪文件分类处置：
   - `docs/*.md`（评估/计划/审计文档）→ 提交；
   - `scripts/eval/`（28 任务 + runner + selftest）→ 提交；
   - `packages/{core,sdk}/tsconfig.json` → 提交（步骤 3-Q4 前置）；
   - `examples/watch-pack-demo/` → 核实内容与引用后提交；
   - `.tmp/` → 不提交（会话工作区，不入库）。
3. 提交分组：按逻辑 1-3 个 commit（建议：B3 MCP 治理 / B1 卡死体检+文案 / docs+evals）；若 diff 耦合无法干净拆分则单提交，message 内分段说明。

**验证**：`npm run ci` 全绿 + `git status` 干净（除 .tmp/ 等忽略项）。

## 步骤 1：删除类（A2 + A4）

**A2 ink fork 删除（用户裁决：彻底删除）**：
1. `git rm -r packages/hermes-ink packages/hermes-tui packages/wxnodus-ink packages/hermes-shared`；
2. 引用残留清扫（逐一 grep 确认零引用）：package.json workspaces、tsconfig*.json include/exclude、vitest.config.ts、scripts/、tests/（tests/hermes-ink-pipeline.test.tsx 工作区已删，随存量提交）；
3. **CI 联动（本步最大风险点）**：ci.yml 注释载明「test 三分片 needs gate 复用 dist/ink-dist 工件」——CI 当前在构建 ink fork 产物；删除后同步移除 ci.yml 中 ink-dist 构建/上传/复用步骤，否则 CI 红；
4. 文案修正：README.md:7-8 技术栈改为「官方 Ink 6 + 自研组件层」的事实表述；AGENTS.md 技术栈行同步（AGENTS.md 为 `/init` 生成摘要 + 手工注记段，只改技术栈行、不动手工注记）；
5. `check:docs-links` / `check:release-surface` / `check:cycles` 兜底复扫。

**A4 双组合根删除**：
1. 删 `src/bootstrap/createApplication.ts` 与五个恒等桩阶段文件（删除前逐一确认零生产引用）；
2. `tests/wave1/w1-02-bootstrap.test.ts`：仅测 createApplication 则整删；若混测 cliComposition 则保留后者断言；
3. hermes-gateway：确认无生产调用后随批删除（knownFailures 台账留名条目同步核对）。

**验证**：typecheck + build + test:all + check:cycles + check:docs-links 全绿；`git diff --stat` 净删 ≈10.6 万行。

## 步骤 2：收敛类（K2 + A5 + A7）

**K2 版本解析统一**：
1. `selfUpdate.isNewerVersion`、`bundle.bundleVersionOk` 内部解析改调 `semverRange` 统一出口（parseVersion 或导出 compare 语义）；
2. semver-range.test.ts 补「两调用方行为与统一出口一致」契约用例（等价类：major/minor/patch/前缀不等长/非法输入）。

**A5 魔数派生**：
1. registry.ts:49、tui/commands.ts:6 的「126」改为 `SLASH.length` 模板串派生；
2. handlersExt.ts:1 注释去写死数字（表述为「与 SLASH 长度同步」）；
3. tests/cli-surface-copy.test.ts 增源码文案计数锁（A5 防漂移测试既有框架扩展——user-guide 行数锁已有，本项补源码侧）。

**A7 版本统一**：
1. packages/{core,sdk}/package.json version → 4.0.2；
2. scripts/release/publish-local.mjs 检查并补统一 bump（主仓与 packages 版本同步推进，杜绝再漂移）。

**验证**：typecheck + test:all（含新增契约用例）全绿；`--help`/TUI 手册实测计数随 SLASH 长度自动正确。

## 步骤 3：门禁类（Q5 + Q2 + Q4 + B4）

**Q5 重写死测试**：tests/docs-links.test.ts 按 V4-M0 注释重写为 V4 文档集契约——① README 引用的 docs 文件存在；② docs/*.md 中出现的命令名全部对账 SLASH 注册表；③ docs 内部相对链接有效。替换 describe.skip，恢复活性。

**Q2 registry 审计正式化**：.tmp/ 三表对账逻辑（SLASH = handlers = TUI 菜单）迁为 `scripts/check-registry-consistency.mjs`；package.json 增 `check:registry-consistency` 并入 ci 链；ci.yml 与 npm run ci 同源同步。

**Q4 sdk/core typecheck**：package.json 增 `typecheck:core` / `typecheck:sdk`（tsc -p 对应 tsconfig）并入 ci 链与 ci.yml。

**B4 smoke:tui 进 CI**：ci 链追加 `npm run smoke:tui`（windows-latest ConPTY 支持，AttachConsole 豁免既有）；本地 Windows 先实测一遍确认无假绿。

**验证**：`npm run ci` 全链（含新增 4 项门禁）全绿。

## 验收与提交纪律

- **每步**：typecheck + build + test:all + 受影响 check:* 全绿才提交；预计 4-6 个 commit（存量 1-3 + 步骤 1/2/3 各 1）；步骤 0 完成后记录批次起点 commit hash（终验 diff 基线）。
- **终验**：
  1. `npm run ci` 全链绿（门禁数量净增：check:registry-consistency / typecheck:core / typecheck:sdk / smoke:tui）；
  2. `git diff <批次起点>..HEAD --stat`（步骤 0 记录的 hash）复核净删 ≈10.6 万行、零功能面 diff（文案/版本号/门禁除外）；
  3. registry 三表 126=126=126 复核（正式化脚本输出）；
  4. GitHub Actions 实跑一轮（步骤 1 改动 ci.yml 后必须远端验证）。
- **文档收尾**：docs/improvement-master-plan-2026-09-04.md E 节记录清理批闭环；本计划文档随批归档。

## 缺陷台账闭环对照（评估 §6 → 本批）

| 台账编号 | 状态（本批后） |
|---|---|
| A2 / A4 / K2 / Q5 / A5 / A7 / Q2 / Q4 / Q1(B4) | ✅ 闭环（本批） |
| B2 进程树回收 | ⏳ 下一批次（单独执行，回归面最大） |
| K1/C5 记忆时间衰减 | ⏳ 第四批（master plan 既定） |
| A1 分层解耦 / A3 handlers 拆分 / K3 单例 reset / K4 agent 拆分 / Q3 hasDist / Q6 脆断言 / K5 MCP transcript / K6 错误形状 / Q7/Q8 | ⏳ 渐进项（不属本批） |
| 评估 §5.4 TOP10 #1/#2（P0） | ✅ 已落地/已起步（报告勘误，实证见 §0） |

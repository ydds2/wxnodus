# 清理插队批实施计划（2026-09-04）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 固化存量并修复 master CI → 删 106,229 行 ink fork 死重与死代码 → 三项单一事实源收敛 → 补 4 项质量门禁（spec：docs/cleanup-batch-plan-2026-09-04.md v2）。

**Architecture:** 四步分组（存量→删除→收敛→门禁），每步本地门禁全绿后独立提交；远端验收两点（步骤 0 推送转绿、步骤 1 改 ci.yml 后 dispatch 验证）。

**Tech Stack:** Node 22 + TypeScript 严格 ESM · vitest · GitHub Actions windows-latest · npm workspaces（仅 sdk/core）。

## Global Constraints

- 零功能变更（文案/版本号/门禁配置除外）；每步提交前 typecheck + build + test:all + 受影响 check:* 全绿。
- docs/*.md 必须 UTF-8 BOM + 严格 UTF-8 + LF（check:docs-encoding 门禁）。
- 命令计数文案禁止硬编码数字（A5 防漂移：SLASH.length 派生）。
- fork 不在 workspaces——删除后 package-lock.json 必须零 diff。
- 提交信息沿用仓库 conventional commits 中文风格（feat:/fix:/chore:/docs:）。

---

### Task 0: 存量固化 + 修复 master CI

**Files:** 无代码修改——纯 git add/commit/push（88 M + 1 D + 94 未跟踪）。

**分组清单（94 未跟踪三级分类）：**
- **G1 编译/测试必需（CI 红根因）**：`src/migrations/`、`src/kernel/`（agentShared/clipboardImage/instanceIdentity/localVision/processScan/screenMatch/screenStream/semverRange/versionManifest）、`src/commands/`（ext/agentFlowCommands/ext/modpackCommands/ext/oasisCommands/ext/watchCommands/ext/webCommands/mcpStatus/outputFormat）、`src/tui/`（i18n/keys/markdown/mouse/paste/ui/modeColor/ui/stableInput/viewport）、`src/lib/`（errorMessage/hash）、`scripts/swap-dist.mjs`（build 链引用）、`scripts/tui-pty-smoke.mjs` + `scripts/tui-e2e-mock.mjs`（smoke:tui/e2e:tui 入口）、`scripts/evidence-b1-b3-governance.mjs`、tests/ 全部 26 文件
- **G2 成果物**：docs/*.md（15 份）、`scripts/eval/tasks/t11-t28`（18 项）、`packages/{core,sdk}/tsconfig.json`、`examples/watch-pack-demo/`（核实后）
- **G3 不提交**：`scripts/tmp-fix-quotes.py`、`scripts/tmp-fulltest.mjs`、`scripts/tmp-xxxi-1.py`（tmp-* 一次性脚本——核实无引用后留工作区）

- [ ] **Step 0.1: 全量门禁实证** — Run: `npm run ci`（后台，预计 5-15 分钟）。Expected: 全链绿（typecheck×2/build/test:all 3031+skipped/known-failures/发现/覆盖/lint/环/docs×2/eval selftest）。
- [ ] **Step 0.2: 核实 G2/G3 疑点** — `grep -rn "tmp-fulltest\|tmp-fix-quotes\|tmp-xxxi" scripts/ src/ tests/ package.json .github/` 零引用 → 确认 G3 不提交；`ls -R examples/watch-pack-demo/` + grep 引用 → 确认 G2 处置。
- [ ] **Step 0.3: commit G1** — `git add src/migrations src/kernel src/commands src/tui src/lib scripts/swap-dist.mjs scripts/tui-pty-smoke.mjs scripts/tui-e2e-mock.mjs scripts/evidence-b1-b3-governance.mjs tests/ && git commit -m "fix: 补齐未提交源码与测试——修复 master CI（TS2307 src/migrations 等缺失）"`
- [ ] **Step 0.4: commit 已跟踪改动** — `git add -u && git commit -m "feat: B1 卡死体检 + B3 MCP 治理 + A 批文案/语义修复（评估会话存量）"`（-u 含 1 个 D：tests/hermes-ink-pipeline.test.tsx）
- [ ] **Step 0.5: commit G2** — `git add docs/ scripts/eval/ packages/core/tsconfig.json packages/sdk/tsconfig.json examples/ && git commit -m "docs+chore: 评估文档集 + eval 任务 t11-t28 + packages tsconfig"`（examples 若 Step 0.2 判不提交则从列表去除）
- [ ] **Step 0.6: 记录批次起点** — `git rev-parse HEAD > .tmp/cleanup-batch-base.txt`（终验 diff 基线）。
- [ ] **Step 0.7: 推送 + 远端转绿** — `git push && gh run watch $(gh run list --workflow=ci.yml --limit 1 --json databaseId -q '.[0].databaseId')`。Expected: master CI 由红转绿（2026-08-29 起首次）。若仍红：`gh run view --log-failed` 定位，修复后重推。

### Task 1: 删除类（A2 + A4）

**Files:** Delete: `packages/{hermes-ink,hermes-tui,wxnodus-ink,hermes-shared}`（106,229 行）、`src/bootstrap/createApplication.ts` + 桩阶段文件、`tests/wave1/w1-02-bootstrap.test.ts`（视内容）；Modify: `.github/workflows/ci.yml`（:9/:83-88/:121-122 ink-dist 三处）、`vitest.config.ts:13-14`、`scripts/check-cycles.mjs:3/20`、`README.md:7-8`、`AGENTS.md` 技术栈行。

- [ ] **Step 1.1: 删 fork 四目录** — `git rm -r -q packages/hermes-ink packages/hermes-tui packages/wxnodus-ink packages/hermes-shared`
- [ ] **Step 1.2: ci.yml 清 ink-dist 三处** — 删 :9 头注释「复用 dist/ink-dist」句段、:83-88 Upload ink dist 步骤块、test job :121-122 附近 Download ink-dist 步骤块（执行时以 grep -n ink-dist 定位全部行）。
- [ ] **Step 1.3: 清死配置** — vitest.config.ts:13-14 两行 exclude；check-cycles.mjs:3 注释句与 :20 过滤中 fork 相关分支。
- [ ] **Step 1.4: 文案修正** — README.md:7-8 改为「V4.2 变更（2026-09-03）：交互 TUI 定型官方 Ink 6 + 自研组件层（App/Composer/Overlays 等）」事实表述；AGENTS.md「@wxnodus/ink 自研 TUI 渲染器」→「官方 Ink 6 + 自研组件层」。
- [ ] **Step 1.5: 零残留 grep** — `grep -rni "hermes-ink\|hermes-tui\|hermes-shared\|wxnodus-ink\|ink-dist" src/ tests/ scripts/ package.json tsconfig*.json vitest.config.ts .github/ README.md AGENTS.md` → Expected: 零命中（w4 两测试的反向断言按 spec 保留——若命中仅为这两文件则改写断言为通用「fork 不存在」或删除对应断言块，二选一以最小 diff 为准）。
- [ ] **Step 1.6: lock 零 diff 核账** — `npm install --package-lock-only && git diff --exit-code package-lock.json` → Expected: 无输出 exit 0。
- [ ] **Step 1.7: A4 死代码** — 读 `src/bootstrap/createApplication.ts` 头部与 import 确认五个桩阶段文件名 → `git rm` 之 + createApplication.ts；读 tests/wave1/w1-02-bootstrap.test.ts——仅测 createApplication 则 `git rm`，混测 cliComposition 则删 createApplication 断言保留其余；grep hermes-gateway 引用，无生产调用则删除对应文件/条目。
- [ ] **Step 1.8: 门禁验证** — `npm run typecheck && npm run build && npx vitest run --silent 2>&1 | tail -5 && npm run check:cycles && npm run check:docs-links && npm run check:release-surface` → 全绿。
- [ ] **Step 1.9: commit + 远端验证** — `git add -A && git commit -m "chore!: 删除三套 ink fork 与双组合根死代码（-10.6万行）——TUI 已定型官方 Ink 6"` → `git push` → `gh workflow run ci` → watch 绿。

### Task 2: 收敛类（K2 + A5 + A7）

**Files:** Modify: `src/kernel/selfUpdate.ts`（isNewerVersion 内部改调 semverRange）、`src/kernel/bundle.ts`（bundleVersionOk 同）、`src/commands/registry.ts:49`、`src/tui/commands.ts:6`、`src/commands/handlersExt.ts:1`、`tests/semver-range.test.ts`（+等价类）、`tests/cli-surface-copy.test.ts`（+源码文案计数锁）、`packages/{core,sdk}/package.json`（4.0.2）、`scripts/release/publish-local.mjs`（视检查结果）。

- [ ] **Step 2.1: K2 旧语义快照** — `npx vitest run tests/kernel-self-update.test.ts tests/*bundle* 2>/dev/null || npx vitest run -t "version"`——先定位实际测试文件名再跑；Expected: 全绿（旧基线）。
- [ ] **Step 2.2: K2 切换** — selfUpdate.ts/bundle.ts 版本解析改 import semverRange 统一出口；test:all 复跑同套零漂移。
- [ ] **Step 2.3: K2 等价类契约** — semver-range.test.ts 增 describe「调用方一致性」：isNewerVersion/bundleVersionOk 与 parseVersion 在 {0.x 边界, 预发布号, 前缀不等长, 非法输入} 等价。
- [ ] **Step 2.4: A5 魔数派生** — registry.ts:49 与 tui/commands.ts:6 改 `` `查看帮助（默认全目录 ${SLASH.length} · ...` `` 模板；handlersExt.ts:1 注释改「此计数与 SLASH 长度同步，勿回写旧值」去数字。
- [ ] **Step 2.5: A5 测试锁** — cli-surface-copy.test.ts 增用例：读 registry.ts/tui/commands.ts 源码断言不含硬编码 `126`/`108` 字面量（正则 `/\b12[06]\b|\b108\b/` 对特定行）。
- [ ] **Step 2.6: A7 版本统一** — 两 package.json version → 4.0.2；读 publish-local.mjs 若无版本同步则补「发布前断言三处 version 相等」防再漂移。
- [ ] **Step 2.7: 门禁 + commit** — `npm run typecheck && npx vitest run tests/semver-range.test.ts tests/cli-surface-copy.test.ts && npm run check:docs-encoding`（README 若提及版本需同步）→ `git add -A && git commit -m "refactor: 版本解析统一 semverRange 出口 + 命令计数 SLASH.length 派生 + packages 版本对齐 4.0.2"`。

### Task 3: 门禁类（Q2 + Q4 + Q5 + B4）

**Files:** Create: `scripts/check-registry-consistency.mjs`；Modify: `package.json`（ci 链 +3 命令）、`.github/workflows/ci.yml`（同步 + smoke:tui 观察 step）、`tests/docs-links.test.ts`（整文件重写）。

- [ ] **Step 3.1: Q2 审计脚本** — 读 `.tmp/guide-vs-registry.mts` 等三表对账逻辑 → 写 scripts/check-registry-consistency.mjs（运行期 import registry/SLASH、handlers 注册面、TUI 菜单源——三表计数+项集合一致才 exit 0，输出 `REGISTRY_CONSISTENCY_OK: N=N=N`）。
- [ ] **Step 3.2: Q2/Q4 挂链** — package.json scripts 增 `"check:registry-consistency"`、`"typecheck:core": "tsc -p packages/core"`、`"typecheck:sdk": "tsc -p packages/sdk"`；ci 链插入三者；ci.yml gate pwsh 块同源加三行（各带 `$LASTEXITCODE` 检查，反恒绿纪律）。
- [ ] **Step 3.3: Q5 重写** — tests/docs-links.test.ts 重写：HISTORICAL 集合（日期后缀快照豁免，复用 check-docs-links.mjs 先例）+ 对账白名单 [README.md, docs/user-guide.md] + 反引号 token 正则 + 退役豁免表 `{ '/key': '/model' }`；断言提取的每个 token ∈ SLASH ∪ 豁免表。describe.skip 移除。
- [ ] **Step 3.4: Q5 实测** — `npx vitest run tests/docs-links.test.ts`——若红：逐 token 判断真漂移（修文档）vs 漏豁免（补表）；Expected: 绿。
- [ ] **Step 3.5: B4 阶段① 本地三连跑** — `npm run smoke:tui && npm run smoke:tui && npm run smoke:tui` 三轮全绿（本地 ConPTY 真机）。
- [ ] **Step 3.6: B4 阶段② 观察位** — ci.yml test job 后加独立 step：`- name: smoke:tui (observation)  continue-on-error: true  run: npm run smoke:tui`；**不进** package.json ci 链。
- [ ] **Step 3.7: 全链 + commit** — `npm run ci`（净增 3 硬门禁）全绿 → `git add -A && git commit -m "test+chore: registry 三表审计/Q5 文档对账复活/sdk-core typecheck 挂 CI + smoke:tui 观察位"` → push → 远端绿 + 观察 step 执行不阻塞。
- [ ] **Step 3.8: B4 阶段③ 升格条件记录** — cleanup-batch-plan 文档记录「连续 ≥5 轮绿或一周后升硬门禁」待办。

### Task 4: 终验

- [ ] **Step 4.1: diff 核账** — `git diff $(cat .tmp/cleanup-batch-base.txt)..HEAD --stat | tail -3` → 净删 ≈10.6 万行、改动集中于文案/版本/门禁。
- [ ] **Step 4.2: 全链 + lock 复核** — `npm run ci` 绿 + `npm install --package-lock-only && git diff --exit-code package-lock.json`。
- [ ] **Step 4.3: master plan 更新** — improvement-master-plan E 节记录清理批闭环 + 评估文档两处勘误（用户已确认将改）。
- [ ] **Step 4.4: 远端最终态** — `gh run list --workflow=ci.yml --limit 1` → green。

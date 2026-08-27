# 规格：/bundle 场景整合包修复闭环（2026-08-19）

> 状态：设计已获用户确认（2026-08-19 八评后）· 单一子系统（/bundle 缺陷闭环）。
> 用户拍板的两项语义决策：① import 同名拒绝；② use = 配置 + 全量安装。
> 代码锚点基于 HEAD fc5071d（`src/kernel/bundle.ts` 165 行 / `tests/kernel-bundle.test.ts` 98 行 / 5 既有用例）。

## 0. 背景与缺陷索引

八评对 `/bundle`（ea6c668）深审出的缺陷（N-1~N-8），本 spec 逐一闭环：

| ID | 缺陷 | 本 spec 落点 |
|---|---|---|
| N-1 | export 无 import 闭环（.bundle.tgz 无消费路径） | §2.1 `importBundle` |
| N-2 | `loadBundle` 不校验 manifest.name（路径穿越面） | §2.2 |
| N-3 | `exportBundle` renameSync 跨盘/同名冲突异常逃逸 | §2.3 |
| N-4 | installBundle plugin 项 ok:true 虚报 | §2.4 |
| N-5 | use/install 职责重叠（MCP 双路径、use 不装技能） | §2.5 |
| N-6 | xcopy 外部命令依赖（vendoring 复制） | §2.3 |
| N-7 | 测试面薄（5 用例全 happy path） | §4 |
| N-8 | 命令面文档漂移（扩展层 63→70） | §5 |

## 1. 接口与数据模型

### 1.1 新增/变更导出（`src/kernel/bundle.ts`）

```ts
// 从资源引用推导技能目录名（npm 包末段 / github repo 名）——export vendoring 与 install 幂等共用
export const skillDirHint = (ref: string): string;

// 解包树安全校验：深度 ≤3、条目 ≤1000、逐条目 realpath 必须落在 realpath(root) 内
export const validateExtractedTree = (root: string): { ok: boolean; message: string };

// import 全链路（纯本地、零网络）：解包 → 校验 → 同名拒绝 → vendored 技能落位 → 清单落位
export const importBundle = (tgzPath: string, dataDir: string): { ok: boolean; message: string };

// 报告形状变更：新增 deferred 标记（plugin 提示项不虚报成功）
export interface BundleInstallReport { item: string; ok: boolean; deferred?: boolean; message: string }
```

### 1.2 `src/kernel/market.ts` 最小改动

`installSkillDir`（:136，当前 `const`）改为 `export const`——签名不变：
`(srcDir: string, dataDir: string): { ok: boolean; message: string }`（SKILL.md frontmatter name 校验 + staging 原子 rename 落位，目标已存在则覆盖更新——import 沿用市场安装同款语义）。

### 1.3 命令层（`src/commands/ext/sessionCommands.ts` / `src/kernel/commandLevels.ts`）

- `/bundle import <文件.tgz>`：level `confirm`（写 skills 与清单）。
- install/use 汇总改为三段：`✅ <ok 数> · ⏭ <deferred 数> · ❌ <失败数>`（deferred 不计入 ok）。
- `COMMAND_DESC['/bundle']` 文案补「导入」。

## 2. 组件设计

### 2.1 `importBundle(tgzPath, dataDir)`

纯同步、零网络。步骤：

1. `existsSync(tgzPath)` 否 → `{ok:false,'文件不存在：<path>'}`；
2. `mkdtempSync(tmpdir()/'wxn-imp-')` → `tar -xzf <basename>`（cwd=tmp，规避 C:/ 冒号路径坑，同 market.ts:117 手法；timeout 60s）失败 → 清理 + 结构化报错；
3. `validateExtractedTree(tmp)` 不过 → 拒绝（zip-slip 防护）；
4. 有界查找 bundle.json（深度 ≤3，首个命中）→ JSON 解析 + 形状校验 + **name 过 `BUNDLE_NAME_RE`**（与 createBundle 同规则）→ 不过即拒绝；
5. **同名拒绝**：`existsSync(bundlePath(dataDir, name))` → `{ok:false,'整合包 <name> 已存在（/bundle remove <name> 移除或改包名后重试）'}`；
6. `manifestDir = dirname(bundle.json 命中路径)`；`join(manifestDir,'vendored')` 一层遍历：每个含 SKILL.md 的目录 → `installSkillDir(dir, dataDir)`，计数成功数（覆盖语义与市场安装一致）；
7. `mkdirSync(bundleDir(dataDir), {recursive:true})` → 清单写入 `bundlePath`；
8. 报告：`已导入 <name> v<version>：清单落位 · vendored 技能 N 个 · 下一步 /bundle use <name>（应用配置并补齐 MCP）`；
9. `finally` 清理 tmp。

### 2.2 `loadBundle` name 校验

现有形状校验（数组字段）后追加：`typeof m.name === 'string' && BUNDLE_NAME_RE.test(m.name)`，不过 → `{ok:false,'整合包清单损坏：<name>'}`。
一处修复同时保护 `saveBundle`/`editBundle`/`exportBundle`/`useBundle`/`importBundle` 全部写路径（防御纵深，不只堵 import 入口）。

### 2.3 `exportBundle` 加固（N-3+N-6）

- vendoring 复制：`spawnSync('xcopy',…)` → `fs.cpSync(join(skillsDir, nm), join(build, m.name, 'vendored', nm), {recursive:true})`；
- 落位序列：`rmSync(tgz, {force:true})`（重复导出=重新生成，覆盖合理）→ `try { renameSync(join(build, tgzName), tgz) } catch { try { cpSync(join(build, tgzName), tgz); rmSync(join(build, tgzName), {force:true}) } catch { return {ok:false,'打包产物落位失败：<err>'} } }`——**任何路径不抛异常逃逸**；
- EXDEV 回退路径在开发机/CI 无跨盘环境可复现，不强制单测（catch 覆盖 + 结构化报错为可观察契约）。

### 2.4 `installBundle` 幂等跳过 + plugin deferred

- skill 循环前：`const hint = skillDirHint(ref)`；`existsSync(join(dataDir,'skills',hint))` → push `{item, ok:true, message:'已存在本地副本（vendored/先前安装），跳过网络安装'}` 并 continue——**离线导入流中 use/install 不再把已就位技能报成 ❌**；
- 已知局限（诚实口径）：SKILL.md 内 name 与包名末段不一致时 hint 命中不了，走网络安装（覆盖更新语义，无害）；
- plugin 项 → `{item, ok:true, deferred:true, message:'插件不代装：/plugin install <ref>（沙箱/校验契约由 /plugin 持有）'}`；
- 命令层汇总：`ok = reports.filter(r=>r.ok && !r.deferred).length`、`deferred = reports.filter(r=>r.deferred).length`，行图标 `✅/⏭/❌` 三分。

### 2.5 `useBundle` = 配置 + 全量安装

`installBundle({...manifest, skills:[], plugins:[]}, …)` → `installBundle(manifest, …)`（skills+MCP 全量）；settings 并入逻辑不变；`useBundle` message 追加一行资源安装汇总「资源安装 ✅ x · ⏭ y · ❌ z」（可观测性，返回值形状不变 `{ok,message}`）。职责边界：**install = 装资源；use = 开场景（配置 + 装资源）**。

### 2.6 `skillDirHint(ref)` 推导规则

`ref.trim()` 依次：去 `npm:` 前缀 → 去 `github:<owner>/` 段 → `split('/').pop()`。与 exportBundle 现有 vendoring 推导（bundle.ts:110-115 内联逻辑）完全一致，抽为公共函数消除两处重复。

## 3. 错误处理与安全

- 所有新入口一律返回 `{ok,message}`，不抛异常（try/finally 清 tmp）；
- import 的信任边界：tgz 是**不可信输入**——三道校验（树逃逸 → 清单形状 → name 正则）任一不过即拒绝，先校验后落盘；
- 解包炸弹防护：深度 ≤3、条目 ≤1000（沿用 market.ts walkForSkillMd 的深度哲学）；
- `installSkillDir` 复用保证技能落位与市场安装同款原子性（staging + rename，绝不写半目录）。

## 4. 测试策略（TDD，扩展 `tests/kernel-bundle.test.ts`）

新增用例（沿用 `okDeps` 注入 + `mkdtemp` 沙箱）：

1. `importBundle：export→import 往返`——建包→export→清空 bundles/skills→import→清单落位 + vendored 技能落位 + ok:true；
2. `importBundle：同名拒绝`——二次 import → ok:false、message 含「已存在」；
3. `importBundle：manifest name 穿越拒绝`——手工构造 name=`../../evil` 的 tgz → ok:false、无任何越界写入；
4. `importBundle：解包树逃逸拒绝`——tmp 内放 `symlinkSync(outside, 'junction')`（Windows 免提权）→ `validateExtractedTree` ok:false；
5. `importBundle：tgz 不存在诚实报错`；
6. `useBundle：全量安装（skills 透传证明）`——预置 `data/skills/<hint>` 后 use：fetchImpl 调用计数 **===1**（仅 MCP；技能走本地跳过 ⇒ 证明 skills 已透传给 installBundle，否则计数为 0）+ .mcp.json 落位 + settings 并入 + message 含「✅」汇总行（真 tar 落位的 e2e 由 kernel-market.test.ts 既有「真实 tar 解包落位」覆盖，不重复）；
7. `installBundle：本地已存在技能跳过网络`——预置 `data/skills/<hint>` → fetchImpl 抛错也不触发 → report ok:true 含「已存在」；
8. `installBundle：plugin deferred 标记`——deferred:true 且不计入 ok；
9. `loadBundle：name 非法拒绝`——手工写 `../../evil` 清单 → ok:false；
10. `exportBundle：重复导出覆盖旧 tgz`——同 outDir 二次 export → ok:true、产物存在且内容为最新。

既有 5 用例回归不动。全量门禁：`npm run ci` 九步 + 远程 CI 绿。

## 5. 文档回写（N-8）

- `docs/cli-deep-analysis-score-2026.md` §9.5：「扩展 63 条」→「扩展 70 条（2026-08-19 实测：SLASH 117 = 主干 47 + 扩展 70）」；
- `docs/defect-register-2026.md` A-01 行同步；
- `tests/commands-slim.test.ts:2` 头注释同步；断言保持恒等式不变（数字随命令增减漂移是常态，钉死数字会造成每加一条命令都改测试——采用注释口径）。

## 6. 范围外（明确不做）

- ⑧ 公开分发（winget/scoop 上架）——卡「转公开」用户决策；
- ③ 输出侧终端图片渲染（Windows ConPTY 无成熟协议，另立调研项目）；
- C-02 wxGateway 拆分（已评估维持）；
- `/bundle import` 的网络 MCP 自动安装（import 仅本地资源落位；MCP 经 `/bundle use`/`install` 装取）；
- bundle 内资源版本锁定/升级比对（YAGNI）。

# 规格：wxnodus 生产级完善总体规划（2026-08-19）

> 状态：规划已获用户确认（2026-08-19）。
> 用户三项决策：① 仓库**暂不公开**（先打磨，转公开时机另行决定）；② 安装形态 = **自包含 zip + 一键脚本**；③ 范围 = **全量**（分发闭环 + 缺陷清零 + ③ 图片渲染 + A2A 完整版）。
> 设计决策：包内**不捆绑 node.exe**（Node 22 为唯一前置，缺省给官网/国内镜像一步指引）。
> 评分口径：公开前 **931 维持**（⑧ 5→9 的 +36 卡公开决策）；本轮交付「转公开即可一键兑现」的全部前置 + 真实可用的私有渠道安装体验。
> 代码锚点基于 HEAD 613d6a0。

## 0. 背景（八评 + 合规审计产出）

用户痛点：其他电脑 cmd 里拉 GitHub 链接下载安装使用做不到，还要自己到处配置——即 ⑧ 分发/安装/首启体验为空白。合规审计（2026-08-19 四路取证）另产出：F1-F4 功能缺陷、41 个死代码文件、本机 data/nodus.db 三元组损坏（环境事故）、/bundle N-1~N-8 缺陷（已有独立 spec `2026-08-19-bundle-closure-design.md`）。本 spec 是四阶段的**总体规划**；每阶段执行前再出逐任务实现计划（writing-plans）。

## 1. 阶段 1：生产级分发闭环（P0）

### 1.1 安装包打磨（基于 W6 管线既有产物）

- 产物形态不变：自包含 zip（dist + node_modules + 原生二进制，**免 VS Build Tools**；既有 rc 包 138.8MB / 5673 文件，manifest 全量 sha256 绑定 + install.ps1 安装前全量校验 + -Uninstall 按 journal 卸载——`packaging/`、`src/application/release/*`）。
- install.ps1 强化项：
  1. **Node 22 检测**：`node -v` 缺失/版本不符 → 一步指引（nodejs.org 官方 + npmmirror 国内镜像两条命令），非零退出诚实报错；
  2. **幂等重装**：已装同版本 → 提示「已是最新/重装覆盖」；journal 追加而非重建；
  3. **PATH 写入**：用户级 PATH（`[Environment]::GetEnvironmentVariable('Path','User')`），去重；
  4. **`wxnodus.cmd` shim**：安装目录生成，内部 `@node "<dir>\dist\cli\index.js" %*`；
  5. **数据目录注入**：shim 内设 `WXNODUS_DATA_DIR=%LOCALAPPDATA%\wxnodus`（安装版=生产级惯例；便携版 zip 直跑保持就近 data——双形态不打架，DX-01 `--data-dir` 解析优先级不变）。

### 1.2 三源安装（私有仓库下的主路径 = 本地分发）

- **源 A（主）本地/局域网/U盘 zip**：`install-local.bat` 双击向导——同目录/同盘查找 `wxnodus-*.zip`（唯一命中直装、多命中列表选择、零命中提示下载路径），随后调 install.ps1；
- **源 B 任意 URL**：`install.ps1 -Url <https://…>`（下载 + sha256 校验走 manifest）；
- **源 C 私有 GitHub Release**：`install.ps1 -GitHub <repo> [-Tag v3.1.0]`——探测 `gh auth status`（已登录 → `gh release download`）；未登录给出一步指引（`winget install GitHub.cli` → `gh auth login` 或粘贴 PAT）。Token 不落盘、不内嵌。

### 1.3 零到处配置（首启引导强化）

- 既有 `src/application/bootstrap/preBootstrapOnboarding.ts`（语言引导）扩展为四步流：语言 → 模型（目录探测 + 默认 deepseek-chat）→ 密钥（/model set-key 表单复用）→ 代理（**GitHub 连通性探测**：不通则建议 /proxy 或国内镜像说明）；
- 安装版首启数据目录 = `%LOCALAPPDATA%\wxnodus`（shim 注入）；卸载保留数据目录并明示路径（不删用户数据）。

### 1.4 更新通道

- `/update`（`handlers.ts:320`）五渠道探测已有——接入真实检查：源 C 安装时记录 `install_source` 到 settings；`/update` 按源类型走 `gh release view`（私有）或 URL HEAD（源 B），发现新版 → 提示「下载新 zip 重跑 install.ps1（幂等覆盖）」；无法探测时诚实说明。

### 1.5 打包门禁接线（修复「验证器没人调用」）

- 合规审计发现：`installerPackager.ts`/`dependencyClosure.ts`/`manifestGen.ts`/`installerCandidate.ts` 仅测试引用，生产打包（`scripts/package-installer.ts`、`freeze-candidate`）未走这些验证器。
- 接线：`package-installer.ts` 产出 zip 后强制跑 `dependencyClosure`（闭包完整）+ `installerCandidate` 候选校验 + manifest 全量 sha256 绑定，任一失败 → 打包失败 exit 2（fail-closed）。

### 1.6 验收场景

全新 Windows 环境模拟「其他电脑」：干净 PATH → 拷贝 zip + install-local.bat 双击 → 装完 `wxnodus --version` / `wxnodus -p "/status"` 可用 → /update 探测诚实 → 卸载 → 数据保留。

## 2. 阶段 2：功能缺陷 + 工程债清零

| ID | 项 | 处置 |
|---|---|---|
| F1 | `/config export\|import` 被二次注册遮蔽（`profileMemoryBuildCommands.ts:149` vs `:1048`） | 合并为一个 handler：export/import 分支并入 1048 版（保留 set/view + 未知键警告 + B-05 分层展示）；分级表两键恢复真实分发 |
| F2 | 分级键错配 3 处：`/skill install`（无分支）、`/acp serve`（判 `server`）、`/webhook del`（判 `remove`） | 措辞对齐实际分发分支（改分级键为实际判定的词，或补分支——按「改动最小 + 契约测试」原则逐项定） |
| F3 | `scripts/audit-features.mjs` restore() 对 db/wal/shm 分离拷贝 → 已损坏本机 data 三元组 | 脚本改 `--data-dir` 临时目录运行（不碰开发数据）+ 弃 copyFileSync 改用 WAL 一致备份 API（`src/migrations/db/backup.ts`）；**本机 data 修复**：停持库进程后删陈旧 wal/shm（主库副本验证完好）——执行前需用户确认 |
| F4 | openDB 失败根因被 configError 二次包装吞掉，无恢复指引 | `cliComposition.ts:328` 透出真因 message + `db.ts openDB` catch：损坏/锁忙时输出「数据库不可用：<真因>；恢复：/backup 内副本 或 删除陈旧 -wal/-shm 重试」指引；恢复链路复用 `restoreDbFromBackup` |
| C | 死代码 41 文件 | 10 个零引用直删（`f7ecabd` 删 vimKeys 先例）；31 个仅测试供养模块逐项决策「接入组合根（release/build 验证层优先）/ 降级 tests/fixtures / 删除」，决策表入 audit |
| B | /bundle 修复闭环 N-1~N-8 | 按已批 spec `2026-08-19-bundle-closure-design.md` 执行（import 闭环/name 校验/rename 加固/幂等跳过+deferred/use 全量/cpSync/测试补面/文档回写） |
| D | 文档口径回写 | 扩展层 63→70（score §9.5 / register A-01 / commands-slim 头注释）；vimCore.ts:10 注释「仍无 / 搜索」与实现对齐；apply_patch 13→14 用例数 |

## 3. 阶段 3：能力面补全

### 3.1 ③ 输出侧终端图片渲染（先调研后决策，不盲做）

- 调研判据（写调研记录入 docs）：Windows Terminal 1.22+ sixel 实验性支持现状；ConPTY 对 sixel/kitty 协议的透传能力；codex（宠物图）/crush（内联图片）的实际协议与平台限制；wxnodus-ink 渲染层接入点成本。
- 决策分支：可行 → sixel 实验通道（检测终端能力，不支持诚实降级为「图片已存至 <路径>」文字）；不可行 → 如实归档（③ 8 判词维持，记录证据）。

### 3.2 A2A 完整版

- 现状 91 行子集（`src/kernel/a2a.ts`）→ 完整：agent card（能力/skills 声明）、任务流（sendMessage/getTask/push 通知）、stdin/HTTP 双传输；对标 gemini 独立 a2a-server 包（**参考机制不抄代码**，AGENTS.md 约束在案）；⑦ 已 10 满格——本项是协议面加固，不计分。

## 4. 阶段 4：收尾与转公开就绪

- ⑨ **维持 9**（判词在案：已与 codex 同档；冲 10 无对标，不硬冲——诚实）；
- winget/scoop manifest **终审就绪包**：既有模板（`packaging/`）过审一遍 + `docs/release-checklist.md`（转公开 checklist：仓库 Settings → Release 资产上传 → winget PR → scoop bucket 提交），转公开当日一键兑现；
- 全量回归 + 远程 CI + 阶段 1.6 验收场景复跑；
- audit-deep.md 增补本轮条目（F1-F4/C 类/分发闭环），defect-register 同步。

## 5. 评分与边界（诚实口径）

- 公开前 **931 维持**：⑧ +36 卡公开决策；③ sixel 若落地 → 公开后复评 ③ 8→9（+8）；其余为加固不计分。
- 范围外（明确不做）：云端分享（S-05 不可为）；wxGateway 拆分（C-02 已评估维持）；⑨→10（无对标）；macOS/Linux 沙盒（Windows-only 决策在案）。

## 6. 风险与协调

- **并发会话**：本仓有另一 ZCode 会话在活跃开发（本轮评估期间提交了 ea6c668/fc5071d 等）。每阶段执行前 `git status` 确认工作树；阶段 1 触及 packaging/install.ps1 与 scripts/，阶段 2 触及 commands/ 与 db.ts——若对方同区动工，先协调再动。
- **本机 data 修复**：删 wal/shm 属用户数据操作，执行前单独向用户确认。
- **Node 前置**：不捆绑 node.exe 意味着 Node 仍是唯一前置——1.1 的一步指引是此决策的兜底承诺。

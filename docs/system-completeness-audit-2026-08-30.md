# wxnodus 系统完善度审计（内核 / TUI / SDK / 开放性 · 2026-08-30）

> 取证基线：wxnodus4.0 工作区（批次 ⅩⅩⅢ 收口：全量 **3076 测试通过 / 0 失败**，
> mock e2e 15/15，PTY 冒烟 5/5，lint/cycles/test-discovery 门禁全绿）。
> 本文回答用户三问：① TUI 剩余缺陷是否修复 ② 「网络下载后独一无二」开放性是否落地
> ③ 私有化 SDK 与内核/TUI 体系是否完善——每项带实现锚点与诚实缺口。

---

## 一、规模与验证快照

| 项 | 现状 |
|---|---|
| src | 475 文件 · 6.09 万行（内核 kernel + 应用层 application + 组合根 bootstrap + TUI + serve 网关等） |
| 测试 | 685 测试文件 · 3076 用例全绿（16 skipped 为环境门控硬件项） |
| 真机资产 | PTY 冒烟（scripts/tui-pty-smoke.mjs · 5 断言）· mock 模型 e2e（scripts/tui-e2e-mock.mjs · 15 断言：流式/排队/注入/审批/计划/回滚/降级） |
| 包 | wxnodus（主 CLI）· @wxnodus/sdk · @wxnodus/core · packages/vscode-ext · wxnodus-ink（fork） |

## 二、TUI 剩余缺陷（本轮销项）

| 原缺陷（design-eval 2.4） | 状态 | 实现 |
|---|---|---|
| 无 bracket-paste（粘贴靠 <40ms 突发启发式） | ✅ T76 | `src/tui/paste.ts`：DECSET 2004 + 标记剥离 + 块内 \r 归一 + 25ms 悬挂超时（单独 Esc 不被前缀卡死——e2e 抓获修复）+ 老终端回退启发式（双路） |
| 浮层行数预算静态估计（窄终端可能超窗） | ✅ T79 | `overlayRows(kind, rows)` 封顶 + `overlayListMax` 三长列表面板钳制 + 面板长行 `fit()` 硬截断 |
| Enter→Tab 0ms 合成时序 | 记录在案 | 非缺陷（人类间隔 >150ms 不受影响） |
| /voice /paste 正向路径依赖真硬件 | 记录在案 | 失败路径已 e2e 验证诚实降级；正向路径需真麦克风/剪贴板图 |

**TUI 体系结论：完善。** 59 场景原型覆盖矩阵中 57 场景已落地（媒体工坊 35 / 旅程剧场 57 为
设计演示特性，fence 诚实标注）；34 项自完善缺陷修复 + 本轮 4 项；钉底布局经 80×24/120×30/
40 列/24 行多档真机验证。剩余诚实缺口：无鼠标支持（键位驱动——记录在案，非阻塞）。

## 三、开放性：「网络下载后独一无二」（T77）

**机制**：首启在 dataDir 生成一次性 `instanceId`（离线随机 UUID——绝不联网登记，符合
「数据不出机」红线）+ 确定性派生人类可读代号（`src/kernel/instanceIdentity.ts`：
16×16 中文词表 + 哈希序列码，如「御风·工匠 DADB」）。每份下载（不同 dataDir）身份互异；
同份重启稳定（原子落盘 instance.json，损坏诚实重建）。

**透出面**：
1. TUI 品牌行 + 欢迎语：未手工命名时代号生效；`/brand set` 用户名完全胜出（手工层 > 自动层）；
2. `/status` 身份行（代号 + instanceId 前 8 位 + 「本机唯一」）；
3. `/brand show` 如实显示生效名；
4. SDK 握手行 + `identity` RPC（程序化识别面）。

**开放性分层**（用户可组合）：皮肤文件（`<dataDir>/skins/*.json`）· 主题四色板 · `/brand` 命名 ·
实例代号（自动层）· `/model add` 任意 OpenAI 兼容端点 · /bundle 整包分发。

## 四、私有化 SDK（T78）

| 面 | 现状 |
|---|---|
| 模型 | spawn-attach 本地网关（`wxnodus --serve --sdk`）→ stdout 单行握手（随机端口+随机 token，管道私有即安全边界）→ `rpc()` + `events()` SSE → `stop()` 托管退出。零云端：仅绑 127.0.0.1，凭据生命周期=子进程生命周期 |
| RPC 面 | chat · command · memory.search · memory.recall · sessions · **identity（新增）** · approval.respond（审批闭环 G-6）|
| 发布产物 | **TS 源码 → dist 编译产物**（main/types/files 指向 dist；根 `build:sdk` 进 build 链；publish-local 发布前构建防旧产物上 npm） |
| 实例身份 | 握手回传 instanceId/codename（可选字段=协议兼容；PROTOCOL_VERSION=1） |
| 集成测试 | tests/sdk-client.test.ts 真实子进程链（握手/rpc/SSE/stop + 身份断言，随 dist 构建门控） |

**私有化语义**：`--data-dir` 即隔离边界——同一机器多份安装身份互异、数据互不可见；
密钥 AES-256-GCM 本机加密（明文绝不落盘）；无任何遥测/云端组件。

## 五、内核体系完善度

**结论：完善（按 3000+ 用例与能力面取证）**：
- **执行内核**：agent 回合循环（流式/工具面/审批/子代理 delegate·swarm·duo/串行队列/中断/steer/
  压缩三选/计划模式零工具硬闸/重连退避 agent.retry/reset 契约）；
- **记忆**：三层（working/archival/recall）+ FTS5 中文 bigram + sqlite-vec 向量 + 检索单一实现；
- **命令面**：63+ 命令注册 + 分级白名单（kernel-commandLevels 门禁钉全量覆盖）+ ext 扩展目录；
- **安全**：权限模式 + 硬红线 + SSRF 三层防护 + sudo/secret 通道 + Low IL 沙盒 + 审计链；
- **回滚**：/undo 双路（消息软归档 + 文件快照 undo-undo）+ checkpoint；
- **确定性工具**：exec/apply_patch/LSP/computer use（robotjs+playwright）；
- **诚实性**：doctor 自检/降级路径/门禁（lint 内核层 exit 红线/测试发现检查/需求覆盖检查）。

**剩余诚实缺口**：图像生成后端（媒体工坊 35 fence）；kitty 内联图像渲染（conhost 无图像协议——
降级档即设计）；生态/质量面第三方深度对标评估未在本轮展开（08-27 版竞品对比仍为基线）。

## 六、复核清单（用户目标 → 证据）

| 目标 | 证据 |
|---|---|
| 修复 TUI 剩余缺陷 | T76/T79 落地（§二）· 全量 3076 绿 · e2e 15/15 · PTY 探针 7/7（含 Esc 悬挂根因修复回归） |
| 下载后独一无二 | instanceIdentity 6 用例 + PTY 真机首启代号显示 + /status 身份行 + SDK 身份面 |
| 私有化 SDK 完善 | dist 产物链 + identity RPC + 握手身份字段 + 集成测试断言（§四） |
| 内核/TUI 是否完善 | 完善度结论 + 诚实缺口清单（§二/§五） |

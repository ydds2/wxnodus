# 提高 AI 生产质量与自主能力的提案

> 本文是 WxNodus V3→V4 目标要求的独立产出：回答「如何提高 AI 生产质量（production quality）与自主能力（autonomy）」。
> 全部方法均已在本文档对应代码中落地或已给出落地路径——每一条都标注「已落地」或「待推进」，不含未验证的空谈。

## 一、生产质量：把「信任」换成「可验证」的七条纪律

### 1. verifier 化验收：每个承诺都有一条可执行的验证器（已落地）

W3-01 建立了 16 个内置 verifier（`command.exit-code`→`human.approval`）与 `createBuiltinVerifierRegistry`。生产质量的第一个前提是：**验收标准必须是结构化、可执行、可复跑的**，而不是「看起来完成了」。

- `AcceptanceCriterion`（W3-07 `src/domain/build/acceptance.ts`）强制 required 标准携带 `verifierId + expected + evidenceRequirements`——缺任一字段即 `BUILD_SPEC_INVALID`。
- 提升方法：新功能开发的 Definition of Done 一律先写「验收 verifier」，再写实现；CI 只认 verifier 输出，不认口头确认。

### 2. 证据闭合与篡改检测：failure 不允许藏在 exit 0 / HTTP 200 后面（已落地）

- `EvidenceService.close()` 生成 `closure: { status: 'closed' }` 的 EvidenceRecord；`FileEvidenceStore` 重读实际字节校验 sha256/长度（`EVIDENCE_INTEGRITY_FAILED`），manifest 根摘要防篡改。
- `CompletionGate` 只消费闭包证据：未闭包 → `blocked/COMPLETION_EVIDENCE_NOT_CLOSED`，绝不进入 required-criterion pass 集合。
- `completionTransport` 共享表把六个终态精确映射到退出码/HTTP 状态/wire 终态（succeeded=0/200，failed=1/422，blocked=2/409，incomplete=3/424，inconclusive=4/503，cancelled=130/499），四个入口共用一张表（`src/protocol/completionTransport.ts`），漂移即 `FRONTEND_FAILURE_PROPAGATION_MISMATCH`。
- 提升方法：**诚实比成功更重要**——把「失败」建模为一等公民（blocked/incomplete 与 failed 区分），任何自动化系统在证据不足时必须说 inconclusive，而不是伪造 succeeded。

### 3. 信任模型最小化：WeakSet 收据 + 无 trusted 字段（已落地）

- W1-09 的信任边界贯穿全层：`FileEvidenceStore.owns(receipt)` 只认本实例签发的 receipt（WeakSet），authority 只是审计元数据，**从不引入 `trusted: true` 字段**——因为 caller-assignable 的信任字段是伪造入口。
- 提升方法：任何「上游可信」的假设都改写成「本进程实例签发 + 重读校验」；权限/信任字段一律不可由调用方赋值。

### 4. 授权作用域哈希 + 单次使用（已落地）

- 高影响动作（external-send/delete/payment/publish/system-config）的授权请求做 canonical JSON 的 sha256 绑定全部参数；grant 参数漂移 → `APPROVAL_GRANT_SCOPE_MISMATCH`，重放 → `APPROVAL_GRANT_REPLAYED`；急停复位需要全新 grant。
- 提升方法：所有「用户已批准」的判断都必须是**作用域绑定 + 单次消费**的，而不是布尔记忆。

### 5. 每次动作重证边界：fail-closed 的 driver（已落地）

- `WindowsUiaDriver.act()` 在**每个动作**（不只初始化）前重证 interactive/unlocked/`Default` input desktop/完整性/受保护 UI；Secure Desktop、UAC、锁屏、高完整性目标一律 `blocked`，且**禁止坐标 fallback**（`UIA_COORDINATE_FALLBACK_FORBIDDEN`）。
- `UrlPolicy` 对初始导航/每次请求/重定向/弹窗都解析全部 A/AAAA 并拒绝 loopback/private/link-local，`verifyConnectedAddress` 防 DNS rebinding。
- 提升方法：**安全边界不做会话级缓存**——环境在动作间隙可能已恶化（用户锁屏、桌面切换），任何长寿命特权路径必须逐动作重证。

### 6. 真实进程替换与读回（已落地）

- `BuildVerificationCoordinator.verifyRestart()` 证明：写数据 → 停树 → **端口释放** → 新进程（ID 必须不同，否则 `BUILD_RESTART_REUSED_OLD_PROCESS`）→ 读回同一数据（`BUILD_READBACK_MISMATCH`）。
- 提升方法：部署/重启验证的标准模板 = 「写 → 停 → 释放 → 起新 → 读回」，四项缺一不可。

### 7. 遗留路径断电（已落地）

- `legacyGuard.ts`：入口层（handlers/handlersExt/kernel/tools/wxGateway）不再直接构造/执行遗留驱动，全部经 compat 委托；`setLegacyPathsEnabled(false)` 后任何直接构造在驱动加载前抛 `LEGACY_PATH_DISABLED`。
- 提升方法：重构时保留「整层断电开关」——它能证明新层是唯一真实路径，而不是新旧并存的双写。

## 二、自主能力：让 agent 能安全地「自己跑」的四条机制

### 1. 预算治理的 15 维逐维限额（已落地）

- `ALL_BUDGET_DIMENSIONS`（token/cost/wallclock/turn/tool/retry/depth/fanout/concurrent-agent/network/external-writes/browser-desktop/screenshot/files/bytes）。
- 子代理继承时逐维 `min(parentRemaining, requested)`；grant/tool/file/secret scope 只能收窄（`narrowScope`）。
- 提升方法：自主 = 有界。任何 agent 循环都必须在**每一维**上有明确上限与剩余额跟踪，维度间不可互相挪用。

### 2. 六类稳定停滞检测（已落地）

- `ProgressDetector` 检测 `NO_STATE_CHANGE / REPEATED_ACTION / REPEATED_ERROR / NO_NEW_EVIDENCE / PLAN_OSCILLATION / BUDGET_STAGNATION`，计数器经 SQLite 持久化跨重启续算（`progress_detector_state`）。
- 提升方法：agent 卡死的最常见形态不是崩溃，而是「一直在动但没有任何进展」——用**证据增量**（evidenceDelta）而不是活动量来衡量进展。

### 3. lineage 恢复：lease CAS + 三稳定决策（已落地）

- `RecoveryService.recover()`：lease 未过期 → `RECOVERY_LEASE_ACTIVE`；过期先 CAS `orphaned`（并发恢复只有一个赢家），校验 worktree/base/head/owned-file 与 evidence 后只返回 `resume-from-checkpoint / reconcile-worktree / manual-review` 之一；恢复创建新 Attempt，旧 Attempt 不改写。
- 提升方法：恢复逻辑的复杂度必须收敛到**有限个稳定决策**，否则恢复路径本身会成为新的失败源。

### 4. 取消语义：先 fence 后 abort（已落地）

- `SubagentHost.cancel()` 沿 lineage 先 fence（禁止新 effect）再 AbortSignal，并等待 host stop receipt（`SUBAGENT_STOP_FAILED` 当树未退出）。
- `VoiceSessionService.transcribe()` 与 PTY/构建 workers 全部接受 AbortSignal 且经 `terminateTree` 确认进程树退出。
- 提升方法：可取消性不是「发个信号就完事」——必须验证**进程树确实退出**，否则僵尸 worker 会在取消后继续产生副作用。

## 三、面向后续迭代的推进清单（待推进）

1. **模型层质量环**：把 W3-01 verifier 接入 agent 的自我修订循环——每轮 turn 后自动跑一个轻量 verifier 集，失败即进入下一轮并携带证据（当前 verifier 已就绪，缺 agent 侧接线）。
2. **预算感知的 prompt**：把剩余预算（token/turn/retry）注入 system prompt，让模型在接近限额时收敛而不是硬断。
3. **证据驱动的训练反馈**：把 `CompletionGate` 的 criterionResults 落库为标注数据（哪些 verifier 经常 inconclusive），用于回灌提示词与工具设计。
4. **多级人工介入**：human.approval verifier 已存在；下一步接动态表单（`credential.form` 已有）实现按风险分级的人工闸口。
5. **跨 OS 真实验收常态化**：W3-10 的 Gate E 双 OS-keyed receipt 机制已落地；**用户已裁定列入后续 wave（2026-08-13）**——本机实测 blocked（单一 `\\.\DISPLAY1` 1536x864、无物理麦克风、无 .NET SDK、OS build 26200 不在 24h2/22h2 基线内），机制诚实产出 blocked receipt 绝不伪造；受控 runner 的一键执行命令与前置清单见 `docs/blueprint-drift-checklist.md` §10-6。

## 四、一句话总结

> 生产质量的本质是**可验证**——把验收变成 verifier、把结果变成闭包证据、把失败变成一等公民；
> 自主能力的本质是**有界**——预算逐维限额、停滞稳定检测、恢复稳定决策、取消确认退出。
> 两者共同的前提是：**任何自动化系统都必须在证据不足时诚实地说 inconclusive，而不是伪造 succeeded。**

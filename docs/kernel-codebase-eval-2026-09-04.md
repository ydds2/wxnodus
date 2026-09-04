# wxnodus 4.0.2 内核 / 全代码 / 设计评估 与同类 CLI 差异缺陷说明（2026-09-04）

> **注**：本文为当日早盘版本；当日收尾时的全面重评（含 B1/B3 落地后状态、四路取证子代理、3031 用例基线、竞品增量）见 `docs/eval-4.0.2-comprehensive-2026-09-04.md`（本报告以之为主）。

> **取证基线**：本报告全部结论锚定于 2026-09-02 至 09-04 的真实运行证据（本会话工具结果）：
> 2937 用例全量测试绿（09-02）→ 经六轮迭代后 **216 用例受影响面回归绿（12 文件）**；
> TUI 45+ 项真机断言；`/watch` 视频流真机捕捉（gdigrab 19 帧/OCR/mp4 证据 sha256）；
> NCC 模板匹配真机 1.0000；`/modpack` 真机安装/兼容拒绝；`/channel` 双渠道真机选版；
> 卡死处置（24 孤儿进程）；MCP 30 进程 1.3GB 实测；registry 三表 126=126=126 审计。
> 竞品对照以 `docs/eval-vs-competitors-2026-08-27.md`（六家克隆取证）为基线，叠加本轮增量。

---

## 1. 内核评估（分层，全部有实测证据）

| 内核域 | 评分 | 证据锚点（本会话实测） |
|---|---|---|
| 流式与回合工程 | **A** | mock SSE 全链路 15/15；wire 五事件流 + wireFinal 终态比对；Esc 暂留/清空/Ctrl+S steer 真机 |
| 记忆（黑洞） | **A** | FTS5 中文 bigram + 向量混合；`/hole --all` 跨会话召回真机；watch 段摘要入记忆实测 |
| 安全与审批 | **A** | AES-256-GCM 密钥无明文实测；SSRF loopback 拒绝契约锁定；审批 allow/deny/session 三态；模式选择器 + yolo 脚枪修复；hard redline 分级展示 |
| 命令注册表 | **A-** | SLASH/DESC/CAT 三表 126=126=126 零漂移（审计脚本）；单一事实源驱动 TUI/手册/compat/MCP |
| 更新与分发 | **A-** | 自升级链（sha256+回滚）契约；**新增 version manifest 双渠道**（真机选版）；modpack 兼容矩阵+防篡改；扣分：feed 默认未配置 |
| 协议面 | **A** | MCP stdio/HTTP 握手真机；ACP initialize；serve Bearer 401 实测；wire 双向 RPC；OASIS 门户（status/health 真机探活） |
| 视觉/屏幕 | **B+** | `/watch` 视频流（环缓冲/分段/mp4 证据）真机；NCC 匹配真机满分；OCR 真机识别屏幕文本；**ddagrab 代码+契约就绪，真机受环境限制**（D3D11 设备创建失败——auto 回落 gdigrab 实测生效）；**本地 VLM moondream2 代码+契约就绪，模型下载受网络限制**（镜像端点已支持） |
| 可靠性工程 | **A** | 原子构建交换（SWAP_DIST_OK——dist 永不失窗）；watch 启动判定「收到真实帧才算成功」；FFMPEG_MISSING/NO_FRAMES/EXITED 三态诚实失败 |

**内核总评**：可靠性/安全/协议三域已是品类第一梯队；视觉域的「代码完备度」超前于「环境可验度」——两处环境阻塞（ddagrab D3D11、HF 下载）均有诚实降级与镜像/换构建出路，非代码缺陷。

## 2. 全代码 / 设计评估

### 2.1 设计优点（值得保留的架构决策）

1. **单一事实源纪律**：registry 三表 → TUI 菜单/帮助/手册/compat/MCP 全派生，零手工复制目录（63 命令漂移类缺陷结构性杜绝）。
2. **诚实文化成为可执行契约**：FFMPEG_MISSING/OCR 失败/VLM 失败/ddagram 回落/无审批桥 fail-closed——每一条都在测试里锁定「绝不假装」。
3. **原子性无处不在**：dist 原子交换、插件 staging+rename+回滚、modpack 落位回滚、instance.json 竞态回读。
4. **分层清晰**：kernel（纯逻辑/无 UI）→ commands/ext（命令面）→ tui（渲染）→ cli（组合根装配）；新功能（oasis/watch/modpack/channel）全部走 ext 模块 + 三表 + 契约测试同一范式。
5. **测试三层**：纯函数契约（NCC/semver/manifest）→ 命令契约（vi.mock 内核面）→ 真机夹具（假 ffmpeg 视频流/真实桌面捕捉/本地 manifest feed）。

### 2.2 设计缺陷与残留（诚实清单，按严重度）

| # | 严重度 | 问题 | 状态 |
|---|---|---|---|
| D1 | 中 | **无密钥 `-p` 退出码语义**：exit 0 + `ok:true/status:"succeeded"`——脚本无法区分真答案与未配置指引 | 未修（建议 P0） |
| D2 | 低 | `--help` 头仍是「WxNodus V3」；package.json description 同 | 未修 |
| D3 | 低 | README「算一下 2+3*4」行未标注 `WXNODUS_LEGACY_OFFLINE=1`（默认走 AI 层） | 未修 |
| D4 | 低 | `--help` 用法表缺 `--data-dir/--workspace/--output-schema/--ephemeral/--lang` 等已实现旗标 | 未修 |
| D5 | 低 | `/model` 目录仍含已裁撤的 `offline:Qwen2.5-1.5B` 行 | 未修 |
| D6 | 低 | 更新 feed 默认未配置——用户拿不到升级通知（`update --check` 诚实报无源） | 未修 |
| D7 | 环境 | ddagrab 真机捕捉：本会话环境 D3D11 设备创建失败（auto 回落 gdigrab 实测） | 记录（换 ffmpeg 构建/原生 addon 可解） |
| D8 | 环境 | moondream2 模型下载：huggingface.co 超时；hf-mirror.com 已恢复 200（见 §4） | 重试中 |

## 3. 同类 CLI 差异对比（六家基线 + 本轮增量）

| 维度 | wxnodus 4.0.2（本会话实测） | codex | gemini-cli | opencode | kimi-cli | crush | aider |
|---|---|---|---|---|---|---|---|
| 交互 TUI | ✅ Ink 6 重建（8-27 矩阵「无 TUI」行作废）：三页帮助/选择器/审批/回滚面板全真机 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ REPL |
| **常驻屏幕视频流** | ✅ **`/watch`：ffmpeg 实时捕捉→帧环缓冲→场景分段→模板任务链→mp4 回放证据（sha256）**——六家无此形态（竞品为截图轮询/一次性操作） | — | — | — | — | — | — |
| **组件注册表/探活** | ✅ `/oasis status|health|topo`（MCP 任意语言组件真实 initialize 探活） | 部分（app-server） | — | 部分 | — | — | — |
| **Mod 整合包** | ✅ `/modpack`：兼容矩阵/sha256/原子回滚/一键安装（Minecraft modpack 语义） | — | — | — | — | — | — |
| **版本双渠道** | ✅ snapshot/release 列车 + manifest 选版（真机） | — | — | — | — | — | — |
| 长期记忆 | ✅ 三层 + FTS5 中文 + 向量（竞品唯一检索式） | 两阶段抽取 | 文件+人工 | — | — | — | — |
| 密钥安全 | ✅ AES-256-GCM + 无明文实测 | keyring | keytar | **明文 auth.json** | keyring | env/op | .env |
| 诚实降级 | ✅ 品类独有：voice/paste/FFMPEG/VLM/OCR 全部诚实失败实测 | — | — | — | — | — | — |
| 实例身份 | ✅ 本机唯一代号（英文可迁移）——「网络下载后独一无二」 | — | — | — | — | — | — |
| 测试纪律 | ✅ 2937→216+ 用例/门禁/ratchet（七家密度之首） | ~581 文件 | 大 | 643 | 218 | 212 | 32 |
| Windows 深度 | ✅ 三档终端/winSandbox Low IL/OCR/UIA/robotjs | 一等 | 较好 | 部分 | git-bash | 一等 | 弱 |

**本轮后的差距变化**：8-27 报告「产品形态 C（唯一无 TUI）」已收敛；新增 watch/oasis/modpack/channel 四个竞品空白形态。**剩余差距**集中在：① 生态广度（VS Code 插件薄、无桌面端）② 脚本可编程语义（D1）③ 文案一致性（D2-D6）④ 分发渠道（npm 待上架、feed 未配）。

## 4. 本轮双线验证进展（环境层）

- **ddagrab（P2.2 代码）**：后端选择 + auto 回落 + 显式失败语义全部落地（契约 13/13）；真机 auto 回落 gdigrab 捕捉 16 帧 + mp4 证据正常——ddagrab 真机受本会话 D3D11 环境限制（原始错误「Selected output not supported」已留档）。
- **VLM（P2.1 真机）**：网络诊断——huggingface.co 超时、**hf-mirror.com 已恢复 200**；已带镜像端点重跑真实下载+推理（后台进行，结果以任务完成通知为准）。

## 5. 建议（分级）

- **P0（半小时级）**：D2/D3/D4 文案三件套 + D1 无密钥退出码语义 + D5 offline 行治理 + D6 默认 feed。
- **P1**：心跳默认化 + 孤儿体检（8/30 事故教训）；bash 进程树回收；`/mcp list` 资源列；PTY 测试进 Windows CI；wire 协议版本化。
- **P2**：OASIS M3 bridge/M4 trace/M5 面板；模型选择器最近使用；黑洞召回时间衰减。
- **环境补验**：VLM 镜像下载完成后一条命令补验推理；ddagrab 换含 D3D11 转换的 ffmpeg 构建或原生 addon 补验。

> 详细历史证据：`docs/eval-4.0.2-tui-verification-2026-09-02.md`（含 9.5-9.7 迭代记录）、`docs/tui-design-upgrade-2026-09-03.md`、`docs/oasis-integration-assessment-2026-09-03.md`、`docs/screenwatch-localvlm-modpack-plan-2026-09-03.md`。

# WxNodus V3 — 本地概念编译器 CLI

> **概念进 · 证据出**：说一句话，交付可运行系统——启动级验证、证据可追溯、零配置离线可用。

Windows 本地优先的 AI agent CLI。把「需求」当源代码一样编译：**规格 → 分解 → 执行 → 验证 → 证据**五段闭环，每段都可审计、可回滚、可重放。

三个限定词（经竞品官方文档校准，缺一不可）：
- **启动级验证**——不是 lint/测试通过：对新生成的项目真实执行 启动 → 探活 → 杀进程 → 重启 → 读回
- **证据文件**——不是终端日志：验证结果沉淀为 `evidence.json`（状态/检查项/指纹/时间），`/evidence list` 全量可查
- **零配置离线可用**——不是「支持本地模型」：不配置任何 key/模型，规则脑（47 个需求模板）也能离线编译、确定性计算毫秒级响应

**离线能力分层**（「离线」的精确边界）：
- **完全断网 + 无 key**：核心闭环完整可用——规则脑 47 模板 → 一句话编译 → 启动级验证 → 证据 → 五门（产物零依赖，连 `npm test` 都不联网）；确定性工具 /calc /hash /base64；记忆 FTS5 中文检索；/doctor /compliance /audit /map；文件/终端/后台任务/定时/剧本/回滚；UIA 桌面控制。验证与证据是纯本地进程操作（spawn → localhost 探活 → kill → 重启 → 读回），**验证对象是本地进程不是云服务——AI 可以断，责任链不断**
- **下载一次即离线**（/offline pack download，之后断网全可用）：文本 LLM（Qwen2.5-1.5B q4 ~1.2GB，`/offline on` 或 `/model` 切换——对话/规格化/摘要离线跑，CPU ~15-30 tok/s，无工具调用由规则脑兜底）、向量记忆（embedding ~90MB）、本地视觉（moondream2 ~1.7GB）、语音（whisper）——**四模态全离线拼图**
- **必须有网 + key**：云端大模型对话（更高智能）、开放域需求规格化（规则脑未命中且离线模型不足时）、云视觉、/search /claw 抓公网

验证全部能力在断网等价环境实测：`scripts/core-demo.mjs`（说一句话 → 编译 → 验证 → 证据 → 五门，无 key 全程通过）。

## 编译学派：概念双向编译

**正向编译**——一句话 → 可运行系统：

```
「帮我做一个待办系统」
  → ① 规格（规则脑/LLM 生成 spec.json，sha256 版本化）
  → ② 分解（模块拓扑排序）
  → ③ 执行（脚手架落地）
  → ④ 验证（真实启动 → 探活 → 杀进程 → 重启 → 读回）
  → ⑤ 证据（evidence.json：状态/检查项/指纹/时间，验证失败如实记 failed）
  → 五门质量门（自测/健康/证据/合规/测试——产物声明 test 脚本则真实执行 npm test）
```

**逆向编译**——代码 → 概念规格：`/understand <项目>` 扫描项目生成概念文档（`data/understand/<名>.md`），可再喂回 `/build` 重新编译——双向循环，代码与概念互为编译产物。`/gate <项目>` 可对历史项目重跑五门质量门。

**规则脑**（零配置兜底）：48 个需求模板（待办/记账/笔记/简历/日程/商城/题库/考勤……）不依赖任何模型，离线编译；未命中且无密钥时**诚实引导配置**，绝不假装回答。`/calc` 等确定性能力同样毫秒级本地执行。

## 快速开始

```bash
npm install && npm run build
npm link            # 全局安装 wxnodus / wxn 命令
wxnodus             # 交互 TUI
wxnodus -p "帮我做一个待办系统"   # 非交互：说一句话 → 生成可运行项目 + 证据链
wxnodus -p "你好" --json         # 非交互：agent 结果 JSON
wxnodus -p "你好" --wire         # 非交互：总线事件流 JSONL（协议化接口）
```

> 无 key 时 TUI 首屏会提示配置；未配置也能使用 /build（规则模板）、/search、/calc、/hole、/compliance 等本地能力。

## 自然语言免记命令

| 你说 | 触发 |
|---|---|
| 「帮我做一个待办系统」 | 概念编译 → 生成可运行项目 + 证据链 |
| 「搜一下我之前说的黑洞」 | 黑洞引擎检索 |
| 「算一下 2+3*4」 | 确定性计算（毫秒级不走模型） |
| 「分析这个视频 …」 | 视频人工视觉 |
| 「看看这张图 …」 | GLM-4V 视觉理解 |
| 「体检」 | 系统健康检查 |

（以上路由有契约测试锁定，`tests/commands-intent.test.ts`——README 承诺不漂移）

## 能力地图

**主线：概念编译**（`/build` 正向 + `/understand` 逆向 + `/gate` 质量门 + `/evidence` 证据重验证 + `/plan` 规格计划 + `/import`/`/flow`/`/fdr` 工程流）——证据链产物 `data/projects/<id>/evidence.json`，全部真实落盘可查。

**副线 1：黑洞引擎**（编译的上下文来源）——百万字级记忆库三层记忆（working 窗口受限 / archival 无限 / recall 全量，1M 级容量背书 `npm run evidence:memory-capacity`）+ 自动吸附 + FTS5 中文 bigram + 本地 embedding 向量检索（sqlite-vec KNN，embedding 不可用自动降级纯 FTS）；agent 每轮自动召回相关记忆（`/hole`、`/memory search`、`/assimilate` 同化、`/digest`、`/compact`）。**记忆容量 ≠ 模型上下文窗口**：每轮送入模型的上下文受 64k token 上限约束，超压自动压缩。

**副线 2：安全与合规**——6 权限模式（smart/auto/manual/plan/yolo/goal）+ 13 条硬红线（任何模式不可绕过，含 sudo/env/bash -lc 解包变体）+ AES-256-GCM 密钥加密（明文绝不落盘，机器指纹绑定）+ `/security` 内存 vault（10 分钟过期、输出精确脱敏、关闭即清）；合规五项（`/compliance`）：授权存证（`/consent` 六元组存证簿，外部访问自动留痕）/ AI 生成标注（深度合成办法第二十条）/ 审计导出（SHA-256 哈希链，`/audit` 过滤查询）/ 许可证扫描（AGPL/BUSL/SSPL 拦截）/ robots 护栏（`/claw` 与 `http_get` 尊重 robots.txt + 验证码提示）。

**副线 3：本地能力**（无 key 全可用）——`/search` 自研 DDG/Bing 双引擎联网搜索（免 key）· `/claw` 网页抓取（SSRF 三层防护：内网/IPv6/NAT64 变体 + DNS 重绑定 + 重定向逐跳）· `/browser` 浏览器自动化（有头 Edge/Chrome，AI 可导航/点击/输入/截图）· `/computer` 桌面控制：**UIA 元素级**（Windows UI Automation 零依赖桥：窗口枚举/控件树/按名称或 AutomationId 定位/原生 Invoke 点击/ValuePattern 中文输入）+ robotjs 坐标层（DPI 换算 + 动作护栏），`computer_observe` 截图理解闭环 · `/video` 视频抽帧分析 · `/vision`/`/img` 图片理解 · `/capture` 截屏留证。**视觉开放通道**：默认智谱 glm-4v-flash（免费），`settings.visionBaseURL/visionModel/visionKey` 或环境变量可换任意 OpenAI 兼容端点（ollama 本地 qwen2.5-vl / OpenRouter / 自建网关），`visionLocal=true` 启用 transformers.js 本地 VLM（moondream2，完全离线无 key），失败可归因（无 key/端点被拒/网络）。

**工具与自动化**——43 个内核工具（含 `computer_*` 十件套（坐标+UIA）、`browser_*` 七件套、`memory_search`、`repo_map`、`cron_create`、`credential_form`）；`/jobs` 并行后台任务（db 持久化，kill 幂等）· `/term` 后台终端 · `/cron` 定时任务（标准 5 字段 cron）· `/goal` 目标循环 · `/delegate` 子代理（只读工具集 + 危险工具剔除 + 安全钩子继承）· `/swarm` 1-8 并行子代理 · `/script` 剧本录制/回放（WxScript DSL，回放 CI；fs 修改后 auto 剧本**自动回归重放**）· `/self-evolve` 自举（AI 分析自身源码 → 补丁 → 自测 → 自动回滚，仅限 src/kernel 与 src/commands）· `/fork`/`/checkpoint`/`/undo` 分支与回滚（影子快照，零 git 依赖）· `/map` 仓库地图（aider repo-map 自研版）· `/arena` 多模型对战 · `/review` 自查。

**生态与协议**——`/skill` 本地技能（agentskills.io 兼容，`/learn` 从对话学习生成）· `/forge` 组件化构建（可运行 MCP Server + 技能打包）· `/mcp` 客户端（stdio + Streamable HTTP，热重载）· `/plugin` 插件（事件订阅/配置/日志 API）· `/gateway` HTTP JSON-RPC 网关 · `/a2a`/`/acp` 智能体协议 · `/webhook` 事件回调 · `/sandbox` L0-L3 分层沙盒 · 生态规范文件链（AGENTS.md > CLAUDE.md > GEMINI.md > .cursorrules > .clinerules > .roomodes）。

**系统**——`/voice` 语音全链路（ffmpeg 录音 → VAD 静音自停 → whisper 本地转写 → 自动提交 → TTS 回复；二进制需按提示安装）· `/init` 项目分析生成 AGENTS.md · 生命周期 Hooks 12 类（preToolUse 输出 DENY 即真实拦截，子代理同样生效）· `/doctor` 健康检查 · `/audit`/`/logs`/`/evidence` 留痕 · 会话 token 预算 · `/theme`/`/lang` 个性化 · `/calc` 等确定性工具（毫秒级）。

## 技术栈（成熟框架）

Node 22 + TypeScript 严格 ESM · 自研状态引擎（createStore/createAtom/computed，零第三方状态依赖）· gateway RPC 协议 · 黑洞记忆（本地 embedding）· 概念编译器 · agent 循环/权限/工具链——核心逻辑全部自研；UI 层为自研五域架构（runtime 回合流 / bridge 内核桥 / commands 命令路由 / hooks 交互 / components 组件）。渲染器 @wxnodus/ink 为 **ink(MIT, vadimdemedes) 的派生 fork**：组件 API 骨架继承 ink，渲染管线深度自研重写（自研 TS yoga 布局移植替代官方 WASM、行级差分、屏幕缓冲、DECSTBM/BSU-ESU），来源与版权声明见 packages/wxnodus-ink/LICENSE。其余：micromark+GFM+math（Markdown）· better-sqlite3+sqlite-vec+FTS5 · robotjs+playwright-core+node-screenshots（computer use）· @huggingface/transformers（本地 embedding）· vitest

## 验收证据

- ✅ 838 单元/契约/进程级测试全绿（71 测试文件）+ 类型检查零错误
- ✅ NL 路由契约测试：README「说人话」六行承诺锁定（tests/commands-intent.test.ts）
- ✅ TUI 冒烟（真实终端 node-pty）：首屏/输入/回复/命令面板/Esc/终止不挂死
- ✅ 全命令扫描 105/105 可用（scripts/cmd-sweep.mjs 回归工具，106 命令注册表全覆盖）
- ✅ 概念编译器端到端：「帮我做一个待办系统」→ todo 项目生成 → 启动 → API 增删查 → healthcheck 通过 → evidence.json
- ✅ GLM-4V 视觉实测（/vision 识别 UI 截图）
- ✅ 技能注入实测：`/skill:名` 技能正文注入对话；hooks 实测：userPromptSubmit/stop 副作用触发
- ✅ npm link 全局安装，`wxnodus`/`wxn` 双命令可用

## 目录结构

```
src/
  app/        编排层（zustand 状态/TurnController/Bridge/CommandBus）
  build/      概念编译器（spec/plan/scaffold/evidence/verify/gate）
  cli/        入口（commander + 交互 TUI 装配 + --json/--wire）
  commands/   命令层（registry 命令/四层意图路由/确定性工具/handlers）
  compliance/ 合规五项（红线）
  forge/      组件化构建（MCP 锻造/技能打包/注册表）
  kernel/     领域层（agent/黑洞引擎/tools/权限/事件/providers/computer/vision/skills/hooks/mcp/projectScan/plugins/imageMeta）
  store/      基础设施（SQLite/配置中心/审计/checkpoint/fork）
  ui/         交互层（ink7 组件/Markdown 管线/Kimi 主题）
tests/        四层测试（含意图路由契约）
scripts/      TUI 冒烟（node-pty 驱动）/ cmd-sweep 全命令扫描
```

## License

Apache-2.0

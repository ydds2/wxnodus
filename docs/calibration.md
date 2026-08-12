# 核心声称校准（docs/calibration.md）

> 本文档记录 WxNodus 核心声称的**外部校准证据**——所有竞品侧证据均来自各官方文档/官方仓库一手来源（抓取日期 2026-08，见各条 URL）。目的：核心表述经得起比对，不依赖自说自话。

## 核心命题（校准后）

> **WxNodus 是唯一把「启动级验证 + 证据文件」写进生成流程、且零配置离线可用的本地 agent。**

三个限定词（缺一会被竞品文档驳倒）：

| 限定词 | 竞品对照结论 | 证据来源 |
|---|---|---|
| **启动级验证**（对新生成项目真实启动→探活→杀→重启→读回） | 6 家竞品官方材料无一有此设计——全部停留在「修改后现有测试/lint 通过」层次 | Aider lint-test 文档、Claude Code CHANGELOG、Gemini CLI README、Cline README、OpenCode LSP 文档 |
| **证据文件**（验证结果沉淀为可追溯产物，非终端日志） | 6 家竞品无验证证据产物——Claude Code 只有会话 transcript、OpenCode 是会话 JSONL、Cline 是回滚快照 | 各官方仓库/文档 |
| **零配置离线可用**（不配置任何 key/模型即可完成有用工作，规则脑兜底） | 4/6 竞品支持本地模型（Ollama 等）但**全部要求手动配置**；无一家声称零配置可用 | Codex `codex-rs/ollama`、Aider docs/llms、Cline running-models-locally、OpenCode providers |

## 校准过程：被打平的声称（已修正表述）

| 曾用声称 | 校准结果 | 竞品证据 |
|---|---|---|
| 「模型可不出机」 | ❌ 4/6 打平——本地模型是行业标配 | Codex 内置 Ollama provider（`--oss` 自动检测+自动拉模型）；Aider/OpenCode/Cline 官方支持 Ollama/LM Studio/llama.cpp/OpenAI 兼容端点 |
| 「数据不出机」 | ❌ 行业默认水位——非差异点（保留为承诺，不作差异化主打） | Aider 遥测 opt-in；Gemini CLI 遥测默认 false 且默认发本地；Cline「Code never leaves your machine」；OpenCode 默认不分享 |
| 「生成后自动验证」 | ⚠ 泛化表述不成立 | Aider 官方：「automatically lint and test your code every time it makes changes」；Cline 实时监控编译/测试/服务器崩溃；OpenCode LSP 诊断反馈循环；Claude Code 有可阻塞 hooks 与 `/verify` 技能 |
| 「Windows 原生」 | ⚠ 仅相对 2 家成立 | Claude Code（winget/PowerShell 工具）、Gemini CLI（Win11 24H2+）均原生一等；Codex 仅 WSL2、OpenCode 推荐 WSL |

## 校准过程：校准后成立的差异点

### ① 启动级验证 + 证据化（真空地带）

竞品逐项（官方一手来源）：
- **Aider**：`--test-cmd` + `--auto-test` 跑的是**既有 test suite**；`/run` 人工触发；输出是终端/对话上下文，无证据产物。来源：https://aider.chat/docs/usage/lint-test.html
- **Claude Code**：`/verify`、`/code-review` 为**显式调用**的技能（CHANGELOG：「no longer runs the /verify and /code-review skills on its own」）；hooks 可阻塞但需用户配置；验证对象是代码审查，非新项目启动探活。来源：https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
- **Codex CLI**：sandbox/approval 是权限控制非验证；无生成后自动验证声称（官方文档站 403，以仓库 docs 为准）。来源：https://github.com/openai/codex
- **Gemini CLI**：README 声称「Generate new apps from PDFs, images, or sketches」但**生成后无验证/探活**；质量门仅用于自身发布（docs/release-confidence.md）。来源：https://github.com/google-gemini/gemini-cli
- **Cline**：实时监控 lint/编译/测试/服务器崩溃（过程中自纠，非完成后门禁）；Checkpoints 是回滚快照非验收记录。来源：https://github.com/cline/cline
- **OpenCode**：LSP 诊断作为 agent 反馈（生成中软门）；会话存储是 transcript 非验证证据。来源：https://opencode.ai/docs/lsp

### ② 零配置离线可用

竞品本地模型路径全部要求：装 runtime（Ollama 等）→ 起服务 → 配 base_url → 选模型。Codex `--oss` 最接近但仍需先 `ollama serve` 并配置。WxNodus 规则脑（48 模板离线编译）+ 确定性工具 + 本地搜索（DDG/Bing 免 key）在**零配置**下可用。来源：https://github.com/openai/codex/tree/main/codex-rs/ollama 、https://aider.chat/docs/llms/ollama.html 、https://docs.cline.bot/running-models-locally/overview 、https://opencode.ai/docs/providers/

### ③ 本地向量记忆检索

6 家竞品长期记忆全部为项目内 markdown 文件（CLAUDE.md / AGENTS.md / GEMINI.md / CONVENTIONS.md / .clinerules），官方材料无一有本地向量库/本地 embedding 检索。WxNodus 黑洞引擎：FTS5 中文 bigram + sqlite-vec KNN + transformers.js 本地 embedding，agent 每轮自动召回。来源：各竞品官方仓库/文档。

## 校准结论对产品的要求（已落地）

1. README 核心表述使用三个限定词（启动级验证/证据文件/零配置离线可用）——`README.md` 开头
2. 证据可查性：`/evidence list`（全量证据簿）+ `/evidence show <项目>`（明细）——`src/commands/handlersExt.ts`
3. 规则脑模板扩充至 48 个，支撑「零配置」声称的分量——`src/build/spec.ts`
4. 核心链路可复现验证：`scripts/core-demo.mjs`（说一句话 → 编译 → 启动级验证 → 证据 → 五门）

## 「离线」的精确边界（用户拷问校准）

「零配置离线可用」曾被质疑「没有网络怎么存活」。核实代码后分层（README 已同步）：

- **核心闭环完全离线成立**：规则脑是纯正则（`src/build/spec.ts` 48 模板）；脚手架产物零依赖（`node:http` + `node:test` + JSON 存储，`src/build/scaffold.ts`——npm test 不联网）；验证引擎纯本地进程（spawn → localhost 探活 → kill → 重启 → 读回，`src/build/verify.ts` 无任何 fetch）。**验证对象是本地进程而非云服务，所以责任链与网络无关。**
- **首次联网一次、之后离线**：embedding（transformers.js 从 HF hub 下载 Xenova/all-MiniLM-L6-v2，~90MB）、本地 VLM（moondream2 q8 ~1.7GB）——模型缓存后全离线。
- **必须联网**：AI 对话、开放域规格化（规则脑未命中）、云视觉、/search /claw。

结论：与「支持本地模型」的竞品（Aider/Codex/Cline/OpenCode）的本质区别不是「模型在本地跑」，而是「**验证与证据链全程不过网**」——这是离线责任的真正含义。

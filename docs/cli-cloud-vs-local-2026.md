# 六家 CLI「云端 vs 本地」依赖面盘点（2026-08-18 取证）

> 触发：评估轮提问「其他 CLI 是否有功能不在本地而是云端的？」——双代理取证，锚点全部在
> `C:\Users\20164\Desktop\cli-compare\` 六仓库源码（aider/codex/crush/gemini-cli/kimi-cli/opencode）。
> 口径对照：wxnodus 承诺「数据不出机 + 离线可用（本地模型/本地嵌入/本地记忆/Windows OCR）」。

## 结论先行

1. **无一家有「云端记忆」**——六家的记忆/上下文全是本地文件（gemini `memoryDiscovery.ts`、kimi `~/.kimi`、
   opencode data 目录、aider `.aider`、crush `~/.local/share/crush`）。wxnodus 的本地记忆**不是独有差异化**，
   独有的是**本地向量 KNN + FTS bigram 的跨会话语义召回**（/hole --all，六家皆无此组合）。
2. **本地模型仅 4 家支持**：aider（litellm/ollama）/codex（ollama+lmstudio OSS provider）/crush（ollama+llamacpp
   自动发现）/opencode（models.dev 目录含 ollama）；**gemini-cli 与 kimi-cli 完全没有本地推理路径，离线即失效**。
   wxnodus 离线四模态模型属 4 家阵营，且免 key 即可用（aider/crush/opencode 亦可不登录，codex 仍绑定 ChatGPT 账号体系）。
3. **云端独占（本地做不了）**集中在 4 项：opencode 会话分享（opncd.ai 云）与 GitHub 云端 agent（api.opencode.ai 中转）；
   codex 云端下发配置/公告（cloud-config）与云端任务（cloud-tasks）；kimi 云端搜索/抓取（Moonshot Search/Fetch 服务）。
   这些 wxnodus 同样未提供——属**功能缺口**而非离线劣势。
4. **强制账号**：codex（ChatGPT 订阅，`login/server.rs:59` auth.openai.com）、kimi（Kimi 账号 OAuth）、gemini（Google
   账号或 key）——离线场景三者门槛最高；crush 可选订阅；aider/opencode 仅需 API key。

## 分仓库证据

| 仓库 | 本地推理 | 账号门槛 | 云端独占面 | 遥测 |
|---|---|---|---|---|
| aider | ✅ litellm→ollama/vLLM（models.py:931） | 仅 key | 无 | PostHog+Mixpanel（10% 采样，可关） |
| codex | ✅ ollama/lmstudio（config_toml.rs:35-38） | ChatGPT 订阅必需 | 云端配置下发 + cloud-tasks + 公告 | OpenAI 后端（未见关闭开关） |
| crush | ✅ ollama+llamacpp 自动发现（discover/ollama.go） | 可选（login.go hyper\|copilot） | 无（Catwalk provider 库可禁） | 未发现 |
| gemini-cli | ❌ 仅云端 Gemini（LiteRT 仅本地路由小分类器） | Google 账号或 key | 无分享；语音有本地 whisper 兜底 | Clearcut（GEMINI_TELEMETRY_ENABLED 可关） |
| kimi-cli | ❌ 纯云端（Moonshot/Kimi Code） | Kimi 账号必需（auth.kimi.com） | 云端搜索/抓取服务 + CDN 更新 | telemetry.kimi.com（可关） |
| opencode | ✅ models.dev 目录含 ollama | 仅 key（login 可选） | **分享上云 opncd.ai + GitHub agent 云中转** | **无 telemetry SDK（匿名度最高）** |
| aider | ✅ | 仅 key | 无 | 可关 |

## 对标 wxnodus 的诚实表述

- 「**数据不出机**」：六家记忆全本地 → wxnodus 无差异化；本地模型 4/6 家都有 → wxnodus 属同档。
  真正的离线独有：**无 key 离线能力**（规则脑+确定性工具已删——现为本地离线模型 + 确定性工具 + 本地记忆，
  README 口径已同步）+ **本地向量召回** + **Windows OCR 视觉兜底**（gemini 需本地 whisper/云端 Gemini Live，
  kimi/codex 视觉全云端）。
- 「**离线可用**」最强对手是 aider/crush/opencode（配 ollama 后零外部请求，opencode 需缓存 models.dev 目录）；
  最弱是 gemini-cli/kimi-cli（无本地推理，断网即废）。
- 云端独占项（分享/GitHub agent/云端任务/云搜索）wxnodus 与多数对手同档缺失——唯一值得注意的是 opencode 分享，
  其 `/share` 是 wxnodus /share（离线加密打包）的**云端版对照**（我们无服务器，S-05 阻塞在案）。

## 入档位置

- 缺陷寄存器：⑧/⑦ 相关口径补充（分享/GitHub agent 属云端独占缺口，本地不可替代）
- score §9.19：⑪ 差异化 10 的论据修正——「本地记忆」非独有，「本地向量跨会话召回」才是独有（已按此口径表述）

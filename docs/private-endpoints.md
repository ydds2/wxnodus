# 私有端点接入指南与兼容矩阵（A5 / P1-3）

> 版本：V1（2026-08-27）· 证据来源：`scripts/evidence-private-endpoints.mjs`（mock 五类差异实测 + 真实端点探针）。
> 定位：私有化部署的模型端点开箱即用验收面——wxnodus 只要求 OpenAI 兼容 `/chat/completions`，
> 模型调用不经 SSRF（用户显式信任），内网 `http://` 端点天然可用。

## 1. 客户端兼容矩阵（实测，2026-08-27）

> 实测方式：本地 mock 端点模拟五类私有端点差异，内核 `callLlmStream` 直测（不重试暴露单次行为）。

| 端点形态（mock） | 连接 | 流式解析 | 正文 | 思考字段 | 工具调用 | 用量 | 结论 |
|---|---|---|---|---|---|---|---|
| 标准流式（Ollama/vLLM/one-api 形态） | ✅ | ✅ | ✅ | n/a | ✅ | ✅ | 开箱即用 |
| DeepSeek 私有化（reasoning_content） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅（含缓存命中/未命中五维） | 开箱即用 |
| 缺 `[DONE]` 尾帧的老端点 | ⚠️ | ✅ | ⚠️ | — | — | — | **判「流中断」fail-closed**（内容增量已收到但终态判失败）——真实私有端点（Ollama/vLLM/one-api）均输出 `[DONE]`，不受影响；自研端点请补尾帧 |
| 无 usage 字段 | ✅ | ✅ | ✅ | n/a | — | —（诚实缺省） | 开箱即用（成本估算降级） |
| 不支持工具调用 | ❌ HTTP 400 | — | — | — | — | — | 4xx 不重试、立即诚实报错——解法：`/model add` 时目录标注无工具能力（toolTrim 裁剪）或端点侧开启 tools |
| 工具调用轮转 | ✅ | ✅ | ✅ | n/a | ✅（fs_read 完整解析） | — | 开箱即用 |

## 2. 常见私有端点接入

| 端点 | 命令 | 说明 |
|---|---|---|
| Ollama | `/model add qwen2.5:7b --base http://127.0.0.1:11434/v1` | 本机默认无 key；推理首 token 慢（冷加载），idle watchdog 双档已适配 |
| LM Studio | `/model add <模型ID> --base http://127.0.0.1:1234/v1` | 自带 OpenAI 兼容服务器 |
| vLLM | `/model add qwen2.5-72b --base http://<内网IP>:8000/v1` | `--api-key` 可配；支持工具调用与 reasoning |
| one-api / new-api 中转 | `/model add <模型ID> --base http://<内网IP>:3000/v1 --key <令牌>` | 多模型聚合网关；前端密钥不落盘 |
| DeepSeek 私有化（SGLang/vLLM 部署 V3/R1） | `/model add deepseek-v3 --base http://<内网IP>:8000/v1` | reasoning_content 适配（DeepSeek Harness §6.10）；R1 思考字段回传纪律自动满足 |

## 3. 与安全面的交互（重要）

- **模型端点不走 SSRF**（`llmStream` 裸出站经统一 fetch——用户经 `/model add` 显式信任）；`http_get`/`http_request` 工具对内网 API 仍受 SSRF 拦截，需显式放行（blockedHosts 白名单面，见路线图 A5 验证项）。
- **企业代理**（A2）：私网段默认直连（127/10/172.16-31/192.168/169.254/ULA/链路本地/localhost）——内网端点**绝不**经代理外发；用户可用 `NO_PROXY`（env）或 WinINET `ProxyOverride` 追加内网域名旁路。
- **密钥**：`/model add` 时 key 可选——内网无认证端点直接留空；带 key 的端点经 AES-256-GCM 加密槽位（明文绝不落盘）。

## 4. 真机验收

`scripts/evidence-private-endpoints.mjs` 真实探针经环境变量供给（未配置诚实 skip）：

```powershell
$env:WXNODUS_E2E_OLLAMA_BASE  = 'http://127.0.0.1:11434/v1'
$env:WXNODUS_E2E_LMSTUDIO_BASE = 'http://127.0.0.1:1234/v1'
$env:WXNODUS_E2E_ONEAPI_BASE   = 'http://127.0.0.1:3000/v1'
npm exec -- tsx scripts/evidence-private-endpoints.mjs
```

矩阵口径：mock 差异面 = 客户端宽容度验收；真实探针 = 部署现场验收。两者合流即私有端点「开箱即用」证据。

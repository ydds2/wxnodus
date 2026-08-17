# ZCode × deepseek-v4-pro 图片工作流注记

> 事故背景：2026-08-17，ZCode 切到 `deepseek-v4-pro`（纯文本模型）后回合失败——
> `400 invalid_request：messages[678]: unknown variant image_url, expected text`
> （长会话历史中混入了 `image_url` 内容块，纯文本端点拒绝多模态内容）。
> TraceID: 0577747b-f173-42fc-9b10-b4ae436cc68e

## 规则（ZCode 会话内行为约定）

1. **回合开始先自查**：当前会话上下文里是否存在待识别的图片（截图/贴图/工具返回的 image 内容）？
2. **有图**：先用 **GLM 多模态**（或当前可用的视觉模型）把图片识别为文本描述，再继续任务——绝不把 `image_url` 内容块直接发给 deepseek-v4-pro 类的纯文本模型。
3. **无图**：**不自动调用**视觉模型（零冗余 API 调用）。
4. 长会话警惕：历史消息里若混入多模态 parts，向纯文本模型发请求前必须文本化（`image_url` → `[图片]` 占位）。

## 代码侧对应防御（已落地，2026-08-17）

| 层 | 位置 | 行为 |
|---|---|---|
| 策略纯函数 | `src/kernel/providers.ts` `imageStrategy`/`hasImageIn` | 无图→none（零视觉调用）；视觉模型→inject；文本模型→describe（视觉通道先识别） |
| agent 环能力门 | `src/kernel/agent.ts` loop 多模态注入 | 文本模型带图 → `describeImage`（GLM 默认/自定义 vision 端点/本地 VLM）识别为文本注入 prompt；失败诚实丢弃 + 审计 `agent.image.described/dropped`；自动降级路径跳过 Windows OCR（`visionOcr:false`，聊天回合内不 spawn PowerShell——显式 `/vision` 仍保留 OCR 兜底） |
| 历史清洗 | `src/kernel/agent.ts` working() 装载 | 多模态 parts 数组一律 `contentToText`（image_url → `[图片]`，dataUrl 绝不进 API 消息） |
| 能力识别 | `hasImageIn` | 目录内按 `capabilities.imageIn`；档案自定义模型名按名称启发式（gpt-4o/qwen-vl/gemini/claude/*vision*/llava/moondream…），未知默认文本（安全方向） |
| 测试锁定 | `tests/kernel-image-guard.test.ts` + `kernel-gateway.test.ts` + `kernel-imageHistory.test.ts` | 策略矩阵 + 启发式 + 历史文本化 + 网关透传契约 + agent 环 inject/describe 端到端 |

# ZCode + DeepSeek 纯文本模型视觉工作流

> 事故锚点：2026-08-17 ZCode 切 `deepseek-v4-pro` 后回合 400——`messages[678]: unknown variant image_url, expected text`（纯文本模型收到多模态内容块）。
> 本文档记录：会话工作流规则（人） + 代码侧纵深防御（机器），两者互为兜底。

## 1. 会话工作流规则（ZCode 会话内必须遵守）

1. 切换到 `deepseek-v4-pro`（或任何纯文本模型）后，回合开始先自查上下文是否存在待识别图片；
2. **有图** → 先用 GLM 多模态把图片识别为文本，再继续任务；
3. **无图** → 不自动调用视觉模型（零冗余调用）。

## 2. 代码侧四层防御（已落地）

| 层 | 机制 | 落点 |
|---|---|---|
| 1 能力门 | `imageStrategy(modelId, imageCount)`——纯文本模型 → `{ kind: 'none' }`，dataUrl 不注入 | `src/kernel/providers.ts:168-172` |
| 2 历史文本化 | 历史消息 content 中的图片 parts 一律文本化 | `src/kernel/agent.ts` 历史清洗 |
| 3 发送前兜底 | `textifyForModel(content, modelId)`——请求体组装前最后一道转换 | `src/kernel/providers.ts:291-299` |
| 4 视觉通道降级 | 文本模型遇到图片任务 → 视觉模型识别为文本再回喂 | `src/kernel/agent.ts` 视觉通道 |

**不变量（DSH-3）**：`dataUrl` 绝不进入非视觉 DeepSeek 模型请求体。

## 3. 测试锁定

`tests/kernel-image-guard.test.ts`——能力门/历史清洗/发送前兜底三层各有回归用例；改图片通道必须全绿。

## 4. 关联

- DeepSeek 端点特性适配总表：`docs/architecture-2026-08-27.md` §6.10（DeepSeek Harness）；
- 内核评估：`docs/kernel-eval-2026-08-27.md` §6.5 图片四层守卫。

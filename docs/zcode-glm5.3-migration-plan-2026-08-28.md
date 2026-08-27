# ZCode + GLM-5.3 迁移计划（2026-08-28）

> 目标：把日常编码代理（ZCode）主模型从 DeepSeek 系切换到 **GLM-5.3**，并把 wxnodus 的模型适配面（图片守卫/思考字段/预算钳制/成本五维）同步校准到 GLM-5.3。
> 红线保持：数据不出机语义不变——模型流量只去用户显式配置的端点（GLM 云 API 与 DeepSeek 云 API 同等级别，属用户自选端点，非自动外发）；气隙部署用私有化端点（见 P2-C）。
> 本文档是计划，不是实施记录；实施完成后回改状态（✅ 标注）。

## 一、现状盘点（已确认）

| 项 | 现状 | 锚点 |
|---|---|---|
| ZCode 主模型 | `deepseek-v4-pro`（纯文本，多模态内容块会炸 `messages[678]: unknown variant image_url`） | `docs/zcode-deepseek-vision-workflow.md` 事故锚点 |
| 视觉兜底 | GLM 多模态识别为文本再回喂（`/img` 技能 glm-4v-flash） | `AGENTS.md` ZCode 段 |
| 图片守卫 | 四层防御（能力门/历史文本化/发送前兜底/视觉通道降级），DSH-3 不变量 | `src/kernel/providers.ts:168-172` 等 |
| 模型接入面 | `/model add` 任意 OpenAI 兼容端点 + DeepSeek Harness（DSH-1..4） | `docs/architecture-2026-08-27.md` §6.10 |
| 竞品参考约束 | 机制参考不抄代码、文档如实记录锚点与差异 | `AGENTS.md` 长期约束 |

## 二、GLM-5.3 事实基础

**已取证（来源附后）**：
- **GLM-5.3-Flash**：320B 总参数 / 18B 激活、**原生多模态**、**1M 上下文**、价格约为 GLM-5.3 的 1/10（旗舰 GLM-5.3 的价格约为 Opus 4.8 的 1/40）；国产算力承载；
- 官方端点：智谱开放平台（OpenAI 兼容，VLM 模型文档页）；第三方可用：阿里云百炼 `ZHIPU/GLM-5.3`、360 AI、千问 AI 平台、Telnyx、Baseten；
- 与 DeepSeek V4 / Kimi K3 同级竞争位（第三方评测对比已见公开稿）。

**待真机取证（计划 P0 实测矩阵逐轴确认，不猜）**：
- [ ] GLM-5.3 / 5.3-Flash 的推理字段名（`reasoning_content`？）与流式形态（首帧/尾帧/usage 位置）；
- [ ] 自动上下文缓存字段（`prompt_cache_hit_tokens` 类）——DSH-4 成本五维的 cacheRead/cacheWrite 能否直读；
- [ ] 图片输入形态（image_url dataUrl 是否原生接受；多图与文本混排限制）；
- [ ] 工具调用与并行工具调用支持（tool_choice/parallel_tool_calls）；
- [ ] max_tokens 上限语义与输出窗口预算逻辑（DSH-2 窗口钳制是否需调整）；
- [ ] 私有化部署可行性确认（vLLM/SGLang 对 GLM-5.3-Flash 320B/MoE 的支持——公开教程已有单机异构到多卡路径）。

来源：
- 智谱 GLM-5.3-Flash 文档：https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash
- 360 AI 模型页：https://ai.360.com/open/zh/models/z-ai/glm-5.3
- 阿里云百炼 ZHIPU/GLM-5.3：https://www.alibabacloud.com/help/zh/model-studio/glm-5-3-by-zhipu
- GLM-5.3-Flash 发布稿（320B/18B/原生多模态/1/10 价格）：https://notes.kamacoder.com/llm/news/glm-5-3-flash.html
- 智谱国产算力与价格报道：https://news.qq.com/rain/a/20260826A0E11E00
- 私有化部署教程（API→单机异构→多卡）：https://news.qiniu.com/archives/1787795636541

## 三、关键差异与风险（迁移的实质工作）

1. **原生多模态 → 图片守卫语义反转**（最高优先）：
   - 现状：`imageStrategy(modelId, imageCount)` 对纯文本模型返回 `{ kind: 'none' }`（dataUrl 不注入）。GLM-5.3 原生多模态后，能力门必须把 GLM 模型列入「放行 dataUrl」表——否则四层防御会把合法图片任务全部文本化（守卫从「防事故」变成「误伤功能」）；
   - DSH-3 不变量改口径：`dataUrl 绝不进入【非视觉】模型请求体`——GLM-5.3 属视觉模型，不变量本身不变，变的是「视觉模型」判定表。
2. **1M 上下文 → 预算参数复核**：历史归一化/compaction 阈值、`max_completion_tokens=窗口−输入估算−余量` 的余量系数是否按 1M 窗口放大（防「窗口大了但钳制没跟上」）；
3. **推理字段**：GLM 思考字段名若不同于 `reasoning_content`，`REASONING_FIELDS`（`llmStream.ts:4`）需扩展（DSH-1 同机制，多枚举一行）；
4. **成本五维**：GLM 若不返回缓存读写字段，DSH-4 的成本行如实降级（cacheRead/cacheWrite 记 0 并标注「端点未提供」——绝不编造）；
5. **前缀缓存**：DSH-2 的字节稳定前缀策略在 GLM 自动缓存下的命中率需实测（命中低则维持策略但文档如实记录差异）；
6. **视觉技能升级**：`/img` 当前走 glm-4v-flash——迁移后可切 GLM-5.3-Flash（同家、更强、成本更低），属独立小改动。

## 四、分阶段步骤

### P0 · 端点实测矩阵（半天，不动生产配置）
1. wxnodus 侧加端点：`/model add` GLM-5.3 与 GLM-5.3-Flash（官方 OpenAI 兼容 URL + key）；
2. 用 `scripts/evidence-private-endpoints.mjs` 思路对 GLM 跑实测矩阵：连接/流式/首尾帧/usage/工具调用/图片输入/缓存字段/429 重试——逐轴 PASS/降级/拒绝，产出 `docs/private-endpoints.md` 增补段；
3. 输出：GLM 端点特性卡（哪些 Harness 轴可直用、哪些需适配）。

### P1 · 代码侧适配（1–2 天，wxnodus）
| # | 项 | 落点 |
|---|---|---|
| P1-1 | 视觉能力门 GLM 放行表 + 回归测试 | `providers.ts` imageStrategy + `tests/kernel-image-guard.test.ts` 增 GLM 用例 |
| P1-2 | REASONING_FIELDS 扩展（如字段名不同） | `llmStream.ts` + 测试 |
| P1-3 | 窗口钳制余量按 1M 上下文校准 | `agent.ts` 预算段 + 测试 |
| P1-4 | DSH-4 成本字段兼容（有则直读、无则诚实降级） | `cost.ts` + 测试 |
| P1-5 | `/img` 视觉技能切 GLM-5.3-Flash | 技能配置 |
| P1-6 | 文档同步：architecture §6.10 增 GLM 特性卡 + 台账 | docs |

验收：全量测试绿 + 矩阵文档更新 + 差异记录（参考锚点/实现差异）。

### P2 · ZCode 侧切换（半天 + 3 天双轨观察）
- **P2-A 切换**：ZCode 配置改 model/base_url/key → GLM-5.3（或先 5.3-Flash 试性价比）；`AGENTS.md` ZCode 段更新（视觉工作流规则从「纯文本模型必先转文本」改为「GLM-5.3 原生多模态可直接给图；遇能力降级再走 /img 文本化」）；
- **P2-B 双轨观察（3 天）**：同一批真实任务 DeepSeek/GLM 各跑一遍（wxnodus `eval:tasks` 10 任务库 + 日常工作），对比通过率/成本/延迟，产出《双轨对比》结论再定长期主模型；
- **P2-C 私有化选项（可选）**：企业/气隙场景用 GLM-5.3-Flash 私有化部署（公开教程已覆盖单机异构→多卡），wxnodus `/model add` 指内网端点——数据不出机闭环。

### P3 · 迁移保障
- 会话历史/黑洞记忆：数据全在本地 DB（`data/`），ZCode 切模型**不动数据目录**——零迁移成本；需要时 `/export` 打包留档；
- 回滚预案：ZCode 配置一处回退 + wxnodus 端 GLM 适配全部增量（不删 DeepSeek Harness 路径）——回滚 = 改回 model id；
- 密钥管理：GLM key 走 `/model set-key`（AES-256-GCM 本机加密，明文不落盘），与 DeepSeek key 并存不冲突。

## 五、决策点（需拍板）

| # | 决策 | 建议 |
|---|---|---|
| D1 | 主模型选旗舰 GLM-5.3 还是 Flash | 先 Flash（1/10 价格 + 1M 上下文 + 原生多模态，P0 实测矩阵定夺旗舰必要性） |
| D2 | ZCode 与 wxnodus 是否同模型 | 建议同模型（同端点特性卡，适配面收敛）；wxnodus 保留 DeepSeek Harness 不删 |
| D3 | 双轨期长度 | 3 天 / 10 任务库 + 5 个真实日常任务为最小样本 |
| D4 | 私有化部署是否立即做 | 非气隙场景缓做（P2-C 观察项）；气隙场景优先做 |

## 六、验收清单

- [ ] P0 实测矩阵全轴有结论（PASS/降级/拒绝，零猜测）；
- [ ] 图片守卫 GLM 用例全绿（DSH-3 新口径下「视觉模型放行、纯文本模型拦截」双验证）；
- [ ] `eval:tasks` 10 任务库 GLM 端点首份通过率基线（真实端点 env 供给）；
- [ ] 双轨对比结论 + 主模型定稿；
- [ ] `AGENTS.md` ZCode 段与 `docs/zcode-deepseek-vision-workflow.md` 更新为 GLM-5.3 口径；
- [ ] 台账更新（kimi 无关；本迁移的锚点与差异记录进 `docs/architecture-2026-08-27.md` §6.10 GLM 特性卡）。

*本计划快照：实施时按 P0→P1→P2→P3 顺序执行，每阶段完成后回改状态；红线（数据不出机/不抄代码只抄机制）全程不变。*

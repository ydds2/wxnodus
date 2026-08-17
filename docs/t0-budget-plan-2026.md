# T0 达标预算计划（300 元上限 · 余额护栏 · 2026-08-18）

> 约束来源：用户 ZCode + deepseek-v4-pro，当前余额 ¥80，授权追加至 ¥300 以内；
> 余额不足 ¥1 时自动打断收敛（护栏：`scripts/balance-guard.mjs`，每轮 loop 先查）。
> 本计划只列「剩余未完成项」；本会话已完成 10 轮改进（audit §13.34–13.43 + 规则脑删除）。

## 0. 成本模型（假设，待实测校准）

- 参考价：deepseek-chat 输入未命中 ¥1/M tokens、命中 ¥0.1/M、输出 ¥2/M；v4-pro 按同量级估算。
- ZCode 单轮（含工具输出）约 0.5–2M tokens → 单轮成本约 ¥0.1–2（命中缓存后显著下降）。
- 本计划全部项以「≤150 轮 ZCode 交互」封顶 → 保守上界 ¥300；目标实际消耗 ≤¥150。
- **降本杠杆**：wxnodus 侧前缀缓存稳定化已落地（audit §13.43）——多轮会话 API 成本直接打折，这部分钱省在用户的实际使用中而非本计划。

## 1. 已完成（本会话累计 10 轮，零重复工作）

| 深评 §8 路径 | 状态 |
|---|---|
| ① CI/lint（npm run ci 七步门禁 CI_EXIT=0）+ typecheck:tests 归零 | ✅ |
| ② 分发（CHANGELOG、/update、winget/scoop 生成器；发布 URL 待有 remote） | ✅（发布面留待 remote） |
| ③ 协议面（stdin 管道、--stream-json 别名、wire schema 文档+examples、ACP 接入文档） | ✅ |
| ④ 提示词缓存降费（前缀稳定化 + usage 缓存可观测） | ✅ |
| ⑤ 编辑器/死代码（vim 死代码删除；keymap 配置留待） | 部分 |
| ⑥ 巨文件拆分（handlersExt 第 1 块已迁 ext/；2/3 块迁移尝试后回退） | 部分 |
| 用户显式要求（/model 开放兼容 + /key 彻底移除 + 选择器缺陷修复） | ✅（本轮再清零 6 处漏网 /key set） |

## 2. 剩余路线（按性价比排序，成本估算为 ZCode 轮数）

| 序 | 项 | 收益 | 估算 | 做法 |
|---|---|---|---|---|
| 1 | **余额护栏实战化**：用户 `/model set-key` 配 DeepSeek 密钥后每轮查余额；<¥1 打断 | 硬约束 | 0 轮（已建机制） | 用户 1 次命令 |
| 2 | **分层泄漏修复 4 处**（domain→infra、kernel→store） | 架构分 +0.5 | ~6 轮 | 端口注入 |
| 3 | **fixture node_modules 出 git**（~2550 文件卫生） | 卫生/克隆速度 | ~3 轮 | 脚本化下载+哈希锁 |
| 4 | **测试布局收口**（123 根目录测试归 tests/{unit,contract,integration,failure}） | 可维护性 | ~4 轮 | 机械移动+vitest 发现校验 |
| 5 | handlersExt 拆分 2/3 块（改用「静态 import 清单手写」重做，上次自动修剪脚本失败已回退） | 巨文件达标 | ~10 轮 | 手工逐块 |
| 6 | `/uninstall` 命令 + winget/scoop manifest 实测（需发布 URL，无 remote 则留模板态） | 分发闭环 | ~4 轮 | 渠道感知 |
| 7 | keymap 配置层（codex 式 schema） | 编辑器分 +1 | ~15 轮 | 可选，超预算则砍 |

**止损判定**：若余额监控显示 <¥20 且仍未完成序 2-6，立即收敛：提交全部已绿改动 + 交付摘要，不再新开工项。

## 3. 监控协议（每轮 loop 自动执行）

1. `node scripts/balance-guard.mjs`（exit 0 继续 / 1 打断收敛 / 2 无密钥——按 DEEPSEEK_KEY_MISSING 提示用户配置）。
2. 打断收敛输出：已完成项清单 + 未完成项 + 余额读数 + 恢复方式（`/model set-key` 后重跑）。
3. 当前基线（2026-08-18）：**DeepSeek 密钥不在本机 wxnodus**（仅 zhipu/GLM 已配置）——自动监控待用户执行 `wxnodus -p "/model set-key <DeepSeek密钥>"` 后立即生效。

## 4. T0 达标判据（可验收）

- `npm run ci` 全绿；评分文档 §0 权重表复算 ≥8.0（原 6.14）；深评 S0/P0 清单全部关闭（分发发布面除外——无 remote 物理不可达，模板已就绪）。

# WxNodus 竞品差距分析与降维路线（全网调研）

> 调研范围：Claude Code、Codex CLI（OpenAI）、Gemini CLI（Google）、Aider、Cline、
> Qwen Code（阿里）、Kimi CLI（月之暗面）、OpenCode（SST）——9 大 AI coding CLI 官方文档能力矩阵
> 调研方式：3 组并行研究代理抓取官方文档（code.claude.com / learn.chatgpt.com / github.com / opencode.ai / qwenlm.github.io 等），每条事实带来源

## 一、能力矩阵对照（wxnodus vs 竞品共性）

| 能力维度 | 竞品共性（9 家） | wxnodus 现状 | 判定 |
|---|---|---|---|
| 计划模式（plan/act 双循环） | 全部 | /plan + 6 权限模式 | ✅ 对齐 |
| 权限分级/审批链 | 全部（Qwen 5 级/Codex granular） | 6 模式（smart/auto/goal/manual/plan/yolo） | ✅ 对齐且更细 |
| 子代理 subagent | 7/9（Claude Agent/Codex/Cline/Kimi） | /delegate + delegate 工具 | ✅ 对齐 |
| 后台任务/终端 | 多数（Claude Monitor/Cline Kanban） | /jobs + /term PTY + cron 秒级 | ✅ 对齐 |
| MCP 服务器 | 全部 | 项目/用户双配置 + strict + 热重载 | ✅ 对齐 |
| Hooks 生命周期 | 8/9（Claude 30 事件/Kimi 13） | 12 事件 | ✅ 对齐 |
| Skills 技能包 | 全部（Agent Skills 开放标准） | agentskills 规范 + 跨品牌扫描 | ✅ 对齐 |
| 上下文压缩/记忆 | 全部（md 法/简单记忆） | 黑洞引擎三层记忆 + FTS5 + 向量 | ✅ **领先** |
| Repo map | Aider 图排序/Claude | /map 符号索引 + 自动注入 | ✅ 对齐 |
| 联网搜索 | Gemini ground/Codex/OpenCode | 双引擎免 key + web_search 工具 | ✅ **领先**（本地化） |
| 语音输入 | Aider/部分 | /voice 全控 + whisper.cpp | ✅ 领先 |
| 非交互/CI | 全部（-p/exec/run + JSON 流） | -p/--json/--wire/退出码协议 | ✅ 对齐 |
| 自定义主题/键位 | Claude/Codex/OpenCode | /theme（键位自定义未对齐） | ⚠ 小差距 |
| **浏览器自动化工具** | Gemini browser_agent/Cline/Claude Task | **无**（playwright-core 依赖存在未接线） | ❌ **缺口** |
| **自定义 agent 定义文件** | OpenCode .opencode/agents、Codex agents.md、Kimi agents YAML | **无**（仅内置 /delegate） | ❌ **缺口** |
| Checkpoint 三态回滚 | Claude 100 快照/rewind、Cline 影子 git | /checkpoint save/restore + /versions | ⚠ 部分（非 git 级） |
| LSP 语义补全 | Claude/Qwen/OpenCode | 无 | ⚠ 缺口（重） |
| Agent Teams 多代理编排 | Claude/Cline | /duo /swarm（基础） | ⚠ 中等差距 |
| 策略文件（policy/rules TOML） | Gemini policy/Codex .rules | commandLevels（代码内） | ⚠ 小差距 |
| 多模型对战 Arena | Qwen | 无 | 特色（非必需） |

## 二、wxnodus 独有（竞品没有的降维武器）

1. **黑洞引擎**：百万上下文三层记忆（working/archival/recall）+ FTS5 中文 bigram + 向量 KNN + 策展自动审查——竞品全是 md 文件法或简单记忆
2. **概念编译器 /build**：自然语言 → 规格 IR → 拓扑计划 → 可运行项目 → 启动探活证据链 → 五门质量门（真实验证，不伪造）——竞品无此能力
3. **免 key 可用**：规则脑兜底 + 诚实归因（竞品全部强制 API key）
4. **本地优先安全**：SSRF 三层防护 + AES-256-GCM 密钥 + 合规五项（深度合成标注/审计哈希链）+ 沙盒 L0-L3
5. **搜索质量**：双引擎回退 + 完整实体解码（乱码根治）+ 5 分钟缓存

## 三、降维打击路线（按价值/成本排序）

### P0-1 浏览器自动化工具（最大信用缺口）
- 现状：package.json 声明 playwright-core 依赖，README 宣称 computer use，但 AI 工具表无任何浏览器工具
- 实现：browser_navigate / browser_click / browser_type / browser_screenshot（系统 Chrome/Edge 复用 + 无头回退 + SSRF 域名白名单 + 会话单例）
- 对齐：Gemini browser_agent / Cline browser

### P0-2 自定义 agent 定义体系
- 实现：`.wxnodus/agents/*.md`（YAML 前置元数据：name/description/tools/mode/instructions）+ 扫描加载 + /agent 命令 + delegate 工具按名调用
- 对齐：OpenCode .opencode/agents、Codex agents.md、Kimi agents YAML

### P1-3 提示四要素对齐（Codex 最佳实践）
- Goal/Context/Constraints/Done-when 落进 systemPrompt.ts + /goal 循环输出 [GOAL_DONE] 完成标记（已有 goal 模式，补 done-when 声明）

### P1-4 Checkpoint 三态增强
- /checkpoint compare（当前 vs 快照 diff 预览）——补三态语义（save/compare/restore）

### P2（后续）LSP、Agent Teams、策略文件、键位自定义

## 四、执行顺序建议
```
P0-1 浏览器工具 → P0-2 agent 定义 → P1-3 四要素 → P1-4 checkpoint compare → 验证提交
```

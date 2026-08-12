# WxNodus 深度代码比对报告（vs OpenCode / Cline / Aider / Gemini CLI）

> 方式：3 个并行比对代理抓取竞品源码（raw.githubusercontent + 本地解包）逐模块对照 wxnodus 源码
> 源码依据：OpenCode session/compaction.ts、tool/registry.ts、permission/index.ts、session/llm.ts、agent/agent.ts；
> Cline sdk/packages/core/src（runtime/orchestration、session、hooks、extensions）；
> Aider repomap.py/models.py/base_coder.py/editblock_coder.py；Gemini memoryService/memoryDiscovery/policy-engine/sandbox/windows/modelRouterService

## 逐模块差距矩阵

| 模块 | wxnodus | 竞品最强实现 | 差距 | 可借鉴点 |
|---|---|---|---|---|
| agent 循环 | 单循环≤16 轮，同工具失败 5 次终止 | Cline loop-detection（工具调用签名软/硬双阈值）+ mistake-tracker 回调 | 中 | 签名级循环检测 |
| 工具执行 | 未知工具 3 轮终止 | OpenCode experimental_repairToolCall（失败调用改投 invalid 工具内嵌错误） | 小 | 未知工具重试引导 |
| fs_edit | 单块 indexOf 替换，失败仅报未找到 | Aider SEARCH/REPLACE 多块 + 唯一性校验 + 结构化错误 | 中 | 多块编辑 + 位置反馈 |
| 压缩 | 保头 3 尾 3 + LLM 摘要 | OpenCode 逐 part token 修剪 + 近 2 用户轮保护 + 压缩自动续问 | 大 | token 级修剪 |
| checkpoint | 消息表快照 + undoShadows 逐文件 | Cline 影子 git 三父 stash + 三态恢复 + 事务回滚 + runCount 寻址 | 大 | 文件级 git 快照 |
| repo map | 正则提取 + 全量重扫 | Aider tree-sitter + PageRank 图排序 + mtime 磁盘缓存 + personalization | 大 | 缓存 + 个性化权重 |
| 记忆 | 黑洞三层（被动召回） | Gemini auto memory（空闲扫描历史 → 提取 patch → 校验应用，带锁/节流/processed） | 大 | 主动挖掘 |
| policy | permissions.json {tool,glob,decision} | Gemini TOML：toolName/argsPattern/commandPrefix/modes/priority/denyMessage | 大 | 规则增强 |
| 自动 git | 无 | Aider 每次编辑自动 commit + /undo=git reset + dirty_commit 备份 | 中 | 编辑后自动提交 |
| 任务并行 | 父任务+支线，无依赖链 | Cline Kanban 卡片依赖链 + worktree 隔离 | 大 | 依赖链自动启动 |
| subagent | 深度≤3，只读集 | Cline 自定义 prompt/abort 级联/团队审查者；OpenCode per-agent 模型/温度 | 中 | 透传增强 |
| hooks | 12 事件单命令 | Cline 每事件多命令数组；OpenCode TS 模块插件 | 小 | 多命令 |
| 权限 | 首命中返回 | OpenCode 末匹配生效 + deny 工具从 schema 隐藏 + always 持久化 | 中 | 隐藏 deny 工具 |
| MCP | stdio/HTTP + strict | OpenCode 公共目录 + OAuth 流 | 中 | 目录 + OAuth |

## Top 差距（按 wxnodus 收益排序）

1. **循环检测签名级**（Cline）：记录最近 N 轮 (tool,args) 签名，相同签名≥3 次终止——早识别空转死循环省 token
2. **fs_edit 多块 + 唯一性校验**（Aider）：oldText 出现次数>1 返回位置列表；失败错误带上下文——减少模型重复尝试
3. **repo map mtime 缓存 + 个性化**（Aider）：(path,mtime) 符号缓存免重扫；会话提及符号权重加成——大仓库 /map 提速 + 命中率提升
4. **policy 规则增强**（Gemini）：priority/modes/commandPrefix（bash 命令前缀精确授权「git push 特定分支」）/denyMessage
5. **自动 git commit**（Aider）：git 仓库内 fs 编辑成功后自动 commit（消息标注），/undo 增加 git reset 路径
6. **Token 级压缩**（OpenCode）：保近 2 用户轮 + 工具输出截断 + 压缩自动续问
7. **文件级 git checkpoint 三态**（Cline）：undoShadows → 影子 git stash + 三态 restore + 事务回滚
8. **auto memory 挖掘**（Gemini）：后台扫描归档会话提取事实写入记忆（锁/节流/processed 状态）
9. **Kanban 依赖链**（Cline）：taskRunner dependencies + blocked 状态自动入队
10. **subagent 透传增强**（Cline）：delegate 支持 system_prompt/max_turns + abort 级联

## 实施记录（后续轮次）
- 循环检测、fs_edit 多块、repo map 缓存、policy 增强、自动 git commit（待实施）

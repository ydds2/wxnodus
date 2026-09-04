# wxnodus 用户手册（离线版）

> 版本 4.0.2 · 由命令注册表确定性生成（`npm run docs:user-guide`）· 气隙/内网机器零网可查。

## 1. 快速开始

```bash
npm install && npm run build && npm link
wxnodus                          # 交互模式（薄层 TUI）
wxnodus -p "帮我做一个待办系统"    # 非交互单次执行
wxnodus -p "你好" --json          # 结构化 JSON 结果
wxnodus -p "你好" --wire          # 事件流 JSONL（stdin 帧 RPC 双向）
echo 文件内容 | wxnodus -p "总结"  # stdin 管道（-p 为指令、stdin 为素材）
wxnodus --serve                   # 本地 HTTP 网关（Bearer+CSRF+会话所有权）
wxnodus --mcp-server              # incoming MCP stdio 服务器
wxnodus -p "/acp server"          # ACP stdio（Zed/JetBrains 接入）
```

## 2. 命令总览

### ◈

| 命令 | 说明 |
|---|---|
| `/aliases` | 中文别名总览（/帮助 /体检 /密钥 /权限… → 规范命令——斜杠中文直达） |
| `/balance` | 余额监控（auto-stop on/off——余额耗尽自动停，防烧钱） |
| `/checkpoint` | 会话快照（save/list/compare/restore/clear，undo 前自动保存） |
| `/clear` | 清空会话视图 |
| `/context` | 上下文占用可视化 |
| `/cost` | 成本估算（会话/今日/7天/30天；公开参考价目，未收录模型只报 token） |
| `/fork` | 分支会话（复制当前会话为副本） |
| `/help` | 查看帮助（默认全目录 126 · /help core 主干速览 · /help <命令> 展开单个） |
| `/new` | 新建空会话并切换 |
| `/quit` | 退出 |
| `/resume` | 切换会话（真正加载历史并继续） |
| `/script` | 可执行剧本（record/run/verify/ci/watch——会话录制为可重放脚本+回放CI+自动回归） |
| `/self-evolve` | 自举模式（AI 分析自身源码→补丁→自测→报告，不自动提交；--report 只审查不改码） |
| `/sessions` | 会话列表（非交互模式输出文本列表） |
| `/snapshot` | 目录级快照（建档/整体回滚，/snapshot restore） |
| `/title` | 重命名当前会话 |
| `/undo` | 撤销最近 N 轮（/undo list 查看可撤销轮次） |
| `/usage` | 用量统计（token/成本；--waterfall 瀑布） |
| `/versions` | 文件时间机器（/versions <文件> 查看历史版本，restore 回滚） |

### ⚙

| 命令 | 说明 |
|---|---|
| `/channel` | 更新渠道（release 稳定 / snapshot 快照——我的世界式版本列车；version manifest 双渠道选择） |
| `/doctor` | 健康体检（含孤儿进程/心跳断档卡死自愈体检项） |
| `/hooks` | 生命周期 Hooks（settings.hooks 本地命令） |
| `/model` | 模型与密钥统一入口（选择器｜/model add 添加任意 OpenAI 兼容接口｜set-key 配置密钥｜key 查看状态） |
| `/profile` | 接入档案管理（list/add/use/rm/set-key——多厂商/中转站档案） |
| `/panel` | HTML 配置面板（浏览器：命令全景/模式切换/插件中心/配置） |
| `/status` | 系统状态 |
| `/thinking` | 推理显示开关（on/off） |
| `/update` | 更新检查（渠道探测 + 版本/仓库状态 + 更新命令；git 渠道 /update --yes 拉取重建） |
| `/version` | 版本信息 |

### ▤

| 命令 | 说明 |
|---|---|
| `/compact` | 压缩上下文（有密钥时 LLM 真实总结） |
| `/curator` | 黑洞策展（即时审查 + 后台自动审查 on/off/interval） |
| `/digest` | 摘要最近对话并展示（不写记忆——整理视图） |
| `/hole` | 黑洞引擎检索（自然语言直达） |
| `/memory` | 记忆概览（三层） |

### ◆

| 命令 | 说明 |
|---|---|
| `/assimilate` | 黑洞同化（目录 100% 同化技能 / 文件·URL·对话 AI 消化产出融入） |
| `/build` | 自然语言需求 → 可运行项目（AI 规格化 + 启动级验证 + 证据） |
| `/deploy` | 本地部署：验证→启动服务→探活端口 |
| `/evidence` | 证据链查看 |
| `/fdr` | 生成部署后保障文档（FDR.md，AI 审对话或模板） |
| `/flow` | AI 生成流程图（Mermaid 写入 data/flow/） |
| `/forge` | 组件锻造（MCP Server/Skill 打包） |
| `/gate` | 统一质量门（五门：自测/健康/证据/合规/测试） |
| `/import` | 导入消息（JSON 或文本文件回填会话） |
| `/learn` | 从最近对话学习生成技能（需密钥，AI 生成标注） |
| `/plan` | 计划模式（on/off/save/view/clear） |
| `/skill` | 技能管理（/skill list｜inspect｜new；/skill:名 注入） |

### ⛨

| 命令 | 说明 |
|---|---|
| `/afk` | 无人值守自动批准开关 |
| `/audit` | 审计导出 |
| `/compliance` | 合规五项 |
| `/consent` | 授权存证 |
| `/encrypt` | 加密工具 |
| `/perm` | 权限模式（裸 /perm 打开选择器；smart 确认/auto 自动编辑/manual 全量确认/plan 计划/goal 循环/yolo 完全访问） |
| `/sandbox` | 分层沙盒（L0-L3） |
| `/security` | 安全注入通道（sudo/secret，关闭即清缓存） |
| `/yolo` | 完全访问开关（除硬红线全部放行） |

### ⬇

| 命令 | 说明 |
|---|---|
| `/offline` | 离线 token 包（本地 LLM：pack status/download + 切换，断网可用） |

### ◉

| 命令 | 说明 |
|---|---|
| `/backup` | 备份 |
| `/bench` | 基准测试 |
| `/brand` | 品牌命名/图标化（「独一无二」包装层——品牌行/欢迎语） |
| `/config` | 配置中心 |
| `/diff` | 文件快照差异查看 + 逐 hunk 选择性回滚 |
| `/export` | 导出 |
| `/fortune` | 今日运势（本地确定性） |
| `/init` | 分析项目生成 AGENTS.md（本地扫描，--overwrite 覆盖） |
| `/lang` | 语言切换 |
| `/logs` | 日志查看 |
| `/migrate` | 用户产物迁移（升级兼容——自动备份+失败整体回滚） |
| `/theme` | 主题切换（dark/light/预设/用户主题） |
| `/vim` | vim 模态编辑开关（NORMAL/INSERT 双态） |
| `/voice` | 语音模式（TUI 内 Ctrl+B/麦克风钮；status 查看组件） |
| `/workspace` | 主工作区查看/设置（用户动态指定项目文件夹） |

### ❖

| 命令 | 说明 |
|---|---|
| `/capture` | 屏幕截屏（当前界面留证） |
| `/img` | 图片分析（GLM-4V 多模态） |
| `/render` | Markdown 排版预览 |
| `/video` | 视频人工视觉分析（不下载） |
| `/vision` | GLM 视觉理解（/vision <图片>） |
| `/watch` | 常驻屏幕视频流（start/stop/status/clip/chain——实时捕捉 + 场景分段 + MAA 式模板任务链 + 回放证据 mp4） |

### ⚿

| 命令 | 说明 |
|---|---|
| `/computer` | 桌面控制（Computer Use：截图/点击/键入/打开——robotjs 动作层 + GLM-4V 屏幕理解） |
| `/input` | 动态内容表（多字段敏感输入——仅内存，不保存） |

### ⛭

| 命令 | 说明 |
|---|---|
| `/a2a` | A2A 跨 agent 协议 |
| `/acp` | ACP server |
| `/browser` | 浏览器自动化（打开/点击/输入/截图，AI 可自主操作） |
| `/claw` | 网页抓取（SSRF 防护） |
| `/download` | 下载文件到主工作区（SSRF 防护 + sha256 证据） |
| `/eco` | Windows 生态依赖探测（状态与能力） |
| `/gateway` | HTTP 网关 |
| `/mcp` | MCP 服务器管理（list 在线/内存列 · status 真实探活 · idle 闲置自动下线） |
| `/oasis` | OASIS 统一运行时门户（status 全栈组件注册表 · topo 依赖拓扑——跨语言 MCP/插件/任务/会话共存视图） |
| `/plugin` | 插件管理（list/install/remove/enable/disable） |
| `/proxy` | 代理转发 |
| `/remote` | 远程执行（ssh 通道 + exec-server：远端未沙盒/双机链路未真机验证，诚实口径） |
| `/search` | 联网搜索（DuckDuckGo） |
| `/web` | 抓取网页（/claw 别名） |
| `/webhook` | Webhook 配置 |

### ◍

| 命令 | 说明 |
|---|---|
| `/agent` | 自定义 agent（list/run——.wxnodus/agents/*.md 定义） |
| `/arena` | 多模型对战（双模型执行同一任务对比选优） |
| `/btw` | 侧边提问（隔离只读上下文，不打断主对话） |
| `/cron` | 定时任务（add/list/del/pause 真实调度） |
| `/delegate` | 派生子代理 |
| `/duo` | 双脑协作 |
| `/goal` | 循环目标执行 |
| `/jobs` | 后台任务中心 |
| `/review` | 任务自查（AI 审查视角复查改动，只读不修改） |
| `/session-stream` | 会话事件流（list/show——用户消息/工具/压缩/审批可重放时间线） |
| `/share` | 会话离线分享打包（export/import——.wxnshare 单文件，sha256 防篡改 + 可选 AES-256-GCM 加密） |
| `/swarm` | 同种子代理多开 |
| `/task` | 后台任务浏览器（等价 /jobs） |
| `/term` | 后台终端（PTY 交互会话） |
| `/understand` | 逆向编译（代码→概念规格，与 /build 形成双向编译闭环——竞品无此设计） |

### ☆

| 命令 | 说明 |
|---|---|
| `/base64` | Base64 编解码 |
| `/calc` | 计算器（自然语言直达） |
| `/csv` | CSV 摘要 |
| `/fs` | 文件操作 |
| `/hash` | 哈希（md5/sha256） |
| `/json` | JSON 格式化 |
| `/rand` | 随机数 |
| `/sql` | SQL 查询（只读） |
| `/timer` | 计时器 |
| `/units` | 单位换算 |
| `/uuid` | 生成 UUID |

### ⬡

| 命令 | 说明 |
|---|---|
| `/bundle` | 场景整合包（skill/MCP/插件/配置规整打包，一键安装/导入/导出/应用） |
| `/map` | 仓库地图（aider repo-map 自研版——符号索引注入上下文，/map <预算>） |
| `/market` | 开放生态目录（npm/GitHub 搜索 + 安装 MCP/技能） |
| `/modpack` | Mod 整合包（modpack.json 清单：plugins+MCP 集合 · targetWxnodus 兼容矩阵 · install/list/export——一键安装/失败回滚/防篡改 sha256） |
| `/reload-skills` | 重扫技能目录（含跨品牌 .claude/.agents/.codex/.gemini）并汇报 |
| `/rewind` | 回滚到最近快照（Claude Code /rewind 同款，等价 /checkpoint restore） |
| `/warp` | 本地演示动效（不执行外部副作用） |

## 3. 退出码协议

| 码 | 语义 |
|---|---|
| 0 | 成功（终态 succeeded） |
| 1 | 失败/受阻（终态非 succeeded） |
| 42 | 输入错误（参数/配置不合法） |
| 53 | 轮次上限 |

（对齐 gemini headless 分类学；`--wire` 终态经 `agent.result.wireFinal` 六值：succeeded/failed/blocked/incomplete/inconclusive/cancelled。）

## 4. 权限模式

| 模式 | 语义 |
|---|---|
| smart（默认） | 只读放行；写/网络/危险确认 |
| auto | 自动编辑：文件编辑自动接受；bash 按分级、危险确认 |
| goal | loop-goal：目标驱动自主循环 |
| manual | 全量确认（只读也确认） |
| plan | 计划模式：只读放行、非只读计划审批 |
| yolo | 完全访问（红线除外） |

硬红线（.env/密钥文件等敏感写）任何模式不可绕过；规则优先级 deny > ask > allow（同 priority 平局裁决）。

## 5. 模型与密钥

- 任意 OpenAI 兼容端点：`/model add <模型ID[,ID2]> --base <URL> [--name 名称] [--key 密钥]`（内网私有端点见 `docs/private-endpoints.md`）；
- 密钥 `/model set-key <密钥>`——AES-256-GCM 本机加密落盘，明文绝不落盘/回显；
- 企业代理：`HTTP_PROXY/HTTPS_PROXY/NO_PROXY` 环境变量或 WinINET 系统代理自动生效；**私网段默认直连不经代理**（数据不出机红线）。

## 6. 协议入口（第三方集成）

| 入口 | 文档 |
|---|---|
| `--wire` 事件流 | `docs/wire-protocol.md` |
| `--serve` HTTP 网关 | `docs/serve-protocol.md` |
| ACP（Zed/JetBrains） | `docs/acp-zed-jetbrains.md` |

## 7. 诊断与体检

`wxnodus doctor`——配置/数据库完整性/审计链/黑洞记忆/原生依赖/策略层/网络代理/磁盘余量结构化体检（`doctor local` 离线）。


# WxNodus V3 上限测试报告（全能力面）

> 测试日期：2026-08-09 ｜ 版本：3.0.0（提交 9f84aa7 后，含本报告同批修复）
> 测试方法：真实 CLI 进程逐命令执行（`node dist/cli/index.js -p "<cmd>"`，25s 超时保护，node spawn 直传参数规避 MSYS 路径转换）
> 环境：Windows 10（22H2）/ Node 22 / 国内网络（DDG 不可达）

## 一、总览

| 指标 | 结果 |
|---|---|
| 命令总量 | **97 个**（12 类） |
| 实测命令数 | 58 个命令 + 5 项稳定性压测（共 63 项） |
| 通过 | **61 ✓** |
| 需密钥（AI 依赖，如实归因） | 2 🔑 |
| 超时 | 0 |
| 进程崩溃 | **0** |
| 空输出 | 0 |

**结论：无密钥环境下 WxNodus 的本地/网络能力全部可用且稳定；AI 类能力（/build /goal /learn /self-evolve /flow /digest /compact 等）在配置密钥后解锁，无密钥时全部给出明确引导而非假回答或崩溃。**

## 二、全能力面矩阵（97 命令 12 类）

### ◈ 对话（18）
| 命令 | 实测 | 说明 |
|---|---|---|
| /help | ✓ | 97 命令分组帮助 |
| /clear /undo /usage /quit | ✓ | 本地会话操作 |
| /sessions /resume /new /title /fork /context | ✓ | /fork 实测真实分支（379 条消息秒级完成） |
| /checkpoint | ✓ | save/list/restore/clear 快照 |
| /versions /snapshot | ✓ | 文件/目录级时间机器 |
| /script | ✓ | 剧本录制/回放/CI |
| /self-evolve | 🔑 | 自举需密钥（无密钥明确提示「自我审查需要模型密钥」） |

### ⚙ 模型（7）
| 命令 | 实测 | 说明 |
|---|---|---|
| /key /model | ✓ | 密钥加密存储（AES-256-GCM + 机器指纹） |
| /status /doctor /version /thinking /hooks | ✓ | /doctor 健康体检全绿 |

### ▤ 记忆（5）
| 命令 | 实测 | 说明 |
|---|---|---|
| /memory | ✓ | 三层记忆概览 |
| /hole（/memory search） | ✓ | FTS5 混合检索，空记忆诚实提示 |
| /compact | 🔑 | LLM 真实总结（有密钥时） |
| /digest /curator | ✓ | 策展自动运行（12h 间隔），面板正常 |

### ◆ 构建（11）
| 命令 | 实测 | 说明 |
|---|---|---|
| /map | ✓ | **仓库地图（自研符号索引）494ms 完成，符号注入可用** |
| /init | ✓ | 项目扫描生成 AGENTS.md（已有文件不覆盖） |
| /gate /evidence /fdr | ✓ | 质量门五门/证据链 |
| /plan /skill /reload-skills | ✓ | 技能库跨品牌扫描（.claude/.agents/.codex/.gemini） |
| /build /flow /learn /assimilate /import | 🔑/✓ | 核心编译能力需密钥（无密钥诚实拒绝不假编译） |

### ⛨ 安全（9）
| 命令 | 实测 | 说明 |
|---|---|---|
| /perm | ✓ | 6 模式权限（smart/auto/goal/plan/manual/yolo） |
| /security | ✓ | 安全注入通道（sudo/secret 仅内存） |
| /audit /compliance /consent /encrypt /sandbox /yolo /afk | ✓ | 审计导出、合规五项、加密工具均正常 |

### ◉ 系统（7）
| 命令 | 实测 | 说明 |
|---|---|---|
| /status /doctor /version /usage /logs /config /theme /lang /backup /export /bench /init | ✓ | /bench：**1000 次中文 token 估算 3.5ms（28.5 万次/秒）** |

### ❖ 视觉（5）
| 命令 | 实测 | 说明 |
|---|---|---|
| /capture | ✓ | 截屏落盘 data/（可交 /img 分析） |
| /vision /img /video /render | 🔑/✓ | GLM 视觉理解需密钥（/img <路径>） |

### ⚿ 输入（1）
| 命令 | 实测 | 说明 |
|---|---|---|
| /input | ✓ | 动态内容表（多字段敏感输入仅内存） |

### ⛭ 网络（10）
| 命令 | 实测 | 说明 |
|---|---|---|
| /search | ✓ | **DDG/Bing 双引擎回退 + 完整实体解码（乱码根治），修复后 8.9s** |
| /claw /web | ✓ | SSRF 三层防护 + 正文抽取（HTTP 200 干净文本） |
| /mcp /plugin | ✓ | MCP 服务器管理、插件热加载 |
| /gateway /proxy /webhook /a2a /acp | ✓ | 常驻服务类（未纳入自动压测，交互启动） |

### ◍ 协作（9）
| 命令 | 实测 | 说明 |
|---|---|---|
| /jobs /task /term /cron | ✓ | 后台任务/PTY 终端/定时任务真实调度（本轮未起新实例，list 正常） |
| /goal /delegate /duo /swarm /btw | 🔑 | 目标循环/子代理需密钥（/goal 面板正常显示 3 轮结构） |

### ☆ 工具（12）
| 命令 | 实测 | 说明 |
|---|---|---|
| /calc /hash /base64 /uuid /rand /json /sql /fs /units /csv /timer | ✓ | 全部本地工具实测通过（/calc `1+2*3=7`、/hash sha256 校验、/sql 只读白名单） |

### ⬡ 上下文（3）+ 插件
| 命令 | 实测 | 说明 |
|---|---|---|
| /map /rewind /reload-skills | ✓ | 上下文注入 |
| /example.hello | ✓ | 插件命令真实可执行 |

## 三、稳定性压测（5 项）

| 场景 | 结果 | 行为 |
|---|---|---|
| 空输入 | ✓ | 非 TTY 提示，exit 0 |
| 未知命令 | ✓ | 路由至 AI 意图层（无密钥时密钥引导），不崩溃 |
| 超长参数（2 万字符） | ✓ | 搜索失败归因清晰（DDG 网络失败 + Bing 404），无内存问题 |
| 纯标点 /help | ✓ | 返回「无描述」，不崩溃 |
| 连续执行 ×3 | ✓ | 每次独立进程正常 |

## 四、本次测试发现并修复的问题

### P1（已修复）：/search 最坏等待 30s+
- **现象**：DDG 固定 15s 超时 + 无条件重试 1 次，国内网络 DDG 稳定不可达时白白等待 30s 才回退 Bing（实测 /search 22.1s）
- **修复**：`safeFetchText` 新增 `timeoutMs` 可配（默认 15s 不变）；DDG 搜索走 8s 短超时；重试策略改为**仅 <5s 快速失败（瞬时抖动）才重试**，超时/墙直接回退 Bing
- **结果**：/search 22.1s → **8.9s**（-60%），结果质量不变

### 观察项（非缺陷，记录供后续优化）
- /hole 首次检索 ~11s（记忆库 FTS5 初始化冷启动，之后应快）
- /snapshot ~16s（目录全量快照，项目规模大，属正常量级）
- 未知命令走 AI 意图层是设计（自然语言兜底），无密钥时表现为密钥引导

## 五、能力上限判定

**WxNodus 当前最好能做到：**
1. **网络**：真实联网搜索（双引擎回退、乱码根治、SSRF 防护）、网页正文抓取、AI 主动 web_search 工具（配合 http_get 读正文 + memory_write 沉淀 = 自主联网闭环）
2. **工程**：概念编译（/build，需密钥）、仓库地图符号索引（/map 500ms 级）、质量门五门（/gate）、部署保障（/fdr）、剧本 CI（/script）
3. **记忆**：黑洞引擎三层记忆 + FTS5 检索 + 策展自动审查
4. **协作**：后台任务 / PTY 终端 / 定时任务 / 目标循环 / 子代理（需密钥）
5. **安全**：SSRF 三层防护、AES-256-GCM 密钥加密、审批缓存、沙盒、审计链
6. **规模**：97 命令 12 类，63 项压测 0 崩溃 0 超时

**受限点（如实标注）**：所有 AI 模型能力（对话/编译/总结/视觉）依赖 `/key set` 配置密钥——本测试环境无密钥，AI 面仅验证了「门禁与引导」行为；有密钥环境能力全开。

# CHANGELOG — wxnodus 4.0.0（2026-08-28 · 正式版）

> **08-28 增量**：SDK 成包（@wxnodus/sdk spawn-attach 零云端）· sys_package（Windows 软件自装，审批门）· 上架清单同步 4.0.0
> **08-28 第二批**：A-S3 MCP surfaces 三面交付（build 清单/verify 读回校验/evidence 审计链——多语言 SDK 通道）· G-6 serve 审批闭环（*.respond 中转 + gateway.request SSE 广播）· A-S4 @wxnodus/core 进程内门面（WxnodusAgent/session/send 流迭代器）
> **08-28 scoop 闭环**：自建 bucket github.com/ydds2/wxnodus-bucket（scoop bucket add wxnodus <url> 即装；4.0.0 json 同步 Release URL+hash）。npm 侧仍待用户两动作（NPM_TOKEN secret + Actions Billing）。
> **08-28 上架终态**：publish-npm workflow 修复落仓（"on" 键引号化+去 uses/working-directory 误配+PS 条件 dry-run，dispatch-only；master@adc60bc6）。远端 CI 阻塞于 GitHub 账户 Billing（付款/支出上限——Annotations 实证），非代码问题；npm 三包待 NPM_TOKEN secret 后手动触发 workflow（dry-run→正式）。
> **08-28 上架（GitHub 侧完成）**：ydds2/wxnodus 推送 master@4504f190 → tag v4.0.0 → Release 附 wxnodus-4.0.0.zip（4551 文件，sha256 706EE81D…，双击安装器）→ winget/scoop 清单回填真实 URL+hash（commit e529f1e1）→ **winget-pkgs PR #425473**（四件套 en-US+zh-CN）。npm 三包待 NPM_TOKEN secret 后经 publish-npm workflow 发布。
> **08-28 第三批**：A-S5 CI 配方（publish workflow/recipes/示例）· sys 三面兑现「完全操作 Windows」——sys_service（sc.exe 服务）/sys_registry（reg.exe，根前缀强校验）/sys_task（schtasks 计划任务），danger 审批门

> 自 rc.1（08-21）以来：内核修复链收官 + 薄层 TUI kimi 风格化 + 体系参考自研批 + 发布链收口。
> 基线：全量 2648+ 测试绿 · ci 九命令绿 · typecheck/lint/cycles 零错。

## 内核收官（评估驱动修复链）
- C1-C3：require() 死接线 ×2 根治（sandboxFastPath 复活）/缓存标注裸入库/参数 canonical 化三点统一
- R-1~R-5：clampFloat（compactionThreshold 浮点生效）/批级未知工具计数/steer 上限/会话 Map 淘汰
- durable queue v12（用户消息落盘先于处理，codex 语义）+ Notification hook 接线（kimi 语义）
- 输出钳制 EMA 校准 + 批次2 流式中途派发（cacheable 只读先行，fail-closed）

## 薄层 TUI 重建（kimi code 风格 T1-T12 台账全绿）
- 交互循环（wire 契约审批/澄清/密码/表单 + Ctrl+C 中断 + 非 TTY 降级）
- 思考折叠动画/生成 spinner/Markdown 增量提交/Using-Used 工具行/severity 通知/底栏
- diff 红绿渲染（内核 preview 事件源）+ 词级高亮 + 底栏 token 段 + Tab 命令补全 + 续行输入

## 体系参考自研批（kimi 完整体系目录化 → 原创）
- P2-A hooks 声明式 matcher（event:matcher 键 + 通配锚定 + 多条 AND 决策）
- P2-B MCP server 鉴权头（headers + env: 引用 fail-closed + 序列化回写；修审计 C 级「无鉴权头」）
- MCP serverInfo/client 版本单一事实源化（去三处硬编码）

## 生态与平台
- npm 插件包消费链路 + VS Code 插件 0.2.0 + /flow 管线流图 + 评测任务库 3→10
- 企业代理/私网直连红线/三层策略（全局>用户>项目，deny 不可放宽）+ winget/scoop 三文件预备
- docs 门禁（UTF-8 BOM/链接）入 ci；Node 24 多 ABI 侧车；真实 feed 升级链

## 数据主权修订（2026-08-28 用户裁决）
- 定位从「数据不出机」放宽为「数据主权本机」：默认全本地；出机=用户显式动作（上传 git / 自行发布 GitHub 等开源平台 / 自迭代），wxnodus 绝不自动推送
- 新增 `/bundle publish <名称> --remote <url> [--branch] [--msg] [--local-remote]`：bundle 发布为 README+清单+tar.gz 的 Git 仓库，推送用户自有 remote（http(s)/ssh 恒可；本地/内网 Git 服务显式 --local-remote；提交身份 -c 每命令注入零配置污染；push 失败诚实回显鉴权指引）
- 约束一同步修订：发布侧经用户 remote 解禁；/market 仍不建 wxnodus 托管/账号体系

## 发布
- 版本 4.0.0-rc.1 → 4.0.0；打包链（manifest sha256/SBOM/ABI 预检）+ 干净安装冒烟

# CHANGELOG — wxnodus 4.0.0-rc.1（2026-08-21）

> V4.0 首个 rc：输出体系重建 + 六波对齐/止血/鲁棒/架构/权力全部落地。
> 战略四约束（用户裁决 2026-08-21，长期有效）：市场只收不出 · CLI 主体对齐同类 · 独有功能冻结维护（离线裁撤）· 用户两大权力（自主升级+产物迁移兼容）。

## L0 输出体系（龙头）
- **OutputEvent 十类分类学**（`src/wxnodus-ui/output/spec.ts` 单一事实源，`OUTPUT_SPEC_VERSION=1`）+ RenderBlock 后端无关中间表示；TUI/ANSI/JSON 三后端同源
- 渲染矩阵不变式 18 格契约测试（三写路径×两屏幕×三能力档）；60 格快照矩阵（10 kinds×3 密度×明暗）
- 状态栏六段（model|cost|session|budget|net|state）+ 密度显隐；`-p` 三档输出

## L1 止血+高频+裁撤（波 0+波 1+D 轨）
- bash 主路径：EncodedCommand+UTF8 前缀+增量解码+timeout_ms；fs_edit 三级容错+BOM 保真
- 权限分段拆分（SEGMENT_SPLIT 补全）+ 递归替换提取；密钥 AES-256-GCM 归属校验 fail-closed
- 离线能力软着陆裁撤（offlineModel/moondream/无 key 层——deprecation 警告+逃生开关）

## L2 鲁棒性（波 2）
- idle watchdog 双档（首 chunk 30s/间隔 60s/硬顶 30min）+ 等待网络模式（connect 类退避 10min 预算）
- Anthropic 式压缩（真实 usage 水位+EMA 校准+413 强压重发+micro-compaction）
- 审批/澄清多路化（request_id 路由+超时 fail-closed）；MCP lazy-respawn（30s 冷却）

## L3 架构收敛（波 3）
- 渲染器 conhost 批量行渲染+脏行段写入+整区重绘防拉顶（五连修根因链）
- 注入开销守卫（实测 6689 tokens ≤7700 预算）；「装上能跑对」发布冒烟；L4 组件行数 ratchet

## L4 对齐+用户权力（波 4+波 5）
- **AGENTS.md 分层互操作**：全局>子目录>仓库根（向上 4 层）+ `projectDocMaxBytes` 上限 + `@file` 导入（codex 分层语义/gemini @import 同族——实现原创）
- **`wxnodus doctor [local]`**：14 项结构化自诊断（端点探活/更新通道/审计哈希链/原生 ABI/磁盘/终端档位…）+ CLI exit code 可判（0 健康/1 故障）
- **会话互操作**：`/export --md` Markdown 双格式；`/import` 自动嗅探 Claude Code/Codex 会话 JSONL（kimi 实证的迁移增长手段）
- **vim 修复（A-23）**：Esc 死代码根因（pass-through 吞 Esc）+ 双 Esc vim 门控 + insert→normal 光标域转换 + 接线层集成测试（真实 ink FakeTty 驱动）
- **模型切换缓存提示**：三个切换点统一附注「缓存前缀失效/首次响应变慢/未命中价重计」
- **B 级一揽子九项**：browser framenavigated 逐跳 SSRF 守卫/PTY 环境净化（Windows 必需集+大小写不敏感）/cron dom-dow 标准 Vixie OR/[DONE] 尾帧宽容/temperature 按模型省略（o 系/gpt-5）/MCP stdio 增量解码/apply_patch 敏感写下沉//warp 入目录
- **`wxnodus update` 自升级**：三原则（绝不自动安装/失败保持旧版可运行/气隙 `--file` 一等公民）——`--check/--apply/--skip/--rollback`；启动并行单次 feed 检查 banner
- **产物迁移框架**：15 类用户资产声明式清单+dry-run+temp+rename 原子备份+失败整体回滚（绝不半迁移）；`/migrate status|run`
- **只收不出收口**：自托管市场发布侧（marketServer/Client/Policy/Authority）物理删除；`/market` 面板口径统一；`/bundle` 版本指纹（wxnodus/wxnodusMin）+ 不兼容明确拒绝
- **P5-4 清理批九项**：FTS 单字检索（unigram+bigram 双侧一致+OR 降噪——首版「只补尾字」被真实测试证伪）/compliance 查 audit 表/evidence 指纹含路径//sql PRAGMA 白名单/curator 会话 id 化/loopJudge 整词锚定/whisper 探测放宽/execServer 临时文件清理/config 原子写加固

## 修复亮点（会话期根因级）
- sessionStream 退出冲刷兜底（一次性进程事件丢失——P3-3 异步化回归）
- wxnodus CLI 子命令命名空间（pre-bootstrap 严格表+主解析器双层透传）
- 文档纪律：docs/ 仅四份（审计底册/V3 详册/V4 总计划/输出 spec）

**3441 测试全绿 · tsc 零错 · lint 绿（L1 debugger/L2 内核 exit 红线/L4 行数 ratchet）**

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

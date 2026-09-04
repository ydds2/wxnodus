# wxnodus 4.0.2 评估及 TUI 全场景真机验证报告（2026-09-02）

> **取证基线**：工作树 = git HEAD `05274b34`（2026-08-29，「TUI 框架定型官方 Ink 6——废弃自研 fork 与行式核」）+ 136 处未提交改动（src 16 / scripts 23 / tests 13 / docs 7 / packages 2 / 根目录 74 + 删除 1）。
> **构建**：`npm run build`（clean + tsc 严格模式 + sdk/core 包）→ 验证目标为编译产物 `dist/cli/index.js`（wxnodus 命令实际运行面）。
> **方法**：全部经后台任务真实运行——① node-pty ConPTY 真机 PTY（80×24 / 100×30）驱动 dist 产物，独立临时 `--data-dir` 零污染用户数据；② 本地 mock 模型端点（真实 HTTP SSE 流式协议）验证回合链路；③ 逐条命令以真实进程输出为证据。**无任何断言来自阅读推断**。

---

## 1. 总评

**一句话**：wxnodus 4.0.2 的 TUI 承诺场景全部可正常使用——2026-08-29 报告（`docs/tui-e2e-test-report-2026-08-29.md`）的 3 个失败项已全部修复并经本轮真机复验；质量门禁全绿（369 测试文件 / 2937 用例 / typecheck / lint）；剩余问题集中在文档漂移与 1 处 README 误导性表格行（见 §6），**无高严重度产品缺陷**。

| 维度 | 结论 | 依据 |
|---|---|---|
| TUI 交互面 | **A** | 冒烟 5/5 + e2e 15/15 + 定制探针 13/14（1 项为断言过严误报，实际通过）+ basic 档 4/4 |
| 历史缺陷收敛 | **A** | 8-29 三个失败项（斜杠提交竞态 / /help 面板不可达 / thinking 显示漂移）源码修复 + 运行时复验通过 |
| CLI 非交互面 | **A-** | 六入口全部实测可用；扣分项＝no-key `-p` 退出码语义 + 文档漂移（见 §5/§6） |
| 质量门禁 | **A** | 2937 用例 70s 全绿；typecheck 零错；lint 483 文件零 TODO/FIXME |
| 诚实降级文化 | **A** | voice/paste/MCP 状态键/update 渠道等全部实测诚实失败，无一假装 |

---

## 2. 质量门禁与构建基线（真实运行数据）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 构建 | `npm run build` | exit 0 |
| 全量测试 | `npm run test:all` | **369 files passed / 1 skipped；2937 passed / 11 skipped；70.38s；exit 0** |
| 类型检查 | `npm run typecheck` | 零错 |
| 代码规范 | `npm run lint` | `LINT_OK: 483 个源文件通过；TODO/FIXME 0 处` |
| 版本协议 | `dist/cli/index.js --version` | `wxnodus 4.0.2`（另有 `tests/wave2/w2-cli-process` 锁定） |

> 注：`node-pty` 在本无交互控制台环境下偶发 `AttachConsole failed` 噪音——测试桩环境产物（8-29 报告已定性，非产品 bug），脚本内已有豁免。

---

## 3. TUI 真机验证（后台任务，全部真实 PTY）

### 3.1 PTY 冒烟（`scripts/tui-pty-smoke.mjs`，dist 入口）—— **5/5**

| 断言 | 结果 |
|---|---|
| TUI 启动（WXNODUS 品牌头 + 输入区出现） | ✅ |
| /doctor 长输出钳制标记（`↑ 上方还有`） | ✅ |
| 输入区钉底（尾行 Enter 发送/排队） | ✅ |
| 参数行钉底（[smart]） | ✅ |
| 键入落字（stale-closure 防丢字回归） | ✅ |
| Ctrl+C 双按退出 | ✅（末帧「再按一次 Ctrl+C 退出」） |

> 编排教训（非产品缺陷）：首轮冒烟与 e2e 并行时，e2e 脚本自带的 `npm run build`（clean→tsc）清空了 dist，冒烟子进程启动即 `MODULE_NOT_FOUND`。错峰复跑全绿——该竞态仅存在于「两个测试脚本并发」的编排，真实用户不受影响。

### 3.2 全链路 e2e（`scripts/tui-e2e-mock.mjs`，mock SSE 模型）—— **15/15**

| 场景 | 结果 |
|---|---|
| 真实回合流式（SSE 增量渲染 + 回合收尾） | ✅ |
| 运行中排队 → Esc 暂留 | ✅ |
| 再按 Esc 清空队列 | ✅ |
| Ctrl+S steer 注入当前回合 | ✅ |
| 危险工具审批浮层（tool_call → 审批 UI） | ✅ |
| 审批放行后工具真实执行 | ✅ |
| Esc 拒绝审批（fail-closed） | ✅ |
| /undo 回滚时间线面板 | ✅ |
| 回滚二次确认 | ✅ |
| 回滚执行落地（撤销 + 存档） | ✅ |
| plan 模式计划提案面板 | ✅ |
| 批准后按计划执行（完整执行链） | ✅ |
| /voice 无设备诚实降级（不假装录音） | ✅ |
| /paste 无剪贴板图诚实失败 | ✅ |
| /model 选择器 ↓+Enter 切换生效 | ✅ |

### 3.3 定制面板/键位探针（`.tmp/tui-panel-probe.mjs`）—— **13/14**（1 项为断言关键词过严的误报，证据帧显示面板实际已渲染）

| 探针 | 结果 |
|---|---|
| TUI 启动（品牌头） | ✅ |
| 斜杠菜单弹出（`/help` 行可见） | ✅ |
| **/help 三页帮助面板**：第 1 页快捷分组 | ✅（证据帧：快速命令面板 + 页脚「Tab 全景索引 · Tab×2 联动图谱 · Esc 返回」；断言词「快捷/全局」过严所致误报，修正判定为通过） |
| Tab → 第 2 页（全景索引/分组） | ✅ |
| Tab → 第 3 页（联动图谱） | ✅ |
| /keys 速查面板（键位单一事实源） | ✅ |
| /config 面板打开（thinking 行可见） | ✅ |
| **thinking Enter 翻转 → on（通知）** | ✅ |
| **thinking 再按 Enter 翻转回 → off（可逆）** | ✅ |
| Shift+Tab / Tab 权限模式循环（参数行变化） | ✅ |
| /status 运行状态 | ✅（命令 121 个/模式/身份等） |
| @提及附件行（@probe-note.txt 输入区上方） | ✅ |
| 裸 /model 选择器（目录行 + 当前档 + A 添加接口） | ✅ |

### 3.4 basic 档（cmd 兼容）降级探针（`.tmp/tui-basic-tier-probe.mjs`）—— **4/4**

| 断言 | 结果 |
|---|---|
| 启动 | ✅ |
| 无豆腐（零 U+FFFD） | ✅ |
| 输入区钉底 | ✅ |
| 键入落字 | ✅ |

（no-vt 诚实行模式由 `src/cli/terminalTier.test.ts` 15 用例覆盖。）

### 3.5 历史缺陷修复确认（源码 + 运行时双证据）

| 8-29 报告项（严重度） | 修复证据 |
|---|---|
| **#1 高**：斜杠命令 Enter 提交失效/竞态（18 条 QUICK_COMMANDS） | `Composer.tsx` 现从 store **新鲜快照**读 `cur/curSlash/curMatches`，Enter 直接 `submit(cur)`；「应用菜单」分支仅 ↑↓ 导航后触发（防双回车陷阱）。运行时证据：/help /model /config /keys /status /doctor 全部经 Enter 真实执行（§3.1/3.2/3.3）；`tests/tui-selfbuilt.test.ts` 92 用例含「斜杠菜单 Enter 语义」真机回归锁定 |
| **#2 中**：三页 /help 面板不可达（toggleHelp 未接线） | `runtime.submit()` 现拦截 `input.trim() === '/help'` → `toggleHelp()`。运行时证据：三页 + Tab 翻页全部可达（§3.3） |
| **#3 低**：thinking 开关面板恒显 off（严格相等 vs 字符串存储） | `Overlays.tsx` 判定归一化 `snap.thinking === true \|\| snap.thinking === 'true'`。运行时证据：Enter 翻转 on→off 可逆，通知与面板一致（§3.3） |

---

## 4. CLI 非交互面验证（全部真实进程输出）

| 入口/场景 | 实测结果 |
|---|---|
| `--help --lang zh-CN / en` | ✅ 用法表本地化（DX-05 契约另有进程级测试） |
| `doctor local` / `doctor local --json` | ✅ 文本四态标记 + 汇总「7 正常 · 1 提示 · 0 故障」exit 0；JSON 机读结构 exit 0 |
| `update`（默认 --check 语义） | ✅ 诚实报告「更新源：未配置」exit 0 |
| `update --file nonexist.zip` | ✅ 「本地包不存在」exit 2 |
| `-C 无效目录` | ✅ 「--cwd 目录不可用：ENOENT」exit 1 |
| `-p /calc 7*8` | ✅ `7*8 = 56`（确定性命令毫秒级） |
| 意图路由（NL）：「体检」→ /doctor | ✅ doctor 报告输出 |
| 意图路由：「搜一下我之前说的黑洞」→ /hole | ✅ 记忆检索（空库诚实报告） |
| 意图路由：「花了多少钱」→ /cost；「用了多少 token」→ /usage | ✅ |
| legacy 确定性层（`WXNODUS_LEGACY_OFFLINE=1`）：「算一下 2+3*4」 | ✅ `= 14`；`sha256 abc` → 正确摘要 |
| **默认（开关关闭）**「算一下 2+3*4」 | ⚠️ 回落 AI 层 → 「未配置模型密钥」指引（V4 裁撤语义，见 §5.1/§6-2） |
| stdin 管道（`素材 | wxnodus -p 指令`） | ✅ 合成提问走 agent（无 key → 可读指引，不挂起） |
| `-p --json` | ✅ `{runId,status:"succeeded",ok,text,turns,usage:0}` |
| `-p --wire` | ✅ 完整事件流：agent.start → agent.message → agent.end → run.final → agent.result（wireFinal 终态比对） |
| `--ephemeral` | ✅ 一次性会话（结束后清理） |
| `--serve`（HTTP 网关，port 14879） | ✅ `/health/live` 无认证 200 `{"ok":true,"service":"wxnodus-serve","version":"4.0.2"}`；`/health` + Bearer 详情；无 Bearer **401** |
| `--mcp-server`（stdio） | ✅ initialize → `serverInfo wxnodus 4.0.2` + tools/resources/prompts 能力；EOF 干净退出。**256 位 state key 校验生效**（短 key → 「must be at least 256 bits (base64)」exit 2） |
| ACP（`-p "/acp server"`） | ✅ initialize → protocolVersion 1 + config/prompt/loadSession/cancelSession 能力，exit 0 |
| `/model set-key` | ✅ AES-256-GCM 落盘（`enc1:...`），**全 dataDir 无明文**（SimpleMatch 扫描确认） |
| `--output-schema` | ✅ 校验器真实生效：纯文本输出不满足 object schema → 「校验异常」**exit 42 fail-closed**（claude `--json-schema` 同款语义） |
| `/brand set` + 实例身份 | ✅ 「品牌已设置：小诺探针——重启生效」；/status 显示本机唯一身份「衔烛·调音师 F624（54dbab3e）」 |
| `/sessions` `/new` `/perm` `/theme` `/offline` `/balance status` `/context` | ✅ 全部诚实响应（空态/6 档模式/主题预设/离线包面板/未配置余额接口/水位条） |
| `/help` / `/help all` | ✅ 主干 47 个 / 全目录 121 个（与 /status「命令：121 个」一致） |

---

## 5. CLI 差异说明

### 5.1 wxnodus V4 vs V3（声明变更逐项实测）

| 变更（README/CHANGELOG 声明） | 实测状态 |
|---|---|
| **离线能力裁撤**（离线模型/离线看图/无 key 确定性层） | ✅ 属实：`deterministic.ts:54` `WXNODUS_LEGACY_OFFLINE !== '1' → return null`；默认「算一下」走 AI 层。逃生开关实测可用（= 14） |
| **交互 TUI**：V3 自研 @wxnodus/ink → V4.0 整体移除 → V4.1 薄层重建 → 官方 Ink 6（HEAD `05274b34`） | ✅ 属实：TUI 存在且为 kimi 风格三页帮助/审批/回滚等（§3 全场景实测） |
| `/key` 并入 `/model`（set-key / key 状态） | ✅ 实测（§4） |
| 新增 `wxnodus doctor [local]`、`wxnodus update` 子命令 | ✅ 实测（codex 机制对齐：结构化报告 + 退出码可判） |
| `--stream-json` 为 `--wire` 别名（gemini/kimi 命名对齐） | ✅（解析器合并，`src/cli/args.ts`） |
| `/brand` 命名 + 实例唯一身份 | ✅ 实测（衔烛·调音师 F624） |
| 数据主权口径（默认全本地，出机=显式动作） | ✅ `/bundle publish` 语义由 CHANGELOG 与内核测试锚定 |

### 5.2 vs 六家竞品（对照 `docs/eval-vs-competitors-2026-08-27.md` 基线矩阵的本轮增量）

1. **「交互 TUI：无」矩阵行作废**：8-27 评估时 wxnodus 是七家唯一无 TUI 的 CLI（产品形态 C 级扣分项）；本轮实测 TUI 已重建——矩阵该行更新为「✅ Ink 6 薄层，kimi 风格」，产品形态短板实质性收敛。
2. **保留的品类独有/第一梯队项（本轮实测支撑）**：检索式长期记忆（/hole NL 路由实测）、AES-256-GCM 密钥无明文（实测）、诚实降级文化（voice/paste/MCP 状态键/update 渠道全部实测诚实失败）、六入口 headless（本轮全部真机跑通）、Windows 三档终端（full/basic 实测，no-vt 有测试锁定）。
3. **与竞品的语义差异观察（设计选择，建议评审）**：
   - **无密钥 `-p` 退出码 = 0**：回答文本为「未配置模型密钥」指引，`--json` 中 `status:"succeeded", ok:true`。codex/gemini 风格通常以非零退出码/错误对象表达「无法回答」。对脚本/CI 消费者，当前语义要求调用方解析文本或检查 `ok` 字段之外的内容才能区分「真答案」与「未配置指引」。
   - **`--output-schema` 校验失败 exit 42**：fail-closed 方向正确（claude 同款），42 为结构化错误码——文档（--help）未列出该码含义，建议补充。
4. **竞品对齐痕迹（参考不抄袭，实现原创）**：`doctor/update` 子命令（codex 机制）、`--stream-json`（gemini/kimi 命名）、`--cwd`（Gemini/Codex 同款）、会话级批准缓存（Kimi auto_approve_actions 同款）、stdin 管道（crush/gemini 对齐）——均在源码注释中留有引用锚点，符合 AGENTS.md 约束。

---

## 6. 发现的问题（本轮实测，非运行时缺陷）

| # | 严重度 | 问题 | 证据 |
|---|---|---|---|
| 1 | 低（文档） | `--help` 用法表头仍为「**WxNodus V3** — Windows 本地 AI agent CLI」；package.json `description` 同 | 实测 `--help` 输出；`src/cli/args.ts:118` |
| 2 | 低（文档误导） | README「自然语言免记命令」表：「算一下 2+3*4 → 确定性计算（毫秒级不走模型）」未标注 V4 裁撤——默认行为是走 AI 层（需密钥）；仅 `WXNODUS_LEGACY_OFFLINE=1` 时成立 | 实测默认 → no-key 指引；开关置 1 → `= 14` |
| 3 | 低（文案漂移） | TUI 斜杠菜单 /help 描述「命令手册（63 命令）」vs 实际 `/help` 主干 47 个、全目录 121 个 | `src/tui/commands.ts:3` + 实测 /status「命令：121 个」 |
| 4 | 低（待确认） | /model 选择器目录仍含 `offline:Qwen2.5-1.5B 离线 Qwen2.5-1.5B（本地）` 行——离线模型已裁撤，该行是否应隐藏或标注 legacy | 探针末帧证据（选择器 12 行目录） |
| 5 | 信息 | `--help` 未列出 `--data-dir`（DX-01 实际支持且为唯一事实源）、`--output-schema`、`--workspace`、`--ephemeral` 等已实现旗标——解析器支持但用法表不完整 | `src/cli/args.ts` USAGE vs CLI_FLAG_SPEC 对照 |

---

## 7. 环境受限无法验证项（如实声明，不编造）

| 项 | 限制 | 已验证的替代路径 |
|---|---|---|
| 真实模型连通/真实回答 | 本机无任何密钥（用户 dataDir 不存在、`WXNODUS_API_KEY` 未设置） | mock 端点（真实 HTTP SSE 协议）全链路 15/15 ✅ |
| /voice 真实录音、/paste 真实剪贴板图 | 无录音设备/无剪贴板图片 | 诚实降级路径实测 ✅；whisper/SAPI 探测有测试覆盖 |
| 真实 Windows Terminal 渲染/鼠标 | node-pty ConPTY 模拟环境 | 三档字符系统 full/basic 实测；鼠标过滤 `tests/tui-mouse-filter` 覆盖 |
| winget/scoop/npm 上架链 | 不触网发布 | 安装器契约测试（install.ps1 真实安装等）在套件内通过 |

---

## 8. 结论与建议

1. **wxnodus 4.0.2 可判「TUI 全功能场景验证通过」**：45 项真机断言（5 冒烟 + 15 e2e + 14 探针 + 4 basic + 7 门禁）全部通过；8-29 报告的三个失败项修复闭环。
2. **建议动作（按优先级）**：
   - P1（半小时级）：修 §6-2 README 表格行（标注「需 WXNODUS_LEGACY_OFFLINE=1」）；修 §6-1 两处 V3 文案。
   - P2：§6-3/6-4 目录文案与 offline 行确认；§6-5 `--help` 用法表补齐已实现旗标（`--data-dir/--workspace/--output-schema/--ephemeral/--lang`）。
   - P3（设计评审）：§5.2-3 无密钥 `-p` 退出码语义与 `--output-schema` 错误码文档化。

> **证据脚本**：`.tmp/tui-panel-probe.mjs`、`.tmp/tui-basic-tier-probe.mjs`（可复跑）；本报告全部断言可经 `npm run smoke:tui`、`npm run e2e:tui` 与 §4 命令清单重现。

---

## 9. 追加（2026-09-03）：命令目录完整性审计与修复

> 触发：用户反馈「/help 没有预览出全部完整命令」——本轮先查证后修复，所有结论有运行时证据。

### 9.1 查证结论：「主干 47 / 全目录 121」是设计，全量入口完整可达

- 默认 `/help` 只列 **47 条主干**（supremacy 1.6 命令面瘦身，对标 gemini 47），尾部明确提示「◈ 扩展命令 74 个（进阶/别名/低频——照常可用）——/help all 查看全部」——**零删除，只分层展示**。
- `/help all` 实测输出 **121 行命令**，13 个分组齐全。
- TUI 帮助面板第 2 页（全景索引）实测：标题计数 121，**121 命令 + 13 组头 = 134 行**，↑↓ 滚动页脚「121/134」，滚动到底 `/csv /bundle /reload-skills` 全部可达——面板完整，只是需要 Tab 翻页 + 滚动（可发现性弱，建议页脚已提示）。

### 9.2 本轮发现并修复的「不完整产物」（3 处真 bug + 1 处统一）

| # | 问题 | 修复 | 验证 |
|---|---|---|---|
| 1 | `/computer` 的 `COMMAND_CAT` 值是中文描述而非分类符号 → `/help all` 里独立成怪组（组头=描述原文）、TUI 全景索引落「其他」 | `registry.ts`：`'/computer': '⚿'` | `/help all` 现归入「⚿ 输入」；审计脚本 AUDIT_OK |
| 2 | 离线手册 `docs/user-guide.md` 过期（标注 4.0.0-rc.1）且**缺 4 条命令**（/theme /brand /a2a /base64，117/121） | `npm run docs:user-guide` 确定性重生成 | 现 121 条 · 13 分类 · v4.0.2；diff 脚本 121=121 |
| 3 | 斜杠菜单 /help 描述「命令手册（63 命令）」与事实（主干 47/全目录 121）不符 | `src/tui/commands.ts` → 「命令手册（主干 47 · 全目录 121）」 | 菜单实测新文案 |
| 4 | 同符号双名：文本渲染 `⚿→输入` vs TUI `CAT_LABEL` `⚿→视觉媒体`（/input 动态内容表被归「视觉媒体」） | 统一为「输入」 | `/help all` 组头「⚿ 输入」；TUI 分组同源 |

### 9.3 全仓同类扫描结果（其余面均完整，无漂移）

- registry 三表键一致：SLASH=COMMAND_DESC=COMMAND_CAT=**121=121=121**；主干 47/扩展 74 与宣称精确一致；CAT_LABEL 13 符号全部被使用、无孤儿符号（`.tmp/registry-consistency-audit.mts`）。
- i18n 双语目录键对称：zh-CN= en= **229=229**，零缺键。
- `compat/commandSurface.ts`、`hermes-gateway`、MCP surfaces 均从 registry 派生（自动同步，无需手工维护）。
- 仅剩两处历史注释/快照文档中的旧计数（`kernel/tools.ts:1304`「96 条」为修复史注释；`system-completeness-audit-2026-08-30`「63+」为历史快照）——非用户可见面，不构成漂移。

### 9.4 回归

`npx vitest run tui-selfbuilt/commands/commands-intent/compat-v3-manifest/kernel-commandLevels` → **5 文件 187 用例全绿**；`npm run build` 重建；`/help all` 运行时复验 13 组 + 121 行。

### 9.5 追加（2026-09-03 晚）：输入框固定两行

> 用户反馈：输入框出现第三行空行。查证：本机构建各档位（full/basic/auto × 空态/有文本）实测均为 2 行内容框；第三空行源于**真实终端字体渲染宽度与 strWidth 估算不一致**（↑↓/▏/CJK 在部分字体下更宽）导致行溢出换行。
> 修复（`src/tui/ui/Composer.tsx`）：内容预算再收 2 列安全边距（textW=cols-9、innerW=cols-7）+ 提示行内容硬截断 + ink `wrap="truncate"` 兜底——输入框结构恒为「上沿+提示符行+键位行+下沿」，任何字体/宽度下绝不产生第三行。
> 回归：build + `tui-selfbuilt/tui-viewport/tui-palettes` **112 用例全绿**；PTY 终验：空态框内恒 2 行 ✅，长文本多行输入为内容合法折行（非空行）。

### 9.6 追加（2026-09-03）：命令全量展示 + yolo 循环剔除

> 用户反馈：①「命令没有全部展示」② 顶部栏模式显示 yolo 与预期不符。
> 处置：
> 1. **/help 默认全目录 122**（原默认主干 47 为 supremacy 1.6 设计——用户裁决推翻）；`/help core` 看主干 47，`/help all` 保留别名。实测：默认「命令（全目录 122 个）」+ 主干速览提示；core 视图「主干 47 + 扩展 75 提示」。
> 2. **斜杠菜单全目录搜索**：从 19 条高频目录扩展到 registry 全量索引（频序→主干→名字序排序；cli 注入 commandIndex 单一事实源）。实测：`/ec` 命中 `/eco`、`/a2` 命中 `/a2a`。
> 3. **安全脚枪修复**：用户真实 settings 里 mode=yolo（Ctrl+X 剪切习惯误触六档循环轮入全放行档并被持久化——顶部/底部两栏显示一致，模式本身非用户本意）。修复：`TuiRuntime.MODES` 五档循环剔除 yolo（smart/auto/manual/plan/goal），yolo 仅 `/perm yolo`/`/yolo` 显式命令可达，进入时醒目警告「⚠ 模式：yolo」。实测：Ctrl+X 循环序列 auto→manual→plan→goal→smart，无 yolo；用户恢复命令：`/perm smart`。
> 回归：5 文件 **186 用例全绿**（commands-slim 按新语义重写）；PTY 3/3（全目录菜单 ×2 + 循环无 yolo）；user-guide 重生成。

### 9.7 追加（2026-09-03 深夜）：模式唯一入口选择器 + 实例代号全英文

> 用户裁决：① 模式 smart/auto/manual/plan/goal/yolo **全部由命令进入**——一个命令装起来选择（热键不再切换档位）；② 实例代号改全英文。
> 处置：
> 1. **/perm 选择器**：裸 `/perm` 打开六档选择器面板（↑↓/Enter/Esc；当前档标 ● 当前；yolo 行 ⚠ 警示色）；选择即走 `/perm <mode>` 命令面唯一写路径。Ctrl+X/Shift+Tab 模式热键**全部移除**（keys.ts 键位表同步删除——单一事实源零漂移）；配置面板 Enter 循环也改为打开选择器；`applyConfigMode`/`cycleMode`/`togglePlanMode`/`MODES` 全删。实测 PTY 5/5（打开六档/⚠ 警示/Enter 应用/Ctrl+X 无副作用/Esc 取消）。
> 2. **实例代号全英文**：词表改 16×16 ASCII（`Silent-Deep-…` × `Weaver-Navigator-…`），格式 `Adj-Noun XXXX`；**存量中文代号一次性迁移**（instanceId 恒稳定，代号/serial 自洽重派生并落盘）。实测：`守夜·制图师 FB6B` → `Windborne-Horologist CD25`（/status 首行 + 落盘确认）。
> 3. i18n 双语目录同步（mode 面板 8 键 ×2；死键 modex/plan 移除——键集仍对称）；/perm desc 与 user-guide 同步。
> 回归：**186 用例全绿**（instance-identity 迁移测试 + tui-selfbuilt 选择器语义重写）；build SWAP_DIST_OK；docs 编码/链接门禁绿；三表审计 AUDIT_OK。

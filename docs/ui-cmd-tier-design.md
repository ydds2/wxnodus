# WxNodus TUI 设计：cmd（conhost）使用风险与三级能力档

> 本文件是「基于 cmd 使用风险重新设计 UI」的设计交付物。实现落码：W8-20～W8-24。
> 设计总原则：**现代终端零回归**（modern 档 = 既有行为），**cmd 档绝不输出乱码/豆腐块**，
> **VT 不可用绝不出 TUI**（诚实行模式 + 指引）。

## 1. 风险清单（探索实证——来自 renderer 序列清点）

| # | 风险 | 后果 | 防线 |
|---|---|---|---|
| R1 | conhost 无 VT 开启机制（仓库零 SetConsoleMode） | 老控制台把整屏 ANSI 打成乱码 | **W8-21 PS 引导** + 终态 VT 位回读核验 → Tier 0 行模式 |
| R2 | 无条件发射 DEC 2026（BSU/ESU）每帧包裹 | conhost 不支持（静默忽略，无益） | **W8-22** 能力集门控（退出帧第二调用点一并修复） |
| R3 | DECSTBM 硬件滚动 | conhost 不支持 → 垂直跳变 | 能力集 `decstbm=false` → 整行重写 |
| R4 | truecolor SGR | 老 conhost（1511–1607）不支持 24 位 | 能力集 `truecolor=false` → chalk 钳 level 2（256 色，hex 自动映射） |
| R5 | OSC 8/52/9/99/777/21337 | conhost 无对应能力 | 能力集门控 no-op（标题走 process.title、剪贴板走 clip.exe 原生） |
| R6 | QuickEdit 拦截鼠标 | 鼠标交互失效 | **W8-21 PS** 关 QuickEdit（终态回读核验）；能力集 `mouse` 以核验结果为准 |
| R7 | Kitty/modifyOtherKeys 扩展键 | conhost 不实现 | 能力集 `extendedKeys=false` 不发射 |
| R8 | emoji/盲文字形（🎤⧉🔐🔑⚡、盲文 banner/spinner） | cmd 字体缺字形 → 豆腐块 | **W8-23** 全量字形注册表：cmd 档 BMP 安全集 |
| R9 | `\x1b[3J` 清滚动区 | conhost 不支持 | 既有 HVP `\x1b[0f` 路径（clearTerminal.ts） |
| R10 | CJK 宽字符/IME | 宽度已由 stringWidth 正确处理；IME 待实测 | W6 真 conhost 验收（未过即 blocked） |

## 2. 三级能力档

| 档 | 终端判定 | 画像 |
|---|---|---|
| **modern** | WT_SESSION / TERM_PROGRAM(vscode/Cursor/Windsurf/WezTerm/mintty/…) / MSYSTEM / ConEmuANSI / ANSICON / TERM=xterm\*；非 Windows 平台 | 现状全量：2026+DECSTBM+truecolor+OSC+鼠标+扩展键，**行为零变化** |
| **cmd** | win32 且无上述信号 → PS 开 VT + 终态 VT 位回读通过 | 安全画像：无 2026/DECSTBM/OSC、256 色、BMP 字形集、鼠标仅在 QuickEdit 已关时开 |
| **no-vt** | 探测无应答（VT 未开启或老于 1511） | 诚实行模式：中文指引（Windows Terminal / 注册表 `HKCU\Console` `VirtualTerminalLevel=1` / `-p` 行模式）+ 恢复控制台模式后退出 |

探测链（`src/wxnodus-ui/lib/`）：
`terminalTier.ts`（纯函数 + 探测注入，fail-closed）→ `consoleBootstrap.ts`（PS P/Invoke
SetConsoleMode：输出句柄 -11 开 `VT|PROCESSED_OUTPUT`，输入句柄 -10 关 `QUICK_EDIT|LINE_INPUT|ECHO_INPUT`
）→ **输出句柄终态 VT 位（0x4）直接回读核验**（OS 契约、权威且同步——W8-26 起替代 CPR 回程探测，后者在 winpty/部分 conhost 下应答不可达）→ CLI 注入渲染器
（`render({capabilities})`，ink `capabilities.ts`）。

逃生门：`WXNODUS_TUI_TIER=modern|cmd|no-vt`。

## 3. 字形策略（glyphs.ts）

- 注册表 `GLYPHS: { id: { modern, cmd, ascii } }`，30+ 语义字形（mic/brand/prompt/copy/lock/
  key/warn/check/cross/…）；组件一律经 `icon(id)` 取层级变体，**不再硬编码 emoji/盲文**。
- cmd 变体约束（契约测试钉死）：无 astral（U+1F000–U+1FAFF）、无盲文（U+2800–U+28FF）、
  无低覆盖 BMP（✓✗✕☑☐⧉⏎⌛◈❯◉⛶⚙★☆ 等）；ascii 变体纯 ASCII。
- 整段文案用 `translateText()`（fortune/提示等自由文本；长组合优先替换防 `●REC` 被拆坏）。
- 已知保留（非渲染路径或宽度耦合）：`lib/text.ts` 工具线 ✓/✗ 协议标记（写读同一模块耦合，
  改动需同步协议解析——后续轮）；`content/faces.ts` kaomoji（cmd 档指示器风格强制 ascii，
  不渲染）；`theme.ts` BRAND 数据（消费点已走 icon()）。

## 4. 序列门控矩阵（渲染器能力集）

| 序列 | modern（缺省） | cmd |
|---|---|---|
| DEC 2026 帧包裹 | 环境探测（原逻辑） | 不发 |
| DECSTBM 滚动 | = sync 探测 | 不发（整行重写） |
| 鼠标跟踪（1000/1002/1003/1006） | 原逻辑 | 仅 QuickEdit 已关 |
| Kitty/modifyOtherKeys | 原 allowlist | 不发 |
| OSC 8/52/9/99/777/21337 | 原逻辑 | 不发（标题→process.title、剪贴板→clip.exe） |
| SGR 颜色 | supports-color 原逻辑 | chalk level 2（256 色） |
| 清屏/光标 | 原逻辑（含 conhost HVP 特例） | 同左 |

## 5. 诚实边界

- 老于 1511 的 conhost 无 VT 可开 → Tier 0，不伪装支持。
- 退出时 QuickEdit 恢复为 best-effort（disposer），失败如实记录。
- IME（中文输入）在 conhost raw-mode 下的行为以 W6 真机实测为准——未知即 blocked。
- modern 档零回归由 FakeTty 契约测试与全量 2043 测试钉住。

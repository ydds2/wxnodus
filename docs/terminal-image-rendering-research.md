# ③ 输出侧终端图片渲染调研与决策（2026-08-19，阶段 3 首项）

> 规格依据：`docs/superpowers/specs/2026-08-19-production-readiness-design.md` §3.1「先调研后决策，不盲做」。
> 决策：**不硬做协议内联渲染**——如实归档；输出侧「诚实降级通道」列为候选增强（低优先级）。

## 调研证据

1. **Windows 终端生态碎片化（决定性限制）**：Windows Terminal 1.24/1.25 起有 sixel 解析（release notes：v1.24.11321.0、v1.25.622.0「Sixel images are now parsed more performantly」、v1.25.1322.0 含「特制 sixel 图」安全修复）；但 ① 默认终端 conhost 无 sixel/kitty 任何协议 ② ConPTY 透传历史上被阻断（microsoft/terminal#448 标记 Product-Conpty，2019 年至今）③ 版本碎片化（大量 Windows 10/Server 用户停留在旧 WT 或 conhost）。**协议渲染在 Windows 上的覆盖面不可控**。
2. **竞品机制（参考不抄袭）**：crush 走 **kitty graphics 协议 + 半块字符（half-block）降级 + 终端能力探测**（`internal/ui/image/image.go` EncodingBlocks/EncodingKitty；`internal/ui/common/capabilities.go:91-142` kitty 查询 + tmux passthrough + kittyTerminals 名单）；codex 图片经专用 UI 面板（`tui/src/chatwidget.rs` 等），非内联协议。两者主战场都是 macOS/Linux 终端（kitty/wezterm/alacritty/ghostty）。
3. **wxnodus 现状**：输入侧已有 view_image 图片模型输入通道（波 1）+ 拖拽图片检测（`usePromptDispatch.ts:142`）；输出侧无终端内联渲染路径。

## 决策

- **A（采纳）**：输出侧**诚实降级通道**——助手消息携带图片时显示「图片：<路径>（`explorer <路径>` 打开）」，绝不静默丢弃。成本极低、零协议风险、覆盖 100% 终端。
- **B（归档为候选）**：crush 式协议渲染（kitty + 半块降级 + 能力探测）——转公开后按用户需求排期；Windows-only 决策下覆盖面受限（仅新 WT 且需 VT 直通），③ 8 判词维持不变（该判词已计入此留白）。
- 结论写入 audit §13.83；不预支任何评分。

## 证据锚点

- crush：`cli-compare\crush\internal\ui\image\image.go`、`internal\ui\common\capabilities.go:91-142`
- Windows Terminal release notes：sixel 提及 v1.24.11321.0 / v1.25.622.0 / v1.25.1322.0（github.com/microsoft/terminal/releases）
- microsoft/terminal#448（sixel feature request，Product-Conpty 标签）

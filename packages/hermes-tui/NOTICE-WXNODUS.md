WxNodus TUI 归属说明（NOTICE）
==============================

本产品 packages/hermes-tui/、packages/hermes-ink/、packages/hermes-shared/ 的
源码源自 Nous Research 的开源项目 hermes-agent（MIT License）：

  Copyright (c) 2025 Nous Research
  https://github.com/NousResearch/hermes-agent

依据 MIT 许可证条款复用与修改。修改内容包括：中文化、wsnodus gateway 桥接
（src/hermes-gateway/server.ts——wxnodus 事件流/RPC 面 JSON-RPC 适配）、
依赖扁平化（workspace 三包）、旧 UI 体系移除。

原许可证全文见 packages/hermes-tui/LICENSE-HERMES（随源携带）。
wxnodus 其余源码（src/kernel 等）与 hermes-agent 无关。

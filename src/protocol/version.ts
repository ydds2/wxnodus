// src/protocol/version.ts — 网关协议版本（A-S1 · 2026-08-28）
// SDK 握手与 /health 响应携带；SDK 端不匹配即快失败并提示版本区间。
// 语义化变更规则：新增可选字段/事件 = 兼容（不升）；删改字段/事件语义/鉴权模型 = 主版本 +1。
export const PROTOCOL_VERSION = 1;

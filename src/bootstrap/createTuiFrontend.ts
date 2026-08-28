// src/bootstrap/createTuiFrontend.ts — TUI 入口前端（与 headless 入口共享同一份事件→纯状态管线；React 视图层在 wxnodus-ui 侧另行组装）
import type { GatewayPort } from '../protocol/gateway.js';
import { createFrontendBase, type TuiFrontend } from '../presentation/tui/frontend.js';

export const createTuiFrontend = (gateway: GatewayPort): TuiFrontend => createFrontendBase('tui', gateway);

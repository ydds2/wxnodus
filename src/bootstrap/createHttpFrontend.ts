// src/bootstrap/createHttpFrontend.ts — HTTP（serve /rpc）入口前端（headless：禁止 React/Ink 依赖）
import type { GatewayPort } from '../protocol/gateway.js';
import { createFrontendBase, type TuiFrontend } from '../presentation/tui/frontend.js';

export const createHttpFrontend = (gateway: GatewayPort): TuiFrontend => createFrontendBase('http', gateway);

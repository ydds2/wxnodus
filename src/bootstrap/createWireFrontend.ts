// src/bootstrap/createWireFrontend.ts — Wire（JSONL stdin）入口前端（headless：禁止 React/Ink 依赖）
import type { GatewayPort } from '../protocol/gateway.js';
import { createFrontendBase, type TuiFrontend } from '../presentation/tui/frontend.js';

export const createWireFrontend = (gateway: GatewayPort): TuiFrontend => createFrontendBase('wire', gateway);

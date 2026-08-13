// src/application/applicationServices.ts — Application Services 聚合（Presentation 只依赖此层端口）
import type { CommandService } from './commandService.js';
import type { MemoryService } from './memoryService.js';
import type { PromptService } from './promptService.js';
import type { SessionService } from './sessionService.js';
// W3-09：PTY 应用服务进入聚合面（四入口共享同一 PtyPort）
import type { PtyService } from './pty/ptyService.js';

export interface ApplicationServices {
  sessions: SessionService;
  prompts: PromptService;
  commands: CommandService;
  memory: MemoryService;
  pty?: PtyService;
}

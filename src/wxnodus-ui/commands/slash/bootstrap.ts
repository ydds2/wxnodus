// src/wxnodus-ui/commands/slash/bootstrap.ts — W2-02：/setup 进程内执行（不再 spawn 外部 wxnodus 进程）
import { runInProcessSetup } from '../../bridge/setupHandoff.js'
import type { SlashCommand } from '../slashTypes.js'

export const setupCommands: SlashCommand[] = [
  {
    help: 'run setup in-process (personalization service)',
    name: 'setup',
    run: (_arg, ctx) => void runInProcessSetup({ ctx })
  }
]

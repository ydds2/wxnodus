// src/cli/lifecycle.ts — CLI 宿主能力判定与组合根关闭编排
import { createShutdown } from '../bootstrap/bootstrapShutdown.js';
import type { BootstrapResource } from '../bootstrap/bootstrapTypes.js';

export interface CliHostMode {
  serve: boolean;
  prompt: string | null;
  stdinIsTTY: boolean;
  stdoutIsTTY?: boolean;
}

/** live delegate 必须由真正长驻的 serve 或双向 TTY TUI 持有。 */
export function isLiveDelegateHost(mode: CliHostMode): boolean {
  if (mode.serve) return true;
  return mode.prompt === null
    && mode.stdinIsTTY
    && (mode.stdoutIsTTY ?? mode.stdinIsTTY);
}

/** CLI 资源晚于 composition 建立，因此逆序关闭时先停接纳面和后台工作。 */
export function createCliShutdown(
  shutdownComposition: (reason: string) => Promise<string[]>,
  cliResources: BootstrapResource[],
): (reason: string) => Promise<string[]> {
  return createShutdown([
    {
      id: 'composition',
      dispose: async reason => {
        const failures = await shutdownComposition(reason);
        if (failures.length) throw new Error(`composition failed: ${failures.join(',')}`);
      },
    },
    ...cliResources,
  ]);
}

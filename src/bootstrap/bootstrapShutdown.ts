// src/bootstrap/bootstrapShutdown.ts — 幂等 shutdown：严格逆序、只执行一次
import type { BootstrapResource } from './bootstrapTypes.js';

export function createShutdown(resources: BootstrapResource[]): (reason: string) => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;
  return async (reason: string) => {
    shutdownPromise ??= (async () => {
      for (const resource of [...resources].reverse()) await resource.dispose(reason);
    })();
    await shutdownPromise;
  };
}

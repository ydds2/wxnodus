// src/bootstrap/bootstrapShutdown.ts — 幂等 shutdown：严格逆序、全部尝试、聚合失败
// W2-03：单个 disposer 失败不阻断其余（每个资源都获得关闭机会），失败以资源 id 列表返回；
// 同一实例重复调用返回同一次 settled 结果。
import type { BootstrapResource } from './bootstrapTypes.js';

export interface ShutdownOptions {
  /** Entire reverse-order disposal deadline, not a per-resource allowance. */
  timeoutMs?: number;
}

export function createShutdown(
  resources: BootstrapResource[],
  options: ShutdownOptions = {},
): (reason: string) => Promise<string[]> {
  const timeoutMs = Math.max(0, Math.floor(options.timeoutMs ?? 10_000));
  let shutdownPromise: Promise<string[]> | undefined;
  return (reason: string) => {
    shutdownPromise ??= (async () => {
      const failures: string[] = [];
      const deadline = Date.now() + timeoutMs;
      for (const resource of [...resources].reverse()) {
        let disposed: void | Promise<void>;
        try {
          disposed = resource.dispose(reason);
        } catch {
          failures.push(resource.id);
          continue;
        }
        if (disposed === undefined) continue;

        const operation = Promise.resolve(disposed);
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          failures.push(resource.id);
          void operation.catch(() => undefined);
          continue;
        }

        let timer: NodeJS.Timeout | undefined;
        const outcome = await Promise.race([
          operation.then(() => 'settled' as const, () => 'failed' as const),
          new Promise<'timeout'>(resolve => {
            timer = setTimeout(() => resolve('timeout'), remaining);
          }),
        ]);
        if (timer) clearTimeout(timer);
        if (outcome !== 'settled') failures.push(resource.id);
      }
      return failures;
    })();
    return shutdownPromise;
  };
}

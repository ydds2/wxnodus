// src/bootstrap/bootstrapShutdown.ts — 幂等 shutdown：严格逆序、全部尝试、聚合失败
// W2-03：单个 disposer 失败不阻断其余（每个资源都获得关闭机会），失败以资源 id 列表返回；
// 同一实例重复调用返回同一次 settled 结果。
import type { BootstrapResource } from './bootstrapTypes.js';

export function createShutdown(resources: BootstrapResource[]): (reason: string) => Promise<string[]> {
  let shutdownPromise: Promise<string[]> | undefined;
  return (reason: string) => {
    shutdownPromise ??= (async () => {
      const failures: string[] = [];
      for (const resource of [...resources].reverse()) {
        try {
          await resource.dispose(reason);
        } catch {
          failures.push(resource.id);
        }
      }
      return failures;
    })();
    return shutdownPromise;
  };
}

// src/application/hooks/hookRegistry.ts — fail-closed Hook registry：critical 超时/崩溃 deny，notification-only 显式 fail-open
export type HookDecision = { action: 'continue' } | { action: 'deny'; reasonCode: string } |
  { action: 'modify'; value: unknown } | { action: 'require_approval'; reasonCode: string };

interface Hook { owner: string; id: string; policy: 'security-critical'|'notification-only'; timeoutMs: number;
  run(input: unknown): Promise<HookDecision>; dispose?: () => void | Promise<void> }

const valid = (value: unknown): value is HookDecision => typeof value === 'object' && value !== null &&
  ['continue','deny','modify','require_approval'].includes(String((value as { action?: string }).action));

export class HookRegistry {
  private readonly hooks = new Map<string, Hook>();
  register(hook: Hook): void { this.hooks.set(hook.id, hook); }
  async invoke(id: string, input: unknown): Promise<HookDecision> {
    const hook = this.hooks.get(id); if (!hook) return { action: 'deny', reasonCode: 'HOOK_DENIED' };
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([hook.run(input), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'HOOK_TIMEOUT' })), hook.timeoutMs);
      })]);
      if (!valid(result)) return hook.policy === 'notification-only' ? { action: 'continue' } : { action: 'deny', reasonCode: 'HOOK_MALFORMED' };
      return result;
    } catch (cause) { const code = (cause as { code?: string }).code === 'HOOK_TIMEOUT' ? 'HOOK_TIMEOUT' : 'HOOK_EXECUTION_FAILED';
      return hook.policy === 'notification-only' ? { action: 'continue' } : { action: 'deny', reasonCode: code }; }
    finally { if (timer) clearTimeout(timer); }
  }
  async unregisterOwner(owner: string): Promise<void> { for (const [id, hook] of this.hooks) if (hook.owner === owner) {
    this.hooks.delete(id); await hook.dispose?.(); } }
}

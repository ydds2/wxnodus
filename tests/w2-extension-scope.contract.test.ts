import { describe, expect, it, vi } from 'vitest';
import { ExtensionScopeManager } from '../src/application/extensions/extensionScopeManager.js';

describe('W2-04 extension owner scopes', () => {
  it('retains old and other-owner registrations on failed smoke, then disposes old after swap', async () => {
    const order: string[] = [];
    const manager = new ExtensionScopeManager();
    const old = manager.stage('mcp:weather', '1.0.0');
    expect(old.ok).toBe(true); if (!old.ok) return;
    old.value.registerTool('weather.get', { version: 1 });
    old.value.addDisposer(() => { order.push('dispose:old'); });
    expect((await manager.activate(old.value, async () => { order.push('smoke:old'); return true; })).ok).toBe(true);

    const plugin = manager.stage('plugin:echo', '1.0.0');
    expect(plugin.ok).toBe(true); if (!plugin.ok) return;
    plugin.value.registerTool('echo', {});
    expect((await manager.activate(plugin.value, async () => true)).ok).toBe(true);

    const broken = manager.stage('mcp:weather', '2.0.0');
    expect(broken.ok).toBe(true); if (!broken.ok) return;
    broken.value.registerTool('weather.get', { version: 2 });
    expect((await manager.activate(broken.value, async () => false))).toMatchObject({
      ok: false, error: { code: 'EXTENSION_SMOKE_FAILED' },
    });
    expect(manager.resolveTool('weather.get')).toEqual({ version: 1 });
    expect(manager.resolveTool('echo')).toEqual({});

    const next = manager.stage('mcp:weather', '2.0.1');
    expect(next.ok).toBe(true); if (!next.ok) return;
    next.value.registerTool('weather.get', { version: 2 });
    next.value.addDisposer(vi.fn());
    expect((await manager.activate(next.value, async () => { order.push('smoke:new'); return true; })).ok).toBe(true);
    order.push(`visible:${String((manager.resolveTool('weather.get') as { version: number }).version)}`);
    expect(order).toEqual(['smoke:old', 'smoke:new', 'dispose:old', 'visible:2']);
    expect(manager.snapshot('plugin:echo')?.tools).toEqual(['echo']);
    expect((await manager.deactivate('mcp:weather')).ok).toBe(true);
    expect(manager.resolveTool('weather.get')).toBeUndefined();
    expect(manager.resolveTool('echo')).toEqual({});
  });
});

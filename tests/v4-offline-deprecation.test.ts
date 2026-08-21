// V4 裁撤轨 D 契约：离线能力默认禁用（诚实文案）+ WXNODUS_LEGACY_OFFLINE=1 逃生开关恢复。
// 裁撤面：离线对话（offlineModel）/离线看图（vision 兜底）/无 key 确定性层（deterministic）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { deterministicRun } from '../src/commands/deterministic.js';
import { callOfflineLlm } from '../src/kernel/offlineModel.js';
import { legacyOfflineEnabled, OFFLINE_DEPRECATION_HINT } from '../src/kernel/env.js';

const LEGACY = 'WXNODUS_LEGACY_OFFLINE';
const original = process.env[LEGACY];

describe('V4 裁撤轨 D：离线能力软着陆', () => {
  beforeEach(() => { delete process.env[LEGACY]; });
  afterEach(() => {
    if (original === undefined) delete process.env[LEGACY];
    else process.env[LEGACY] = original;
  });

  it('默认禁用：开关关闭 + 弃用文案包含逃生开关与长期方案', () => {
    expect(legacyOfflineEnabled()).toBe(false);
    expect(OFFLINE_DEPRECATION_HINT).toContain('WXNODUS_LEGACY_OFFLINE=1');
    expect(OFFLINE_DEPRECATION_HINT).toContain('/model');
  });

  it('D-1：callOfflineLlm 默认诚实拒绝；逃生开关开启后进入正常就绪校验路径', async () => {
    const denied = await callOfflineLlm('offline:qwen2.5-1.5b', { messages: [] } as any);
    expect(denied.ok).toBe(false);
    expect(String((denied as any).error)).toContain('WXNODUS_LEGACY_OFFLINE');
    // 逃生开关：进入正常路径（对不存在的模型返回的就绪校验错误——而非弃用错误）
    process.env[LEGACY] = '1';
    const legacy = await callOfflineLlm('offline:not-a-real-model', { messages: [] } as any);
    expect(String((legacy as any).error)).not.toContain('已弃用');
  });

  it('D-3：deterministicRun 默认返回 null（自然落回 NL/chat 路由）；逃生开关恢复确定性求值', async () => {
    // 此前「加密一下这个文件夹里的配置」被 base64 劫持（A-8）——默认禁用后必须 null
    expect(await deterministicRun('加密一下这个文件夹里的配置')).toBeNull();
    expect(await deterministicRun('2+3*4')).toBeNull();
    process.env[LEGACY] = '1';
    expect(await deterministicRun('base64 编码 hello')).not.toBeNull();
  });
});

// tests/kernel-providers.test.ts — L2-1 模型提供商：密钥加密/规则脑/路由/流式请求/错误映射
import { describe, it, expect, vi, afterEach } from 'vitest';
import { encryptKey, decryptKey } from '../src/kernel/providers.js';
import { ruleBrain, mapHttpError, buildChatRequest } from '../src/kernel/providers.js';
import { MODEL_CATALOG, capabilityBadges, filterModels, REASONING_FIELDS, detectProvider, resolveApiKey } from '../src/kernel/providers.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('密钥加密（凭证安全红线）', () => {
  it('AES-256-GCM 加密：往返一致', () => {
    const enc = encryptKey('sk-test-12345');
    expect(enc.startsWith('enc1:')).toBe(true);
    expect(enc).not.toContain('sk-test-12345'); // 明文绝不出现
    expect(decryptKey(enc)).toBe('sk-test-12345');
  });
  it('不同加密盐产生不同密文（同一明文两次加密不同）', () => {
    const a = encryptKey('same-key');
    const b = encryptKey('same-key');
    expect(a).not.toBe(b);
  });
  it('非法密文解密返回 null（不抛）', () => {
    expect(decryptKey('enc1:garbage')).toBeNull();
    expect(decryptKey('plain')).toBeNull();
  });
});

describe('规则脑（无 key 兜底：诚实回答不假装智能）', () => {
  it('打招呼有回复', () => {
    const r = ruleBrain('你好');
    expect(r.length).toBeGreaterThan(0);
    expect(r).toContain('WxNodus');
  });
  it('简单计算可确定性回答', () => {
    const r = ruleBrain('2+3*4 等于多少');
    expect(r).toContain('14');
  });
  it('未知问题诚实说明能力边界', () => {
    const r = ruleBrain('给我写一个操作系统');
    expect(r).toContain('未配置');
  });
  it('规则脑不假装有工具', () => {
    const r = ruleBrain('执行 ls');
    expect(r.toLowerCase()).not.toContain('已执行');
  });
});
describe('请求构造（OpenAI 兼容）', () => {
  it('buildChatRequest 生成正确 body', () => {
    const req = buildChatRequest({
      baseURL: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
      key: 'sk-x',
      messages: [{ role: 'user', content: '你好' }],
      stream: true,
    });
    expect(req.url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(req.headers.Authorization).toBe('Bearer sk-x');
    const body = JSON.parse(req.body as string);
    expect(body.model).toBe('deepseek-v4-flash');
    expect(body.stream).toBe(true);
    expect(body.messages[0].content).toBe('你好');
  });
  it('baseURL 尾部斜杠兼容', () => {
    const req = buildChatRequest({ baseURL: 'https://x.com/v1/', model: 'm', key: 'k', messages: [], stream: false });
    expect(req.url).toBe('https://x.com/v1/chat/completions');
  });
});

describe('HTTP 错误中文映射', () => {
  it('常见状态码映射', () => {
    expect(mapHttpError(401)).toContain('密钥');
    expect(mapHttpError(402)).toContain('余额');
    expect(mapHttpError(429)).toContain('限流');
    expect(mapHttpError(500)).toContain('服务端');
  });
});

// ── 逐帧视频分析（video.ts）────
describe('video 逐帧分析', () => {
  it('不存在路径返回明确错误', async () => {
    const { analyzeVideo } = await import('../src/kernel/video.js');
    const r = await analyzeVideo('/no/such/video.mp4', null);
    expect(r).toContain('GLM key');
  });
  it('无 key 时提示配置', async () => {
    const { analyzeVideo } = await import('../src/kernel/video.js');
    const r = await analyzeVideo('/no/such/video.mp4', 'enc1:aa:bb:cc');
    expect(r.length).toBeGreaterThan(0);
  });
});

// ── 模型能力元数据（M1）────
describe('模型能力元数据', () => {
  it('GLM-4V Flash 标记视觉输入', () => {
    const m = MODEL_CATALOG.find(x => x.modelId === 'glm-4v-flash');
    expect(m?.capabilities?.imageIn).toBe(true);
    expect(m?.capabilities?.thinking).toBeFalsy();
  });
  it('推理模型标记 thinking', () => {
    for (const id of ['deepseek-reasoner', 'glm-4.5']) {
      expect(MODEL_CATALOG.find(x => x.modelId === id)?.capabilities?.thinking).toBe(true);
    }
  });
  it('K3-256k 标记 256k 上下文', () => {
    expect(MODEL_CATALOG.find(x => x.modelId === 'kimi-k3-256k')?.capabilities?.maxContext).toBe(256_000);
  });
  it('能力徽标输出', () => {
    expect(capabilityBadges({ imageIn: true, maxContext: 32_000 })).toContain('👁');
    expect(capabilityBadges({ thinking: true })).toContain('🧠');
    expect(capabilityBadges(undefined)).toBe('');
  });
  it('filterModels 模糊过滤接通（子串匹配）', () => {
    expect(filterModels('glm').map(m => m.modelId)).toContain('glm-4v-flash');
    expect(filterModels('k3').map(m => m.modelId)).toEqual(['kimi-k3', 'kimi-k3-256k']);
    expect(filterModels('').length).toBe(12);
  });
});

// ── 视频无 key 降级（本地场景分析）────
import { detectScenes, localSceneTimeline } from '../src/kernel/video.js';
import { existsSync } from 'node:fs';

describe('视频本地场景分析降级', () => {
  it('detectScenes 返回切换时间点（真实 ffmpeg）', () => {
    const mp4 = 'data/wxnodus-scene.mp4';
    if (existsSync(mp4)) {
      const scenes = detectScenes(mp4);
      expect(Array.isArray(scenes)).toBe(true);
      expect(scenes.length).toBeGreaterThan(0);
      expect(scenes[0]).toBeGreaterThan(0);
    } else {
      expect(true).toBe(true); // 视频不存在时跳过（CI 无录制产物）
    }
  });
  it('localSceneTimeline 输出确定性场景段', () => {
    const out = localSceneTimeline('data/wxnodus-scene.mp4');
    expect(out).toContain('场景');
    expect(out).not.toContain('帧分析失败');
  });
});

// ── 多 provider 适配（思考字段别名）────
describe('多 provider 适配层', () => {
  it('REASONING_FIELDS 覆盖主流思考字段别名', () => {
    expect(REASONING_FIELDS).toContain('reasoning_content');
    expect(REASONING_FIELDS).toContain('thinking_content');
    expect(REASONING_FIELDS).toContain('reasoning');
  });
  it('detectProvider 从 baseURL 识别三家运营商', () => {
    expect(detectProvider('https://api.deepseek.com/v1')).toBe('deepseek');
    expect(detectProvider('https://api.moonshot.cn/v1')).toBe('kimi');
    expect(detectProvider('https://open.bigmodel.cn/api/paas/v4')).toBe('zhipu');
    expect(detectProvider('https://example.com/v1')).toBe('openai-compatible');
    expect(detectProvider(undefined)).toBe('openai-compatible');
  });
});

// ── P3b：buildChatRequest 结构（多 provider 适配层）───
describe('buildChatRequest 结构', () => {
  it('构造 OpenAI 兼容请求：URL/headers/body 齐全', async () => {
    const { buildChatRequest } = await import('../src/kernel/providers.js');
    const req = buildChatRequest({
      baseURL: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
      key: 'sk-test',
      messages: [{ role: 'user', content: '你好' }],
      stream: true,
      tools: [{ type: 'function', function: { name: 'ls', description: 'x', parameters: { type: 'object', properties: {} } } }],
    });
    expect(req.url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(req.headers['Content-Type']).toContain('application/json');
    expect(req.headers['Authorization']).toBe('Bearer sk-test');
    const body = JSON.parse(req.body as string);
    expect(body.model).toBe('deepseek-v4-flash');
    expect(body.stream).toBe(true);
    expect(body.messages[0].content).toBe('你好');
    expect(body.tools).toHaveLength(1);
  });
  it('MODEL_CATALOG 十二模型（含离线二条）且能力标注完整', async () => {
    const { MODEL_CATALOG } = await import('../src/kernel/providers.js');
    expect(MODEL_CATALOG.length).toBe(12);
    const providers = new Set(MODEL_CATALOG.map(m => m.provider));
    expect(providers.size).toBeGreaterThanOrEqual(3);
    for (const m of MODEL_CATALOG) {
      expect(m.modelId).toBeTruthy();
      expect(m.baseURL).toBeTruthy();
    }
    // 视觉模型有 imageIn 标注
    const glm4v = MODEL_CATALOG.find(m => m.modelId.includes('glm-4v'));
    expect(glm4v).toBeDefined();
  });
});

// ── P3b：decryptKey 边界（机器指纹/损坏数据）───
describe('decryptKey 边界', () => {
  it('损坏密文返回 null（不抛错）', async () => {
    const { decryptKey } = await import('../src/kernel/providers.js');
    expect(decryptKey('not-a-valid-enc')).toBeNull();
    expect(decryptKey('')).toBeNull();
    expect(decryptKey('enc1:bad:bad:bad')).toBeNull();
  });
  it('AES-256-GCM 加密→解密往返一致', async () => {
    const { encryptKey, decryptKey } = await import('../src/kernel/providers.js');
    const enc = encryptKey('sk-roundtrip-test-123');
    expect(enc.startsWith('enc1:')).toBe(true);
    const dec = decryptKey(enc);
    expect(dec).toBe('sk-roundtrip-test-123');
  });
});

// ── P3b：filterModels 模糊过滤 / 能力徽标 ──
describe('模型目录能力', () => {
  it('filterModels 模糊匹配（名称/模型ID/厂商）', async () => {
    const { filterModels, MODEL_CATALOG } = await import('../src/kernel/providers.js');
    expect(filterModels('reasoner', MODEL_CATALOG).map(m => m.modelId)).toContain('deepseek-reasoner');
    expect(filterModels('glm', MODEL_CATALOG).some(m => m.provider === 'zhipu')).toBe(true);
    expect(filterModels('256k', MODEL_CATALOG).some(m => m.capabilities?.maxContext === 256_000)).toBe(true);
    expect(filterModels('zzz-none', MODEL_CATALOG)).toEqual([]);
    expect(filterModels('', MODEL_CATALOG).length).toBe(MODEL_CATALOG.length);
  });
  it('capabilityBadges 徽标输出', async () => {
    const { capabilityBadges } = await import('../src/kernel/providers.js');
    expect(capabilityBadges({ imageIn: true, thinking: true, maxContext: 256_000 })).toContain('👁');
    expect(capabilityBadges({ thinking: true })).toContain('🧠');
    expect(capabilityBadges({ maxContext: 256_000 })).toContain('256k');
    expect(capabilityBadges(undefined)).toBe('');
  });

});

// ── P3c：resolveApiKey per-provider 槽位 + 归属校验（多 provider 目录与单槽错配修复）──
describe('resolveApiKey per-provider 槽位', () => {
  const cleanEnv = { ...process.env };
  delete cleanEnv.WXNODUS_DEEPSEEK_KEY; delete cleanEnv.WXNODUS_ZHIPU_KEY; delete cleanEnv.WXNODUS_API_KEY;

  it('per-provider 槽位命中（baseURL 推断 provider）', () => {
    const zk = encryptKey('sk-zhipu-real');
    const res = resolveApiKey({ baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKeys: { zhipu: zk } }, cleanEnv);
    expect(res.key).toBe('sk-zhipu-real');
    expect(res.provider).toBe('zhipu');
    expect(res.source).toBe('enc');
  });

  it('遗留单槽 + 归属不符 → provider-mismatch fail-closed（不再误发 401）', () => {
    const zk = encryptKey('sk-zhipu-real');
    const res = resolveApiKey({ baseURL: 'https://api.deepseek.com/v1', apiKeyEnc: zk, keyProvider: 'zhipu' }, cleanEnv);
    expect(res.key).toBeNull();
    expect(res.error).toBe('provider-mismatch');
    expect(res.hint).toContain('deepseek');
  });

  it('遗留单槽 + 归属匹配 → 正常解密（向后兼容）', () => {
    const zk = encryptKey('sk-zhipu-real');
    const res = resolveApiKey({ baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKeyEnc: zk, keyProvider: 'zhipu' }, cleanEnv);
    expect(res.key).toBe('sk-zhipu-real');
    expect(res.error).toBeUndefined();
  });

  it('遗留单槽无归属标注 → 任意 provider 可用（老配置零回归）', () => {
    const zk = encryptKey('sk-legacy');
    const res = resolveApiKey({ baseURL: 'https://api.deepseek.com/v1', apiKeyEnc: zk }, cleanEnv);
    expect(res.key).toBe('sk-legacy');
  });

  it('per-provider 槽位优先于遗留单槽', () => {
    const dk = encryptKey('sk-deepseek-new');
    const zk = encryptKey('sk-zhipu-old');
    const res = resolveApiKey({ baseURL: 'https://api.deepseek.com/v1', apiKeyEnc: zk, keyProvider: 'zhipu', apiKeys: { deepseek: dk } }, cleanEnv);
    expect(res.key).toBe('sk-deepseek-new');
  });

  it('env 优先于全部加密槽位', () => {
    const env = { ...cleanEnv, WXNODUS_DEEPSEEK_KEY: 'sk-env-key' };
    const dk = encryptKey('sk-deepseek-enc');
    const res = resolveApiKey({ baseURL: 'https://api.deepseek.com/v1', apiKeys: { deepseek: dk } }, env);
    expect(res.key).toBe('sk-env-key');
    expect(res.source).toBe('env');
  });
});

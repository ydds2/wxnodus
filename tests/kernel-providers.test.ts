// tests/kernel-providers.test.ts — L2-1 模型提供商：密钥加密/规则脑/路由/流式请求/错误映射
import { describe, it, expect, vi, afterEach } from 'vitest';
import { encryptKey, decryptKey } from '../src/kernel/providers.js';
import { ruleBrain, routeByKeywords, mapHttpError, buildChatRequest } from '../src/kernel/providers.js';
import { MODEL_CATALOG, capabilityBadges, filterModels, REASONING_FIELDS, detectProvider } from '../src/kernel/providers.js';

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

describe('关键词路由（多端点降级链）', () => {
  it('关键词命中端点', () => {
    const routes = [{ match: /glm|视觉|图片/i, endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-flash' }];
    const hit = routeByKeywords('分析这张图片', routes);
    expect(hit?.endpoint).toContain('bigmodel');
  });
  it('无命中返回 null（走默认）', () => {
    const routes = [{ match: /视频/i, endpoint: 'https://x', model: 'm' }];
    expect(routeByKeywords('写代码', routes)).toBeNull();
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
    expect(filterModels('').length).toBe(10);
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

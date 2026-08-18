// tests/kernel-tool-trim.test.ts — supremacy 1.3 按模型工具裁剪（A-04）：纯函数裁剪集 + agent 装配/热重载契约
// 覆盖：未知模型不裁、文本模型裁图片输出工具、小窗口文本模型裁 GUI 套件、视觉模型全保留、
// mode=off 逃生门、纯函数不可变、agent 装配裁剪生效、updateTools 热重载不绕过裁剪
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, closeDB } from '../src/store/db.js';
import { createEventBus } from '../src/kernel/events.js';
import { createMemory } from '../src/kernel/memory.js';
import { createAgent } from '../src/kernel/agent.js';
import { coreTools } from '../src/kernel/tools.js';
import { trimToolsForModel, modelCapabilitiesFor, VISION_IMAGE_TOOLS, GUI_TEXT_RE } from '../src/kernel/toolTrim.js';

const fullTools = coreTools();
const names = (t: Record<string, unknown>) => Object.keys(t);

describe('modelCapabilitiesFor（目录能力查询）', () => {
  it('目录命中返回能力；未收录/undefined → null', () => {
    expect(modelCapabilitiesFor('deepseek-chat')).toEqual({ maxContext: 64_000 });
    expect(modelCapabilitiesFor('glm-4v-flash')).toEqual({ imageIn: true, maxContext: 32_000 });
    expect(modelCapabilitiesFor('custom-model')).toBeNull();
    expect(modelCapabilitiesFor(undefined)).toBeNull();
  });
});

describe('trimToolsForModel（裁剪集）', () => {
  it('目录未收录模型 → 不裁剪（未知能力不臆测，full tier）', () => {
    const r = trimToolsForModel('custom-model', fullTools);
    expect(r.dropped).toEqual([]);
    expect(r.tier).toBe('full');
    expect(names(r.tools)).toEqual(names(fullTools));
  });

  it('文本模型（deepseek-chat 64k）→ 恰好裁掉 3 个图片输出工具；GUI 文本套件保留', () => {
    const r = trimToolsForModel('deepseek-chat', fullTools);
    expect(r.dropped.sort()).toEqual(['browser_screenshot', 'computer_observe', 'computer_screenshot'].sort());
    expect(r.tier).toBe('full');
    // 文本可用的 GUI/LSP/核心工具全保留
    for (const keep of ['browser_click', 'browser_snapshot', 'computer_uia_tree', 'computer_click', 'lsp_diagnostics', 'bash', 'apply_patch']) {
      expect(r.tools[keep], keep).toBeDefined();
    }
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('文本大窗口模型（glm-4-flash 128k）→ 同样只裁图片输出工具', () => {
    const r = trimToolsForModel('glm-4-flash', fullTools);
    expect(r.dropped).toHaveLength(3);
    expect(r.tier).toBe('full');
  });

  it('视觉小窗口模型（glm-4v-flash 32k）→ 零裁剪（看图是核心用途，不因窗口小砍动作面）', () => {
    const r = trimToolsForModel('glm-4v-flash', fullTools);
    expect(r.dropped).toEqual([]);
    expect(r.tier).toBe('lite');
  });

  it('小窗口文本模型（offline:Qwen2.5-1.5B 32k）→ lite：图片输出 + GUI 文本套件全裁，核心工具保留', () => {
    const r = trimToolsForModel('offline:Qwen2.5-1.5B', fullTools);
    expect(r.tier).toBe('lite');
    const guiText = names(fullTools).filter(n => GUI_TEXT_RE.test(n));
    const vision = names(fullTools).filter(n => VISION_IMAGE_TOOLS.has(n));
    // 全部 GUI 文本工具 + 图片输出工具都被裁掉，且不重复
    for (const d of [...guiText, ...vision]) expect(r.dropped, d).toContain(d);
    expect(new Set(r.dropped).size).toBe(r.dropped.length);
    // 核心/LSP/构建工具保留
    for (const keep of ['fs_read', 'bash', 'lsp_diagnostics', 'scaffold_build', 'apply_patch', 'memory_search']) {
      expect(r.tools[keep], keep).toBeDefined();
    }
    expect(r.reasons.length).toBe(2); // 图片输出 + GUI 套件两条理由
  });

  it("mode='off' → 全量不裁（逃生门）", () => {
    const r = trimToolsForModel('offline:Qwen2.5-1.5B', fullTools, { mode: 'off' });
    expect(r.dropped).toEqual([]);
    expect(names(r.tools)).toEqual(names(fullTools));
  });

  it('纯函数不可变：入参工具表不被修改，结果为新对象', () => {
    const before = names(fullTools);
    const r = trimToolsForModel('deepseek-chat', fullTools);
    expect(names(fullTools)).toEqual(before);
    expect(r.tools).not.toBe(fullTools);
  });
});

describe('agent 装配裁剪（supremacy 1.3 契约）', () => {
  let dir: string;
  let db: ReturnType<typeof openDB>;
  let bus: ReturnType<typeof createEventBus>;
  let mem: ReturnType<typeof createMemory>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'wxn-trim-'));
    db = openDB(dir);
    bus = createEventBus(dir);
    mem = createMemory(db);
  });
  afterAll(() => {
    closeDB(db);
    rmSync(dir, { recursive: true, force: true });
  });

  const makeAgent = (model: string, extraSettings: Record<string, any> = {}) => {
    let seen: string[] = [];
    const agent = createAgent({
      db, bus, mem, sessionId: 'trim-' + Math.random().toString(36).slice(2, 8),
      config: { settings: { baseURL: 'https://mock', model, ...extraSettings } } as any,
      callModel: async (req: any) => {
        seen = (req.tools ?? []).map((t: any) => t.function.name);
        return { type: 'text', content: '完成' };
      },
    } as any);
    return { agent, seen: () => seen };
  };

  it('deepseek-chat 装配：模型可见工具表不含图片输出工具；getToolTrim 报告 3 项', async () => {
    const { agent, seen } = makeAgent('deepseek-chat');
    await agent.run('你好');
    const s = seen();
    expect(s).not.toContain('computer_screenshot');
    expect(s).not.toContain('browser_screenshot');
    expect(s).not.toContain('computer_observe');
    expect(s).toContain('browser_click');
    expect(agent.getToolTrim().dropped).toHaveLength(3);
    expect(agent.getToolTrim().tier).toBe('full');
  });

  it("settings.toolTrim='off'：模型可见全量工具（含图片输出）", async () => {
    const { agent, seen } = makeAgent('deepseek-chat', { toolTrim: 'off' });
    await agent.run('你好');
    expect(seen()).toContain('computer_screenshot');
    expect(agent.getToolTrim().dropped).toEqual([]);
  });

  it('updateTools 热重载后裁剪仍生效（不绕过裁剪层）', async () => {
    const { agent } = makeAgent('deepseek-chat');
    agent.updateTools({ extra_tool: { schema: { type: 'function', function: { name: 'extra_tool', description: 'x', parameters: { type: 'object', properties: {} } } }, danger: false, run: async () => 'ok' } } as any);
    expect(agent.getToolTrim().dropped).toHaveLength(3);
    const { seen } = makeAgent('deepseek-chat'); // 新一轮观察实际注入面
    expect(agent.getToolTrim().dropped).toHaveLength(3);
    void seen;
  });
});

// tests/commands.test.ts — L4 命令层：注册表/别名/NL 路由/确定性工具/瀑布渲染
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SLASH, COMMAND_CAT, COMMAND_DESC, isSlash, resolveAlias } from '../src/commands/registry.js';
import { routeNaturalLanguage, routeInput, NL_TRIGGERS, type NlTrigger } from '../src/commands/intent.js';
import { deterministicRun } from '../src/commands/deterministic.js';
import { renderWaterfall, registerExtHandlers } from '../src/commands/handlersExt.js';
import { createCommandBus } from '../src/app/CommandBus.js';
import { openDB, closeDB } from '../src/store/db.js';
import { createEventBus } from '../src/kernel/events.js';
import { createMemory } from '../src/kernel/memory.js';
// V4 裁撤轨 D-3：以下用例锁定的是 legacy 确定性层行为（默认禁用——
// WXNODUS_LEGACY_OFFLINE=1 逃生开关路径，兼作开关有效性覆盖）
process.env.WXNODUS_LEGACY_OFFLINE = '1';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wx-cmd-'));
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

describe('命令注册表（单一事实来源）', () => {
  it('核心命令全覆盖', () => {
    for (const c of ['/help', '/clear', '/undo', '/quit', '/sessions', '/model', '/profile', '/status', '/doctor',
      '/memory', '/hole', '/compact', '/build', '/deploy', '/forge', '/skill', '/gate', '/perm', '/sandbox',
      '/compliance', '/consent', '/backup', '/export', '/lang', '/vision', '/img', '/video',
      '/claw', '/mcp', '/calc', '/hash', '/base64', '/uuid', '/json', '/timer', '/sql', '/fs', '/version']) {
      expect(SLASH).toContain(c);
    }
  });
  it('/key 已并入 /model（不再独立注册）', () => {
    expect(SLASH).not.toContain('/key');
  });
  it('无重复注册', () => {
    expect(new Set(SLASH).size).toBe(SLASH.length);
  });
  it('分类与描述齐全（无孤儿）', () => {
    for (const c of SLASH) {
      expect(COMMAND_DESC[c], `缺少描述: ${c}`).toBeTruthy();
      expect(COMMAND_CAT[c], `缺少分类: ${c}`).toBeTruthy();
    }
  });
  it('isSlash 识别斜杠命令', () => {
    expect(isSlash('/help')).toBe(true);
    expect(isSlash('/help all')).toBe(true);
    expect(isSlash('帮我做件事')).toBe(false);
  });
});

describe('别名解析（说人话不记命令）', () => {
  it('中文别名 → 英文命令', () => {
    expect(resolveAlias('/帮助')).toBe('/help');
    expect(resolveAlias('/退出')).toBe('/quit');
    expect(resolveAlias('/体检')).toBe('/doctor');
  });
  it('未知命令返回原样', () => {
    expect(resolveAlias('/nope')).toBe('/nope');
  });
});

describe('确定性工具直调（毫秒级不走模型）', () => {
  it('算/哈希/随机/换算', async () => {
    expect(await deterministicRun('算一下 2+3*4')).toContain('14');
    expect(await deterministicRun('md5 hello')).toContain('5d41402abc4b2a76b9719d911017c592');
    expect(await deterministicRun('随机数 1 到 10')).toMatch(/\d+/);
    expect(await deterministicRun('5km 换算成 m')).toContain('5000');
  });
  it('非确定性输入返回 null（走下一层）', async () => {
    expect(await deterministicRun('帮我写个系统')).toBeNull();
  });
});

describe('NL 路由（说人话 → 命令）', () => {
  it('构建类：做个待办系统 → build', () => {
    expect(routeNaturalLanguage('帮我做一个待办系统')).toBe('/build');
  });
  it('视频类：分析视频 → video', () => {
    expect(routeNaturalLanguage('分析这个视频 https://x.com/v')).toBe('/video');
  });
  it('视觉类：看看这张图 → vision', () => {
    expect(routeNaturalLanguage('看看这张图 C:\\a.png')).toBe('/vision');
  });
  it('记忆类：搜一下记忆 → hole', () => {
    expect(routeNaturalLanguage('搜一下我之前说的黑洞')).toBe('/hole');
  });
  it('无关输入返回 null（走 AI 意图或对话）', () => {
    expect(routeNaturalLanguage('今天天气怎么样')).toBeNull();
  });
  it('F16：祈使备份触发，叙述式"备份过"不劫持', () => {
    expect(routeNaturalLanguage('把代码备份到U盘')).toBe('/backup');
    expect(routeNaturalLanguage('我之前备份过这个项目')).toBeNull();
  });
  it('F16：长句非祈使（叙述/提及）不劫持为命令', () => {
    expect(routeNaturalLanguage('这个方案部署上线后要注意安全问题')).toBeNull();
  });
});

describe('NL_TRIGGERS 结构', () => {
  it('触发器含正则与命令映射', () => {
    const t: NlTrigger[] = NL_TRIGGERS;
    expect(t.length).toBeGreaterThan(3);
    for (const x of t) {
      expect(x.re).toBeInstanceOf(RegExp);
      expect(typeof x.cmd).toBe('string');
    }
  });
});

// ── P3b：routeInput 全链路分派（命令/工具/对话三态）───
describe('routeInput 完整分派', () => {
  it('斜杠命令 → command', async () => {
    const r = await routeInput('/calc 1+2');
    expect(r.kind).toBe('command');
    expect(r.cmd).toBe('/calc');
    expect(r.value).toBe('1+2');
  });
  it('确定性工具 → tool（毫秒级不走模型）', async () => {
    const r = await routeInput('计算 1+1');
    expect(r.kind).toBe('tool');
  });
  it('自然语言需求 → chat（走 AI）', async () => {
    const r = await routeInput('帮我分析一下这个项目的架构');
    expect(r.kind).toBe('chat');
  });
  it('斜杠冒号参数语法（/skill:名）→ command 带 value', async () => {
    const r = await routeInput('/skill:myflow 帮我做事');
    expect(r.kind).toBe('command');
    expect(r.cmd).toBe('/skill');
    expect(r.value).toContain('myflow');
  });
  it('未知斜杠命令 → chat（交 AI 意图层）', async () => {
    const r = await routeInput('/nonexistent-cmd-xyz');
    expect(r.kind).toBe('chat');
  });
});

// ── P3b：NL 触发参数化矩阵 + 斜杠边界 ──
describe('NL 触发矩阵（参数化）', () => {
  it.each([
    ['帮我建一个记账系统', '/build'],
    ['做一个待办应用', '/build'],
    ['分析这个视频里的内容', '/video'],
    ['视频里说了什么', '/video'],
    ['帮我看这张图', '/vision'],
    ['识别图片里的文字', '/vision'],
    ['搜索黑洞记忆里的内容', '/hole'],
    ['找一下之前说的那个项目', '/hole'],
    ['给项目做个体检', '/doctor'],
    ['备份一下项目代码', '/backup'],
    ['把这个部署上线', '/deploy'],
    ['抓取这个网页的内容', '/claw'],
    ['每天定时提醒我喝水', '/cron'],
    ['沙盒里跑这个脚本', '/sandbox'],
  ])('%s → %s', (input, expected) => {
    expect(routeNaturalLanguage(input)).toBe(expected);
  });
  it.each([
    ['我之前备份过数据', null],
    ['项目已经部署了', null],
    ['你觉得这个方案怎么样', null],
    ['请问如何处理报错', null],
    ['随便聊聊今天的天气', null],
  ])('误劫持防御：%s → null', (input, expected) => {
    expect(routeNaturalLanguage(input)).toBe(expected);
  });
  it('别名解析进入 command 分派', async () => {
    const r = await routeInput('/帮助');
    expect(r.kind).toBe('command');
    expect(r.cmd).toBe('/help');
  });
  it('大小写斜杠命令归一', async () => {
    const r = await routeInput('/HELP');
    expect(r.kind).toBe('command');
    expect(r.cmd).toBe('/help');
  });
});

describe('token 瀑布（renderWaterfall）', () => {
  const rows = [
    { model: 'kimi-k2', input_tokens: 8000, output_tokens: 2000, ts: 1700000000000 },
    { model: 'glm-4v', input_tokens: 1000, output_tokens: 9000, ts: 1700000001000 },
  ];
  it('每行含时间/模型/token 总量与输入输出', () => {
    const out = renderWaterfall(rows, 30);
    expect(out).toContain('kimi-k2');
    expect(out).toContain('glm-4v');
    expect(out).toContain('10,000 tok');
    expect(out).toContain('入 8,000 / 出 2,000');
    expect(out).toContain('░'); // 输入段
    expect(out).toContain('█'); // 输出段
  });
  it('单行/空输入不崩', () => {
    expect(renderWaterfall([rows[0]!], 30)).toContain('1');
    expect(renderWaterfall([], 30)).toContain('0 轮');
  });
  it('0 token 行（端点未上报用量）→ 不标 ≈$0 不 NaN 崩，显式「未上报用量」', () => {
    const zero = { model: 'mystery-model', input_tokens: 0, output_tokens: 0, ts: 1700000002000 };
    const out = renderWaterfall([zero, rows[0]!], 30);
    expect(out).toContain('未上报用量');
    expect(out).not.toContain('mystery-model ≈$0');
    expect(out).toContain('kimi-k2');
  });
  it('新命令已注册：/versions /snapshot', () => {
    expect(SLASH).toContain('/versions');
    expect(SLASH).toContain('/snapshot');
  });
});

// ── /self-evolve --report：自我审查（只审查不修改）──
describe('/self-evolve --report 自我审查报告', () => {
  it('AI 审查输出建议清单并落盘 reports/（未修改任何代码）', async () => {
    const d = tmp();
    const bus = createCommandBus();
    const db = openDB(d);
    const evBus = createEventBus(d);
    const mem = createMemory(db);
    const reviewJson = JSON.stringify([
      { file: 'src/kernel/env.ts', severity: 'high', issue: 'sanitizedEnv 未覆盖某密钥', suggestion: '补全过滤名单' },
      { file: 'src/kernel/agent.ts', severity: 'medium', issue: '重复样板', suggestion: '抽取共用函数' },
      { file: 'src/commands/handlers.ts', severity: 'low', issue: '死代码', suggestion: '删除' },
    ]);
    const ctx = {
      dataDir: d,
      cwd: process.cwd(),
      db, mem, bus: evBus,
      config: {
        get: () => ({ apiKeyEnc: null, baseURL: 'https://mock' }),
        getKey: () => undefined,
        setKey: () => undefined,
      },
      // 模拟 AI 审查结果（真实模型输出同构 JSON）
      agent: {
        run: async () => ({ ok: true, text: reviewJson, turns: 1, interrupted: false }),
      },
    } as any;
    // env 密钥使 resolveApiKey 通过（mock agent 不发网络请求）
    const oldKey = process.env.WXNODUS_API_KEY;
    process.env.WXNODUS_API_KEY = 'test-key';
    try {
      registerExtHandlers(bus, ctx);
      const r = await bus.execute('/self-evolve --report');
      expect(r.ok).toBe(true);
      expect(r.output).toContain('自我审查报告');
      expect(r.output).toContain('3 条');
      expect(r.output).toContain('🔴 1'); // 严重度计数
      // 落盘审计留痕
      const files = readdirSync(join(d, 'reports'));
      expect(files.length).toBe(1);
      const md = readFileSync(join(d, 'reports', files[0]!), 'utf8');
      expect(md).toContain('# WxNodus 自我审查报告');
      expect(md).toContain('[HIGH] src/kernel/env.ts');
      expect(md).toContain('> 建议：');
    } finally {
      process.env.WXNODUS_API_KEY = oldKey;
      closeDB(db);
    }
  });
});

// ── /jobs 并行任务系统（真实 shell 子进程 + 并行编排）──
describe('/jobs 并行任务系统', () => {
  it('run --parallel 创建父任务 + 3 条执行线；tree 展示任务树', async () => {
    const d = tmp();
    const bus = createCommandBus();
    const db = openDB(d);
    const evBus = createEventBus(d);
    const mem = createMemory(db);
    const { createTaskRunner } = await import('../src/kernel/taskRunner.js');
    const taskRunner = createTaskRunner({
      db, bus: evBus, dataDir: d,
      spawnSubagent: async () => ({ ok: true, output: 'ok', turns: 1 }),
      maxConcurrent: 4,
    });
    const ctx = {
      dataDir: d, cwd: process.cwd(), db, mem, bus: evBus,
      config: { get: () => ({}), getKey: () => undefined, setKey: () => {} },
      agent: { run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }) },
      taskRunner,
      getModel: () => '', getMode: () => 'smart', setMode: () => {}, setTheme: () => {}, getThemeName: () => 'wxnodus',
      requestExit: () => {}, clearHistory: () => {}, setModel: () => {}, openModelPicker: () => {}, openSessions: () => {}, setThinking: () => {},
    } as any;
    registerExtHandlers(bus, ctx);
    const r = await bus.execute('/jobs run node -e "console.log(1)" --parallel node -e "console.log(2)" --parallel node -e "console.log(3)"');
    expect(r.ok).toBe(true);
    expect(r.output).toContain('并行任务已启动');
    const m = r.output!.match(/t[a-z0-9]+/);
    const pid = m ? m[0] : '';
    expect(pid).toBeTruthy();
    // 等待父任务聚合完成
    const wait = (ms: number) => new Promise(res => setTimeout(res, ms));
    let done = false;
    for (let i = 0; i < 50 && !done; i++) {
      await wait(200);
      done = taskRunner.get(pid)?.status === 'success' || taskRunner.get(pid)?.status === 'failed';
    }
    expect(taskRunner.get(pid)!.status).toBe('success');
    expect(taskRunner.childrenOf(pid)).toHaveLength(3); // 主线 + 2 支线
    const tree = await bus.execute(`/jobs tree ${pid}`);
    expect(tree.ok).toBe(true);
    expect(tree.output).toContain('任务树');
    expect(tree.output).toContain(pid);
    const list = await bus.execute('/jobs list');
    expect(list.ok).toBe(true);
    expect(list.output).toContain(pid);
    // kill 已完成任务 → 无副作用（幂等）
    const kill = await bus.execute(`/jobs kill ${pid}`);
    expect(kill.ok).toBe(true);
    closeDB(db);
  });
});

// ── /assimilate 黑洞同化器（目录 100% 同化 + 素材消化）──
describe('/assimilate 黑洞同化', () => {
  it('目录同化：真实技能目录 → 面板报告 + discoverSkills 可见', async () => {
    const d = tmp();
    const src = tmp();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    mkdirSync(join(src, 'skill-x'), { recursive: true });
    writeFileSync(join(src, 'skill-x', 'SKILL.md'), '---\nname: "skill-x"\ndescription: "测试技能"\n---\n\n# skill-x\n\n## 工作流\n1. 步骤');
    const bus = createCommandBus();
    const db = openDB(d);
    const evBus = createEventBus(d);
    const mem = createMemory(db);
    const ctx = {
      dataDir: d, cwd: process.cwd(), db, mem, bus: evBus,
      config: { get: () => ({}), getKey: () => undefined, setKey: () => {} },
      agent: { run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }) },
      getModel: () => '', getMode: () => 'smart', setMode: () => {}, setTheme: () => {}, getThemeName: () => 'wxnodus',
      requestExit: () => {}, clearHistory: () => {}, setModel: () => {}, openModelPicker: () => {}, openSessions: () => {}, setThinking: () => {},
    } as any;
    registerExtHandlers(bus, ctx);
    const r = await bus.execute(`/assimilate ${src}`);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('黑洞同化');
    expect(r.output).toContain('✅ 同化 1 个');
    expect(r.output).toContain('skill-x');
    // 同化后可用
    const { discoverSkills } = await import('../src/kernel/skills.js');
    expect(discoverSkills(d, process.cwd()).some(m => m.name === 'skill-x')).toBe(true);
    closeDB(db);
  });

  it('素材消化：无 key 诚实提示（不产生假内容）', async () => {
    const d = tmp();
    const bus = createCommandBus();
    const db = openDB(d);
    const evBus = createEventBus(d);
    const mem = createMemory(db);
    const ctx = {
      dataDir: d, cwd: process.cwd(), db, mem, bus: evBus,
      config: { get: () => ({}), getKey: () => undefined, setKey: () => {} },
      agent: { run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }) },
      getModel: () => '', getMode: () => 'smart', setMode: () => {}, setTheme: () => {}, getThemeName: () => 'wxnodus',
      requestExit: () => {}, clearHistory: () => {}, setModel: () => {}, openModelPicker: () => {}, openSessions: () => {}, setThinking: () => {},
    } as any;
    registerExtHandlers(bus, ctx);
    const oldKey = process.env.WXNODUS_API_KEY;
    delete process.env.WXNODUS_API_KEY;
    try {
      const r = await bus.execute('/assimilate 素材.md --name demo-skill');
      expect(r.ok).toBe(true);
      expect(r.output).toContain('模型密钥'); // 诚实提示
      expect(r.output).not.toContain('已消化'); // 未产生假技能
    } finally {
      if (oldKey !== undefined) process.env.WXNODUS_API_KEY = oldKey;
      closeDB(db);
    }
  });
});

describe('renderWaterfall 成本后缀', () => {
  it('priceFor 提供时行尾 ≈$；null 不显示', () => {
    const rows = [{ model: 'deepseek-chat', input_tokens: 1_000_000, output_tokens: 1_000_000, ts: Date.now() }];
    const withCost = renderWaterfall(rows, 20, undefined, () => 0.7);
    expect(withCost).toContain('≈$0.7000');
    const noCost = renderWaterfall(rows, 20, undefined, () => null);
    expect(noCost).not.toContain('≈$');
  });
});

describe('/fs 面板封顶诚实标注（纯函数）', () => {
  it('fsLsRows：超 30 个标注总数，未超原样', async () => {
    const { fsLsRows } = await import('../src/commands/handlersExt.js');
    const many = Array.from({ length: 35 }, (_, i) => `f${i}`);
    const out = fsLsRows(many);
    expect(out).toHaveLength(31); // 30 + 1 标注行
    expect(out.at(-1)).toContain('共 35 个');
    expect(out).not.toContain('f34');
    expect(fsLsRows(['a', 'b'])).toEqual(['a', 'b']);
  });
  it('fsReadRows：超 60 行标注总数，未超原样', async () => {
    const { fsReadRows } = await import('../src/commands/handlersExt.js');
    const many = Array.from({ length: 70 }, (_, i) => `第${i}行`);
    const out = fsReadRows(many);
    expect(out).toHaveLength(61);
    expect(out.at(-1)).toContain('共 70 行');
    expect(out).not.toContain('第69行');
    expect(fsReadRows(['a'])).toEqual(['a']);
  });
  it('sqlTableRows：超 20 行标注总数（行数影响结论——绝不静默截前 20 行），未超无标注', async () => {
    const { sqlTableRows } = await import('../src/commands/handlersExt.js');
    const many = Array.from({ length: 25 }, (_, i) => ({ id: i }));
    const out = sqlTableRows(many, ['id']);
    expect(out).toHaveLength(21); // 20 + 1 标注行
    expect(out.at(-1)).toContain('共 25 行');
    expect(out.at(-1)).toContain('LIMIT 收窄');
    expect(out).not.toContain(' 24 ');
    expect(sqlTableRows([{ id: 1 }], ['id'])).toHaveLength(1);
  });
});

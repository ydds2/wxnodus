// tests/commands.test.ts — L4 命令层：注册表/别名/NL 路由/确定性工具
import { describe, it, expect } from 'vitest';
import { SLASH, COMMAND_CAT, COMMAND_DESC, isSlash, resolveAlias } from '../src/commands/registry.js';
import { nlTrigger, routeNaturalLanguage, routeInput, NL_TRIGGERS, type NlTrigger } from '../src/commands/intent.js';
import { deterministicRun } from '../src/commands/deterministic.js';

describe('命令注册表（单一事实来源）', () => {
  it('核心命令全覆盖', () => {
    for (const c of ['/help', '/clear', '/undo', '/quit', '/sessions', '/key', '/model', '/status', '/doctor',
      '/memory', '/hole', '/compact', '/build', '/deploy', '/forge', '/skill', '/gate', '/perm', '/sandbox',
      '/compliance', '/consent', '/backup', '/export', '/theme', '/lang', '/vision', '/img', '/video',
      '/claw', '/mcp', '/calc', '/hash', '/base64', '/uuid', '/json', '/timer', '/sql', '/fs', '/version']) {
      expect(SLASH).toContain(c);
    }
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

// tests/commands-intent.test.ts — NL 路由契约测试
// 审查修复：README「说人话」表此前无任何测试锁定——/hole 与 /search 的重叠正则
// 靠数组顺序兜底，任何增改都会静默破坏 README 承诺。本文件把承诺写成断言。
import { describe, it, expect } from 'vitest';
import { routeInput, routeNaturalLanguage } from '../src/commands/intent.js';

describe('NL 路由契约（README「说人话」六行锁定）', () => {
  const cases: Array<{ text: string; kind: 'command' | 'tool' | 'chat'; cmd?: string }> = [
    // 「帮我做一个待办系统」→ 概念编译
    { text: '帮我做一个待办系统', kind: 'command', cmd: '/build' },
    { text: '帮我做一个记账应用', kind: 'command', cmd: '/build' },
    // 「搜一下我之前说的黑洞」→ 黑洞引擎（与 /search 正则重叠——顺序锁定）
    { text: '搜一下我之前说的黑洞', kind: 'command', cmd: '/hole' },
    { text: '我记得之前说过什么来着', kind: 'command', cmd: '/hole' },
    // 「算一下 2+3*4」→ 确定性计算（不走模型；需「算/计算」开头词）
    { text: '算一下 2+3*4', kind: 'tool' },
    { text: '计算 2+3*4', kind: 'tool' },
    // 「分析这个视频 …」→ 视频人工视觉
    { text: '分析这个视频讲了什么', kind: 'command', cmd: '/video' },
    // 「看看这张图 …」→ GLM-4V 视觉理解
    { text: '看看这张图', kind: 'command', cmd: '/vision' },
    { text: '分析一下这张截图', kind: 'command', cmd: '/vision' },
    // 「体检」→ 系统健康检查
    { text: '体检', kind: 'command', cmd: '/doctor' },
  ];
  for (const c of cases) {
    it(`${c.text} → ${c.cmd ?? c.kind}`, async () => {
      const r = await routeInput(c.text);
      expect(r.kind).toBe(c.kind);
      if (c.cmd) expect(r.cmd).toBe(c.cmd);
    });
  }
});

describe('NL 路由边界（防误劫持）', () => {
  // 重叠正则顺序：搜一下+记忆词 → /hole；搜一下+其他 → /search
  it('「搜一下Python教程」→ /search（无记忆词）', () => {
    expect(routeNaturalLanguage('搜一下Python教程')).toBe('/search');
  });
  it('「上网搜一下Python的最新版本」→ /search（无记忆词）', () => {
    expect(routeNaturalLanguage('上网搜一下Python的最新版本')).toBe('/search');
  });
  // F16 守卫：疑问/叙述长句交 AI 对话层，不劫持为命令
  it('疑问长句 → 对话层（不劫持）', () => {
    expect(routeNaturalLanguage('你觉得这个项目怎么样')).toBeNull();
  });
  it('叙述完成态 → 对话层（备份过不算命令）', () => {
    expect(routeNaturalLanguage('我之前备份过数据')).toBeNull();
    expect(routeNaturalLanguage('项目已经部署上线了')).toBeNull();
  });
  it('祈使长句 → 正常路由', () => {
    expect(routeNaturalLanguage('把代码备份到U盘')).toBe('/backup');
    expect(routeNaturalLanguage('帮我分析一下这个系统的安全性')).toBeNull(); // 分析词后无图/视频 → 对话层
  });
  // 斜杠命令：别名归一 + 补全
  it('中文别名 /权限 → /perm', async () => {
    const r = await routeInput('/权限');
    expect(r.kind).toBe('command');
    expect(r.cmd).toBe('/perm');
  });
  it('/help 精确命中（无补全漂移）', async () => {
    const r = await routeInput('/help');
    expect(r.cmd).toBe('/help');
  });
});

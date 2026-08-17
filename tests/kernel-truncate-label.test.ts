// tests/kernel-truncate-label.test.ts — 截断四件套补全：delegate / browser 快照 / labelTruncate 单一事实源
// 口径：任何面向模型的截断都必须显式标注「共 N 字 / 剩余 M 字」——绝不静默截断（模型误判「内容到此为止」）
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 静默 */ } } });

describe('labelTruncate 单一事实源', () => {
  it('短文本原样返回（无标注）', async () => {
    const { labelTruncate } = await import('../src/kernel/truncate.js');
    expect(labelTruncate('短', 100, '提示')).toBe('短');
  });
  it('超限截断显式标注：已截断 / 共 N 字 / 剩余 M 字 / 续查提示', async () => {
    const { labelTruncate } = await import('../src/kernel/truncate.js');
    const out = labelTruncate('x'.repeat(250), 100, '分段续查');
    expect(out.length).toBeLessThan(250);
    expect(out).toContain('已截断');
    expect(out).toContain('共 250 字');
    expect(out).toContain('剩余 150 字');
    expect(out).toContain('分段续查');
  });
  it('无提示时省略破折号后缀（每条目紧凑标注）', async () => {
    const { labelTruncate } = await import('../src/kernel/truncate.js');
    const out = labelTruncate('a'.repeat(50), 10);
    expect(out).toContain('已截断（共 50 字，剩余 40 字未读）]');
    expect(out).not.toContain('——');
  });
  it('capNote 列表封顶标注：超限共 N 个/前 M 个 + 提示；未超限为空', async () => {
    const { capNote } = await import('../src/kernel/truncate.js');
    expect(capNote(35, 30, 'computer_uia_tree <handle> 直达')).toContain('共 35 个，已截断（前 30 个）');
    expect(capNote(35, 30, 'computer_uia_tree <handle> 直达')).toContain('computer_uia_tree <handle> 直达');
    expect(capNote(5, 30)).toBe('');
    expect(capNote(30, 30)).toBe('');
  });
});

describe('delegate 子代理输出诚实截断', () => {
  it('超长输出显式标注（模型知道子代理还有话没给全）', async () => {
    const { coreTools } = await import('../src/kernel/tools.js');
    const delegate = coreTools().delegate!;
    const long = '结论'.repeat(3000); // >4000 字
    const ctx = { spawnSubagent: async () => ({ ok: true, turns: 3, output: long }) };
    const out = await delegate.run({ goal: '生成很长报告' }, ctx as any);
    expect(out).toContain('已截断');
    expect(out).toContain(`共 ${long.length} 字`);
    expect(out).toContain('子代理完成');
  });
  it('短输出无标注', async () => {
    const { coreTools } = await import('../src/kernel/tools.js');
    const delegate = coreTools().delegate!;
    const ctx = { spawnSubagent: async () => ({ ok: true, turns: 2, output: '简短结论' }) };
    const out = await delegate.run({ goal: 'x' }, ctx as any);
    expect(out).toContain('简短结论');
    expect(out).not.toContain('已截断');
  });
});

describe('browser 快照正文诚实截断', () => {
  it('cleanBodyText 超限标注（正文截断不再静默）', async () => {
    const { cleanBodyText } = await import('../src/kernel/browser.js');
    const out = cleanBodyText('字'.repeat(3000), 2500, 'browser_snapshot 续看');
    expect(out).toContain('已截断');
    expect(out).toContain('共 3000 字');
    expect(out).toContain('剩余 500 字');
    expect(out).toContain('browser_snapshot 续看');
  });
  it('短正文原样返回（无标注）', async () => {
    const { cleanBodyText } = await import('../src/kernel/browser.js');
    expect(cleanBodyText('短正文', 2500, 'x')).toBe('短正文');
  });
});

describe('wx_cmd 命令输出诚实截断（labelTruncate 统一口径）', () => {
  it('超长命令输出标注共 N 字/剩余 M 字', async () => {
    const { coreTools } = await import('../src/kernel/tools.js');
    const long = '出'.repeat(3000);
    const out = await coreTools().wx_cmd!.run({ command: '/hole 全部' }, { runCommand: async () => long } as any);
    expect(out).toContain('已截断');
    expect(out).toContain('共 3000 字');
    expect(out).toContain('剩余 1000 字');
  });
  it('短输出原样返回（无标注）', async () => {
    const { coreTools } = await import('../src/kernel/tools.js');
    const out = await coreTools().wx_cmd!.run({ command: '/status' }, { runCommand: async () => '短输出' } as any);
    expect(out).toBe('短输出');
  });
});

describe('bash 输出诚实截断（8000–20000 原静默区间补标）', () => {
  it('9000 字输出 → 显式标注（修复 8000–20000 静默截断缺陷）', async () => {
    const { coreTools } = await import('../src/kernel/tools.js');
    const d = mkdtempSync(join(tmpdir(), 'wx-bash-'));
    dirs.push(d);
    const out = await coreTools().bash!.run({ command: `node -e "process.stdout.write('x'.repeat(9000))"` }, { cwd: d } as any);
    expect(out).toContain('已截断');
    expect(out).toContain('共 9000 字');
    expect(out).toContain('剩余 1000 字');
  }, 30000);
  it('短输出无标注', async () => {
    const { coreTools } = await import('../src/kernel/tools.js');
    const d = mkdtempSync(join(tmpdir(), 'wx-bash2-'));
    dirs.push(d);
    const out = await coreTools().bash!.run({ command: `node -e "process.stdout.write('ok')"` }, { cwd: d } as any);
    expect(out).toContain('ok');
    expect(out).not.toContain('已截断');
  }, 30000);
});

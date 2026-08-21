// tests/v4-lsp-feedback.test.ts — V4 P2-8：LSP 诊断自动回灌
// ① settings.lspFeedback 默认 off（编辑结果零附加）
// ② 开启 + 无语言服务器：零附加（不拉）
// ③ 开启 + mock LSP 返回非空诊断：附加 [LSP 诊断反馈] 块（截断 10 条）
// ④ LSP 超时 300ms 兜底：编辑主路径不被拖慢（零附加）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const lspSessionMock = { diagnostics: vi.fn(), hover: vi.fn(), definition: vi.fn() };
vi.mock('../src/kernel/lspClient.js', () => ({
  discoverLspServers: () => [{ id: 'ts', command: 'tsserver', languages: ['typescript'] }],
  serverForFile: () => ({ id: 'ts', command: 'tsserver', languages: ['typescript'] }),
  lspSessionFor: async () => lspSessionMock,
}));

import { coreTools } from '../src/kernel/tools.js';

const work = () => {
  mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
  return mkdtempSync(join(process.cwd(), '.tmp', 'wx-lsp-'));
};

describe('V4 P2-8 LSP 诊断自动回灌', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('默认 off：编辑成功结果零附加（LSP 不被触碰）', async () => {
    const d = work();
    try {
      writeFileSync(join(d, 'a.ts'), 'const x = 1;\n', 'utf8');
      const tools = coreTools();
      const ctx = { cwd: d, getSettings: () => ({}) } as any;
      const r = await tools.fs_edit!.run({ path: 'a.ts', oldText: 'const x = 1;', newText: 'const x = 2;' }, ctx);
      expect(String(r)).toContain('已替换');
      expect(String(r)).not.toContain('LSP 诊断反馈');
      expect(lspSessionMock.diagnostics).not.toHaveBeenCalled();
    } finally { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  });

  it('开启 lspFeedback：非空诊断附反馈块（文件:行:列 + 严重度图标）', async () => {
    const d = work();
    try {
      writeFileSync(join(d, 'b.ts'), 'const y = 1;\n', 'utf8');
      lspSessionMock.diagnostics.mockResolvedValue([
        { severity: 'error', line: 1, col: 7, message: "Type 'number' is not assignable" },
        { severity: 'warning', line: 2, col: 1, message: '未使用变量' },
      ]);
      const tools = coreTools();
      const ctx = { cwd: d, getSettings: () => ({ lspFeedback: true }) } as any;
      const r = await tools.fs_edit!.run({ path: 'b.ts', oldText: 'const y = 1;', newText: 'const y = "s";' }, ctx);
      expect(String(r)).toContain('LSP 诊断反馈');
      expect(String(r)).toContain('b.ts:1:7');
      expect(String(r)).toContain('✗');
      expect(String(r)).toContain('!');
    } finally { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  });

  it('LSP 空/超时：零附加（编辑主路径不受影响）', async () => {
    const d = work();
    try {
      writeFileSync(join(d, 'c.ts'), 'const z = 1;\n', 'utf8');
      lspSessionMock.diagnostics.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve([{ severity: 'error', line: 1, col: 1, message: 'late' }]), 5_000)));
      const tools = coreTools();
      const ctx = { cwd: d, getSettings: () => ({ lspFeedback: true }) } as any;
      const started = Date.now();
      const r = await tools.fs_edit!.run({ path: 'c.ts', oldText: 'const z = 1;', newText: 'const z = 2;' }, ctx);
      expect(Date.now() - started).toBeLessThan(1_500); // 300ms 兜底生效（非 5s）
      expect(String(r)).not.toContain('LSP 诊断反馈');
    } finally { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  });
});

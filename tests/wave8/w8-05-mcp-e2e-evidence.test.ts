// tests/wave8/w8-05-mcp-e2e-evidence.test.ts — W8-05：MCP 真实端到端证据入口契约
// 契约：`npm run evidence:mcp-e2e` 必须经生产模块真实执行端到端——
// 生成可运行 stdio 服务器 → connectAllMcp 真实连接（生产客户端）→ callTool 真实调用
// → mcpClientsToTools 真实工具表映射 → receipt 落盘。不得以 mock/占位冒充 E2E。
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('W8-05 MCP 真实 E2E 证据入口（诚实背书）', () => {
  it('npm script evidence:mcp-e2e 指向 scripts/evidence-mcp-e2e.mjs', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['evidence:mcp-e2e']).toContain('scripts/evidence-mcp-e2e.mjs');
  });

  it('证据实现经生产模块真实执行：connectAllMcp + callTool + mcpClientsToTools + 真实进程 spawn', () => {
    const src = readFileSync(join(ROOT, 'scripts', 'evidence-mcp-e2e.ts'), 'utf8');
    expect(src).toContain("await import('../src/kernel/mcp.js')");
    expect(src).toContain('connectAllMcp');
    expect(src).toContain('callTool(');
    expect(src).toContain('mcpClientsToTools');
    expect(src).toContain('spawn'); // 真实子进程（不 mock）
    expect(src).toContain('generateMcpServer'); // 真实生成器产出可运行服务器
  });

  it('receipt 判定真实：连接成功 + 工具调用返回 + 关闭清理，任一失败即 exit 2', () => {
    const src = readFileSync(join(ROOT, 'scripts', 'evidence-mcp-e2e.ts'), 'utf8');
    expect(src).toContain('connected');
    expect(src).toContain('closeAllMcp');
    expect(src).toContain('process.exit(passed ? 0 : 2)');
  });
});

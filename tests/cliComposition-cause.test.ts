// tests/cliComposition-cause.test.ts — F4 修复契约：组合失败根因透出（不吞真因）
import { describe, it, expect } from 'vitest';
import { composeFailureCause } from '../src/bootstrap/cliComposition.js';
import { configError } from '../src/domain/config/configSchema.js';

describe('F4：组合失败根因透出（纯函数）', () => {
  it('THREW 阶段的真实 cause 优先于错误码', () => {
    const threw = {
      ok: false as const,
      error: configError('CLI_COMPOSITION_PHASE_THREW', 'cli.composition.phase_threw', { phase: 'repositories', cause: 'file is not a database' }),
    };
    expect(composeFailureCause(threw)).toBe('file is not a database');
  });

  it('无 details 时回退错误码', () => {
    const bare = {
      ok: false as const,
      error: configError('CLI_COMPOSITION_PHASE_THREW', 'cli.composition.phase_threw'),
    };
    expect(composeFailureCause(bare)).toBe('CLI_COMPOSITION_PHASE_THREW');
  });
});

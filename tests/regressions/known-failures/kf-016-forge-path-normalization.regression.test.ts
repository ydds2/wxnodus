// tests/regressions/known-failures/kf-016-forge-path-normalization.regression.test.ts — KF-016 已修复回归
// forgeSkillDir/forgeMcpServer 目录组合幂等：outDir 已含组件名时不得二次 join（路径双拼）。
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { forgeMcpServer, forgeSkillDir } from '../../../src/forge/forge.js';

describe('KF-016 resolved: forge 目录组合幂等（不双拼）', () => {
  it('调用方已按组件名建目录 → 产物落位该目录本身（不再嵌套一层同名目录）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-kf016r-'));
    try {
      const composed = join(dir, 'my-skill');
      const skill = forgeSkillDir(composed, 'my-skill', '描述', '流程');
      expect(skill).toBe(composed);
      expect(existsSync(join(composed, 'SKILL.md'))).toBe(true); // 双拼缺陷时落在 composed/my-skill/SKILL.md
      const server = forgeMcpServer(composed, 'my-skill', []);
      expect(existsSync(join(server, 'server.js'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('父目录 + 组件名约定保持（向后兼容：outDir 为父目录时仍创建命名子目录）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-kf016c-'));
    try {
      const skill = forgeSkillDir(dir, 'other-skill', '描述', '流程');
      expect(skill).toBe(join(dir, 'other-skill'));
      expect(existsSync(join(dir, 'other-skill', 'SKILL.md'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

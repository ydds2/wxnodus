// tests/integration/wave3-legacy-bypass.test.ts — W3-11：遗留路径断电（compat 委托整体禁用 → LEGACY_PATH_DISABLED，任何构造之前 fail closed）
import { afterEach, describe, expect, it } from 'vitest';
import { areLegacyPathsEnabled, assertLegacyPath, setLegacyPathsEnabled } from '../../src/application/legacy/legacyGuard.js';
import { createComputerUse } from '../../src/commands/computerCompat.js';

afterEach(() => { setLegacyPathsEnabled(true); });

describe('legacy path disablement', () => {
  it('allows compat delegation by default', () => {
    expect(areLegacyPathsEnabled()).toBe(true);
    expect(assertLegacyPath('computer-use')).toMatchObject({ ok: true });
  });

  it('fails closed with LEGACY_PATH_DISABLED once legacy paths are switched off', () => {
    setLegacyPathsEnabled(false);
    expect(assertLegacyPath('voice-record')).toMatchObject({
      ok: false,
      error: { code: 'LEGACY_PATH_DISABLED', details: { path: 'voice-record' } },
    });
  });

  it('throws LEGACY_PATH_DISABLED before any driver construction', async () => {
    setLegacyPathsEnabled(false);
    await expect(createComputerUse({ width: 800, height: 600 } as never)).rejects.toMatchObject({
      code: 'LEGACY_PATH_DISABLED',
    });
  });
});

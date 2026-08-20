import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfig } from '../src/store/config.js';

const fixture = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  'fixtures/config/v3-corrupt.json',
);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('config corruption', () => {
  it('returns CONFIG_CORRUPT instead of silently manufacturing empty state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-config-corrupt-'));
    dirs.push(dir);
    copyFileSync(fixture, join(dir, 'settings.json'));
    const config = createConfig(dir);

    let errorCode: string | undefined;
    try {
      config.get('settings');
    } catch (error) {
      errorCode = (error as { code?: string }).code;
    }

    expect(errorCode, 'CONFIG_CORRUPT').toBe('CONFIG_CORRUPT');
  });
});

// tests/kernel-image-pending.test.ts — 待注入图片登记（共享 pending.json 契约）
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePending, readPending, clearPending, attachmentsDir } from '../src/kernel/imagePending.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 静默 */ } } });

describe('imagePending 共享契约', () => {
  it('write → read 往返；文件丢失 → null；clear 幂等', () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-pend-'));
    dirs.push(d);
    const img = join(d, 'a.png');
    writeFileSync(img, 'png');
    expect(readPending(d, 's1')).toBeNull();
    writePending(d, 's1', img, 'image/png');
    expect(readPending(d, 's1')).toEqual({ file: img, mime: 'image/png', ts: expect.any(Number) });
    clearPending(d, 's1');
    expect(readPending(d, 's1')).toBeNull();
    clearPending(d, 's1'); // 幂等不抛
  });

  it('pending 文件存在但图片已删 → 诚实 null（不注入幽灵路径）', () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-pend-'));
    dirs.push(d);
    const img = join(d, 'gone.png');
    writePending(d, 's1', img, 'image/png'); // 只写登记不落图片
    expect(readPending(d, 's1')).toBeNull();
    expect(existsSync(join(attachmentsDir(d, 's1'), 'pending.json'))).toBe(true);
  });
});

// tests/kernel-skin.test.ts — 皮肤数据源（/skin 真实生效：文件加载 + 回退）
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkinFile } from '../src/kernel/skin.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wx-skin-'));
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

describe('loadSkinFile（皮肤数据源）', () => {
  it('default/空名 → null（内置主题）', () => {
    const d = tmp();
    expect(loadSkinFile(d, 'default')).toBeNull();
    expect(loadSkinFile(d, '')).toBeNull();
    expect(loadSkinFile(d, null)).toBeNull();
  });
  it('data/skins/<name>.json 存在 → 返回皮肤对象', () => {
    const d = tmp();
    mkdirSync(join(d, 'skins'), { recursive: true });
    writeFileSync(join(d, 'skins', 'ocean.json'), JSON.stringify({
      colors: { ui_accent: '#00FFAA' },
      branding: { agent_name: 'Ocean Agent' },
    }), 'utf8');
    const skin = loadSkinFile(d, 'ocean');
    expect(skin).not.toBeNull();
    expect(skin!.colors!.ui_accent).toBe('#00FFAA');
    expect(skin!.branding!.agent_name).toBe('Ocean Agent');
  });
  it('文件不存在/损坏 → null（回退内置，不抛）', () => {
    const d = tmp();
    expect(loadSkinFile(d, 'nope')).toBeNull();
    mkdirSync(join(d, 'skins'), { recursive: true });
    writeFileSync(join(d, 'skins', 'bad.json'), '{broken', 'utf8');
    expect(loadSkinFile(d, 'bad')).toBeNull();
  });
});

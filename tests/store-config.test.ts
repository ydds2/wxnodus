// tests/store-config.test.ts — L1-2 配置中心：分区 json / 类型化 / 原子写 / 默认值
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig, type Config } from '../src/store/config.js';

let dir: string;
let cfg: Config;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxn-cfg-'));
  cfg = createConfig(dir);
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('分区读写', () => {
  it('get/set 各分区独立', () => {
    cfg.set('settings', { model: 'deepseek-v4-flash', baseURL: 'https://api.deepseek.com/v1' });
    cfg.set('aliases', { '/帮助': '/help' });
    expect(cfg.get('settings').model).toBe('deepseek-v4-flash');
    expect(cfg.get('aliases')['/帮助']).toBe('/help');
    // 分区互不污染
    expect(cfg.get('aliases').model).toBeUndefined();
  });

  it('set 合并而非覆盖（同分区增量）', () => {
    cfg.set('settings', { model: 'deepseek-v4-flash' });
    cfg.set('settings', { apiKeyEnc: 'enc1:xxx' });
    const s = cfg.get('settings');
    expect(s.model).toBe('deepseek-v4-flash');
    expect(s.apiKeyEnc).toBe('enc1:xxx');
  });

  it('未设置分区返回空对象（不崩溃）', () => {
    expect(cfg.get('nope')).toEqual({});
  });

  it('持久化到磁盘（data/<分区>.json）', () => {
    expect(existsSync(join(dir, 'settings.json'))).toBe(true);
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(onDisk.model).toBe('deepseek-v4-flash');
  });

  it('重新打开可读回（持久性）', () => {
    const cfg2 = createConfig(dir);
    expect(cfg2.get('settings').model).toBe('deepseek-v4-flash');
  });
});

describe('键路径读写（settings.apiKeyEnc）', () => {
  it('getKey/setKey 点路径', () => {
    cfg.setKey('settings', 'model', 'glm-4v-flash');
    expect(cfg.getKey('settings', 'model')).toBe('glm-4v-flash');
    cfg.setKey('settings', 'nested.a.b', 42);
    expect(cfg.getKey('settings', 'nested.a.b')).toBe(42);
  });
});

describe('原子写', () => {
  it('写入后无 .tmp 残留', () => {
    cfg.set('routes', { '/default': 'deepseek' });
    const files = require('node:fs').readdirSync(dir) as string[];
    expect(files.some(f => f.includes('.tmp'))).toBe(false);
  });
});

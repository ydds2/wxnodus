// tests/wave8/w8-13-receipt-scenario-files.test.ts — W8-13：Windows 验收证据 → 场景结果目录（produce --scenario-dir 供给）
// writeScenarioFiles 把证据场景写为 per-scenario JSON（{id,status,attachmentIds}）+ 真实 stdout 附件 log——
// Gate E receipt 的场景闭包从此由本机证据真实喂入（绝不硬编码 passed）。
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeScenarioFiles } from '../../src/release/evidenceScenarioFiles.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) { try { close(); } catch { /* already closed */ } } });

describe('writeScenarioFiles（W8-13 场景结果目录供给）', () => {
  it('每个场景落独立 JSON（id/status/attachmentIds）+ 附件 log 内容逐字节等于真实 stdout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w8-13-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const written = writeScenarioFiles(dir, {
      voice: { status: 'passed', raw: 'RIFF\tWAVE\t"transcriptChars": 7', parsed: { status: 'passed' } },
      uia: { status: 'blocked', raw: 'requires interactive fixture session', parsed: { status: 'blocked', reason: 'requires interactive fixture session' } },
    });
    expect(written.map(w => w.id).sort()).toEqual(['uia', 'voice']);

    const voiceJson = JSON.parse(readFileSync(join(dir, 'voice.json'), 'utf8')) as Record<string, unknown>;
    expect(voiceJson).toEqual({ id: 'voice', status: 'passed', attachmentIds: ['voice.log'] });
    expect(readFileSync(join(dir, 'voice.log'), 'utf8')).toBe('RIFF\tWAVE\t"transcriptChars": 7\n');

    const uiaJson = JSON.parse(readFileSync(join(dir, 'uia.json'), 'utf8')) as Record<string, unknown>;
    expect(uiaJson).toMatchObject({ id: 'uia', status: 'blocked', reason: 'requires interactive fixture session', attachmentIds: ['uia.log'] });
    expect(existsSync(join(dir, 'uia.log'))).toBe(true);
  });

  it('blocked 无 reason 时不写 reason 字段（如实，不编造原因）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w8-13-noreason-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    writeScenarioFiles(dir, { x: { status: 'blocked', raw: 'whisper 资产缺失', parsed: null } });
    const json = JSON.parse(readFileSync(join(dir, 'x.json'), 'utf8')) as Record<string, unknown>;
    expect(json).toEqual({ id: 'x', status: 'blocked', attachmentIds: ['x.log'] });
  });

  it('附件路径为纯文件名（receipt manifest 路径校验不越界）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w8-13-path-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    writeScenarioFiles(dir, { 'build-restart-readback': { status: 'passed', raw: 'readBackMatches: true', parsed: {} } });
    const json = JSON.parse(readFileSync(join(dir, 'build-restart-readback.json'), 'utf8')) as { attachmentIds: string[] };
    for (const attachmentId of json.attachmentIds) {
      expect(attachmentId).not.toContain('\\');
      expect(attachmentId).not.toContain('..');
      expect(attachmentId.startsWith('/')).toBe(false);
    }
  });
});

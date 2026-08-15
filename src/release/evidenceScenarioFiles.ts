// src/release/evidenceScenarioFiles.ts — W8-13：Windows 验收证据 → 场景结果目录（Gate E produce --scenario-dir 供给）
// 每个场景落 <id>.json（{id,status,attachmentIds}，blocked 且 parsed 有 reason 时附带 reason）+
// <id>.log（该场景真实 stdout 全文）。produce 的 loadScenarioResults 消费此格式并把附件哈希绑定进 receipt
// 三件套——场景闭包由本机证据真实喂入，绝不硬编码。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface EvidenceScenarioResult {
  status: string;
  raw: string;
  parsed: Record<string, unknown> | null;
}

export interface WrittenScenarioFile {
  id: string;
  json: string;
  log: string;
}

export function writeScenarioFiles(
  dir: string,
  results: Record<string, EvidenceScenarioResult>,
): WrittenScenarioFile[] {
  mkdirSync(dir, { recursive: true });
  const written: WrittenScenarioFile[] = [];
  for (const [id, result] of Object.entries(results)) {
    const json = `${id}.json`;
    const log = `${id}.log`;
    const body: Record<string, unknown> = { id, status: result.status, attachmentIds: [log] };
    if (result.status !== 'passed' && result.parsed?.reason) body.reason = result.parsed.reason;
    writeFileSync(join(dir, json), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    writeFileSync(join(dir, log), `${result.raw}\n`, 'utf8');
    written.push({ id, json, log });
  }
  return written;
}

// src/kernel/imagePending.ts — 待注入图片登记（P3 图片附加链路的共享事实源）
// 命令层（/capture --attach）与 UI 层（image.attach/clipboard.paste/capture.attach 热键）
// 共用同一 pending.json 契约：下次提问时随能力门管线注入（视觉模型 parts / 文本模型 GLM 先识别）。
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function attachmentsDir(dataDir: string, sessionId: string): string {
  return join(dataDir, 'attachments', sessionId.replace(/[^\w.-]/g, '_'));
}

export function pendingPath(dataDir: string, sessionId: string): string {
  return join(attachmentsDir(dataDir, sessionId), 'pending.json');
}

export function writePending(dataDir: string, sessionId: string, file: string, mime: string): void {
  const dir = attachmentsDir(dataDir, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(pendingPath(dataDir, sessionId), JSON.stringify({ file, mime, ts: Date.now() }), 'utf8');
}

export function readPending(dataDir: string, sessionId: string): { file: string; mime: string } | null {
  try {
    const raw = readFileSync(pendingPath(dataDir, sessionId), 'utf8');
    const p = JSON.parse(raw) as { file: string; mime: string };
    return p?.file && existsSync(p.file) ? p : null;
  } catch {
    return null;
  }
}

export function clearPending(dataDir: string, sessionId: string): void {
  try { unlinkSync(pendingPath(dataDir, sessionId)); } catch { /* 无待注入 */ }
}

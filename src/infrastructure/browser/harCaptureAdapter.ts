// src/infrastructure/browser/harCaptureAdapter.ts — CDP/HAR 采集适配最小版（蓝图 §3.1.2）：
// 网络事件 → HAR 1.2 落盘（确定性：按 startedAt 排序）+ 与 VisionCapture 轨迹的 network 通道桥接
// 真实 CDP Network 域接入由 playwright-core 运行时完成（§10 后续 wave）；本适配器为可无头验证的合同层
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { OperationResult } from '../../protocol/results.js';
import { configError } from '../../domain/config/configSchema.js';
import type { RecordedNetworkEvent } from '../../domain/computer/visionCapture.js';

export interface HarCaptureEvent {
  method: string;
  url: string;
  status: number;
  startedAt: string;
  durationMs: number;
  mimeType?: string;
  size?: number;
}

export interface HarSession {
  sessionId: string;
  events: HarCaptureEvent[];
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class HarCaptureAdapter {
  openSession(sessionId: string): OperationResult<HarSession> {
    if (!SAFE_ID.test(sessionId)) return { ok: false, error: configError('HAR_CAPTURE_INVALID', 'har.capture.session.invalid') };
    return { ok: true, value: { sessionId, events: [] } };
  }

  recordEvent(session: HarSession, event: HarCaptureEvent): OperationResult<void> {
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(event.method) ||
        !event.url.startsWith('http://') && !event.url.startsWith('https://') ||
        !Number.isInteger(event.status) || event.status < 100 ||
        !Number.isFinite(event.durationMs) || event.durationMs < 0) {
      return { ok: false, error: configError('HAR_CAPTURE_INVALID', 'har.capture.event.invalid', { url: event.url }) };
    }
    session.events.push(event);
    return { ok: true, value: undefined };
  }

  /** HAR 1.2 落盘（确定性：条目按 startedAt 排序，URL 原样保留、不写绝对路径/时间戳以外的随机值） */
  async flush(session: HarSession, outDir: string): Promise<OperationResult<{ path: string; sha256: string }>> {
    if (session.events.length === 0) return { ok: false, error: configError('HAR_CAPTURE_EMPTY', 'har.capture.empty') };
    const entries = [...session.events].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).map(event => ({
      startedDateTime: event.startedAt,
      time: event.durationMs,
      request: { method: event.method, url: event.url, httpVersion: 'HTTP/1.1', headers: [], queryString: [], cookies: [] },
      response: { status: event.status, statusText: '', httpVersion: 'HTTP/1.1', headers: [], cookies: [], redirectURL: '', content: { size: event.size ?? 0, mimeType: event.mimeType ?? 'application/octet-stream' } },
      cache: {},
      timings: { send: 0, wait: event.durationMs, receive: 0 },
    }));
    const har = {
      log: {
        version: '1.2',
        creator: { name: 'wxnodus-har-capture', version: '1.0.0' },
        entries,
      },
    };
    const body = `${JSON.stringify(har, null, 2)}\n`;
    const sha256 = createHash('sha256').update(body).digest('hex');
    try {
      await mkdir(dirname(`${outDir}/x`), { recursive: true });
      const path = `${outDir.replace(/\\/g, '/').replace(/\/$/, '')}/session-${session.sessionId}.har`;
      await writeFile(path, body, 'utf8');
      return { ok: true, value: { path, sha256 } };
    } catch (cause) {
      return { ok: false, error: configError('HAR_CAPTURE_WRITE_FAILED', 'har.capture.write.failed', { cause: String(cause) }) };
    }
  }

  /** 桥接：HAR 会话 → VisionCapture RecordedStep.network（操作→端点对照的流量通道输入） */
  toNetworkEvents(session: HarSession): RecordedNetworkEvent[] {
    return session.events.map(event => ({ method: event.method, url: event.url, status: event.status }));
  }
}

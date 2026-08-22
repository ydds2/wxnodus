// src/infrastructure/browser/harCaptureAdapter.ts — CDP/HAR 采集适配（W5-02 隐私加固版）：
// 网络事件 → 预存储脱敏（userinfo + 敏感 query 在进内存前删除；不可 parse 拒绝）→ 配额逐维强制
// → HAR 1.2 落盘（确定性排序 + 原子写 tmp/fsync/rename）。超限仍落盘但 complete:false + reason + counts
// + policyDigest（诚实标记不完整，绝不伪装成功）。桥接 VisionCapture 轨迹 network 通道。
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { OperationResult } from '../../protocol/results.js';
import { configError } from '../../domain/config/configSchema.js';
import type { RecordedNetworkEvent } from '../../domain/computer/visionCapture.js';
import { redactHarUrl } from './redactionPolicy.js';
import { createHarQuotaPolicy, type HarQuotaPolicy, type HarQuotaPolicyOptions } from './harQuotaPolicy.js';
import { OWNED_HAR_FILE } from './harRetention.js';

export interface HarCaptureEvent {
  method: string;
  url: string;
  status: number;
  startedAt: string;
  durationMs: number;
  mimeType?: string;
  size?: number;
}

export interface HarSessionCounts {
  events: number;
  redactedParams: number;
  rejected: number;
}

export interface HarSession {
  sessionId: string;
  events: HarCaptureEvent[];
  counts: HarSessionCounts;
}

export interface HarFlushResult {
  path: string;
  sha256: string;
  complete: boolean;
  counts: HarSessionCounts;
  policyDigest: string;
  reason?: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class HarCaptureAdapter {
  private readonly quota: HarQuotaPolicy;

  constructor(options: { quota?: Partial<HarQuotaPolicyOptions> } = {}) {
    this.quota = createHarQuotaPolicy(options.quota);
  }

  openSession(sessionId: string): OperationResult<HarSession> {
    if (!SAFE_ID.test(sessionId)) return { ok: false, error: configError('HAR_CAPTURE_INVALID', 'har.capture.session.invalid') };
    return { ok: true, value: { sessionId, events: [], counts: { events: 0, redactedParams: 0, rejected: 0 } } };
  }

  /** 事件入内存前即脱敏：userinfo/敏感 query 删除、URL 长度与事件数配额强制；非法事件拒绝（绝不带病存储） */
  recordEvent(session: HarSession, event: HarCaptureEvent): OperationResult<void> {
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(event.method) ||
        !Number.isInteger(event.status) || event.status < 100 ||
        !Number.isFinite(event.durationMs) || event.durationMs < 0) {
      session.counts.rejected++;
      return { ok: false, error: configError('HAR_CAPTURE_INVALID', 'har.capture.event.invalid', { url: event.url }) };
    }
    const redacted = redactHarUrl(event.url);
    if (!redacted.ok) {
      session.counts.rejected++;
      return redacted;
    }
    const urlLength = this.quota.checkUrl(redacted.value.url);
    if (!urlLength.ok) return urlLength;
    const eventCount = this.quota.checkEventCount(session.events.length);
    if (!eventCount.ok) return eventCount;
    session.events.push({ ...event, url: redacted.value.url });
    session.counts.events = session.events.length;
    session.counts.redactedParams += redacted.value.redactedKeys.length;
    return { ok: true, value: undefined };
  }

  /** HAR 1.2 落盘：确定性排序 + 原子写（tmp→fsync→rename）；配额超限 → complete:false（仍落盘、诚实标记） */
  async flush(session: HarSession, outDir: string): Promise<OperationResult<HarFlushResult>> {
    if (session.events.length === 0) return { ok: false, error: configError('HAR_CAPTURE_EMPTY', 'har.capture.empty') };
    const entries = [...session.events].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).map(event => ({
      startedDateTime: event.startedAt,
      time: event.durationMs,
      request: { method: event.method, url: event.url, httpVersion: 'HTTP/1.1', headers: [], queryString: [], cookies: [] },
      response: { status: event.status, statusText: '', httpVersion: 'HTTP/1.1', headers: [], cookies: [], redirectURL: '', content: { size: event.size ?? 0, mimeType: event.mimeType ?? 'application/octet-stream' } },
      cache: {},
      timings: { send: 0, wait: event.durationMs, receive: 0 },
    }));
    // 配额裁决：文件字节 + 目录（owned 文件数/总字节）——超限仍落盘但 complete:false（诚实：不伪装完整采集）
    let complete = true;
    let reason: string | undefined;
    const fileCheck = this.quota.checkFileBytes(Buffer.byteLength(JSON.stringify(entries)));
    if (!fileCheck.ok) { complete = false; reason = fileCheck.error.code; }
    if (complete) {
      try {
        const owned = readdirSync(outDir).filter(name => OWNED_HAR_FILE.test(name));
        const totalBytes = owned.reduce((sum, name) => sum + statSync(join(outDir, name)).size, 0);
        const dirCheck = this.quota.checkDirectory(owned.length, totalBytes);
        if (!dirCheck.ok) { complete = false; reason = dirCheck.error.code; }
      } catch { /* 目录不存在 → 新目录，目录配额自然通过 */ }
    }
    const har = {
      log: {
        version: '1.2',
        creator: { name: 'wxnodus-har-capture', version: '1.1.0' },
        entries,
        // 诚实元数据：完整性/计数/策略摘要（审计可比对策略漂移与配额裁决）
        _wxnodus: { complete, ...(reason ? { reason } : {}), counts: session.counts, policyDigest: this.quota.digest },
      },
    };
    const body = `${JSON.stringify(har, null, 2)}\n`;
    const sha256 = createHash('sha256').update(body).digest('hex');
    try {
      mkdirSync(dirname(`${outDir}/x`), { recursive: true });
      // SESSION_ID 放行冒号后（旧子会话 :sub 兼容）文件名侧必须消毒——Windows 冒号非法
      const path = join(outDir, `session-${String(session.sessionId).replace(/[^\w.-]/g, '_')}.har`);
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, body, 'utf8');
      try {
        const fd = openSync(tmp, 'r+');
        try { fsyncSync(fd); } finally { closeSync(fd); }
      } catch { /* Windows 只读句柄 fsync EPERM——继续 rename（数据已完整写盘） */ }
      renameSync(tmp, path);
      rmSync(tmp, { force: true });
      return { ok: true, value: { path, sha256, complete, counts: session.counts, policyDigest: this.quota.digest, ...(reason ? { reason } : {}) } };
    } catch (cause) {
      return { ok: false, error: configError('HAR_CAPTURE_WRITE_FAILED', 'har.capture.write.failed', { cause: String(cause) }) };
    }
  }

  /** 桥接：HAR 会话 → VisionCapture RecordedStep.network（操作→端点对照的流量通道输入；URL 已脱敏） */
  toNetworkEvents(session: HarSession): RecordedNetworkEvent[] {
    return session.events.map(event => ({ method: event.method, url: event.url, status: event.status }));
  }
}

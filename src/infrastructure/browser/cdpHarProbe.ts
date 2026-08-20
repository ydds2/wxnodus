// src/infrastructure/browser/cdpHarProbe.ts — 真实 CDP Network 域接入（§10-1 完整集成）：
// 无头 Chromium CDP 事件 → HarCaptureAdapter 会话（document/xhr/fetch 全通道），导航失败/零事件显式失败
// 端口化设计：探针不依赖 playwright 类型，真实实现见 playwrightCdpPorts.ts（可无浏览器单元测试）
import type { OperationResult } from '../../protocol/results.js';
import { HarCaptureAdapter, type HarSession } from './harCaptureAdapter.js';
import { redactHarUrl } from './redactionPolicy.js';
import type { SegmentableEvent } from '../../domain/computer/segmentReplay.js';

export interface CdpNetworkRequestEvent {
  requestId: string;
  method: string;
  url: string;
  /** CDP wallTime（epoch 秒，浮点）→ 落盘 startedAt 的 ISO 时间 */
  wallTimeSeconds: number;
  /** CDP 单调时间戳（秒）→ durationMs 计算 */
  monotonicSeconds: number;
}

export interface CdpNetworkResponseEvent {
  requestId: string;
  status: number;
  mimeType?: string;
  monotonicSeconds: number;
}

export interface CdpClientPort {
  enableNetwork(): Promise<void>;
  onRequest(handler: (event: CdpNetworkRequestEvent) => void): void;
  onResponse(handler: (event: CdpNetworkResponseEvent) => void): void;
  goto(url: string): Promise<void>;
  close(): Promise<void>;
}

export interface CdpHarProbePorts {
  launch(): Promise<CdpClientPort>;
}

const fail = (code: string, details?: Record<string, unknown>): OperationResult<never> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false, details },
});

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

export class CdpHarProbe {
  constructor(private readonly ports: CdpHarProbePorts, private readonly adapter: HarCaptureAdapter) {}

  /** 启动无头浏览器 → 采集一次页面加载的完整网络轨迹；settleMs 等待尾部异步请求落盘 */
  async capture(sessionId: string, url: string, options?: { settleMs?: number; signal?: AbortSignal }): Promise<OperationResult<HarSession>> {
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return fail('CDP_PROBE_INVALID_URL', { url });
    }
    const opened = this.adapter.openSession(sessionId);
    if (!opened.ok) return opened;
    let client: CdpClientPort;
    try { client = await this.ports.launch(); } catch { return fail('CDP_PROBE_LAUNCH_FAILED'); }
    const pending = new Map<string, { method: string; url: string; wallTimeSeconds: number; monotonicSeconds: number }>();
    try {
      await client.enableNetwork();
      client.onRequest(event => {
        // W5-02：secret 不得进入内存——CDP 事件边界即脱敏（pending 只存脱敏 URL）；不可 parse 丢弃
        const redacted = redactHarUrl(event.url);
        if (!redacted.ok) return;
        pending.set(event.requestId, {
          method: event.method,
          url: redacted.value.url,
          wallTimeSeconds: event.wallTimeSeconds,
          monotonicSeconds: event.monotonicSeconds,
        });
      });
      client.onResponse(event => {
        const request = pending.get(event.requestId);
        if (!request) return;
        const durationMs = Math.max(0, Math.round((event.monotonicSeconds - request.monotonicSeconds) * 1000));
        const recorded = this.adapter.recordEvent(opened.value, {
          method: request.method,
          url: request.url,
          status: event.status,
          startedAt: new Date(request.wallTimeSeconds * 1000).toISOString(),
          durationMs,
          mimeType: event.mimeType,
        });
        void recorded; // 非法事件（非 http(s)）静默丢弃，不中断采集
      });
      try {
        await client.goto(url);
      } catch {
        return fail('CDP_PROBE_NAVIGATION_FAILED', { url });
      }
      const settleMs = options?.settleMs ?? 500;
      await sleep(settleMs);
      if (options?.signal?.aborted) return fail('CDP_PROBE_ABORTED');
    } finally {
      pending.clear(); // W5-02：complete/fail/abort 一律清空 pending（不残留未配对请求）
      await client.close();
    }
    if (opened.value.events.length === 0) return fail('CDP_PROBE_NO_EVENTS', { url });
    return opened;
  }

  /** 会话 → 分段器输入（document 响应开启新段） */
  toSegmentable(session: HarSession): SegmentableEvent[] {
    return session.events.map(event => ({
      method: event.method,
      url: event.url,
      status: event.status,
      startedAt: event.startedAt,
      isDocument: event.mimeType?.startsWith('text/html') === true,
    }));
  }
}

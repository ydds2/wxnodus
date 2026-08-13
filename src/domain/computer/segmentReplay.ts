// src/domain/computer/segmentReplay.ts — 轨迹归纳分段 + 回放校验（蓝图 M1 归纳管线，纯确定性）：
// 平铺网络事件 → 按文档边界/时间间隙切段（segment）→ 段签名（METHOD url 序列）→ 回放与基线逐段比对
// 校验失败输出首个不匹配段的 diff（绝不静默通过——held-out 变体必须被识别）
import type { OperationResult } from '../../protocol/results.js';

export interface SegmentableEvent {
  method: string;
  url: string;
  status: number;
  startedAt: string;
  /** text/html 等文档响应开启新段（探针侧标注；缺省时仅按时间间隙切段） */
  isDocument?: boolean;
}

export interface HarSegment {
  segmentId: string;
  events: Array<{ method: string; url: string; status: number }>;
}

const GAP_MS_DEFAULT = 5000;

export function segmentHarEvents(events: SegmentableEvent[], options?: { gapMs?: number }): HarSegment[] {
  const gapMs = options?.gapMs ?? GAP_MS_DEFAULT;
  const sorted = [...events].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const segments: HarSegment[] = [];
  let current: HarSegment | null = null;
  let previousAt: number | null = null;
  let index = 0;
  for (const event of sorted) {
    const at = Date.parse(event.startedAt);
    const boundary =
      event.isDocument === true ||
      previousAt === null ||
      (Number.isFinite(at) && at - previousAt > gapMs);
    if (boundary || !current) {
      index += 1;
      current = { segmentId: `seg-${String(index).padStart(2, '0')}`, events: [] };
      segments.push(current);
    }
    current.events.push({ method: event.method, url: event.url, status: event.status });
    if (Number.isFinite(at)) previousAt = at;
  }
  return segments;
}

export interface ReplayComparison {
  matchedSegments: number;
  canonicalSegments: number;
  replaySegments: number;
  mismatches: Array<{
    index: number;
    kind: 'missing-segment' | 'extra-segment' | 'signature-diff';
    detail: string;
  }>;
}

const signature = (segment: HarSegment) => segment.events.map(event => `${event.method} ${event.url}`);

/** 回放校验：回放段序列必须与基线段序列逐段一致（顺序、数量、签名全比对） */
export function validateReplay(canonical: HarSegment[], replay: HarSegment[]): OperationResult<ReplayComparison> {
  const mismatches: ReplayComparison['mismatches'] = [];
  const common = Math.min(canonical.length, replay.length);
  for (let index = 0; index < common; index += 1) {
    const left = signature(canonical[index]);
    const right = signature(replay[index]);
    if (left.length !== right.length || left.some((entry, i) => entry !== right[i])) {
      const firstDiff = left.findIndex((entry, i) => entry !== right[i]);
      mismatches.push({
        index,
        kind: 'signature-diff',
        detail: `segment ${index} first diff at event ${firstDiff}: canonical="${left[firstDiff] ?? '<missing>'}" replay="${right[firstDiff] ?? '<missing>'}"`,
      });
    }
  }
  for (let index = common; index < canonical.length; index += 1) {
    mismatches.push({ index, kind: 'missing-segment', detail: `canonical segment ${index} not present in replay` });
  }
  for (let index = common; index < replay.length; index += 1) {
    mismatches.push({ index, kind: 'extra-segment', detail: `replay segment ${index} not present in canonical` });
  }
  const comparison: ReplayComparison = {
    matchedSegments: common - mismatches.filter(mismatch => mismatch.index < common).length,
    canonicalSegments: canonical.length,
    replaySegments: replay.length,
    mismatches,
  };
  if (mismatches.length > 0) {
    return {
      ok: false,
      error: {
        code: 'REPLAY_SEGMENT_MISMATCH',
        message: 'Replay segments diverge from the canonical trace',
        messageKey: 'REPLAY_SEGMENT_MISMATCH',
        retryable: false,
        details: { mismatches: mismatches.slice(0, 8) },
      },
    };
  }
  return { ok: true, value: comparison };
}

// src/domain/pty/pty.ts — PTY 端口契约（计划原文）
import type { OperationResult } from '../../protocol/results.js';
export interface PtyOpenRequest {
  executable: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  timeoutMs: number;
}
export interface PtyExit { exitCode: number | null; signal: number | null; reason: 'exit' | 'timeout' | 'abort' }
export interface PtySessionPort {
  readonly processId: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(handler: (data: string) => void): () => void;
  wait(): Promise<PtyExit>;
  close(): Promise<OperationResult<void>>;
}
export interface PtyPort { open(request: PtyOpenRequest, signal: AbortSignal): Promise<OperationResult<PtySessionPort>> }

// src/application/voice/voiceSessionService.ts — 语音会话服务：状态机强制 + 可取消转写（进程树确认）+ 转写产物落盘（opaque ref 唯一出口）
// W3 Voice 第 2 步：状态变更全部走 transitionVoice（非法跳变 fail-closed VOICE_ILLEGAL_TRANSITION）；
// 转写产物经 transcriptStore 落盘，服务只返回 opaque TranscriptRef（明文永不从服务层流出）。
import { randomUUID } from 'node:crypto';
import type { OperationResult } from '../../protocol/results.js';
import type { AudioRef, TranscriptRef } from '../../domain/voice/voiceSession.js';
import { transcriptRefFor } from '../../domain/voice/voiceSession.js';
import { transitionVoice, type VoiceSessionSnapshot } from '../../domain/voice/voiceState.js';

interface ProcessResult { processId: number; exitCode: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean }
interface SupervisorPort {
  spawn(executable: string, args: string[], options: { timeoutMs: number }, signal: AbortSignal): Promise<ProcessResult>;
  terminateTree(processId: number, deadlineMs: number): Promise<OperationResult<void>>;
}
interface TempPort { remove(path: string): Promise<OperationResult<void>> }
interface TranscriptStorePort {
  save(audioId: string, text: string): Promise<OperationResult<void>>;
  load(ref: TranscriptRef): Promise<OperationResult<string>>;
}

const error = (code: string, details?: Record<string, unknown>): OperationResult<never> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false, details },
});

export interface VoiceSessionDeps {
  supervisor: SupervisorPort;
  temp: TempPort;
  transcriptStore: TranscriptStorePort;
  sttReady(): boolean;
}

export class VoiceSessionService {
  private current: VoiceSessionSnapshot = {
    id: randomUUID(), state: 'idle', mode: 'push-to-talk', selectedDeviceId: null,
  };

  constructor(private readonly deps: VoiceSessionDeps) {}
  snapshot(): VoiceSessionSnapshot { return structuredClone(this.current); }

  /** 状态迁移走状态机；非法跳变 fail-closed（绝不静默吞掉） */
  private move(next: VoiceSessionSnapshot['state']): OperationResult<VoiceSessionSnapshot> {
    try {
      this.current = transitionVoice(this.current, next);
      return { ok: true, value: this.snapshot() };
    } catch {
      return error('VOICE_ILLEGAL_TRANSITION', { from: this.current.state, to: next });
    }
  }

  async start(mode: VoiceSessionSnapshot['mode'], _signal: AbortSignal): Promise<OperationResult<VoiceSessionSnapshot>> {
    if (!this.deps.sttReady()) return error('VOICE_STT_UNAVAILABLE');
    this.current = { ...this.current, mode };
    return this.move('listening');
  }

  /** 检测到语音（listening → speech_detected）——转写的前置合法状态 */
  speechDetected(): OperationResult<VoiceSessionSnapshot> {
    return this.move('speech_detected');
  }

  async transcribe(audio: AudioRef, signal: AbortSignal): Promise<OperationResult<{ transcriptRef: TranscriptRef }>> {
    // 状态机前置：转写只允许从 speech_detected 进入（idle 直跳是非法跳变——契约锁定）
    if (this.current.state !== 'speech_detected') {
      return error('VOICE_ILLEGAL_TRANSITION', { from: this.current.state, to: 'transcribing' });
    }
    const moved = this.move('transcribing');
    if (!moved.ok) return moved;
    let spawned = false;
    // 状态机合法出口：成功 thinking→idle；abort cancelling→idle；失败/超时 error→idle
    let exit: VoiceSessionSnapshot['state'] = 'error';
    try {
      const result = await this.deps.supervisor.spawn('whisper-cli', ['-f', audio.path], { timeoutMs: 120_000 }, signal);
      spawned = true;
      if (result.aborted || signal.aborted) {
        const stopped = await this.deps.supervisor.terminateTree(result.processId, 5_000);
        if (!stopped.ok) return error('VOICE_PROCESS_TREE_STILL_RUNNING', { processId: result.processId });
        exit = 'cancelling';
        return error('VOICE_WORKER_ABORTED');
      }
      if (result.timedOut) return error('VOICE_WORKER_TIMEOUT', { processId: result.processId });
      if (result.exitCode !== 0) return error('VOICE_WORKER_CRASHED', { processId: result.processId, exitCode: result.exitCode });
      // 转写产物落盘（opaque ref 是唯一出口——明文从不随返回值流出）
      const text = String(result.stdout ?? '').trim();
      const saved = await this.deps.transcriptStore.save(audio.id, text);
      if (!saved.ok) return saved;
      exit = 'thinking';
      return { ok: true, value: { transcriptRef: transcriptRefFor(audio.id) } };
    } catch {
      return error('VOICE_WORKER_SPAWN_FAILED', spawned ? undefined : { audioId: audio.id });
    } finally {
      if (audio.retention === 'ephemeral') await this.deps.temp.remove(audio.path);
      await this.move(exit);
      await this.move('idle');
    }
  }

  /** 经 opaque ref 读取转写产物（读回也走 ref，不暴露明文路径） */
  async readTranscript(ref: TranscriptRef): Promise<OperationResult<string>> {
    return this.deps.transcriptStore.load(ref);
  }
}

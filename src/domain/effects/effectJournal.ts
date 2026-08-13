// src/domain/effects/effectJournal.ts — 副作用日志端口：追加式哈希链（完整性可校验）
import type { OperationResult } from '../../protocol/results.js';

export interface JournalEntry {
  sequence: number;
  effectId: string;
  state: string;
  payloadJson: string;
  prevHash: string;
  entryHash: string;
  createdAt: string;
}

export interface EffectJournal {
  append(entry: Omit<JournalEntry, 'sequence' | 'entryHash'>): OperationResult<JournalEntry>;
  verify(): OperationResult<void>;
}

// src/release/windowsAcceptanceContract.d.mts — 类型声明（实现见 windowsAcceptanceContract.mjs）
export interface WindowsRunnerSnapshot {
  selfHosted: boolean;
  labels: string[];
  interactive: boolean;
  unlocked: boolean;
  inputDesktop: string;
  sessionId: number;
  os: { family: 'win10' | 'win11'; version: string };
  node: { version: string; arch: 'x64' };
  candidateCommit: string;
  artifact: { id: string; sha256: string };
  environment: { snapshotId: string; sha256: string };
  capability: { snapshotId: string; sha256: string };
  microphones: Array<{ id: string; active: boolean; physical: boolean }>;
  sapiVoices: string[];
  sapiPlaybackPassed: boolean;
  fixtures: { lockSha256: string; sourceHashesValid: boolean; artifactHashesValid: boolean };
  monitors: Array<{ id: string; x: number; y: number; width: number; height: number; scale: number; physical: boolean }>;
}
export type WindowsRunnerDecision =
  | { status: 'passed' }
  | { status: 'blocked'; code: 'WINDOWS_PHYSICAL_PRECONDITION_BLOCKED'; missing: string[] };
export type WindowsReceiptKey = 'windows-11-24h2-production-real' | 'windows-10-22h2-legacy-compatibility';
export interface WindowsAcceptanceReceipt {
  receiptId: string;
  receiptKey: WindowsReceiptKey;
  runId: string;
  candidateCommit: string;
  artifact: { id: string; sha256: string };
  environment: { snapshotId: string; sha256: string };
  capability: { snapshotId: string; sha256: string };
  runner: WindowsRunnerSnapshot;
  fixtures: { lockSha256: string; sourceHashesValid: boolean; artifactHashesValid: boolean };
  scenarios: Array<{ id: string; status: 'passed' | 'failed' | 'blocked'; attachmentIds: string[] }>;
  closure: { status: 'closed' };
  manifestSha256: string;
}
export type GateEAggregateDecision =
  | { status: 'passed'; receiptIds: string[] }
  | { status: 'blocked'; code: string; missing?: string[] };

export declare function evaluateWindowsRunner(snapshot: WindowsRunnerSnapshot): WindowsRunnerDecision;
export declare function aggregateGateEReceipts(receipts: readonly WindowsAcceptanceReceipt[]): GateEAggregateDecision;

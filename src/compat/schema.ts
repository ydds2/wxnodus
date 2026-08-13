// src/compat/schema.ts — V3 兼容清单 schema（Wave 0 冻结面）
export type CompatibilityDisposition = 'preserve' | 'deprecate' | 'intentional_break';

export type CompatibilityReasonCode =
  | 'false_success'
  | 'fail_open_security'
  | 'permission_bypass'
  | 'memory_scope_leak'
  | 'unknown_flag_ignored'
  | 'unsafe_http_default'
  | 'weak_evidence_fingerprint'
  | 'cancel_without_effect_stop';

export interface CompatibilityEntry {
  id: string;
  kind: 'cli' | 'slash' | 'config' | 'schema' | 'gateway' | 'wire' | 'extension';
  name: string;
  descriptor: Record<string, unknown>;
  disposition: CompatibilityDisposition;
  replacement?: string;
  reasonCode?: CompatibilityReasonCode;
}

export interface CompatibilityManifest {
  schemaVersion: 1;
  generatedFromCommit: string;
  entries: CompatibilityEntry[];
  checksum: string;
}

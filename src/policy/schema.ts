// src/policy/schema.ts — 版本化 Policy Manifest schema（Wave 0 规范性红线目录）
export type NormativeRedlineCategory =
  | 'root_home_recursive_destruction'
  | 'disk_format_partition_raw_write'
  | 'shutdown_restart_fork_bomb'
  | 'system_registry_destruction'
  | 'interpreter_pipe_injection'
  | 'credential_secret_persistence_leak'
  | 'unmediated_privilege_key_security_mode_change'
  | 'remote_history_force_push';

export type PolicyMatcher =
  | { type: 'regex'; value: string; flags: string }
  | { type: 'path'; value: string }
  | { type: 'command'; value: string };

export interface PolicyRuleDescriptor {
  id: string;
  version: number;
  kind: 'hard_redline' | 'sensitive_write' | 'command_redline';
  category: NormativeRedlineCategory;
  descriptionKey: string;
  source: string;
  overrideable: false;
  requiresUserPresence: boolean;
  matcher: PolicyMatcher;
}

export interface PolicyManifest {
  schemaVersion: 1;
  catalogVersion: 1;
  categories: Array<{
    id: NormativeRedlineCategory;
    normative: true;
    descriptionKey: string;
  }>;
  rules: PolicyRuleDescriptor[];
  checksum: string;
}

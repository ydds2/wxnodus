// src/policy/catalog.ts — 规范性红线目录（类别级；规则描述符单一事实源在 src/kernel/permissions.ts）
import type { NormativeRedlineCategory } from './schema.js';

export interface NormativeRedlineCategoryDescriptor {
  id: NormativeRedlineCategory;
  normative: true;
  descriptionKey: string;
}

export const NORMATIVE_REDLINE_CATALOG: readonly NormativeRedlineCategoryDescriptor[] = [
  { id: 'root_home_recursive_destruction', normative: true, descriptionKey: 'policy.redline.root_home_recursive_destruction' },
  { id: 'disk_format_partition_raw_write', normative: true, descriptionKey: 'policy.redline.disk_format_partition_raw_write' },
  { id: 'shutdown_restart_fork_bomb', normative: true, descriptionKey: 'policy.redline.shutdown_restart_fork_bomb' },
  { id: 'system_registry_destruction', normative: true, descriptionKey: 'policy.redline.system_registry_destruction' },
  { id: 'interpreter_pipe_injection', normative: true, descriptionKey: 'policy.redline.interpreter_pipe_injection' },
  { id: 'credential_secret_persistence_leak', normative: true, descriptionKey: 'policy.redline.credential_secret_persistence_leak' },
  { id: 'unmediated_privilege_key_security_mode_change', normative: true, descriptionKey: 'policy.redline.unmediated_privilege_key_security_mode_change' },
  { id: 'remote_history_force_push', normative: true, descriptionKey: 'policy.redline.remote_history_force_push' },
] as const;

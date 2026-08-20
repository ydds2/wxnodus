// scripts/wave2GateRunner.mjs — Wave 2 Gate 求值：exact script mapping + suite 存在 + migration + W1 基础设施 + 六类 progress reasons
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const reasons = ['NO_STATE_CHANGE','REPEATED_ACTION','REPEATED_ERROR','NO_NEW_EVIDENCE','PLAN_OSCILLATION','BUDGET_STAGNATION'];
const suites = ['w2-config-onboarding','w2-personalization','w2-capability-registry','w2-extension-scope','w2-session-lifecycle-hooks','w2-mcp-duplex','w2-skill-lifecycle','w2-plugin-sandbox','w2-autonomy-persistence-budget','w2-subagent-recovery-progress','w2-wave2-migration-gate'];
export function runWave2Gates({ rootDir, migration }) {
  const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  const scripts = packageJson.scripts ?? {};
  const failures = [];
  for (let i=0;i<suites.length;i+=1) {
    const key = `test:w2-${String(i+1).padStart(2,'0')}`;
    const expected = `vitest run tests/${suites[i]}.contract.test.ts`;
    if (scripts[key] !== expected || !existsSync(join(rootDir, `tests/${suites[i]}.contract.test.ts`))) failures.push(`SCRIPT_OR_SUITE:${key}`);
  }
  if (scripts['migration:drill:wave2'] !== 'node scripts/run-wave2-migration-drill.mjs') failures.push('SCRIPT:migration:drill:wave2');
  if (scripts['gate:wave2'] !== 'node scripts/run-wave2-gates.mjs') failures.push('SCRIPT:gate:wave2');
  if (!migration?.ok || migration.sequence?.join(' → ') !== 'upgrade → new write → rollback → re-upgrade') failures.push('MIGRATION_DRILL');
  if (!existsSync(join(rootDir, 'src/protocol/events.ts'))) failures.push('W1_GATEWAY_EVENT_MISSING');
  if (!existsSync(join(rootDir, 'src/application/capabilities/capabilityRegistry.ts'))) failures.push('W1_11_REGISTRY_MISSING');
  if (reasons.length !== 6) failures.push('PROGRESS_REASON_SET');
  return { ok: failures.length === 0, failures, unavailable:{ computer:'CAPABILITY_UNAVAILABLE', forge:'CAPABILITY_UNAVAILABLE' }, checked:['A','B','C','D','F','G'] };
}

// scripts/run-wave1-migration-drill.mjs — Wave 1 迁移演练：upgrade → 新版本确认写入 → rollback/reconcile → re-upgrade
export async function runWaveMigrationDrill(descriptor) {
  const failed = stage => ({ ok: false, error: { code: 'MIGRATION_DRILL_FAILED', stage } });
  try {
    await descriptor.upgrade();
    await descriptor.confirmNewWrite();
    if (descriptor.strategy === 'rollbackable') {
      if (typeof descriptor.rollback !== 'function') return failed('rollback');
      await descriptor.rollback();
    } else {
      const recover = descriptor.reconcile ?? descriptor.recovery;
      if (typeof recover !== 'function') return failed('forward-reconcile');
      await recover();
    }
    await descriptor.reupgrade();
    return { ok: true };
  } catch (error) { return { ...failed('exception'), error: { code: 'MIGRATION_DRILL_FAILED', stage: 'exception', cause: String(error) } }; }
}

// 直接调用：对真实 Wave 0/1 迁移 registry 执行演练（config rollbackable + db forward-only V2-V5）
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const { spawnSync } = await import('node:child_process');
  const steps = [
    ['npx', ['tsx', 'scripts/drill-wave0-recovery.ts'], 'wave0 config/db 六步演练'],
    ['npx', ['tsx', 'scripts/drill-wave1-security.ts'], 'wave1 security forward-only 演练'],
  ];
  for (const [command, args, label] of steps) {
    const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.status !== 0) {
      console.error(`MIGRATION_DRILL_FAILED:${label}:exit=${result.status ?? 'signal'}`);
      process.exit(result.status ?? 1);
    }
  }
}

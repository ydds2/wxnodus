// scripts/run-completion-gate.mjs — Gate G-W3：只消费 integrity-verified 且 closureStatus 'closed' 的 evidence
// 用法：npm.cmd run gate:completion -- --run <uuid>
// 退出码：0 succeeded / 1 failed / 2 blocked / 3 incomplete / 4 inconclusive / 130 cancelled
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const args = process.argv.slice(2);
const runFlag = args.indexOf('--run');
const runId = runFlag >= 0 ? args[runFlag + 1] : undefined;

const decide = (status, reasons = []) => ({ status, reasons });

if (!runId) {
  process.stderr.write('usage: run-completion-gate.mjs --run <uuid>\n');
  process.exitCode = 3; // incomplete
} else {
  const runDir = resolve('artifacts/release-evidence', runId);
  const manifestPath = join(runDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    process.stdout.write(`${JSON.stringify(decide('incomplete', ['COMPLETION_EVIDENCE_MISSING']))}\n`);
    process.exitCode = 3;
  } else {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/.test(manifest.rootDigest)) {
        process.stdout.write(`${JSON.stringify(decide('blocked', ['COMPLETION_EVIDENCE_NOT_CLOSED']))}\n`);
        process.exitCode = 2;
      } else {
        // 重读实际字节（绝不信任落盘 hash）
        const entries = [];
        for (const entry of manifest.entries) {
          const bytes = readFileSync(resolve(runDir, entry.path));
          entries.push({ ...entry, measured: sha256(bytes), measuredBytes: bytes.byteLength });
        }
        const tampered = entries.some(entry => entry.measured !== entry.sha256 || entry.measuredBytes !== entry.bytes);
        const listed = new Set(manifest.entries.map(entry => entry.path));
        const stray = ['records', 'attachments']
          .filter(directory => existsSync(join(runDir, directory)))
          .flatMap(directory => readdirSync(join(runDir, directory)))
          .some(name => !listed.has(name));
        if (tampered || stray) {
          process.stdout.write(`${JSON.stringify(decide('blocked', ['EVIDENCE_INTEGRITY_FAILED']))}\n`);
          process.exitCode = 2;
        } else {
          const records = entries.filter(entry => entry.path.startsWith('records/'))
            .map(entry => JSON.parse(readFileSync(resolve(runDir, entry.path), 'utf8')));
          const unclosed = records.some(record => record.closure?.status !== 'closed');
          if (unclosed) {
            process.stdout.write(`${JSON.stringify(decide('blocked', ['COMPLETION_EVIDENCE_NOT_CLOSED']))}\n`);
            process.exitCode = 2;
          } else {
            const criteria = records.flatMap(record => record.criteria ?? []);
            const required = criteria.filter(criterion => criterion.required);
            const failed = required.filter(criterion => criterion.status === 'failed');
            if (failed.length > 0) {
              process.stdout.write(`${JSON.stringify(decide('failed', failed.map(criterion => criterion.id)))}\n`);
              process.exitCode = 1;
            } else if (required.length === 0) {
              process.stdout.write(`${JSON.stringify(decide('incomplete', ['COMPLETION_REQUIRED_CRITERION_MISSING']))}\n`);
              process.exitCode = 3;
            } else {
              process.stdout.write(`${JSON.stringify(decide('succeeded', []))}\n`);
              process.exitCode = 0;
            }
          }
        }
      }
    } catch (error) {
      process.stdout.write(`${JSON.stringify(decide('blocked', ['EVIDENCE_INTEGRITY_FAILED']))}\n`);
      process.exitCode = 2;
    }
  }
}

// scripts/generate-v3-compatibility.ts — 生成/校验 docs/superpowers/manifests/v3-compatibility.json
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildV3CompatibilityManifest, verifyCompatibilityChecksum } from '../src/compat/generateV3.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = resolve(root, 'docs/superpowers/manifests/v3-compatibility.json');
const check = process.argv.includes('--check');

const commit = (() => {
  try {
    return execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
})();

const manifest = buildV3CompatibilityManifest({ generatedFromCommit: commit });

if (check) {
  let stored: unknown;
  try {
    stored = JSON.parse(readFileSync(outPath, 'utf8'));
  } catch (e) {
    console.error(`COMPAT_MANIFEST_MISSING:${outPath}: ${String(e)}`);
    process.exit(1);
  }
  const ok = verifyCompatibilityChecksum(stored as ReturnType<typeof buildV3CompatibilityManifest>);
  if (!ok.ok) {
    console.error(`COMPAT_CHECKSUM_MISMATCH:${outPath}`);
    process.exit(1);
  }
  const storedEntries = (stored as { entries: Array<{ id: string }> }).entries.map(e => e.id);
  const builtEntries = manifest.entries.map(e => e.id);
  if (JSON.stringify(storedEntries) !== JSON.stringify(builtEntries)) {
    console.error(`COMPAT_SURFACE_DRIFT:${outPath}`);
    process.exit(1);
  }
  console.log(`COMPAT_OK:${outPath}`);
  process.exit(0);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`WROTE:${outPath}`);

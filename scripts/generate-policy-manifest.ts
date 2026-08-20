// scripts/generate-policy-manifest.ts — 生成/校验 docs/superpowers/manifests/v3-policy.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPolicyManifest, verifyPolicyManifestBytes } from '../src/policy/snapshot.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = resolve(root, 'docs/superpowers/manifests/v3-policy.json');
const check = process.argv.includes('--check');

if (check) {
  let bytes: Buffer;
  try {
    bytes = readFileSync(outPath);
  } catch (e) {
    console.error(`POLICY_MANIFEST_MISSING:${outPath}: ${String(e)}`);
    process.exit(1);
  }
  const result = verifyPolicyManifestBytes(bytes);
  if (!result.ok) {
    console.error(`${result.code}:${outPath}`);
    process.exit(1);
  }
  const rebuilt = buildPolicyManifest();
  if (JSON.stringify(rebuilt.rules) !== JSON.stringify(result.manifest.rules)) {
    console.error(`POLICY_SURFACE_DRIFT:${outPath}`);
    process.exit(1);
  }
  console.log(`POLICY_OK:${outPath}`);
  process.exit(0);
}

const manifest = buildPolicyManifest();
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`WROTE:${outPath}`);

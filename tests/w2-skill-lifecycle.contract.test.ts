import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSkillDocument,
  resolveSkillEntrypoints,
  serializeSkillDocument,
  SkillManifestError,
} from '../src/infrastructure/skills/skillManifest.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wxn-skill-security-'));
  roots.push(root);
  return root;
}

const DOCUMENT = `---
schemaVersion: 1
name: audit-helper
version: 1.2.3
description: Verify an artifact without claiming completion
dependencies:
  - builtin:workspace.read
capabilities:
  - workspace.read
entrypoints:
  - prompts/review.md
source: project
artifactHash: ${'a'.repeat(64)}
trustLevel: reviewed
extensions:
  ui:
    category: quality
  aliases:
    - audit
    - review
---
# Audit helper
Use evidence, not self-report.
`;

describe('Skill manifest security contract', () => {
  it('round-trips YAML arrays and maps without flattening them', () => {
    const parsed = parseSkillDocument(DOCUMENT, 'fixture:skill');
    expect(parsed.manifest.dependencies).toEqual(['builtin:workspace.read']);
    expect(parsed.manifest.capabilities).toEqual(['workspace.read']);
    expect(parsed.manifest.entrypoints).toEqual(['prompts/review.md']);
    expect(parsed.manifest.extensions).toEqual({
      ui: { category: 'quality' },
      aliases: ['audit', 'review'],
    });

    const roundTrip = parseSkillDocument(
      serializeSkillDocument(parsed),
      'fixture:round-trip',
    );
    expect(roundTrip).toEqual(parsed);
  });

  it.each([
    '../outside.md',
    'nested/../../outside.md',
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
    '\\\\server\\share\\skill.md',
  ])('rejects traversal, drive and UNC entrypoint %s', entrypoint => {
    const root = makeRoot();
    const manifest = parseSkillDocument(
      DOCUMENT.replace('prompts/review.md', entrypoint),
      'fixture:path-escape',
    ).manifest;

    expect(() => resolveSkillEntrypoints(root, manifest)).toThrowError(
      expect.objectContaining<Partial<SkillManifestError>>({ code: 'SKILL_PATH_ESCAPE' }),
    );
  });

  it('rejects a symlink or Windows junction whose realpath escapes the Skill root', () => {
    const root = makeRoot();
    const outside = makeRoot();
    mkdirSync(join(root, 'prompts'), { recursive: true });
    writeFileSync(join(outside, 'review.md'), '# escaped', 'utf8');
    symlinkSync(
      outside,
      join(root, 'prompts', 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const manifest = parseSkillDocument(
      DOCUMENT.replace('prompts/review.md', 'prompts/escape/review.md'),
      'fixture:link-escape',
    ).manifest;

    expect(() => resolveSkillEntrypoints(root, manifest)).toThrowError(
      expect.objectContaining<Partial<SkillManifestError>>({ code: 'SKILL_PATH_ESCAPE' }),
    );
  });

  it('uses stable schema and missing-entrypoint codes', () => {
    expect(() => parseSkillDocument(DOCUMENT.replace('schemaVersion: 1', 'schemaVersion: 2'), 'fixture:v2'))
      .toThrowError(expect.objectContaining<Partial<SkillManifestError>>({ code: 'SKILL_MANIFEST_INVALID' }));

    const root = makeRoot();
    const manifest = parseSkillDocument(DOCUMENT, 'fixture:missing').manifest;
    expect(() => resolveSkillEntrypoints(root, manifest)).toThrowError(
      expect.objectContaining<Partial<SkillManifestError>>({ code: 'SKILL_ENTRYPOINT_MISSING' }),
    );
  });
});

// src/infrastructure/skills/skillManifest.ts — Skill manifest 解析/序列化/路径安全（词法 + realpath 双边界）
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { assertSafeExtensionName } from '../../domain/safeNames.js';

export type SkillManifestErrorCode =
  | 'SKILL_MANIFEST_INVALID'
  | 'SKILL_NAME_INVALID'
  | 'SKILL_PATH_ESCAPE'
  | 'SKILL_ENTRYPOINT_MISSING';

export class SkillManifestError extends Error {
  constructor(
    readonly code: SkillManifestErrorCode,
    readonly source: string,
    message: string,
    cause?: unknown,
  ) {
    super(`${code}:${source}:${message}`, { cause });
    this.name = 'SkillManifestError';
  }
}

export interface SkillManifest {
  schemaVersion: 1;
  name: string;
  version: string;
  description: string;
  dependencies: string[];
  capabilities: string[];
  entrypoints: string[];
  source: string;
  artifactHash: string;
  trustLevel: 'untrusted' | 'reviewed' | 'trusted';
  extensions: Record<string, unknown>;
}

export interface ParsedSkillDocument {
  manifest: SkillManifest;
  body: string;
}

function stringArray(value: unknown, key: string, source: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new SkillManifestError('SKILL_MANIFEST_INVALID', source, `${key} must be string[]`);
  }
  return [...value];
}

function record(value: unknown, key: string, source: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new SkillManifestError('SKILL_MANIFEST_INVALID', source, `${key} must be a map`);
  }
  return structuredClone(value as Record<string, unknown>);
}

export function parseSkillDocument(text: string, source: string): ParsedSkillDocument {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new SkillManifestError('SKILL_MANIFEST_INVALID', source, 'frontmatter missing');
  try {
    const document = parseDocument(match[1], { prettyErrors: false, strict: true });
    if (document.errors.length > 0) throw document.errors[0];
    const raw = document.toJS() as Record<string, unknown>;
    if (raw.schemaVersion !== 1) throw new Error('schemaVersion must equal 1');
    const name = String(raw.name ?? '');
    try {
      assertSafeExtensionName(name);
    } catch (error) {
      throw new SkillManifestError('SKILL_NAME_INVALID', source, name, error);
    }
    const trustLevel = raw.trustLevel;
    if (trustLevel !== 'untrusted' && trustLevel !== 'reviewed' && trustLevel !== 'trusted') {
      throw new Error('trustLevel is invalid');
    }
    const artifactHash = String(raw.artifactHash ?? '');
    if (!/^[a-f0-9]{64}$/.test(artifactHash)) throw new Error('artifactHash must be lowercase SHA-256');
    const manifest: SkillManifest = {
      schemaVersion: 1,
      name,
      version: String(raw.version ?? ''),
      description: String(raw.description ?? ''),
      dependencies: stringArray(raw.dependencies, 'dependencies', source),
      capabilities: stringArray(raw.capabilities, 'capabilities', source),
      entrypoints: stringArray(raw.entrypoints, 'entrypoints', source),
      source: String(raw.source ?? ''),
      artifactHash,
      trustLevel,
      extensions: record(raw.extensions, 'extensions', source),
    };
    if (!manifest.version || !manifest.description || !manifest.source) {
      throw new Error('version, description and source are required');
    }
    return { manifest, body: match[2] ?? '' };
  } catch (error) {
    if (error instanceof SkillManifestError) throw error;
    throw new SkillManifestError('SKILL_MANIFEST_INVALID', source, 'invalid YAML manifest', error);
  }
}

export function serializeSkillDocument(value: ParsedSkillDocument): string {
  const yaml = stringify(value.manifest, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${value.body}`;
}

function lexicalPathIsUnsafe(path: string): boolean {
  return path.length === 0
    || isAbsolute(path)
    || win32.isAbsolute(path)
    || /^[a-zA-Z]:/.test(path)
    || path.startsWith('\\\\')
    || path.split(/[\\/]+/).some(part => part === '..');
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function resolveSkillEntrypoints(root: string, manifest: SkillManifest): string[] {
  const realRoot = realpathSync.native(root);
  return manifest.entrypoints.map(entrypoint => {
    if (lexicalPathIsUnsafe(entrypoint)) {
      throw new SkillManifestError('SKILL_PATH_ESCAPE', entrypoint, 'entrypoint is not relative');
    }
    const lexical = resolve(realRoot, entrypoint);
    if (!isInside(realRoot, lexical)) {
      throw new SkillManifestError('SKILL_PATH_ESCAPE', entrypoint, 'lexical boundary escape');
    }
    let real: string;
    try {
      real = realpathSync.native(lexical);
      if (!statSync(real).isFile()) throw new Error('entrypoint is not a file');
    } catch (error) {
      throw new SkillManifestError('SKILL_ENTRYPOINT_MISSING', entrypoint, 'entrypoint missing', error);
    }
    if (!isInside(realRoot, real)) {
      throw new SkillManifestError('SKILL_PATH_ESCAPE', entrypoint, 'realpath boundary escape');
    }
    return real;
  });
}

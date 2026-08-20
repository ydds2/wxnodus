// src/release/evidenceTypes.ts — GateEvidence 判别联合类型（与 evidenceSchema 验证器配套）
export type GateId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I';
export type Sha256 = string;
export type ProfileId = 'core' | 'standard' | 'full-local-ai';
export type PlatformId = 'windows' | 'linux' | 'macos';

export interface EvidenceAttachment {
  path: string;
  sha256: Sha256;
  kind: 'stdout' | 'stderr' | 'artifact' | 'environment' | 'policy-manifest' | 'migration-drill' | 'unreachable-capability';
}

export interface EvidenceBinding {
  environment: EvidenceAttachment;
  policyManifest: EvidenceAttachment & { manifestChecksum: Sha256 };
  artifact: EvidenceAttachment & { artifactSha256: Sha256; commit: string };
  bindingSha256: Sha256;
}

export interface CommandEvidence {
  executable: string;
  args: string[];
  exitCode: number | null;
  stdoutAttachment: string;
  stderrAttachment: string;
}

interface CommonGateEvidence {
  schemaVersion: 1;
  waveScope: 'wave0';
  gate: GateId;
  requirementIds: Array<`R${string}`>;
  profiles: ProfileId[];
  platforms: PlatformId[];
  capabilityIds: string[];
  attachments: EvidenceAttachment[];
  binding: EvidenceBinding;
}

export type ExecutedGateEvidence = CommonGateEvidence & (
  | { status: 'passed'; commands: CommandEvidence[] }
  | { status: 'failed'; commands: CommandEvidence[]; reasonCode: string }
  | { status: 'blocked'; commands: CommandEvidence[]; reasonCode: string }
);

export interface NotApplicableGateEvidence extends CommonGateEvidence {
  status: 'not_applicable';
  unreachableEvidenceIds: string[];
  reasonCode: 'CAPABILITY_NOT_DELIVERED_IN_WAVE_SCOPE';
}

export type GateEvidence = ExecutedGateEvidence | NotApplicableGateEvidence;

export interface MigrationDrillBinding {
  waveScope: 'wave0';
  registryPath: 'src/migrations/config/registry.ts' | 'src/migrations/db/registry.ts';
  descriptorId: string;
  descriptorChecksum: Sha256;
  registryArtifactPath: string;
  registryArtifactSha256: Sha256;
  compatibilityManifestPath: 'docs/superpowers/manifests/v3-compatibility.json';
  compatibilityManifestSha256: Sha256;
  candidateArtifactSha256: Sha256;
  environmentSha256: Sha256;
  policyManifestSha256: Sha256;
  bindingSha256: Sha256;
}

export type EmbeddingActivationSpace = {
  _id: string; status: string; validatedAt?: number; validationJobId?: string; failure?: string;
};
export type EmbeddingValidation = { _id: string; spaceId?: string; kind: string; phase: string; failure?: string };

export function declaredBackupSource(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const archive = value as Record<string, unknown>;
  const manifest = archive.manifest as Record<string, unknown> | undefined;
  const sections = archive.sections as Record<string, unknown> | undefined;
  if (!manifest || !sections || !Array.isArray(sections.federationIdentity)) return null;
  let identity: unknown = sections.federationIdentity[0];
  if (typeof identity === 'string') {
    try { identity = JSON.parse(identity); } catch { return null; }
  }
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return null;
  const source = identity as Record<string, unknown>;
  return { townId: typeof source.townId === 'string' ? source.townId : 'not declared',
    fingerprint: typeof source.fingerprint === 'string' ? source.fingerprint : 'not declared',
    includeVectors: manifest.includeVectors === true };
}

export function canActivateEmbeddingSpace(space: EmbeddingActivationSpace | undefined,
  validation: EmbeddingValidation | null | undefined, restoreState?: string) {
  return !!space && space.status === 'READY' && !!space.validatedAt && !space.failure &&
    !!validation && validation._id === space.validationJobId && validation.spaceId === space._id &&
    validation.kind === 'VALIDATION' && validation.phase === 'DONE' && !validation.failure &&
    (restoreState === undefined || restoreState === 'PENDING_VALIDATION');
}

export function vectorRecoveryReason(reason: string) {
  const reasons: Record<string, string> = {
    SOURCE_KEY_WAS_NOT_LOCALLY_TRUSTED_AT_IMPORT: 'The source signing key was not locally trusted when this archive was imported. Rebuild from retained text; an archive cannot grant itself trust.',
    ARCHIVE_HAS_NO_PROVEN_VECTOR_SNAPSHOT: 'This archive has no proven vector snapshot. Rebuild from retained text.',
    NO_AUTHORIZED_PROVIDER_EVIDENCE: 'The target provider has no server-authorized identity evidence. Configure an authorized provider or rebuild from retained text.',
    VECTOR_MODEL_EVIDENCE_INCOMPATIBLE: 'The source weights or processing pipeline do not match the independently verified target. Rebuild from retained text.',
    VECTOR_SOURCE_OWNER_OR_TEXT_CHANGED: 'The memory owner or canonical text changed. Rebuild from the current retained text.',
    EMBEDDING_CERTIFICATE_FENCED: 'The target serving certificate was revoked, changed or expired. Verify the provider again before rebuilding or validating.',
    EMBEDDING_COVERAGE_INCOMPLETE: 'The snapshot does not cover every retained memory. Rebuild missing vectors, then validate coverage and live retrieval again.',
  };
  return reasons[reason] ?? `Vector recovery requires attention (${reason}). Rebuild from retained text and validate before activation.`;
}

import { digest } from './security';
import { validateSelectiveManifest, type SelectiveManifest } from './backupSelectiveHelpers';
import { validateLocalChunkManifest, type LocalArchiveProof } from './travelPrivacyLocalChunkManifest';
import { decodeRow, type BackupRow } from './backupHelpers';
import { redactedFact } from './backupPrivacy';
import type { LargeChunk } from './backupLargeHelpers';

/** Original town signatures authenticate source evidence; only the local proof authenticates current bytes. */
export async function validateSelectiveImportManifest(value: unknown, signature: string,
  localProof?: LocalArchiveProof, expectedDigest?: string, expectedLocalProofFingerprint?: string) {
  if ((value as { format?: string } | null)?.format !== 'ai-town-local-sanitized-chunks') {
    if (localProof || expectedDigest || expectedLocalProofFingerprint) throw new Error('LOCAL_ARCHIVE_IMPORT_AUTH_AMBIGUOUS');
    const manifest = value as SelectiveManifest;
    await validateSelectiveManifest(manifest, signature);
    return { manifest, local: undefined };
  }
  if (signature !== '') throw new Error('LOCAL_ARCHIVE_SOURCE_SIGNATURE_NOT_CURRENT');
  const local = await validateLocalChunkManifest(value, { localProof, expectedDigest }, { portable: true });
  if (!expectedLocalProofFingerprint) throw new Error('LOCAL_ARCHIVE_PROOF_SIGNER_CONFIRMATION_REQUIRED');
  if (`sha256:${await digest(localProof!.publicKey)}` !== expectedLocalProofFingerprint)
    throw new Error('LOCAL_ARCHIVE_PROOF_SIGNER_MISMATCH');
  const original = local.sourceEvidence.manifest;
  if (!original || original.format !== 'ai-town-selective-archive' || local.chunks.some(chunk => chunk.encoding !== 'SELECTIVE'))
    throw new Error('RAW_ARCHIVE_USE_LARGE_API');
  if (local.chunks.filter(chunk => chunk.table === 'federationIdentity').reduce((n, c) => n + c.count, 0) !== 1)
    throw new Error('BACKUP_SINGLETON_MISMATCH');
  // Preserve signed selection and identity; substitute only authenticated current descriptors.
  const manifest: SelectiveManifest = { ...original, chunks: local.chunks.map(({ index, table, count, bytes, digest }) =>
    ({ index, table, count, bytes, digest })) };
  return { manifest, local };
}

export async function selectiveImportAuthenticationMetadata(plan: Awaited<ReturnType<typeof validateSelectiveImportManifest>>,
  localProof?: LocalArchiveProof, expectedLocalProofFingerprint?: string) {
  return plan.local ? {
    sourceSignatureValid: false,
    archiveImportedFromId: plan.local.archiveId,
    archiveLocalManifestDigest: await digest(plan.local),
    archiveLocalProof: localProof,
    archiveLocalProofFingerprint: expectedLocalProofFingerprint,
    archiveClearedVisits: plan.local.clearedVisits,
    archiveSourceEvidence: { digest: plan.local.sourceEvidence.digest, signature: plan.local.sourceEvidence.signature,
      publicKey: plan.local.sourceEvidence.publicKey },
    derivativeClearedVisitsCount: plan.local.clearedVisits.length,
    derivativeDerivedAt: plan.local.derivedAt,
    derivativePrivacyChunkCount: 'privacyChunks' in plan.local ? (plan.local.privacyChunks as unknown[]).length : 0,
    uploadedPrivacyChunks: 0,
  } : {};
}

export function assertSelectiveDerivativeClearedVisits(chunk: LargeChunk, clearedVisits: readonly string[]) {
  const cleared = new Set(clearedVisits);
  for (const encoded of chunk.rows) {
    const envelope = decodeRow(encoded);
    if (envelope.kind !== 'record') continue;
    const row: BackupRow = decodeRow(envelope.record);
    const data = row.data as { type?: unknown; visitId?: unknown } | undefined;
    const visit = chunk.table === 'memories' && data?.type === 'travel' ? data.visitId : row.visitId;
    if (typeof visit !== 'string' || !cleared.has(visit)) continue;
    if (chunk.table === 'memories' && data?.type === 'travel' ||
      ['homeTravelTranscripts', 'homeTravelTranscriptPages'].includes(chunk.table) ||
      ['federationEventFacts', 'federationActionFacts'].includes(chunk.table) && !redactedFact(chunk.table, row) ||
      chunk.table === 'autonomousTravelDecisions' && (row.reason !== undefined || row.error !== undefined))
      throw new Error('BACKUP_PRIVACY_REDACTED');
  }
}

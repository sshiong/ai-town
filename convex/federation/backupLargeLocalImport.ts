import { digest } from './security';
import { validateManifest, type ChunkDescriptor, type LargeManifest } from './backupLargeHelpers';
import { validateLocalChunkManifest, type LocalArchiveProof } from './travelPrivacyLocalChunkManifest';
import { redactedFact } from './backupPrivacy';
import { decodeRow, type BackupRow } from './backupHelpers';
import type { LargeChunk } from './backupLargeHelpers';

/** Source evidence authenticates the original town; the local proof authenticates current bytes. */
export async function validateLargeImportManifest(value: unknown, signature: string,
  localProof?: LocalArchiveProof, expectedDigest?: string, expectedLocalProofFingerprint?: string) {
  if ((value as { format?: string } | null)?.format !== 'ai-town-local-sanitized-chunks') {
    if (localProof || expectedDigest || expectedLocalProofFingerprint) throw new Error('LOCAL_ARCHIVE_IMPORT_AUTH_AMBIGUOUS');
    const manifest = value as LargeManifest;
    await validateManifest(manifest, signature);
    return { source: manifest.source, chunks: manifest.chunks, includeVectors: manifest.includeVectors,
      exportedAt: manifest.exportedAt, local: undefined };
  }
  if (signature !== '') throw new Error('LOCAL_ARCHIVE_SOURCE_SIGNATURE_NOT_CURRENT');
  const local = await validateLocalChunkManifest(value, { localProof, expectedDigest }, { portable: true });
  if (!expectedLocalProofFingerprint) throw new Error('LOCAL_ARCHIVE_PROOF_SIGNER_CONFIRMATION_REQUIRED');
  if (`sha256:${await digest(localProof!.publicKey)}` !== expectedLocalProofFingerprint)
    throw new Error('LOCAL_ARCHIVE_PROOF_SIGNER_MISMATCH');
  const original = local.sourceEvidence.manifest;
  if (!original || original.format !== 'ai-town-chunks' || local.chunks.some(chunk => chunk.encoding !== 'RAW'))
    throw new Error('SELECTIVE_ARCHIVE_USE_SELECTIVE_API');
  // Local validation preserves the complete index/table set and only lowers counts.
  // Identity is the one required row that privacy deletion may never remove.
  if (local.chunks.filter(chunk => chunk.table === 'federationIdentity').reduce((sum, chunk) => sum + chunk.count, 0) !== 1)
    throw new Error('BACKUP_SINGLETON_MISMATCH');
  const chunks: ChunkDescriptor[] = local.chunks.map(({ index, table, count, bytes, digest }) =>
    ({ index, table, count, bytes, digest }));
  return { source: original.source, chunks, includeVectors: original.includeVectors,
    exportedAt: original.exportedAt, local };
}

export async function largeImportAuthenticationMetadata(
  plan: Awaited<ReturnType<typeof validateLargeImportManifest>>, localProof?: LocalArchiveProof,
  expectedLocalProofFingerprint?: string,
) {
  return plan.local ? {
    sourceSignatureValid: false,
    archiveImportedFromId: plan.local.archiveId,
    archiveLocalManifestDigest: await digest(plan.local),
    archiveLocalProof: localProof,
    archiveLocalProofFingerprint: expectedLocalProofFingerprint,
    archiveClearedVisits: plan.local.clearedVisits,
    // A portable source storage ID has no authority in this deployment. The
    // original signed manifest is embedded in the authenticated local manifest.
    archiveSourceEvidence: { digest: plan.local.sourceEvidence.digest, signature: plan.local.sourceEvidence.signature,
      publicKey: plan.local.sourceEvidence.publicKey },
    derivativeClearedVisitsCount: plan.local.clearedVisits.length,
    derivativeDerivedAt: plan.local.derivedAt,
  } : {};
}

/** A locally signed descriptor cannot reintroduce the visit prose it claims to have cleared. */
export function assertLargeDerivativeClearedVisits(chunk: LargeChunk, clearedVisits: readonly string[]) {
  const cleared = new Set(clearedVisits);
  for (const encoded of chunk.rows) {
    const row: BackupRow = decodeRow(encoded);
    const data = row.data as { type?: unknown; visitId?: unknown } | undefined;
    const visit: unknown = chunk.table === 'memories' && data?.type === 'travel' ? data.visitId : row.visitId;
    if (typeof visit !== 'string' || !cleared.has(visit)) continue;
    if (chunk.table === 'memories' && data?.type === 'travel' ||
      ['homeTravelTranscripts', 'homeTravelTranscriptPages'].includes(chunk.table) ||
      ['federationEventFacts', 'federationActionFacts'].includes(chunk.table) && !redactedFact(chunk.table, row) ||
      chunk.table === 'autonomousTravelDecisions' && (row.reason !== undefined || row.error !== undefined))
      throw new Error('BACKUP_PRIVACY_REDACTED');
  }
}

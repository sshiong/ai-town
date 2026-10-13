import type { DatabaseReader } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { assertNoSecrets, decodeRow, type BackupRow } from './backupHelpers';
import { largeTables, oldTables, descriptor, MAX_ARCHIVE_BYTES, MAX_CHUNKS, MAX_CHUNK_BYTES, size,
  validateChunk, validateManifest, type ChunkDescriptor, type LargeChunk, type LargeManifest } from './backupLargeHelpers';
import { selectiveTables, validateSelectiveChunk, validateSelectiveManifest,
  type ArchiveEnvelope, type SelectiveManifest } from './backupSelectiveHelpers';
import { digest, verifySignature } from './security';

export type LocalChunkDescriptor = ChunkDescriptor & {
  role: 'SOURCE' | 'OLD' | 'EXPORT'; encoding: 'RAW' | 'SELECTIVE';
};
export type LocalSourceEvidence = {
  manifest?: LargeManifest | SelectiveManifest; manifestStorageId?: string;
  digest: string; signature: string; publicKey: string;
};
export type LocalSanitizedChunkManifest = {
  format: 'ai-town-local-sanitized-chunks'; version: 1; schemaVersion: 1;
  sourceSignatureValid: false; archiveId: string; derivedAt: number;
  chunks: LocalChunkDescriptor[]; clearedVisits: string[]; sourceEvidence: LocalSourceEvidence;
};
export type LocalArchiveProof = {
  format: 'ai-town-local-archive-proof'; version: 1; townId: string; publicKey: string;
  manifestDigest: string; signature: string;
};
type Auth = { expectedDigest?: string; localProof?: LocalArchiveProof };
const fail = (code: string): never => { throw new Error(`LOCAL_ARCHIVE_${code}`); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const checksum = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value);
function keys(value: unknown, allowed: readonly string[]) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('METADATA_INVALID');
}

/** Reject extra signed fields instead of cropping them and claiming the original signature survived. */
export function assertLocalSourceManifestMetadata(value: unknown): asserts value is LargeManifest | SelectiveManifest {
  keys(value, ['format', 'version', 'schemaVersion', 'scope', 'exportId', 'source', 'exportedAt', 'includeVectors',
    'chunks', 'selection', 'usage', 'operator', 'reason', 'coldHistoryFiles']);
  const manifest = value as LargeManifest | SelectiveManifest;
  if (!['ai-town-chunks', 'ai-town-selective-archive'].includes(manifest.format)) fail('SOURCE_FORMAT_INVALID');
  if (manifest.format === 'ai-town-chunks' && Object.keys(manifest).some(key =>
    ['selection', 'usage', 'operator', 'reason', 'coldHistoryFiles'].includes(key))) fail('METADATA_INVALID');
  keys(manifest.source, ['_id', '_creationTime', 'timePolicy', 'identityVersion', 'townId', 'townName', 'publicKey',
    'fingerprint', 'deploymentInstanceId', 'deploymentEpoch', 'endpoint', 'enabled', 'allowIncomingPairRequests',
    'allowUnencryptedHttp', 'allowPublicHttp', 'maxVisitors', 'maxVisitDurationMs', 'replyTimeoutMs', 'resourceLimits',
    'mode', 'createdAt', 'migrationFrozenAt', 'migrationOperator', 'activeHandoffId', 'quarantinePreviousMode',
    'endpointSequence', 'endpointCandidates', 'endpointGeneration']);
  for (const [name, allowed] of Object.entries({
    timePolicy: ['reservationMs', 'leaseMs', 'clockSkewMs', 'probeFreshnessMs', 'probeIntervalMs', 'gapTimeoutMs',
      'returnMarginMs', 'clockObservationGapMs', 'requestTimeoutMs'],
    resourceLimits: ['maxResidentAgents', 'maxHumanPlayers', 'maxVisitReservations', 'maxConcurrentLocalLLM',
      'maxPendingDecisions', 'maxPendingLocalLLM'],
  })) if (manifest.source[name] !== undefined) {
    keys(manifest.source[name], allowed);
    if (Object.values(manifest.source[name]).some(n => typeof n !== 'number' || !Number.isFinite(n))) fail('METADATA_INVALID');
  }
  if (manifest.source.endpointCandidates !== undefined) {
    if (!Array.isArray(manifest.source.endpointCandidates)) fail('METADATA_INVALID');
    for (const endpoint of manifest.source.endpointCandidates) {
      keys(endpoint, ['url', 'priority']);
      if (typeof endpoint.url !== 'string' || !Number.isFinite(endpoint.priority)) fail('METADATA_INVALID');
    }
  }
  if (!Array.isArray(manifest.chunks)) fail('METADATA_INVALID');
  for (const chunk of manifest.chunks) {
    keys(chunk, ['index', 'table', 'count', 'bytes', 'digest']);
    if (!checksum(chunk.digest)) fail('METADATA_INVALID');
  }
  if (manifest.format === 'ai-town-selective-archive') {
    keys(manifest.selection, ['scope', 'owners', 'categories', 'from', 'to', 'includePublicPeers', 'dependencyPolicy', 'timePolicy']);
    if (!Array.isArray(manifest.selection.owners)) fail('METADATA_INVALID');
    for (const owner of manifest.selection.owners) keys(owner, ['agentGlobalId', 'worldId', 'playerId', 'agentId', 'chatProfileId']);
    if (manifest.coldHistoryFiles !== undefined) {
      keys(manifest.coldHistoryFiles, ['policy', 'included', 'excluded']);
      keys(manifest.coldHistoryFiles.excluded, ['CANONICAL_MEMORY_NOT_SELECTED', 'SOURCE_SCOPE_INCOMPLETE', 'SOURCE_SCOPE_NOT_SELECTED']);
    }
  }
  assertNoSecrets(manifest);
}

async function validateStructure(value: unknown, portable = false): Promise<LocalSanitizedChunkManifest> {
  keys(value, ['format', 'version', 'schemaVersion', 'sourceSignatureValid', 'archiveId', 'derivedAt',
    'chunks', 'clearedVisits', 'sourceEvidence']);
  const manifest = value as LocalSanitizedChunkManifest;
  if (manifest.format !== 'ai-town-local-sanitized-chunks' || manifest.version !== 1 || manifest.schemaVersion !== 1 ||
    manifest.sourceSignatureValid !== false || !identifier(manifest.archiveId) || !Number.isFinite(manifest.derivedAt) ||
    !Array.isArray(manifest.chunks) || manifest.chunks.length > (portable ? MAX_CHUNKS : 2 * MAX_CHUNKS) || size(manifest) > (portable ? 5_000_000 : 10_000_000) ||
    !Array.isArray(manifest.clearedVisits) || !manifest.clearedVisits.length ||
    manifest.clearedVisits.some(visit => !identifier(visit)) ||
    new Set(manifest.clearedVisits).size !== manifest.clearedVisits.length) fail('MANIFEST_INVALID');
  keys(manifest.sourceEvidence, ['manifest', 'manifestStorageId', 'digest', 'signature', 'publicKey']);
  const evidence = manifest.sourceEvidence;
  if (!checksum(evidence.digest) || typeof evidence.signature !== 'string' || typeof evidence.publicKey !== 'string' ||
    evidence.manifestStorageId !== undefined && !identifier(evidence.manifestStorageId)) fail('SOURCE_EVIDENCE_INVALID');
  if (evidence.manifest !== undefined) {
    assertLocalSourceManifestMetadata(evidence.manifest);
    if (await digest(evidence.manifest) !== evidence.digest || evidence.publicKey !== evidence.manifest.source.publicKey)
      fail('SOURCE_EVIDENCE_INVALID');
    if (evidence.manifest.format === 'ai-town-chunks') await validateManifest(evidence.manifest, evidence.signature);
    else await validateSelectiveManifest(evidence.manifest, evidence.signature);
  } else if (evidence.signature !== '' || evidence.publicKey !== '' || manifest.chunks.some(chunk => chunk.role !== 'OLD'))
    fail('SOURCE_EVIDENCE_MISSING');
  let totalBytes = 0, previousIndex = -1;
  for (const chunk of manifest.chunks) {
    keys(chunk, ['index', 'table', 'count', 'bytes', 'digest', 'role', 'encoding']);
    if (!Number.isSafeInteger(chunk.index) || chunk.index <= previousIndex || chunk.index >= 2 * MAX_CHUNKS ||
      !['SOURCE', 'OLD', 'EXPORT'].includes(chunk.role) || !['RAW', 'SELECTIVE'].includes(chunk.encoding) ||
      !Number.isSafeInteger(chunk.count) || chunk.count < 0 || chunk.count > 20 ||
      !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 1 || chunk.bytes > MAX_CHUNK_BYTES || !checksum(chunk.digest))
      fail('DESCRIPTOR_INVALID');
    const tables = chunk.role === 'OLD' ? [...oldTables, 'federationIdentity'] : chunk.encoding === 'SELECTIVE' ? [...selectiveTables, 'coldHistoryFiles', 'referenceMappings'] : largeTables;
    if (!(tables as readonly string[]).includes(chunk.table) || chunk.table === 'coldHistoryFiles' && chunk.count > 1 ||
      chunk.role === 'OLD' && chunk.encoding !== 'RAW') fail('DESCRIPTOR_INVALID');
    if (portable && chunk.role === 'OLD') fail('PRIVATE_ROLLBACK_NOT_PORTABLE');
    if (chunk.role !== 'OLD') {
      const original = evidence.manifest!.chunks[chunk.index];
      const encoding = evidence.manifest!.format === 'ai-town-selective-archive' ? 'SELECTIVE' : 'RAW';
      if (!original || original.index !== chunk.index || original.table !== chunk.table || chunk.count > original.count ||
        chunk.encoding !== encoding) fail('SOURCE_DESCRIPTOR_MISMATCH');
    }
    previousIndex = chunk.index;
    totalBytes += chunk.bytes;
  }
  const retainedSourceIndices = new Set(manifest.chunks.filter(chunk => chunk.role !== 'OLD').map(chunk => chunk.index));
  if (evidence.manifest && evidence.manifest.chunks.some(original => !retainedSourceIndices.has(original.index)))
    fail('SOURCE_CHUNK_SET_INCOMPLETE');
  if (portable && !evidence.manifest) fail('PRIVATE_ROLLBACK_NOT_PORTABLE');
  if (totalBytes > (portable ? MAX_ARCHIVE_BYTES : 2 * MAX_ARCHIVE_BYTES)) fail('ARCHIVE_BUDGET');
  assertNoSecrets(manifest);
  return manifest;
}

export async function createLocalChunkManifest(
  input: Omit<LocalSanitizedChunkManifest, 'format' | 'version' | 'schemaVersion' | 'sourceSignatureValid'>,
): Promise<LocalSanitizedChunkManifest> {
  return validateStructure({ ...input, format: 'ai-town-local-sanitized-chunks', version: 1,
    schemaVersion: 1, sourceSignatureValid: false });
}

/** A DB digest pins local storage; a local proof authenticates a portable derivative, never the original source. */
export async function validateLocalChunkManifest(value: unknown, auth: Auth, options: { portable?: boolean } = {}) {
  const manifest = await validateStructure(value, options.portable);
  const manifestDigest = await digest(manifest);
  if (auth.expectedDigest !== undefined && (!checksum(auth.expectedDigest) || auth.expectedDigest !== manifestDigest))
    fail('DIGEST_MISMATCH');
  if (auth.localProof !== undefined) {
    keys(auth.localProof, ['format', 'version', 'townId', 'publicKey', 'manifestDigest', 'signature']);
    const { signature, ...payload } = auth.localProof;
    if (payload.format !== 'ai-town-local-archive-proof' || payload.version !== 1 || !identifier(payload.townId) ||
      typeof payload.publicKey !== 'string' || payload.manifestDigest !== manifestDigest || typeof signature !== 'string' ||
      !await verifySignature(payload, signature, payload.publicKey)) fail('LOCAL_PROOF_INVALID');
  }
  if (!auth.expectedDigest && !auth.localProof || options.portable && !auth.localProof) fail('AUTHENTICATION_REQUIRED');
  return manifest;
}

export async function createLocalArchiveProof(manifest: LocalSanitizedChunkManifest,
  local: { townId: string; publicKey: string }, signValue: (payload: unknown) => Promise<string>): Promise<LocalArchiveProof> {
  await validateStructure(manifest, true);
  const payload = { format: 'ai-town-local-archive-proof' as const, version: 1 as const,
    townId: local.townId, publicKey: local.publicKey, manifestDigest: await digest(manifest) };
  const proof = { ...payload, signature: await signValue(payload) };
  await validateLocalChunkManifest(manifest, { localProof: proof }, { portable: true });
  return proof;
}

export async function portableLocalChunkManifest(manifest: LocalSanitizedChunkManifest) {
  await validateStructure(manifest);
  return validateStructure({ ...manifest, chunks: manifest.chunks.filter(chunk => chunk.role !== 'OLD') }, true);
}

/** New descriptors cover the complete stored JSON, including the optional upload recovery marker. */
export async function validateLocalChunk(value: unknown, expected: LocalChunkDescriptor): Promise<BackupRow[] | ArchiveEnvelope[]> {
  keys(expected, ['index', 'table', 'count', 'bytes', 'digest', 'role', 'encoding']);
  const tables = expected.role === 'OLD' ? [...oldTables, 'federationIdentity'] : expected.encoding === 'SELECTIVE' ? [...selectiveTables, 'coldHistoryFiles', 'referenceMappings'] : largeTables;
  if (!['RAW', 'SELECTIVE'].includes(expected.encoding) || !['SOURCE', 'OLD', 'EXPORT'].includes(expected.role) ||
    !(tables as readonly string[]).includes(expected.table) || !checksum(expected.digest) ||
    !Number.isSafeInteger(expected.index) || expected.index < 0 ||
    !Number.isSafeInteger(expected.count) || expected.count < 0 || expected.count > 20 ||
    !Number.isSafeInteger(expected.bytes) || expected.bytes < 1 || expected.bytes > MAX_CHUNK_BYTES) fail('DESCRIPTOR_INVALID');
  keys(value, ['index', 'table', 'rows', 'privacyRewriteOperationId']);
  const chunk = value as LargeChunk & { privacyRewriteOperationId?: string };
  if (chunk.privacyRewriteOperationId !== undefined && !identifier(chunk.privacyRewriteOperationId)) fail('UPLOAD_MARKER_INVALID');
  if (size(chunk) > MAX_CHUNK_BYTES) fail('CHUNK_BUDGET');
  if (expected.role === 'OLD' && expected.encoding !== 'RAW') fail('DESCRIPTOR_INVALID');
  if (expected.role === 'OLD') {
    if (!Array.isArray(chunk.rows) || chunk.index !== expected.index || chunk.table !== expected.table) fail('CHUNK_MISMATCH');
    const actual = await descriptor(chunk);
    if (actual.count !== expected.count || actual.bytes !== expected.bytes || actual.digest !== expected.digest) fail('CHUNK_CHECKSUM_MISMATCH');
    // OLD is a private checkpoint, including required encrypted credentials. Portable validation always excludes it.
    return chunk.rows.map(decodeRow);
  }
  return expected.encoding === 'SELECTIVE' ? validateSelectiveChunk(chunk, expected) : validateChunk(chunk, expected);
}

/** Read-side fence is global while a live rewrite owns town; per-job fencing survives interrupted rewrites. */
export async function localArchiveExportSnapshot(ctx: { db: DatabaseReader }, job: Doc<'backupLargeJobs'>, index?: number) {
  const rewrite = await ctx.db.query('travelPrivacyChunkRewrites').withIndex('key', q => q.eq('key', 'town')).unique();
  if (rewrite && rewrite.phase !== 'DONE' || job.archivePrivacyState === 'REWRITING')
    throw new Error('BACKUP_PRIVACY_REWRITE_ACTIVE');
  if (job.kind !== 'export' || job.state !== 'COMPLETE' || !job.manifestStorageId)
    throw new Error('BACKUP_MANIFEST_NOT_READY');
  const chunk = index === undefined ? null : await ctx.db.query('backupLargeChunks')
    .withIndex('job_index', q => q.eq('jobId', job._id).eq('index', index)).unique();
  return { job, chunk };
}

export async function readLocalArchiveManifest(
  ctx: { storage: { get(id: Doc<'backupLargeJobs'>['manifestStorageId'] & {}): Promise<Blob | null> } },
  job: Doc<'backupLargeJobs'>,
) {
  if (!job.manifestStorageId || typeof job.metadata?.archiveLocalManifestDigest !== 'string')
    fail('AUTHENTICATION_REQUIRED');
  const blob = await ctx.storage.get(job.manifestStorageId!);
  if (!blob) throw new Error('BACKUP_CHUNK_STORAGE_MISSING');
  if (blob.size > 10_000_000) fail('MANIFEST_INVALID');
  const manifest = await validateLocalChunkManifest(JSON.parse(await blob.text()), {
    expectedDigest: job.metadata.archiveLocalManifestDigest,
    localProof: job.metadata.archiveLocalProof,
  });
  if (manifest.archiveId !== job._id) fail('ARCHIVE_ID_MISMATCH');
  return manifest;
}

export async function assertArchiveExportUnchanged(before: unknown, after: unknown) {
  if (await digest(before) !== await digest(after)) throw new Error('BACKUP_CHECKPOINT_CHANGED');
}

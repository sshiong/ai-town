import { validateTimePolicy } from './timePolicy';
import { validatePrivacyBackupRow, redactedFact } from './backupPrivacy';
import {
  BackupRow,
  assertNoSecrets,
  dataTables,
  decodeRow,
  snapshotTables,
  stripSystem,
  validateFields,
  validateResourcePolicy,
} from './backupHelpers';
import { digest, verifySignature } from './security';
import schema from '../schema';
import { validateResourceLimits } from './resources';
import { validateEndpointRecord } from './protocol';
import { validateModelPolicyPortable } from '../models/usageSchema';
import { MAX_DENIED_RESIDENTS, validateResidentPolicyPortable } from './residentPolicySchema';
import { MAX_DISCLOSURE_POLICIES, validateDisclosurePolicyPortable } from './disclosurePolicySchema';
import { vectorFields } from './vectorEvidence';
import { isMemoryBackupTable, memoryBackupReferences, memoryBackupTables } from './memoryBackup';

// Derived vectors are opt-in; canonical memories remain the complete rebuilding source.
export const largeTables = [
  ...dataTables.filter((t) => !['modelMemoryVectors', 'storagePolicies', 'federationActionFacts', 'federationEventFacts', 'homeTravelTranscripts', 'homeTravelTranscriptPages', 'autonomousTravelPolicies', 'autonomousTravelDecisions', 'federationResourcePolicy', 'federationResourceAudit'].includes(t)),
  ...snapshotTables.filter((t) => t !== 'federationTranscriptJobs'),
  'federationIdentity',
  'federationPeers',
  'storagePolicies',
  'federationActionFacts',
  'federationEventFacts',
  'homeTravelTranscripts',
  'homeTravelTranscriptPages',
  'federationTranscriptJobs',
  'autonomousTravelPolicies',
  'autonomousTravelDecisions',
  'federationResourcePolicy',
  'federationResourceAudit',
  'coldHistoryFiles',
  'modelMemoryVectors',
  'travelPrivacyTombstones',
] as const;
export const oldTables = [
  ...largeTables.filter((t) => !['travelPrivacyTombstones', 'modelMemoryVectors', 'coldHistoryFiles', 'federationIdentity', 'autonomousTravelPolicies', 'autonomousTravelDecisions', 'federationResourcePolicy', 'federationResourceAudit'].includes(t)),
  'modelMemoryVectors',
  'memoryEmbeddings',
  'embeddingsCache',
  'coldHistoryArchives',
  'coldHistoryChunks',
  'pairRequests',
  'migrationPeerExchanges',
  'federationReplayNonces',
  'storageUsageScans',
  'storageUsageSnapshots',
  'storageCleanupJobs',
  'autonomousTravelPolicies',
  'autonomousTravelDecisions',
  'federationResourcePolicy',
  'federationResourceAudit',
] as const;
export const MAX_CHUNK_BYTES = 900_000;
export const TARGET_CHUNK_BYTES = 512 * 1024;
export const MAX_ARCHIVE_BYTES = 1024 ** 3;
export const MAX_CHUNKS = 20_000;
export type LargeChunk = { index: number; table: string; rows: unknown[] };
export type ChunkDescriptor = {
  index: number;
  table: string;
  count: number;
  bytes: number;
  digest: string;
};
export type LargeManifest = {
  format: 'ai-town-chunks';
  version: 1;
  schemaVersion: 1;
  scope: 'town';
  exportId: string;
  source: BackupRow;
  exportedAt: number;
  includeVectors?: boolean;
  chunks: ChunkDescriptor[];
};
export function sanitizeLargeValue(value: any): any {
  if (value instanceof ArrayBuffer || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitizeLargeValue);
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !['embeddingCertificateId', 'coverageJobId', 'validationJobId'].includes(key) &&
          !/(privateKey|secretEncrypted|credentialEncrypted|ephemeralPrivate|apiKey$|adminToken|fencingToken)/i.test(
            key,
          ),
      )
      .map(([key, item]) => [key, sanitizeLargeValue(item)]),
  );
}
export function size(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
export async function descriptor(chunk: LargeChunk): Promise<ChunkDescriptor> {
  return {
    index: chunk.index,
    table: chunk.table,
    count: chunk.rows.length,
    bytes: size(chunk),
    digest: await digest(chunk),
  };
}
export async function validateManifest(manifest: LargeManifest, signature: string) {
  if (
    !manifest ||
    manifest.format !== 'ai-town-chunks' ||
    manifest.version !== 1 ||
    manifest.schemaVersion !== 1 ||
    manifest.scope !== 'town' ||
    (manifest.includeVectors !== undefined && typeof manifest.includeVectors !== 'boolean') ||
    !Array.isArray(manifest.chunks) ||
    !manifest.source?.townId ||
    !manifest.source.publicKey ||
    !manifest.exportId ||
    !Number.isFinite(manifest.exportedAt)
  )
    throw new Error('UNSUPPORTED_LARGE_BACKUP_MANIFEST');
  assertNoSecrets(manifest);
  if (manifest.chunks.length > MAX_CHUNKS || size(manifest) > 5_000_000)
    throw new Error('LARGE_BACKUP_MANIFEST_BUDGET');
  const tables = new Set<string>();
  let bytes = 0;
  let previousTable = -1;
  for (let index = 0; index < manifest.chunks.length; index++) {
    const entry = manifest.chunks[index];
    if (
      entry.index !== index ||
      !(largeTables as readonly string[]).includes(entry.table) ||
      !Number.isSafeInteger(entry.count) ||
      entry.count < 0 ||
      entry.count > 20 ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 1 ||
      entry.bytes > MAX_CHUNK_BYTES ||
      typeof entry.digest !== 'string'
    )
      throw new Error('INVALID_LARGE_BACKUP_DESCRIPTOR');
    if (entry.table === 'coldHistoryFiles' && entry.count > 1)
      throw new Error('BACKUP_COLD_FILES_CHUNK_BOUND_REQUIRED');
    if (entry.table === 'modelMemoryVectors' && entry.count && !manifest.includeVectors)
      throw new Error('VECTOR_BACKUP_OPTION_REQUIRED');
    const tableIndex = (largeTables as readonly string[]).indexOf(entry.table);
    if (tableIndex < previousTable) throw new Error('LARGE_BACKUP_TABLE_ORDER');
    previousTable = tableIndex;
    tables.add(entry.table);
    bytes += entry.bytes;
  }
  if (bytes > MAX_ARCHIVE_BYTES) throw new Error('LARGE_BACKUP_ARCHIVE_BUDGET');
  if (largeTables.some((table) => !['travelPrivacyTombstones', 'modelMemoryVectors', 'modelProviderQuotas', 'coldHistoryFiles', 'federationIdentityKeyHistory', 'homeTravelTranscripts', 'homeTravelTranscriptPages', 'federationTranscriptJobs', 'migrationHandoffRecords', 'autonomousTravelPolicies', 'autonomousTravelDecisions', 'federationResourcePolicy', 'federationResourceAudit', 'federationTravelAudit', 'federationResidentPolicy', 'federationResidentPolicyAudit', 'federationDisclosurePolicy', 'federationDisclosureAudit', ...memoryBackupTables].includes(table) && !tables.has(table)))
    throw new Error('INCOMPLETE_LARGE_BACKUP_MANIFEST');
  if (manifest.chunks.filter(c => c.table === 'federationResidentPolicy').reduce((sum, c) => sum + c.count, 0) > MAX_DENIED_RESIDENTS)
    throw new Error('RESIDENT_POLICY_CAPACITY_EXCEEDED');
  if (manifest.chunks.filter(c => c.table === 'federationDisclosurePolicy').reduce((sum, c) => sum + c.count, 0) > MAX_DISCLOSURE_POLICIES)
    throw new Error('DISCLOSURE_POLICY_CAPACITY_EXCEEDED');
  validateSourceRow('federationIdentity', manifest.source);
  if (manifest.source.fingerprint !== `sha256:${await digest(manifest.source.publicKey)}`)
    throw new Error('BACKUP_IDENTITY_MISMATCH');
  if (
    manifest.chunks
      .filter((c) => c.table === 'federationIdentity')
      .reduce((n, c) => n + c.count, 0) !== 1 ||
    manifest.chunks.filter((c) => c.table === 'modelSettings').reduce((n, c) => n + c.count, 0) > 1 ||
    manifest.chunks.filter((c) => c.table === 'federationResourcePolicy').reduce((n, c) => n + c.count, 0) > 1
  )
    throw new Error('BACKUP_SINGLETON_MISMATCH');
  if (!(await verifySignature(manifest, signature, manifest.source.publicKey)))
    throw new Error('BACKUP_SIGNATURE_INVALID');
}
export async function validateChunk(chunk: LargeChunk, expected: ChunkDescriptor) {
  if (
    !chunk ||
    !Array.isArray(chunk.rows) ||
    chunk.index !== expected.index ||
    chunk.table !== expected.table
  )
    throw new Error('LARGE_BACKUP_CHUNK_MISMATCH');
  if (chunk.table === 'coldHistoryFiles' && chunk.rows.length > 1)
    throw new Error('BACKUP_COLD_FILES_CHUNK_BOUND_REQUIRED');
  assertNoSecrets(chunk);
  const actual = await descriptor(chunk);
  if (
    actual.count !== expected.count ||
    actual.bytes !== expected.bytes ||
    actual.digest !== expected.digest
  )
    throw new Error('BACKUP_CHECKSUM_MISMATCH');
  return chunk.rows.map(row => {
    const decoded = decodeRow(row);
    assertNoSecrets(decoded);
    return decoded;
  });
}
export function referencesFor(value: any, validator: any): { id: string; table: string }[] {
  if (validator.type === 'id')
    return typeof value === 'string' ? [{ id: value, table: validator.tableName }] : [];
  if (validator.type === 'array')
    return (value as any[]).flatMap((v) => referencesFor(v, validator.value));
  if (validator.type === 'union') {
    for (const member of validator.value) {
      try {
        validateFields(value, member);
        return referencesFor(value, member);
      } catch {
        /* Try the declared next branch. */
      }
    }
    return [];
  }
  if (validator.type === 'object')
    return Object.entries<any>(validator.value).flatMap(([key, entry]) =>
      value?.[key] === undefined ? [] : referencesFor(value[key], entry.fieldType),
    );
  return [];
}
export function validateSourceRow(table: string, row: BackupRow) {
  if (table === 'travelPrivacyTombstones') validatePrivacyBackupRow(row);
  if (table === 'coldHistoryFiles') return [{id:row.owner.worldId,table:'worlds'},{id:row.owner.memoryId,table:'memories'}];
  if (typeof row._id !== 'string' || !row._id || !Number.isFinite(row._creationTime))
    throw new Error('INVALID_BACKUP_DOCUMENT_ID');
  if (table === 'modelMemoryVectors') {
    const fields = vectorFields(row);
    validateFields(stripSystem(fields), (schema.tables.modelMemoryVectors.validator as unknown as { json: unknown }).json);
    return [{ id: row.memoryId, table: 'memories' }];
  }
  let fields = stripSystem(row);
  if (table === 'federationIdentity') fields = { ...fields, privateKeyEncrypted: '' };
  if (table === 'federationPeers') fields = { ...fields, credentialEncrypted: '' };
  if (table === 'visitLedger') fields = { ...fields, fencingToken: '' };
  const definition = schema.tables[table as keyof typeof schema.tables];
  if (!definition) throw new Error('INVALID_BACKUP_SECTION');
  const validator = (definition.validator as unknown as { json: unknown }).json;
  validateFields(fields, validator);
  if (table === 'federationIdentity' || table === 'federationPeers') {
    validateEndpointRecord(fields as never);
  }
  if (table === 'federationIdentity' && fields.identityVersion !== undefined &&
    (!Number.isSafeInteger(fields.identityVersion) || fields.identityVersion < 1))
    throw new Error('INVALID_IDENTITY_VERSION');
  if (table === 'federationResourcePolicy') validateResourcePolicy(fields);
  validateModelPolicyPortable(table, fields);
  validateResidentPolicyPortable(table, fields);
  validateDisclosurePolicyPortable(table, fields);
  if (table === 'federationIdentity' && fields.timePolicy !== undefined)
    validateTimePolicy(fields.timePolicy, fields.maxVisitDurationMs);
  if (table === 'visitLedger' && fields.leaseSafetyMs !== undefined &&
    (!Number.isSafeInteger(fields.leaseSafetyMs) || fields.leaseSafetyMs < 60_000 || fields.leaseSafetyMs > 1_260_000))
    throw new Error('INVALID_RESTORED_LEASE_MARGIN');
  if (table === 'federationIdentity' && fields.resourceLimits !== undefined)
    validateResourceLimits(fields.resourceLimits);
  // Runtime snapshots intentionally contain source IDs, never executable target references.
  return (snapshotTables as readonly string[]).includes(table)
    ? []
    : [...memoryBackupReferences(table, fields), ...referencesFor(
        table === 'embeddingSpaces'
          ? { ...fields, coverageJobId: undefined, validationJobId: undefined }
          : table === 'memories'
          ? { ...fields, embeddingId: undefined, embeddingSpaceId: undefined }
          : fields,
        validator,
      )];
}

/** Only metadata required for cross-chunk preflight; payloads remain in private storage. */
export function rowMetadata(table: string, row: BackupRow): BackupRow {
  if (table === 'travelPrivacyTombstones') return stripSystem(row);
  if (isMemoryBackupTable(table)) return { ...stripSystem(row), _creationTime: row._creationTime };
  if (table === 'coldHistoryFiles') return {owner:row.owner,kind:row.file.manifest.kind,digest:row.file.manifest.digest,
    ...(row.file.version === 2 ? { manifest: row.file.manifest, descriptor: row.file.descriptor,
      publicKey: row.file.publicKey, signature: row.file.signature,
      sourcePageNumber: row.file.payload.sourcePageNumber,
      aliases: row.authorAliases, messageIds: row.file.payload.messages.map((m: BackupRow) => m.messageId),
      messageAuthors: row.file.payload.messages.map((m: BackupRow) => m.authorGlobalId ?? m.authorPlayerId) } : {})};
  const keys = [
    'worldId',
    'id',
    'playerId',
    'agentId',
    'agentGlobalId',
    'homeTownId',
    'chatProfileId',
    'profileId',
    'fingerprint',
    'activeEmbeddingSpaceId',
    'mainChatProfileId',
    'engineId',
    'visitId',
    'leaseExpiry',
    'leaseSafetyMs',
    'homePlayerId',
    'role',
    'policyId',
    'data',
    'conversationId',
    'transcriptId',
    'messageUuid',
    'pageNumber',
    'finalPage',
    'finalPageNumber',
  ];
  const metadata: BackupRow = {};
  for (const key of keys) if (row[key] !== undefined) metadata[key] = row[key];
  if (redactedFact(table, row)) {
    if (table === 'federationEventFacts') metadata.payload = row.payload;
    else Object.assign(metadata, { action: row.action, result: row.result, receiptPayload: row.receiptPayload });
  }
  if (table === 'memories' && row.data.type === 'travel') {
    // Cross-chunk ownership/range checks need identifiers, not transcript prose.
    // Content integrity is carried by the separately computed content digest.
    const { messageText: _messageText, ...data } = row.data;
    metadata.data = data;
  }
  if (table === 'homeTravelTranscriptPages') metadata.messageCount = row.messages.length;
  if (table === 'worlds')
    metadata.agents = row.agents.map((a: BackupRow) => ({ id: a.id, playerId: a.playerId }));
  return metadata;
}
export function relationKey(table: string, row: BackupRow): string | undefined {
  if (table === 'travelPrivacyTombstones') return row.key;
  if (table === 'memorySummaryProvenance') return row.summaryMemoryId;
  if (table === 'memorySourceClaims') return JSON.stringify([row.worldId, row.playerId, row.sourceKey, row.generation]);
  if (table === 'federationResidentPolicy' || table === 'federationDisclosurePolicy') return row.agentGlobalId;
  if (table === 'modelProviderQuotas') return JSON.stringify([row.kind, row.providerKey]);
  if (table === 'messages') return JSON.stringify([row.worldId, row.conversationId, row.messageUuid]);
  if (table === 'archivedConversations') return JSON.stringify([row.worldId, row.id]);
  if (table === 'homeTravelTranscripts') return JSON.stringify([row.agentGlobalId, row.transcriptId]);
  if (table === 'homeTravelTranscriptPages') return JSON.stringify([row.agentGlobalId, row.transcriptId, row.pageNumber]);
  if (table === 'autonomousTravelPolicies') return row.agentGlobalId;
  if (table === 'visitLedger') return `visit:${row.visitId}`;
  if (['maps', 'worldStatus'].includes(table)) return row.worldId;
  if (['residentModelBindings', 'federationAgentRuntimes'].includes(table))
    return `${row.worldId}:${row.playerId}`;
  return undefined;
}

/** Record every proposed lease in nested runtime envelopes, without retaining executable queues. */
export function leaseEvidence(value: any): Map<string, number> {
  const leases = new Map<string, number>();
  const inspect = (item: any, visitId?: string): void => {
    if (!item || typeof item !== 'object' || item instanceof ArrayBuffer) return;
    if (Array.isArray(item)) {
      item.forEach((child) => inspect(child, visitId));
      return;
    }
    const matched = typeof item.visitId === 'string' ? item.visitId : visitId;
    if (matched && item.leaseExpiry !== undefined) {
      if (!Number.isFinite(item.leaseExpiry)) throw new Error('INVALID_RESTORED_LEASE');
      leases.set(matched, Math.max(leases.get(matched) ?? 0, item.leaseExpiry));
    }
    Object.values(item).forEach((child) => inspect(child, matched));
  };
  inspect(value);
  return leases;
}

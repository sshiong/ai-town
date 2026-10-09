import {
  BackupRow,
  assertNoSecrets,
  dataTables,
  decodeRow,
  snapshotTables,
  stripSystem,
  validateFields,
} from './backupHelpers';
import { digest, verifySignature } from './security';
import schema from '../schema';

// Derived vectors are deliberately omitted: canonical memories are the complete rebuilding source.
export const largeTables = [
  ...dataTables.filter((t) => !['modelMemoryVectors', 'storagePolicies', 'federationActionFacts', 'federationEventFacts', 'homeTravelTranscripts', 'homeTravelTranscriptPages'].includes(t)),
  ...snapshotTables.filter((t) => t !== 'federationTranscriptJobs'),
  'federationIdentity',
  'federationPeers',
  'storagePolicies',
  'federationActionFacts',
  'federationEventFacts',
  'homeTravelTranscripts',
  'homeTravelTranscriptPages',
  'federationTranscriptJobs',
] as const;
export const oldTables = [
  ...largeTables.filter((t) => t !== 'federationIdentity'),
  'modelMemoryVectors',
  'memoryEmbeddings',
  'embeddingsCache',
  'pairRequests',
  'federationReplayNonces',
  'storageUsageScans',
  'storageUsageSnapshots',
  'storageCleanupJobs',
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
  includeVectors: false;
  chunks: ChunkDescriptor[];
};
export function sanitizeLargeValue(value: any): any {
  if (value instanceof ArrayBuffer || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitizeLargeValue);
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
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
    manifest.includeVectors !== false ||
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
    const tableIndex = (largeTables as readonly string[]).indexOf(entry.table);
    if (tableIndex < previousTable) throw new Error('LARGE_BACKUP_TABLE_ORDER');
    previousTable = tableIndex;
    tables.add(entry.table);
    bytes += entry.bytes;
  }
  if (bytes > MAX_ARCHIVE_BYTES) throw new Error('LARGE_BACKUP_ARCHIVE_BUDGET');
  if (largeTables.some((table) => !['homeTravelTranscripts', 'homeTravelTranscriptPages', 'federationTranscriptJobs'].includes(table) && !tables.has(table)))
    throw new Error('INCOMPLETE_LARGE_BACKUP_MANIFEST');
  validateSourceRow('federationIdentity', manifest.source);
  if (manifest.source.fingerprint !== `sha256:${await digest(manifest.source.publicKey)}`)
    throw new Error('BACKUP_IDENTITY_MISMATCH');
  if (
    manifest.chunks
      .filter((c) => c.table === 'federationIdentity')
      .reduce((n, c) => n + c.count, 0) !== 1 ||
    manifest.chunks.filter((c) => c.table === 'modelSettings').reduce((n, c) => n + c.count, 0) > 1
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
  assertNoSecrets(chunk);
  const actual = await descriptor(chunk);
  if (
    actual.count !== expected.count ||
    actual.bytes !== expected.bytes ||
    actual.digest !== expected.digest
  )
    throw new Error('BACKUP_CHECKSUM_MISMATCH');
  return chunk.rows.map(decodeRow);
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
  if (typeof row._id !== 'string' || !row._id || !Number.isFinite(row._creationTime))
    throw new Error('INVALID_BACKUP_DOCUMENT_ID');
  let fields = stripSystem(row);
  if (table === 'federationIdentity') fields = { ...fields, privateKeyEncrypted: '' };
  if (table === 'federationPeers') fields = { ...fields, credentialEncrypted: '' };
  if (table === 'visitLedger') fields = { ...fields, fencingToken: '' };
  const definition = schema.tables[table as keyof typeof schema.tables];
  if (!definition) throw new Error('INVALID_BACKUP_SECTION');
  const validator = (definition.validator as unknown as { json: unknown }).json;
  validateFields(fields, validator);
  // Runtime snapshots intentionally contain source IDs, never executable target references.
  return (snapshotTables as readonly string[]).includes(table)
    ? []
    : referencesFor(
        table === 'memories'
          ? { ...fields, embeddingId: undefined, embeddingSpaceId: undefined }
          : fields,
        validator,
      );
}

/** Only metadata required for cross-chunk preflight; payloads remain in private storage. */
export function rowMetadata(table: string, row: BackupRow): BackupRow {
  const keys = [
    'worldId',
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
    'homePlayerId',
    'role',
  ];
  const metadata: BackupRow = {};
  for (const key of keys) if (row[key] !== undefined) metadata[key] = row[key];
  if (table === 'worlds')
    metadata.agents = row.agents.map((a: BackupRow) => ({ id: a.id, playerId: a.playerId }));
  return metadata;
}
export function relationKey(table: string, row: BackupRow): string | undefined {
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

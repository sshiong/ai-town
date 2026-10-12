import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const archiveUploadProducer = v.union(
  v.literal('ORDINARY_BUNDLE'), v.literal('LARGE_MANIFEST'), v.literal('LARGE_CHUNK'),
  v.literal('SELECTIVE_MANIFEST'), v.literal('SELECTIVE_CHUNK'), v.literal('COLD_ATTACHMENT'),
  v.literal('ORDINARY_PRIVACY_REPLACEMENT'), v.literal('CHUNK_PRIVACY_REPLACEMENT'), v.literal('CHUNK_PRIVACY_MANIFEST'),
);
/** Byte-level ownership journal. Payloads, vectors, credentials and signed source bodies never belong here. */
export const archiveUploadTables = {
  archiveUploadOperations: defineTable({
    producerKind: archiveUploadProducer, ownerKey: v.string(), operationKey: v.string(),
    state: v.union(v.literal('RESERVED'), v.literal('UPLOADING'), v.literal('UPLOADED'), v.literal('PUBLISHED'), v.literal('RETIRED'), v.literal('CLEANED')),
    revision: v.number(), contentType: v.string(), sha256Hex: v.string(), size: v.number(),
    uploadAcknowledged: v.boolean(), publishedStorageId: v.optional(v.id('_storage')),
    publication: v.optional(v.object({ table: v.string(), rowId: v.string(), field: v.string() })),
    reasonCode: v.optional(v.string()), producerTerminalAt: v.optional(v.number()),
    recoveryRevision: v.number(), recoveryCursor: v.union(v.string(), v.null()), recoveryCutoff: v.optional(v.number()),
    recoveryCompleteCutoff: v.optional(v.number()), recoveryConflict: v.boolean(), recoveryPasses: v.number(),
    createdAt: v.number(), updatedAt: v.number(), retiredAt: v.optional(v.number()), cleanedAt: v.optional(v.number()),
  }).index('operation', ['producerKind', 'ownerKey', 'operationKey']).index('state', ['state'])
    .index('publishedStorage', ['publishedStorageId']),
  archiveUploadCandidates: defineTable({
    operationId: v.id('archiveUploadOperations'), storageId: v.id('_storage'),
    state: v.union(v.literal('STORED'), v.literal('PUBLISHED'), v.literal('DELETED')),
    discoveredBy: v.union(v.literal('ACKNOWLEDGED_UPLOAD'), v.literal('METADATA_RECOVERY')),
    createdAt: v.number(), deletedAt: v.optional(v.number()),
  }).index('operation', ['operationId']).index('operation_storage', ['operationId', 'storageId'])
    .index('storage', ['storageId']),
};

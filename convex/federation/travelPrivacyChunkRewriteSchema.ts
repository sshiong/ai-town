import { defineTable } from 'convex/server';
import { v } from 'convex/values';

const descriptor = v.object({
  index: v.number(),
  table: v.string(),
  count: v.number(),
  bytes: v.number(),
  digest: v.string(),
});
export const travelPrivacyChunkRewriteTables = {
  travelPrivacyChunkRewrites: defineTable({
    scanId: v.id('travelPrivacyChunkScans'),
    privacyJobId: v.id('travelPrivacyJobs'),
    expectedParentRevision: v.number(),
    key: v.optional(v.string()),
    revision: v.number(),
    sourceRevision: v.number(),
    phase: v.union(
      v.literal('PREPARING'),
      v.literal('IMPORT_FENCE'),
      v.literal('ROWS'),
      v.literal('OBJECTS'),
      v.literal('MANIFESTS'),
      v.literal('DELETE'),
      v.literal('DONE'),
    ),
    cursor: v.union(v.string(), v.null()),
    errorCode: v.optional(v.string()),
    objects: v.number(),
    published: v.number(),
    deleted: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    finishedAt: v.optional(v.number()),
  })
    .index('key', ['key'])
    .index('scan', ['scanId']),
  travelPrivacyChunkReplacements: defineTable({
    rewriteId: v.id('travelPrivacyChunkRewrites'),
    planObjectId: v.id('travelPrivacyChunkObjects'),
    originalStorageId: v.id('_storage'),
    originalDescriptor: descriptor,
    state: v.union(
      v.literal('PLANNING'),
      v.literal('PREPARED'),
      v.literal('UPLOADED'),
      v.literal('VERIFIED'),
      v.literal('PUBLISHED'),
      v.literal('DELETED'),
    ),
    selectedIndices: v.array(v.number()),
    expectedSelectedRows: v.number(),
    planCursor: v.union(v.string(), v.null()),
    aliasIndex: v.number(),
    rowOffset: v.number(),
    retainedRows: v.number(),
    operationId: v.optional(v.id('archiveUploadOperations')),
    operationRevision: v.optional(v.number()),
    replacementStorageId: v.optional(v.id('_storage')),
    replacementDescriptor: v.optional(descriptor),
    rowIndices: v.optional(v.array(v.number())),
    aliases: v.array(
      v.object({
        chunkId: v.id('backupLargeChunks'),
        planObjectId: v.id('travelPrivacyChunkObjects'),
        jobId: v.id('backupLargeJobs'),
        role: v.union(v.literal('SOURCE'), v.literal('OLD'), v.literal('EXPORT')),
        descriptor,
        published: v.boolean(),
      }),
    ),
    deletedAt: v.optional(v.number()),
  })
    .index('rewrite_state', ['rewriteId', 'state'])
    .index('rewrite_storage', ['rewriteId', 'originalStorageId']),
  travelPrivacyChunkManifestRewrites: defineTable({
    rewriteId: v.id('travelPrivacyChunkRewrites'),
    backupJobId: v.id('backupLargeJobs'),
    expectedProducerDigest: v.string(),
    producerRevision: v.number(),
    state: v.union(
      v.literal('PLANNED'),
      v.literal('BUILDING'),
      v.literal('UPLOADED'),
      v.literal('PUBLISHED'),
      v.literal('COMPLETE'),
    ),
    cursor: v.union(v.string(), v.null()),
    chunks: v.optional(
      v.array(
        v.object({
          index: v.number(),
          table: v.string(),
          count: v.number(),
          bytes: v.number(),
          digest: v.string(),
          role: v.union(v.literal('SOURCE'), v.literal('OLD'), v.literal('EXPORT')),
          encoding: v.union(v.literal('RAW'), v.literal('SELECTIVE')),
        }),
      ),
    ),
    operationId: v.optional(v.id('archiveUploadOperations')),
    operationRevision: v.optional(v.number()),
    manifestStorageId: v.optional(v.id('_storage')),
    manifestDigest: v.optional(v.string()),
    sourceManifestStorageId: v.optional(v.id('_storage')),
    sourceManifestDigest: v.optional(v.string()),
    sourceSignature: v.string(),
    sourcePublicKey: v.string(),
    clearedVisits: v.array(v.string()),
    localProof: v.optional(v.any()),
  })
    .index('rewrite_job', ['rewriteId', 'backupJobId'])
    .index('rewrite_state', ['rewriteId', 'state']),
};

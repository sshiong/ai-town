import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const chunkRole = v.union(v.literal('SOURCE'), v.literal('OLD'), v.literal('EXPORT'));
export const chunkEvidence = v.object({
  sourceId: v.string(), table: v.string(), rowIndex: v.number(),
  worldId: v.optional(v.string()), playerId: v.optional(v.string()), ownerGlobalId: v.optional(v.string()),
  visitId: v.optional(v.string()), conversationId: v.optional(v.string()), conversationPlayerIds: v.optional(v.array(v.string())), transcriptId: v.optional(v.string()),
  relation: v.optional(v.string()), memoryId: v.optional(v.string()), memoryType: v.optional(v.string()),
  relatedMemoryIds: v.array(v.string()), evidenceMemoryIds: v.array(v.string()),
  inputId: v.optional(v.string()), parentArchiveId: v.optional(v.string()), storageIds: v.array(v.string()),
  blocker: v.optional(v.string()),
});

/** These are inspection journals. READY_TO_REWRITE never means privacy cleanup is complete. */
export const travelPrivacyChunkTables = {
  travelPrivacyChunkScans: defineTable({
    jobId: v.id('travelPrivacyJobs'), privacyRevision: v.number(), version: v.literal(1), revision: v.number(),
    phase: v.union(v.literal('OBJECTS'), v.literal('SEED'), v.literal('CLOSURE'), v.literal('VALIDATE'), v.literal('CHECK'),
      v.literal('READY_TO_REWRITE'), v.literal('BLOCKED')),
    cursor: v.union(v.string(), v.null()), cutoff: v.number(), cutoffId: v.optional(v.id('backupLargeChunks')), changedInPass: v.boolean(),
    objects: v.number(), rows: v.number(), selectedRows: v.number(), blockers: v.number(),
    blockerCodes: v.array(v.string()), sourceRevision: v.number(),
    createdAt: v.number(), updatedAt: v.number(),
  }).index('job', ['jobId']),
  travelPrivacyChunkObjects: defineTable({
    scanId: v.id('travelPrivacyChunkScans'), backupJobId: v.id('backupLargeJobs'), chunkId: v.id('backupLargeChunks'),
    role: chunkRole, originalStorageId: v.id('_storage'), originalDigest: v.string(), descriptor: v.object({
      index: v.number(), table: v.string(), count: v.number(), bytes: v.number(), digest: v.string(),
    }), backupDigest: v.string(), sourceManifestDigest: v.optional(v.string()), sourceManifestStorageId: v.optional(v.id('_storage')),
    sourcePublicKey: v.optional(v.string()), sourceSignature: v.optional(v.string()),
    state: v.union(v.literal('INDEXING'), v.literal('VERIFIED'), v.literal('INVALID'), v.literal('CHECKED')),
    rowOffset: v.number(), selectedRows: v.number(), selectionDigest: v.string(),
    nextCursor: v.union(v.string(), v.null()), scanDone: v.boolean(),
    referenceCursor: v.union(v.string(), v.null()),
    blockers: v.array(v.string()),
    aliases: v.array(v.object({ table: v.string(), id: v.string() })),
  }).index('scan', ['scanId']).index('scan_state', ['scanId', 'state'])
    .index('scan_chunk', ['scanId', 'chunkId']).index('scan_storage', ['scanId', 'originalStorageId']),
  travelPrivacyChunkRows: defineTable({
    scanId: v.id('travelPrivacyChunkScans'), objectId: v.id('travelPrivacyChunkObjects'),
    backupJobId: v.id('backupLargeJobs'), role: chunkRole, evidence: chunkEvidence,
    selected: v.boolean(), selection: v.optional(v.string()), blocker: v.optional(v.string()), ownerDigest: v.optional(v.string()),
  }).index('scan', ['scanId']).index('object', ['objectId'])
    .index('source', ['scanId', 'backupJobId', 'role', 'evidence.sourceId', 'evidence.table'])
    .index('relation', ['scanId', 'backupJobId', 'role', 'evidence.table', 'evidence.relation'])
    .index('owner', ['scanId', 'backupJobId', 'role', 'evidence.table', 'evidence.ownerGlobalId'])
    .index('selected', ['scanId', 'selected']).index('backup_selected', ['scanId', 'backupJobId', 'role', 'selected']),
};

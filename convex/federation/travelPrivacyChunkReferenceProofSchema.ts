import { defineTable } from 'convex/server';
import { v } from 'convex/values';
const proofId = v.id('travelPrivacyChunkReferenceProofs');
const cursor = v.union(v.string(), v.null());
export const travelPrivacyChunkReferenceProofTables = {
  travelPrivacyChunkReferenceProofs: defineTable({
    rewriteId: v.id('travelPrivacyChunkRewrites'), rewriteRevision: v.number(), referenceRevision: v.number(),
    purpose: v.optional(v.union(v.literal('DELETE'), v.literal('PREPARING'))),
    writerPhase: v.optional(v.union(v.literal('PREPARING'), v.literal('IMPORT_FENCE'), v.literal('ROWS'), v.literal('OBJECTS'), v.literal('MANIFESTS'))),
    phase: v.union(v.literal('TARGETS'), v.literal('ROWS'), v.literal('BLOBS'), v.literal('READY')),
    tableIndex: v.number(), cursor, leafOffset: v.number(), rows: v.number(), targets: v.number(), objects: v.number(), bytes: v.number(),
  }).index('rewrite', ['rewriteId']),
  travelPrivacyChunkReferenceTargets: defineTable({ proofId, storageId: v.id('_storage'),
    planObjectId: v.optional(v.id('travelPrivacyChunkObjects')), selectedIndices: v.optional(v.array(v.number())), selective: v.optional(v.boolean()),
  })
    .index('target', ['proofId', 'storageId']),
  travelPrivacyChunkReferenceObjects: defineTable({
    proofId, storageId: v.id('_storage'), sha256: v.string(), size: v.number(),
    state: v.union(v.literal('PENDING'), v.literal('VERIFIED')), leafOffset: v.number(),
  }).index('object', ['proofId', 'storageId']).index('pending', ['proofId', 'state']),
  travelPrivacyChunkReferenceEdges: defineTable({
    proofId, targetStorageId: v.id('_storage'), sourceTable: v.string(), sourceId: v.string(),
    kind: v.union(v.literal('STRONG'), v.literal('HISTORICAL'), v.literal('UNKNOWN')),
  }).index('target_kind', ['proofId', 'targetStorageId', 'kind']).index('proof_kind', ['proofId', 'kind']),
  travelPrivacyChunkReferenceRetirements: defineTable({
    proofId, operationId: v.id('archiveUploadOperations'), storageId: v.id('_storage'),
  }).index('operation', ['proofId', 'operationId', 'storageId']),
};

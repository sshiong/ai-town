import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { playerId } from '../aiTown/ids';

export const memorySource = v.object({
  memoryId: v.id('memories'), sourceKey: v.string(), digest: v.string(),
  correctionId: v.optional(v.id('memorySourceCorrections')),
});
const owner = { worldId: v.id('worlds'), playerId, agentGlobalId: v.optional(v.string()) };
export const memoryCompressionTables = {
  memoryCompressionJobs: defineTable({
    ...owner, kind: v.union(v.literal('BATCH'), v.literal('REFLECTION')),
    state: v.union(v.literal('CAPTURING'), v.literal('READY'), v.literal('RUNNING'), v.literal('DONE'), v.literal('FAILED'), v.literal('CANCELLED')),
    snapshotAt: v.number(), cursor: v.union(v.string(), v.null()), scanDone: v.boolean(),
    sources: v.array(memorySource), revision: v.number(), attempts: v.number(),
    leaseUntil: v.optional(v.number()), nextAttemptAt: v.number(), errorCode: v.optional(v.string()),
    batchesCompleted: v.number(), sourcesCompleted: v.number(), createdAt: v.number(), updatedAt: v.number(),
  }).index('owner', ['worldId', 'playerId']).index('owner_state', ['worldId', 'playerId', 'state'])
    .index('owner_kind_state', ['worldId', 'playerId', 'kind', 'state']).index('state_retry', ['state', 'nextAttemptAt']),
  memorySourceClaims: defineTable({
    ...owner, sourceKey: v.string(), generation: v.string(), memoryId: v.id('memories'),
    digest: v.string(), jobId: v.id('memoryCompressionJobs'), state: v.union(v.literal('CLAIMED'), v.literal('DONE')),
    createdAt: v.number(),
  }).index('source_generation', ['worldId', 'playerId', 'sourceKey', 'generation']).index('job', ['jobId']).index('job_state', ['jobId', 'state']),
  memorySummaryProvenance: defineTable({
    ...owner, summaryMemoryId: v.id('memories'), jobId: v.id('memoryCompressionJobs'), sources: v.array(memorySource),
    subjective: v.literal(true), confidenceKind: v.literal('MODEL_ESTIMATE'), confidence: v.optional(v.number()),
    firstSourceAt: v.number(), lastSourceAt: v.number(), createdAt: v.number(),
  }).index('summary', ['summaryMemoryId']).index('owner', ['worldId', 'playerId']),
  memorySourceCorrections: defineTable({
    ...owner, sourceMemoryId: v.id('memories'), sourceKey: v.string(),
    previousCorrectionId: v.optional(v.id('memorySourceCorrections')), evidenceMemoryIds: v.array(v.id('memories')),
    correctionOrder: v.optional(v.number()),
    text: v.string(), operator: v.string(), verification: v.literal('ADMIN_REPORTED'), createdAt: v.number(),
  }).index('source', ['worldId', 'playerId', 'sourceKey']).index('owner', ['worldId', 'playerId'])
    .index('source_order', ['worldId', 'playerId', 'sourceKey', 'correctionOrder']),
};

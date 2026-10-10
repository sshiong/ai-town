import { defineTable } from 'convex/server';
import { v } from 'convex/values';
const usageGroups = v.array(
  v.object({
    category: v.union(
      v.literal('canonicalMemory'),
      v.literal('history'),
      v.literal('vectors'),
      v.literal('cache'),
      v.literal('operational'),
    ),
    records: v.number(),
    bytes: v.number(),
  }),
);
export const storagePolicyFields = {
  hotMemoryBytes: v.number(),
  historyBytes: v.number(),
  vectorBytes: v.number(),
  cacheBytes: v.number(),
  operationalBytes: v.number(),
  warningRatio: v.number(),
  messageRetentionMs: v.number(),
  runtimeRetentionMs: v.number(),
  cacheRetentionMs: v.number(),
  pauseNonessentialOnLimit: v.boolean(),
  coldArchiveLocation: v.optional(v.string()),
  backupIntervalHours: v.number(),
  vectorRebuildBatchSize: v.number(),
};
export const storagePolicyTables = {
  coldHistoryArchives: defineTable({
    sourceKey: v.string(), worldId: v.id('worlds'), kind: v.union(v.literal('conversation'), v.literal('travel')),
    sourceId: v.string(), ownerGlobalId: v.optional(v.string()),
    state: v.union(v.literal('PENDING'), v.literal('VERIFIED')),
    manifest: v.any(), signature: v.string(), publicKey: v.string(),
    storageId: v.optional(v.id('_storage')), verifiedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index('source', ['sourceKey']),

  storagePolicies: defineTable({
    key: v.string(),
    ...storagePolicyFields,
    updatedAt: v.number(),
    lastVerifiedBackupAt: v.optional(v.number()),
  }).index('key', ['key']),
  storageUsageScans: defineTable({
    key: v.string(),
    state: v.string(),
    tableIndex: v.number(),
    revision: v.optional(v.number()),
    cursor: v.union(v.string(), v.null()),
    groups: usageGroups,
    startedAt: v.number(),
    updatedAt: v.number(),
    error: v.optional(v.string()),
  }).index('key', ['key']),
  storageUsageSnapshots: defineTable({
    key: v.string(),
    groups: usageGroups,
    measuredAt: v.number(),
    scanStartedAt: v.number(),
  }).index('key', ['key']),
  storageCleanupJobs: defineTable({
    key: v.string(),
    state: v.string(),
    tableIndex: v.number(),
    revision: v.optional(v.number()),
    cursor: v.union(v.string(), v.null()),
    deletedRows: v.number(),
    compactedActions: v.number(),
    compactedEvents: v.number(),
    startedAt: v.number(),
    updatedAt: v.number(),
    finishedAt: v.optional(v.number()),
  }).index('key', ['key']),
  federationActionFacts: defineTable({
    actionId: v.string(),
    visitId: v.string(),
    turnId: v.string(),
    basedOnEventId: v.string(),
    agentAuthorityEpoch: v.number(),
    visitLeaseVersion: v.number(),
    action: v.any(),
    result: v.any(),
    receiptPayload: v.optional(v.any()),
    occurredAt: v.number(),
  })
    .index('action', ['actionId'])
    .index('visit', ['visitId']),
  federationEventFacts: defineTable({
    messageId: v.string(),
    visitId: v.string(),
    fromTownId: v.string(),
    type: v.string(),
    payload: v.any(),
    receivedAt: v.number(),
  })
    .index('messageId', ['messageId'])
    .index('visit', ['visitId']),
};

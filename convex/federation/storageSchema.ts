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
    metadataBytes: v.optional(v.number()),
    payloadBytes: v.optional(v.number()),
  }),
);
const storageObjects = v.object({
  objects: v.number(), bytes: v.number(),
  publishedColdObjects: v.number(), publishedColdBytes: v.number(),
  otherOrUnpublishedObjects: v.number(), otherOrUnpublishedBytes: v.number(),
  classificationLimitedObjects: v.number(),
});
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
  travelPrivacyTombstones: defineTable({
    key: v.string(), visitId: v.string(), createdAt: v.number(),
    worldId: v.optional(v.id('worlds')), ownerGlobalId: v.optional(v.string()), playerId: v.optional(v.string()), playerIds: v.optional(v.array(v.string())),
  }).index('key', ['key']).index('world', ['worldId']).index('world_key', ['worldId', 'key']),
  travelPrivacyJobs: defineTable({
    visitId: v.string(), scope: v.union(v.literal('CACHE'), v.literal('SENSITIVE')),
    state: v.string(), phase: v.string(), tableIndex: v.number(), cursor: v.union(v.string(), v.null()),
    revision: v.number(), sourceRevision: v.number(), privacyRevision: v.number(), changed: v.boolean(),
    worldId: v.optional(v.id('worlds')), role: v.string(), ownerGlobalId: v.string(),
    history: v.optional(v.object({ importId: v.id('backupImports'), worldId: v.id('worlds'), ownerGlobalId: v.string() })),
    conversationIds: v.array(v.string()), conversationOwners: v.array(v.object({ conversationId: v.string(), playerIds: v.array(v.string()) })), transcriptIds: v.array(v.string()),
    memoryIds: v.array(v.id('memories')), memoryOwners: v.array(v.object({ memoryId: v.id('memories'), worldId: v.optional(v.id('worlds')), playerId: v.string(), ownerGlobalId: v.optional(v.string()) })), archiveIds: v.array(v.id('coldHistoryArchives')),
    textHashes: v.array(v.string()), blockers: v.array(v.string()), externalCopies: v.number(),
    counts: v.any(), processedRows: v.number(), createdAt: v.number(), updatedAt: v.number(),
    finishedAt: v.optional(v.number()),
  }).index('visit', ['visitId']).index('state', ['state']).index('scope_state', ['scope', 'state']),
  coldHistoryArchives: defineTable({
    sourceKey: v.string(),
    lookupKey: v.optional(v.string()),
    worldId: v.id('worlds'),
    kind: v.union(v.literal('conversation'), v.literal('travel')),
    sourceId: v.string(),
    ownerGlobalId: v.optional(v.string()),
    state: v.union(v.literal('PENDING'), v.literal('VERIFIED')),
    manifest: v.any(),
    signature: v.string(),
    publicKey: v.string(),
    storageId: v.optional(v.id('_storage')),
    jobId: v.optional(v.id('coldHistoryJobs')),
    verifiedAt: v.optional(v.number()),
    createdAt: v.number(),
    importedAt: v.optional(v.number()),
    authorAliases: v.optional(
      v.array(v.object({ sourceAuthor: v.string(), targetAuthor: v.string() })),
    ),
  })
    .index('source', ['sourceKey'])
    .index('lookup', ['lookupKey'])
    .index('storage', ['storageId']),

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
    objects: v.optional(storageObjects),
    measurementVersion: v.optional(v.number()),
    storageCreationCutoff: v.optional(v.number()),
    startedAt: v.number(),
    updatedAt: v.number(),
    error: v.optional(v.string()),
  }).index('key', ['key']),
  storageUsageSnapshots: defineTable({
    key: v.string(),
    groups: usageGroups,
    objects: v.optional(storageObjects),
    measurementVersion: v.optional(v.number()),
    storageCreationCutoff: v.optional(v.number()),
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

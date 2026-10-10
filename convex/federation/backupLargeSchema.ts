import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const backupLargeTables = {
  backupMaintenanceLocks: defineTable({
    key: v.string(),
    jobId: v.id('backupLargeJobs'),
    createdAt: v.number(),
  }).index('key', ['key']),
  backupLargeJobs: defineTable({
    kind: v.union(v.literal('export'), v.literal('import')),
    state: v.string(),
    phase: v.string(),
    resumeState: v.optional(v.string()),
    tableIndex: v.number(),
    cursor: v.union(v.string(), v.null()),
    chunkCount: v.number(),
    processedChunks: v.number(),
    recordCount: v.number(),
    bytes: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    error: v.optional(v.string()),
    manifestStorageId: v.optional(v.id('_storage')),
    signature: v.optional(v.string()),
    source: v.any(),
    mode: v.optional(v.string()),
    targetEndpoint: v.optional(v.string()),
    sourceStoppedAt: v.optional(v.number()),
    newTownId: v.optional(v.string()),
    keys: v.optional(v.any()),
    metadata: v.optional(v.any()),
  }),
  backupLargeChunks: defineTable({
    jobId: v.id('backupLargeJobs'),
    index: v.number(),
    table: v.string(),
    count: v.number(),
    bytes: v.number(),
    digest: v.string(),
    storageId: v.id('_storage'),
  }).index('job_index', ['jobId', 'index']),
  backupLargeRows: defineTable({
    jobId: v.id('backupLargeJobs'),
    role: v.union(v.literal('SOURCE'), v.literal('OLD')),
    table: v.string(),
    sourceId: v.string(),
    chunkIndex: v.number(),
    rowIndex: v.number(),
    relationKey: v.optional(v.string()),
    ownerGlobalId: v.optional(v.string()),
    newId: v.optional(v.string()),
    state: v.string(),
    references: v.array(v.object({ id: v.string(), table: v.string() })),
    metadata: v.any(),
  })
    .index('job_source', ['jobId', 'sourceId'])
    .index('job_state', ['jobId', 'state'])
    .index('job_new', ['jobId', 'role', 'newId'])
    .index('job_role_source', ['jobId', 'role', 'sourceId'])
    .index('job_relation', ['jobId', 'role', 'table', 'relationKey'])
    .index('job_owner', ['jobId', 'role', 'table', 'ownerGlobalId'])
    .index('job_role', ['jobId', 'role'])
    .index('job_table', ['jobId', 'role', 'table']),
  backupLargeVisitEvidence: defineTable({
    jobId: v.id('backupLargeJobs'),
    visitId: v.string(),
    leaseExpiry: v.number(),
  }).index('job_visit', ['jobId', 'visitId']),
  backupLargeGlobalMappings: defineTable({
    jobId: v.id('backupLargeJobs'),
    sourceId: v.string(),
    targetId: v.string(),
  }).index('job_source', ['jobId', 'sourceId']),
};

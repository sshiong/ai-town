import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const archiveScope = v.object({
  townId: v.string(),
  publicKey: v.string(),
  deploymentInstanceId: v.string(),
  deploymentEpoch: v.number(),
  identityVersion: v.number(),
});
export const coldArchiveTables = {
  coldArchiveDestinations: defineTable({
    name: v.string(),
    endpoint: v.string(),
    region: v.string(),
    bucket: v.string(),
    prefix: v.string(),
    enabled: v.boolean(),
    state: v.union(v.literal('UNVERIFIED'), v.literal('VERIFIED')),
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    verifiedAt: v.optional(v.number()),
    verifiedScope: v.optional(archiveScope),
    environmentBinding: v.optional(v.string()),
    operator: v.string(),
  }).index('name', ['name']),
  coldArchiveMirrorJobs: defineTable({
    destinationId: v.id('coldArchiveDestinations'),
    destinationRevision: v.number(),
    environmentBinding: v.string(),
    identityScope: archiveScope,
    archiveId: v.id('coldHistoryArchives'),
    archiveBinding: v.string(),
    runId: v.string(),
    keyScope: v.string(),
    root: v.any(),
    state: v.union(
      v.literal('RUNNING'),
      v.literal('FAILED'),
      v.literal('COMPLETE'),
      v.literal('CANCELLED'),
    ),
    revision: v.number(),
    nextIndex: v.number(),
    partCount: v.number(),
    verifiedBytes: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    error: v.optional(v.string()),
    operator: v.string(),
  })
    .index('destination', ['destinationId'])
    .index('archive', ['archiveId']),
  coldArchiveMirrorObjects: defineTable({
    jobId: v.id('coldArchiveMirrorJobs'),
    index: v.number(),
    key: v.string(),
    sha256: v.string(),
    bytes: v.number(),
    verifiedAt: v.number(),
  }).index('job_index', ['jobId', 'index']),
};

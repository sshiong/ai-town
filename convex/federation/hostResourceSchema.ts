import { defineTable } from 'convex/server';
import { v } from 'convex/values';

// Collector readings are ephemeral, deployment-bound and never portable in backups.
export const hostResourceTables = {
  federationHostResources: defineTable({
    townId: v.string(), deploymentInstanceId: v.string(), deploymentEpoch: v.number(),
    sampleStartedAt: v.number(), measuredAt: v.number(), receivedAt: v.number(),
    cpuPercent: v.number(), memoryUsedBytes: v.number(), memoryTotalBytes: v.number(),
    scope: v.literal('OS_HOST'),
  }),
};

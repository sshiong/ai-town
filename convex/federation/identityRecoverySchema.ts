import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const identityRecoveryTables = {
  identityRecoveryAudit: defineTable({
    operation: v.union(v.literal('EXPORT'), v.literal('RESTORE')),
    townId: v.string(),
    fingerprint: v.string(),
    sourceDeploymentEpoch: v.number(),
    deploymentInstanceId: v.string(),
    createdAt: v.number(),
  }),
};

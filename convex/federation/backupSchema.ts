import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const backupTables = {
  backupImports: defineTable({
    sourceTownId: v.string(),
    mode: v.string(),
    exportedAt: v.number(),
    importedAt: v.number(),
    sourceStoppedAt: v.optional(v.number()),
    mapping: v.any(),
    runtimeSnapshot: v.any(),
    manifest: v.any(),
  }),
  backupReconciliations: defineTable({
    importId: v.id('backupImports'),
    agentGlobalId: v.string(),
    worldId: v.id('worlds'),
    playerId: v.string(),
    visitId: v.string(),
    safeAfter: v.number(),
    reconciledAt: v.number(),
    sourceDeploymentInstanceId: v.string(),
    currentDeploymentInstanceId: v.string(),
  }).index('agent', ['agentGlobalId']),
};

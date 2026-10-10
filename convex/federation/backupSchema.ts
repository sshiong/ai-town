import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const backupTables = {
  backupExportAudits: defineTable({
    scope: v.union(v.literal('town'), v.literal('resident')),
    sourceTownId: v.string(),
    exportedAt: v.number(),
    recordedAt: v.number(),
    operator: v.string(),
    reason: v.string(),
    attribution: v.union(v.literal('declared'), v.literal('legacy-admin-token')),
    manifestDigest: v.string(),
    sectionCounts: v.record(v.string(), v.number()),
    bytes: v.number(),
    worldId: v.optional(v.id('worlds')),
    playerId: v.optional(v.string()),
  }).index('recorded', ['recordedAt']),
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

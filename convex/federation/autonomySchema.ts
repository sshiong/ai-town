import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { agentId, playerId } from '../aiTown/ids';

export const autonomyTables = {
  autonomousTravelPolicies: defineTable({
    agentGlobalId: v.string(),
    worldId: v.id('worlds'),
    playerId,
    enabled: v.boolean(),
    allowedPeerTownIds: v.array(v.string()),
    decisionIntervalMs: v.number(),
    dailyRequestLimit: v.number(),
    revision: v.number(),
    nextDecisionAt: v.number(),
    operator: v.string(),
    reason: v.string(),
    updatedAt: v.number(),
  })
    .index('resident', ['agentGlobalId'])
    .index('world', ['worldId']),
  autonomousTravelDecisions: defineTable({
    policyId: v.id('autonomousTravelPolicies'),
    policyRevision: v.number(),
    agentGlobalId: v.string(),
    worldId: v.id('worlds'),
    playerId,
    agentId,
    operationId: v.string(),
    state: v.string(),
    createdAt: v.number(),
    deadline: v.number(),
    completedAt: v.optional(v.number()),
    destinationTownId: v.optional(v.string()),
    visitId: v.optional(v.string()),
    reason: v.optional(v.string()),
    error: v.optional(v.string()),
  })
    .index('resident', ['agentGlobalId', 'createdAt'])
    .index('policy', ['policyId'])
    .index('state', ['state', 'createdAt'])
    .index('world', ['worldId']),
};

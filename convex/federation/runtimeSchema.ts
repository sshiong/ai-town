import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { playerId, agentId, conversationId } from '../aiTown/ids';

export const runtimeTables = {
  federationDecisionJobs: defineTable({
    visitId: v.string(),
    eventId: v.string(),
    observation: v.any(),
    state: v.string(),
    createdAt: v.number(),
    deadline: v.number(),
    error: v.optional(v.string()),
  })
    .index('event', ['eventId'])
    .index('state', ['state']),
  federationAgentRuntimes: defineTable({
    agentGlobalId: v.string(),
    homeTownId: v.string(),
    worldId: v.id('worlds'),
    playerId,
    agentId,
    state: v.string(),
    visitId: v.optional(v.string()),
    agentAuthorityEpoch: v.number(),
    updatedAt: v.number(),
    activeDecisionId: v.optional(v.string()),
    lastError: v.optional(v.string()),
  })
    .index('globalId', ['agentGlobalId'])
    .index('world', ['worldId', 'playerId'])
    .index('visit', ['visitId']),
  federationPresenceJobs: defineTable({
    visitId: v.string(),
    kind: v.string(),
    inputId: v.id('inputs'),
    state: v.string(),
    createdAt: v.number(),
    error: v.optional(v.string()),
  })
    .index('input', ['inputId'])
    .index('visit_kind', ['visitId', 'kind'])
    .index('state', ['state']),
  federationTurns: defineTable({
    visitId: v.string(),
    eventId: v.string(),
    turnId: v.string(),
    worldId: v.id('worlds'),
    playerId,
    conversationId: v.optional(conversationId),
    federationConversationId: v.optional(v.string()),
    deadline: v.number(),
    expectedNumMessages: v.optional(v.number()),
    state: v.string(),
  })
    .index('visit', ['visitId'])
    .index('turn', ['turnId']),
  federationPendingActions: defineTable({
    actionId: v.string(),
    visitId: v.string(),
    turnId: v.string(),
    basedOnEventId: v.string(),
    agentAuthorityEpoch: v.number(),
    visitLeaseVersion: v.number(),
    action: v.any(),
    inputId: v.id('inputs'),
    state: v.string(),
    createdAt: v.number(),
    result: v.optional(v.any()),
    receiptPending: v.optional(v.boolean()),
    receiptPayload: v.optional(v.any()),
    receiptRetryAt: v.optional(v.number()),
  })
    .index('input', ['inputId'])
    .index('action', ['actionId'])
    .index('state', ['state'])
    .index('receiptPending', ['receiptPending', 'receiptRetryAt', 'createdAt']),
};

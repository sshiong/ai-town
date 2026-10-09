import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const endpointTables = {
  federationEndpointUpdates: defineTable({
    updateId: v.string(),
    peerTownId: v.string(),
    direction: v.string(),
    senderDeploymentInstanceId: v.string(),
    senderDeploymentEpoch: v.number(),
    sequence: v.number(),
    previousEndpoint: v.string(),
    newEndpoint: v.string(),
    credentialId: v.string(),
    operator: v.string(),
    reason: v.string(),
    state: v.string(),
    createdAt: v.number(),
    attempts: v.number(),
    nextRetryAt: v.number(),
    lastError: v.optional(v.string()),
    packet: v.optional(v.any()),
    requestDigest: v.optional(v.string()),
    response: v.optional(v.any()),
  })
    .index('update', ['direction', 'peerTownId', 'updateId'])
    .index('sender_sequence', [
      'peerTownId',
      'direction',
      'senderDeploymentInstanceId',
      'senderDeploymentEpoch',
      'sequence',
    ])
    .index('retry', ['state', 'nextRetryAt']),
  federationEndpointAudit: defineTable({
    operation: v.string(),
    peerTownId: v.optional(v.string()),
    updateId: v.optional(v.string()),
    previousEndpoint: v.string(),
    newEndpoint: v.string(),
    sequence: v.number(),
    operator: v.string(),
    reason: v.string(),
    createdAt: v.number(),
    evidence: v.optional(v.any()),
  }),
};

import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const identityKeyRotationTables = {
  // Public audit evidence only. Restoring these rows must set verified=false;
  // archives cannot turn history into live trust or restore pending operations.
  federationIdentityKeyHistory: defineTable({
    rotationId: v.string(),
    townId: v.string(),
    oldVersion: v.number(),
    newVersion: v.number(),
    oldPublicKey: v.string(),
    newPublicKey: v.string(),
    kind: v.string(),
    role: v.string(),
    certificate: v.any(),
    activation: v.any(),
    verified: v.boolean(),
    acceptedAt: v.number(),
    operator: v.string(),
    reason: v.string(),
  })
    .index('town_version', ['townId', 'newVersion'])
    .index('rotation', ['townId', 'rotationId']),
  federationIdentityKeyRotations: defineTable({
    rotationId: v.string(),
    certificate: v.any(),
    activation: v.optional(v.any()),
    newPrivateEncrypted: v.optional(v.string()),
    state: v.string(),
    expiresAt: v.number(),
    operator: v.string(),
    reason: v.string(),
    createdAt: v.number(),
  })
    .index('rotation', ['rotationId'])
    .index('state_expiry', ['state', 'expiresAt']),
  federationIdentityKeyExchanges: defineTable({
    rotationId: v.string(),
    peerTownId: v.string(),
    direction: v.string(),
    state: v.string(),
    peerPublicKey: v.string(),
    peerIdentityVersion: v.number(),
    credentialId: v.string(),
    peerDeploymentInstanceId: v.string(),
    peerDeploymentEpoch: v.number(),
    localPublicKey: v.string(),
    certificate: v.any(),
    activation: v.optional(v.any()),
    packet: v.optional(v.any()),
    response: v.optional(v.any()),
    challenge: v.optional(v.any()),
    proof: v.optional(v.any()),
    expiresAt: v.number(),
    createdAt: v.number(),
    attempts: v.number(),
    nextRetryAt: v.number(),
    lastError: v.optional(v.string()),
  })
    .index('exchange', ['peerTownId', 'direction', 'rotationId'])
    .index('rotation_direction', ['rotationId', 'direction'])
    .index('state_retry', ['state', 'nextRetryAt']),
};

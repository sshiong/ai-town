import { defineTable } from 'convex/server';
import { v } from 'convex/values';

// Live authentication state: excluded from town backups and migration archives.
export const credentialRotationTables = {
  federationCredentialRotations: defineTable({
    rotationId: v.string(),
    peerTownId: v.string(),
    direction: v.string(),
    oldCredentialId: v.string(),
    newCredentialId: v.string(),
    state: v.string(),
    packet: v.any(),
    peerPublicKey: v.string(),
    localPublicKey: v.string(),
    requestDigest: v.string(),
    response: v.optional(v.any()),
    ephemeralPrivateEncrypted: v.optional(v.string()),
    previousCredentialEncrypted: v.optional(v.string()),
    overlapUntil: v.number(),
    createdAt: v.number(),
    attempts: v.number(),
    retiredAt: v.optional(v.number()),
    nextRetryAt: v.number(),
    lastError: v.optional(v.string()),
  })
    .index('rotation', ['peerTownId', 'direction', 'rotationId'])
    .index('credential', ['peerTownId', 'newCredentialId'])
    .index('old_credential', ['peerTownId', 'oldCredentialId', 'state'])
    .index('peer_state', ['peerTownId', 'state'])
    .index('retry', ['state', 'nextRetryAt'])
    .index('expiry', ['retiredAt', 'overlapUntil']),
};

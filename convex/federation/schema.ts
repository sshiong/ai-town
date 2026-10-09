import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { resourceLimits } from './resources';

export const federationTables = {
  migrationHandoffRecords: defineTable({
    handoffId: v.string(), townId: v.string(), body: v.any(), signature: v.string(),
    role: v.string(), acceptedAt: v.number(),
  }).index('handoffId', ['handoffId']).index('townId', ['townId']),
  migrationPeerExchanges: defineTable({
    handoffId: v.string(), peerTownId: v.string(), direction: v.string(),
    request: v.any(), response: v.optional(v.any()),
    ephemeralPrivateEncrypted: v.optional(v.string()), state: v.string(), createdAt: v.number(),
  }).index('exchange', ['handoffId', 'peerTownId', 'direction']),
  federationLlmRequests: defineTable({
    state: v.string(), createdAt: v.number(), deadline: v.number(),
    queueDeadline: v.number(), expiresAt: v.number(),
  }).index('state_created', ['state', 'createdAt']).index('state_expiry', ['state', 'expiresAt']),
  federationTranscriptJobs: defineTable({
    transcriptId: v.string(), visitId: v.string(), worldId: v.id('worlds'),
    conversationId: v.string(), federationConversationId: v.string(), endedAt: v.number(),
    participants: v.any(), cursor: v.optional(v.string()), pageNumber: v.number(),
    state: v.string(), lastError: v.optional(v.string()), createdAt: v.number(),
    nextRetryAt: v.optional(v.number()), attempts: v.optional(v.number()),
    pendingMessages: v.optional(v.array(v.any())), pageReadDone: v.optional(v.boolean()),
    pendingMessageId: v.optional(v.string()), pendingFinalPage: v.optional(v.boolean()),
  }).index('transcript', ['transcriptId']).index('state', ['state', 'createdAt'])
    .index('retry', ['state', 'nextRetryAt']).index('pendingMessage', ['pendingMessageId']),
  federationIdentity: defineTable({
    townId: v.string(), townName: v.string(), publicKey: v.string(), privateKeyEncrypted: v.string(),
    fingerprint: v.string(), deploymentInstanceId: v.string(), deploymentEpoch: v.number(),
    endpoint: v.string(), enabled: v.boolean(), allowIncomingPairRequests: v.boolean(),
    allowUnencryptedHttp: v.boolean(), allowPublicHttp: v.boolean(), maxVisitors: v.number(),
    maxVisitDurationMs: v.number(), replyTimeoutMs: v.optional(v.number()), resourceLimits: v.optional(resourceLimits), mode: v.string(), createdAt: v.number(),
    migrationFrozenAt: v.optional(v.number()), migrationOperator: v.optional(v.string()),
    activeHandoffId: v.optional(v.string()),
  }),
  deploymentRecords: defineTable({ townId: v.string(), deploymentInstanceId: v.string(), deploymentEpoch: v.number(), mode: v.string(), createdAt: v.number() }).index('townId', ['townId']),
  pairRequests: defineTable({
    pairRequestId: v.string(), direction: v.string(), state: v.string(), request: v.any(),
    endpoint: v.string(), secretEncrypted: v.optional(v.string()), ephemeralPrivateEncrypted: v.optional(v.string()),
    response: v.optional(v.any()), credentialEncrypted: v.optional(v.string()),
    requestedAt: v.number(), expiresAt: v.number(), attempts: v.number(),
  }).index('requestId', ['pairRequestId']).index('state', ['state']),
  federationPeers: defineTable({
    townId: v.string(), townName: v.string(), publicKey: v.string(), fingerprint: v.string(),
    deploymentInstanceId: v.string(), deploymentEpoch: v.number(), endpoint: v.string(),
    credentialId: v.string(), credentialEncrypted: v.string(), trustState: v.string(),
    inboundVisitsAllowed: v.boolean(), outboundVisitsAllowed: v.boolean(), pairedAt: v.number(),
    verifiedHandoffId: v.optional(v.string()),
  }).index('townId', ['townId']),
  transportSessions: defineTable({
    peerTownId: v.string(), channelState: v.string(), transportType: v.string(),
    localDeploymentEpoch: v.number(), verifiedPeerDeploymentEpoch: v.number(),
    outboundVerifiedAt: v.optional(v.number()), inboundVerifiedAt: v.optional(v.number()),
    lastReadyAt: v.optional(v.number()), lastError: v.optional(v.string()),
  }).index('peerTownId', ['peerTownId']),
  federationOutbox: defineTable({
    messageId: v.string(), toTownId: v.string(), envelope: v.any(), attempts: v.number(),
    nextRetryAt: v.number(), ackedAt: v.optional(v.number()), failedAt: v.optional(v.number()), lastError: v.optional(v.string()),
  }).index('visit', ['envelope.visitId']).index('messageId', ['messageId']).index('retry', ['ackedAt', 'failedAt', 'nextRetryAt']),
  federationInbox: defineTable({
    messageId: v.string(), fromTownId: v.string(), payloadDigest: v.string(), envelope: v.any(),
    status: v.string(), receivedAt: v.number(), processedAt: v.optional(v.number()), ack: v.optional(v.any()),
  }).index('visit', ['envelope.visitId']).index('messageId', ['messageId']).index('status', ['status', 'receivedAt']),
  messageStreamCursors: defineTable({
    streamKey: v.string(), peerTownId: v.string(), visitIdOrPairSessionId: v.string(), streamId: v.string(),
    senderTownId: v.string(), senderDeploymentEpoch: v.number(), direction: v.string(),
    nextExpectedSequence: v.number(), nextOutgoingSequence: v.number(), lastAckedSequence: v.number(),
    resyncState: v.string(), gapSince: v.optional(v.number()),
  }).index('streamKey', ['streamKey']),
  visitLedger: defineTable({
    visitId: v.string(), agentGlobalId: v.string(), homeTownId: v.string(), hostTownId: v.string(),
    homeDeploymentEpoch: v.number(), hostDeploymentEpoch: v.number(), agentAuthorityEpoch: v.number(),
    visitLeaseVersion: v.number(), leaseExpiry: v.number(), fencingToken: v.string(), state: v.string(),
    role: v.string(), worldId: v.optional(v.id('worlds')), homePlayerId: v.optional(v.string()),
    hostPlayerId: v.optional(v.string()), profile: v.any(), createdAt: v.number(), updatedAt: v.number(),
    cleanupConfirmed: v.optional(v.boolean()), lastError: v.optional(v.string()),
  }).index('visitId', ['visitId']).index('agentGlobalId', ['agentGlobalId']).index('state', ['state']),
  visitReservations: defineTable({ visitId: v.string(), hostTownId: v.string(), expiresAt: v.number(), reservedSlot: v.boolean() }).index('visitId', ['visitId']).index('active', ['reservedSlot', 'expiresAt']),
  federationReplayNonces: defineTable({ peerTownId: v.string(), nonce: v.string(), expiresAt: v.number() }).index('nonce', ['peerTownId', 'nonce']).index('expiry', ['expiresAt']),
};

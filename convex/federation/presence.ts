import { v } from 'convex/values';
export const remoteVisitor = v.object({
  visitId: v.string(),
  agentGlobalId: v.string(),
  homeTownId: v.string(),
  homeTownName: v.string(),
  agentAuthorityEpoch: v.number(),
  visitLeaseVersion: v.number(),
  leaseExpiry: v.number(),
  replyTimeoutMs: v.optional(v.number()),
  lastObservationAt: v.number(),
  pendingTurn: v.optional(
    v.object({ eventId: v.string(), turnId: v.string(), deadline: v.number() }),
  ),
});

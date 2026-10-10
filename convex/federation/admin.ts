import { replyTimeoutMs } from './replyPolicy';
import { action, internalMutation, mutation, query } from '../maintenanceFunctions';
import { v } from 'convex/values';
import { createIdentityKeys, requireAdmin, randomSecret } from './security';
import { identity } from './store';
import { normalizeEndpoint } from './protocol';
import { actionRef, mutationRef } from './refs';
import { resourceLimits, validateResourceLimits, configuredResourceLimits, pendingDecisionCount } from './resources';
import { remoteEventRate, resourceMeasurements, sourceVisitorQuota } from './resourceMonitoring';
import { visitorQueueSummary } from './visitorQueue';
import { commitLocalEndpoint } from './endpoints';
export const configureResources = mutation({
  args: { adminToken: v.string(), limits: resourceLimits },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    validateResourceLimits(args.limits);
    const local = await identity(ctx);
    if (!local) throw new Error('INITIALIZE_IDENTITY_FIRST');
    // Reducing a budget pauses new admissions; existing residents and work are retained.
    await ctx.db.insert('federationResourceAudit', { operation: 'LIMITS_CHANGED',
      previous: local.resourceLimits ?? await configuredResourceLimits(ctx.db), next: args.limits, createdAt: Date.now() });
    await ctx.db.patch(local._id, { resourceLimits: args.limits });
  },
});
export const initialize = action({
  args: {
    adminToken: v.string(),
    townName: v.string(),
    endpoint: v.string(),
    maxVisitors: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    if (!args.townName.trim() || args.townName.length > 80) throw new Error('INVALID_TOWN_NAME');
    const keys = await createIdentityKeys();
    return await ctx.runMutation(mutationRef('admin/saveIdentity'), {
      ...keys,
      townName: args.townName.trim(),
      endpoint: normalizeEndpoint(args.endpoint),
      maxVisitors: args.maxVisitors ?? 8,
    });
  },
});
export const saveIdentity = internalMutation({
  args: {
    townName: v.string(),
    endpoint: v.string(),
    publicKey: v.string(),
    privateKeyEncrypted: v.string(),
    fingerprint: v.string(),
    maxVisitors: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await identity(ctx);
    if (existing) return { townId: existing.townId };
    if (!Number.isSafeInteger(args.maxVisitors) || args.maxVisitors < 0 || args.maxVisitors > 100)
      throw new Error('INVALID_CAPACITY');
    const townId = `town:${crypto.randomUUID()}`;
    const deploymentInstanceId = crypto.randomUUID();
    await ctx.db.insert('federationIdentity', {
      ...args,
      townId,
      deploymentInstanceId,
      deploymentEpoch: 1,
      enabled: true,
      allowIncomingPairRequests: true,
      allowUnencryptedHttp: false,
      allowPublicHttp: false,
      maxVisitDurationMs: 5 * 60_000,
      mode: 'ACTIVE',
      createdAt: Date.now(),
    });
    await ctx.db.insert('deploymentRecords', {
      townId,
      deploymentInstanceId,
      deploymentEpoch: 1,
      mode: 'ACTIVE',
      createdAt: Date.now(),
    });
    return { townId };
  },
});
export const generatePairingSecret = action({
  args: { adminToken: v.string() },
  handler: async (_ctx, args) => {
    requireAdmin(args.adminToken);
    return { pairingSecret: randomSecret() };
  },
});
export const configure = mutation({
  args: {
    adminToken: v.string(),
    enabled: v.boolean(),
    allowIncomingPairRequests: v.boolean(),
    maxVisitors: v.number(),
    maxVisitDurationMs: v.number(),
    replyTimeoutMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const local = await identity(ctx);
    if (!local) throw new Error('INITIALIZE_IDENTITY_FIRST');
    if (
      !Number.isSafeInteger(args.maxVisitors) ||
      args.maxVisitors < 0 ||
      args.maxVisitors > 100 ||
      args.maxVisitDurationMs < 60_000 ||
      args.maxVisitDurationMs > 30 * 60_000
    )
      throw new Error('INVALID_CAPACITY_OR_DURATION');
    if (local.mode !== 'ACTIVE' && args.enabled) throw new Error('DEPLOYMENT_NOT_ACTIVE');
    await ctx.db.patch(local._id, {
      enabled: args.enabled,
      allowIncomingPairRequests: args.allowIncomingPairRequests,
      maxVisitors: args.maxVisitors,
      maxVisitDurationMs: args.maxVisitDurationMs,
      replyTimeoutMs: replyTimeoutMs(args.replyTimeoutMs ?? local.replyTimeoutMs),
    });
  },
});
export const status = query({
  args: { adminToken: v.string() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const local = await identity(ctx);
    const peers = await ctx.db.query('federationPeers').take(100);
    const limits = await configuredResourceLimits(ctx.db);
    const worlds = await ctx.db.query('worlds').collect();
    const now = Date.now();
    const pendingDecisions = await pendingDecisionCount(ctx.db, now);
    const pendingChat = await ctx.db.query('federationLlmRequests')
      .withIndex('state_expiry', q => q.eq('state', 'PENDING').gt('expiresAt', now)).take(1001);
    const runningChat = await ctx.db.query('federationLlmRequests')
      .withIndex('state_expiry', q => q.eq('state', 'RUNNING').gt('expiresAt', now)).take(33);
    const sessions = await ctx.db.query('transportSessions').take(100);
    const requests = await ctx.db.query('pairRequests').order('desc').take(100);
    const unreadRequests = await ctx.db.query('pairRequests').withIndex('direction_read', q => q.eq('direction', 'INBOUND').eq('readAt', undefined)).take(1001);
    const visibleRequests = [...unreadRequests.slice(0, 100), ...requests.filter(request => !unreadRequests.some(unread => unread._id === request._id))].slice(0, 100);
    const visits = await ctx.db.query('visitLedger').order('desc').take(100);
    const slots = await ctx.db
      .query('visitReservations')
      .withIndex('active', (q) => q.eq('reservedSlot', true))
      .collect();
    const slotLedgers = await Promise.all(
      slots.map((slot) =>
        ctx.db
          .query('visitLedger')
          .withIndex('visitId', (q) => q.eq('visitId', slot.visitId))
          .unique(),
      ),
    );
    const activeSlots = slots.filter((slot, index) => slot.expiresAt > now ||
      slotLedgers[index]?.role === 'host' && ['CREATING', 'ACTIVE', 'REMOVING'].includes(slotLedgers[index]!.state));
    const reservations = slots.filter((slot, index) => slot.expiresAt > now && slotLedgers[index]?.state === 'RESERVED').length;
    const chatQueueFull = pendingChat.length >= limits.maxPendingLocalLLM &&
      (pendingChat.length > 0 || runningChat.length >= limits.maxConcurrentLocalLLM);
    const admissionState = !local?.enabled || local.mode !== 'ACTIVE' ? 'CLOSED'
      : activeSlots.length >= local.maxVisitors || reservations >= limits.maxVisitReservations ? 'FULL'
      : pendingDecisions >= limits.maxPendingDecisions || chatQueueFull || !limits.maxConcurrentLocalLLM ? 'DEGRADED' : 'OPEN';
    const sourceOccupancy = new Map<string, number>();
    for (const slot of activeSlots) {
      const ledger = slotLedgers[slots.indexOf(slot)];
      if (ledger?.role === 'host') sourceOccupancy.set(ledger.homeTownId, (sourceOccupancy.get(ledger.homeTownId) ?? 0) + 1);
    }
    return {
      resources: {
        limits, admissionState,
        visitorQueue: await visitorQueueSummary(ctx.db),
        residents: worlds.reduce((count, world) => count + world.agents.length, 0),
        humans: worlds.reduce((count, world) => count + world.players.filter(p => p.human).length, 0),
        reservations, pendingDecisions, pendingLocalLLM: pendingChat.length, runningLocalLLM: runningChat.length,
        cpu: null, memory: null,
        measurements: await resourceMeasurements(ctx.db, now),
        maxVisitorsPerSourceTown: await sourceVisitorQuota(ctx.db),
        maxRemoteEventsPerSecond: await remoteEventRate(ctx.db),
        sourceOccupancy: [...sourceOccupancy].map(([townId, occupied]) => ({ townId, occupied })),
        audit: await ctx.db.query('federationResourceAudit').withIndex('created').order('desc').take(25),
      },
      capacity: {
        reserved: slots.filter(
          (slot, index) =>
            slot.expiresAt > Date.now() ||
            (slotLedgers[index]?.role === 'host' &&
              ['CREATING', 'ACTIVE', 'REMOVING'].includes(slotLedgers[index]!.state)),
        ).length,
        maxVisitors: local?.maxVisitors ?? 8,
      },
      identity: local
        ? {
            townId: local.townId,
            townName: local.townName,
            fingerprint: local.fingerprint,
            publicKey: local.publicKey,
            endpoint: local.endpoint,
            deploymentInstanceId: local.deploymentInstanceId,
            deploymentEpoch: local.deploymentEpoch,
            mode: local.mode,
          }
        : null,
      settings: {
        enabled: local?.enabled ?? false,
        allowIncomingPairRequests: local?.allowIncomingPairRequests ?? false,
        maxVisitors: local?.maxVisitors ?? 8,
        maxVisitDurationMs: local?.maxVisitDurationMs ?? 300_000,
        replyTimeoutMs: local?.replyTimeoutMs ?? 25_000,
        allowUnencryptedHttp: false,
        allowPublicHttp: false,
        httpPayloadProtectionMode: 'DISABLED',
        httpUnavailableReason: 'HTTP_AUTH_LIBRARY_UNAVAILABLE',
      },
      peers: peers.map(
        ({
          townId,
          townName,
          fingerprint,
          endpoint,
          trustState,
          inboundVisitsAllowed,
          outboundVisitsAllowed,
        }) => {
          const state = sessions.find((s) => s.peerTownId === townId);
          const expired =
            !state?.outboundVerifiedAt ||
            !state?.inboundVerifiedAt ||
            Math.min(state.outboundVerifiedAt, state.inboundVerifiedAt) < Date.now() - 120_000;
          return {
            townId,
            townName,
            fingerprint,
            endpoint,
            trustState,
            inboundVisitsAllowed,
            outboundVisitsAllowed,
            readinessExpiresAt:
              Math.min(state?.outboundVerifiedAt ?? 0, state?.inboundVerifiedAt ?? 0) +
              (state?.outboundVerifiedAt && state?.inboundVerifiedAt ? 120000 : 0),
            channelState:
              expired && state?.channelState === 'TRANSPORT_READY'
                ? 'TRANSPORT_TESTING'
                : (state?.channelState ?? 'TRANSPORT_TESTING'),
            lastError: state?.lastError,
            transportType: 'DIRECT_HTTPS',
          };
        },
      ),
      unreadPairRequests: unreadRequests.length,
      pairRequests: visibleRequests.map((r) => ({
        pairRequestId: r.pairRequestId,
        direction: r.direction,
        state:
          r.expiresAt <= now && !['TRUSTED', 'REJECTED', 'AUTH_FAILED', 'CANCELLED', 'CANCEL_PENDING'].includes(r.state)
            ? 'EXPIRED'
            : r.state,
        endpoint: r.endpoint,
        claimedTownId: r.direction === 'INBOUND' ? r.request.townId : r.request.targetTownId,
        claimedTownName: r.direction === 'INBOUND' ? r.request.townName : r.targetIdentity?.townName,
        fingerprint: r.direction === 'INBOUND' ? r.request.fingerprint : r.targetIdentity?.fingerprint,
        protocol: r.direction === 'INBOUND' ? r.request.protocol : r.targetIdentity?.protocol,
        identityVerified: r.state === 'TRUSTED',
        unread: r.direction === 'INBOUND' && r.readAt === undefined,
        requestedAt: r.requestedAt,
        retryAfter: r.requestedAt + 60_000,
        expiresAt: r.expiresAt,
      })),
      visits: visits.map(
        ({
          visitId,
          agentGlobalId,
          homeTownId,
          hostTownId,
          state,
          role,
          leaseExpiry,
          agentAuthorityEpoch,
          visitLeaseVersion,
          lastError,
          queuedAt, queueExpiresAt, queueReason, queuePaused, allowQueue, requestOrigin, autonomousPolicyRevision,
        }) => ({
          visitId,
          agentGlobalId,
          homeTownId,
          hostTownId,
          state,
          role,
          leaseExpiry,
          agentAuthorityEpoch,
          visitLeaseVersion,
          lastError,
          queuedAt, queueExpiresAt, queueReason, queuePaused, allowQueue, requestOrigin, autonomousPolicyRevision,
        }),
      ),
    };
  },
});

export const updateLocalEndpoint = mutation({
  args: { adminToken: v.string(), endpoint: v.string(), operator: v.optional(v.string()), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    return commitLocalEndpoint(ctx, { endpoint: args.endpoint,
      operator: args.operator ?? 'Local administrator', reason: args.reason ?? 'Administrator changed the town address' });
  },
});

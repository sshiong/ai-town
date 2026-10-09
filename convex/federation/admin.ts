import { replyTimeoutMs } from './replyPolicy';
import { action, internalMutation, mutation, query } from '../maintenanceFunctions';
import { v } from 'convex/values';
import { createIdentityKeys, requireAdmin, randomSecret } from './security';
import { identity } from './store';
import { normalizeEndpoint } from './protocol';
import { actionRef, mutationRef } from './refs';
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
    const sessions = await ctx.db.query('transportSessions').take(100);
    const requests = await ctx.db.query('pairRequests').order('desc').take(100);
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
    return {
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
      pairRequests: requests.map((r) => ({
        pairRequestId: r.pairRequestId,
        direction: r.direction,
        state:
          r.expiresAt < Date.now() && !['TRUSTED', 'REJECTED'].includes(r.state)
            ? 'EXPIRED'
            : r.state,
        endpoint: r.endpoint,
        claimedTownId: r.request.townId,
        claimedTownName: r.request.townName,
        fingerprint: r.request.fingerprint,
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
        }),
      ),
    };
  },
});

export const updateLocalEndpoint = mutation({
  args: { adminToken: v.string(), endpoint: v.string() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const local = await identity(ctx);
    if (!local) throw new Error('INITIALIZE_IDENTITY_FIRST');
    if (local.mode !== 'ACTIVE') throw new Error('DEPLOYMENT_NOT_ACTIVE');
    const endpoint = normalizeEndpoint(args.endpoint);
    if (local.endpoint === endpoint) return { townId: local.townId, endpoint };
    await ctx.db.patch(local._id, { endpoint });
    const connections = await ctx.db.query('transportSessions').collect();
    for (const connection of connections) {
      await ctx.db.patch(connection._id, {
        channelState: 'TRANSPORT_TESTING',
        inboundVerifiedAt: undefined,
        outboundVerifiedAt: undefined,
        lastError: undefined,
      });
      const remote = await ctx.db
        .query('federationPeers')
        .withIndex('townId', (q) => q.eq('townId', connection.peerTownId))
        .unique();
      if (local.enabled && remote?.trustState === 'TRUSTED')
        await ctx.scheduler.runAfter(0, actionRef('transport/probeInternal'), {
          peerTownId: remote.townId,
        });
    }
    return { townId: local.townId, endpoint };
  },
});

import type { HttpRouter } from 'convex/server';
import { internalQuery, httpAction } from '../_generated/server';
import { identity } from './store';
import { configuredResourceLimits, pendingDecisionCount } from './resources';
import { remoteEventRate, sourceVisitorQuota } from './resourceMonitoring';
import { PROTOCOL } from './protocol';
import { queryRef } from './refs';
import { sign } from './security';

const MAX_COUNT = 1001;
export const signingSnapshot = internalQuery({
  args: {},
  handler: async (ctx) => {
    const local = await identity(ctx);
    if (!local) return null;
    const now = Date.now(),
      limits = await configuredResourceLimits(ctx.db);
    const slots = await ctx.db
      .query('visitReservations')
      .withIndex('active', (q) => q.eq('reservedSlot', true))
      .take(MAX_COUNT);
    let occupied = 0,
      reserved = 0;
    for (const slot of slots) {
      const ledger = await ctx.db
        .query('visitLedger')
        .withIndex('visitId', (q) => q.eq('visitId', slot.visitId))
        .unique();
      if (
        slot.expiresAt > now ||
        (ledger?.role === 'host' && ['CREATING', 'ACTIVE', 'REMOVING'].includes(ledger.state))
      )
        occupied++;
      if (slot.expiresAt > now && ledger?.state === 'RESERVED') reserved++;
    }
    const pending = await pendingDecisionCount(ctx.db, now);
    const pendingChat = await ctx.db
      .query('federationLlmRequests')
      .withIndex('state_expiry', (q) => q.eq('state', 'PENDING').gt('expiresAt', now))
      .take(MAX_COUNT);
    const runningChat = await ctx.db
      .query('federationLlmRequests')
      .withIndex('state_expiry', (q) => q.eq('state', 'RUNNING').gt('expiresAt', now))
      .take(33);
    const maintenance = !!(await ctx.db
      .query('backupMaintenanceLocks')
      .withIndex('key', (q) => q.eq('key', 'town'))
      .unique());
    const sourceQuota = await sourceVisitorQuota(ctx.db);
    const countsAreLowerBounds =
      slots.length === MAX_COUNT ||
      pending >= MAX_COUNT ||
      pendingChat.length === MAX_COUNT ||
      runningChat.length === 33;
    const reasons: string[] = [];
    if (!local.enabled) reasons.push('FEDERATION_DISABLED');
    if (local.mode !== 'ACTIVE') reasons.push('DEPLOYMENT_NOT_ACTIVE');
    if (maintenance) reasons.push('MAINTENANCE');
    if (occupied >= local.maxVisitors) reasons.push('VISITOR_CAPACITY');
    if (reserved >= limits.maxVisitReservations) reasons.push('RESERVATION_CAPACITY');
    if (sourceQuota === 0) reasons.push('SOURCE_QUOTA_ZERO');
    if (pending >= limits.maxPendingDecisions) reasons.push('DECISION_BACKLOG');
    const chatQueueFull =
      pendingChat.length >= limits.maxPendingLocalLLM &&
      (pendingChat.length > 0 || runningChat.length >= limits.maxConcurrentLocalLLM);
    if (chatQueueFull) reasons.push('CHAT_BACKLOG');
    if (!limits.maxConcurrentLocalLLM) reasons.push('LOCAL_LLM_PAUSED');
    if (countsAreLowerBounds) reasons.push('CAPACITY_SAMPLE_LIMIT');
    const state =
      !local.enabled || local.mode !== 'ACTIVE' || maintenance
        ? 'CLOSED'
        : occupied >= local.maxVisitors ||
            reserved >= limits.maxVisitReservations ||
            sourceQuota === 0
          ? 'FULL'
          : pending >= limits.maxPendingDecisions ||
              chatQueueFull ||
              !limits.maxConcurrentLocalLLM ||
              countsAreLowerBounds
            ? 'DEGRADED'
            : 'OPEN';
    // Whitelist the public fields. Admin status, peers, per-source occupancy,
    // residents, profile routes, leases and observations never enter this body.
    const body = {
      protocol: PROTOCOL,
      kind: 'CAPABILITIES' as const,
      schemaVersion: 1 as const,
      townId: local.townId,
      townName: local.townName,
      publicKey: local.publicKey,
      fingerprint: local.fingerprint,
      deploymentInstanceId: local.deploymentInstanceId,
      deploymentEpoch: local.deploymentEpoch,
      sentAt: now,
      expiresAt: now + 30_000,
      transports: ['DIRECT_HTTPS'],
      actions: [
        'say',
        'moveTo',
        'inviteToTalk',
        'acceptInvite',
        'rejectInvite',
        'leaveConversation',
        'leaveTown',
        'wait',
      ],
      admission: {
        state,
        reasons,
        indicationOnly: true,
        authorization: 'TRUST_POLICY_AND_ATOMIC_RESERVATION_REQUIRED',
        visitorQueue: 'REJECT_AND_RETRY',
        observationScheduling: 'LEAST_RECENT_SOURCE_WITH_VISITOR_ROUNDS',
        chatScheduling: 'GLOBAL_FIFO_WITH_QUEUE_DEADLINE',
      },
      capacity: {
        maxVisitors: local.maxVisitors,
        occupiedVisitorsAndReservations: occupied,
        remainingVisitorSlots:
          slots.length === MAX_COUNT ? null : Math.max(0, local.maxVisitors - occupied),
        reservations: reserved,
        maxVisitReservations: limits.maxVisitReservations,
        maxVisitorsPerSourceTown: sourceQuota,
        maxVisitDurationMs: local.maxVisitDurationMs,
        pendingDecisions: pending,
        maxPendingDecisions: limits.maxPendingDecisions,
        pendingLocalLLM: pendingChat.length,
        maxPendingLocalLLM: limits.maxPendingLocalLLM,
        runningLocalLLM: runningChat.length,
        maxConcurrentLocalLLM: limits.maxConcurrentLocalLLM,
        maxRemoteEventsPerSecond: await remoteEventRate(ctx.db),
        countsAreLowerBounds,
        cpu: null,
        memory: null,
        hostMeasurements: 'UNAVAILABLE',
      },
    };
    return { body, privateKeyEncrypted: local.privateKeyEncrypted };
  },
});

export function registerCapacityRoutes(http: HttpRouter) {
  http.route({
    path: '/federation/v1/capabilities',
    method: 'GET',
    handler: httpAction(async (ctx) => {
      const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
      try {
        const snapshot = await ctx.runQuery(queryRef('capacity/signingSnapshot'), {});
        if (!snapshot)
          return new Response(JSON.stringify({ error: 'FEDERATION_UNAVAILABLE' }), {
            status: 503,
            headers,
          });
        return new Response(
          JSON.stringify({
            body: snapshot.body,
            signature: await sign(snapshot.body, snapshot.privateKeyEncrypted),
          }),
          { headers },
        );
      } catch {
        return new Response(JSON.stringify({ error: 'FEDERATION_UNAVAILABLE' }), {
          status: 503,
          headers,
        });
      }
    }),
  });
}

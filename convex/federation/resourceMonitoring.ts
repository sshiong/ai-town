import { v } from 'convex/values';
import { DatabaseReader, MutationCtx, internalMutation, mutation } from '../maintenanceFunctions';
import { constantTimeEqual, requireAdmin } from './security';
import { hostResourceThresholds, validateHostResourceThresholds } from './resourceValidators';
import { identity } from './store';
import { configuredVisitorQueue, drainVisitorQueue } from './visitorQueue';
import { beginReturn } from './ledger';
import { mutationRef } from './refs';

const BUCKET_MS = 10_000;
const WINDOW_MS = 300_000;
const RETENTION_MS = 24 * 60 * 60_000;
const MAX_SAMPLES_PER_BUCKET = 256;

export const configureHostResources = mutation({
  args: { adminToken: v.string(), thresholds: v.union(hostResourceThresholds, v.null()) },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    if (args.thresholds !== null) validateHostResourceThresholds(args.thresholds);
    if (!(await identity(ctx))) throw new Error('INITIALIZE_IDENTITY_FIRST');
    const previous = await ctx.db.query('federationResourcePolicy').unique();
    if (previous) await ctx.db.patch(previous._id, { hostResourceThresholds: args.thresholds });
    else await ctx.db.insert('federationResourcePolicy', {
      maxVisitorsPerSourceTown: null, hostResourceThresholds: args.thresholds,
    });
    await ctx.db.insert('federationResourceAudit', {
      operation: 'HOST_RESOURCE_THRESHOLDS_CHANGED', previous: previous?.hostResourceThresholds ?? null,
      next: args.thresholds, createdAt: Date.now(),
    });
  },
});

// This credential authorizes only readings from an administrator's co-located
// collector. Peers and browser clients cannot attest host CPU or memory health.
export const reportHostResources = mutation({
  args: {
    reportToken: v.string(), townId: v.string(), deploymentInstanceId: v.string(), deploymentEpoch: v.number(),
    sampleStartedAt: v.number(), measuredAt: v.number(), cpuPercent: v.number(),
    memoryUsedBytes: v.number(), memoryTotalBytes: v.number(), scope: v.literal('OS_HOST'),
  },
  handler: async (ctx, args) => {
    const expected = process.env.FEDERATION_RESOURCE_REPORT_TOKEN;
    if (!expected || expected.length < 32 || expected === process.env.FEDERATION_ADMIN_TOKEN ||
        !constantTimeEqual(args.reportToken, expected)) throw new Error('RESOURCE_REPORT_UNAUTHORIZED');
    const local = await identity(ctx);
    if (!local || args.townId !== local.townId || args.deploymentInstanceId !== local.deploymentInstanceId ||
        args.deploymentEpoch !== local.deploymentEpoch) throw new Error('RESOURCE_REPORT_DEPLOYMENT_MISMATCH');
    const now = Date.now(), duration = args.measuredAt - args.sampleStartedAt;
    if (!Number.isSafeInteger(args.measuredAt) || !Number.isSafeInteger(args.sampleStartedAt) ||
        duration < 1000 || duration > 60000 || args.measuredAt > now || now - args.measuredAt > 30000 ||
        !Number.isFinite(args.cpuPercent) || args.cpuPercent < 0 || args.cpuPercent > 100 ||
        !Number.isSafeInteger(args.memoryTotalBytes) || args.memoryTotalBytes <= 0 ||
        !Number.isSafeInteger(args.memoryUsedBytes) || args.memoryUsedBytes < 0 ||
        args.memoryUsedBytes > args.memoryTotalBytes) throw new Error('INVALID_HOST_RESOURCE_MEASUREMENT');
    const previous = await ctx.db.query('federationHostResources').unique();
    if (previous?.townId === local.townId && previous.deploymentInstanceId === local.deploymentInstanceId &&
        previous.deploymentEpoch === local.deploymentEpoch && args.measuredAt <= previous.measuredAt)
      throw new Error('STALE_HOST_RESOURCE_REPORT');
    const { reportToken: _reportToken, ...readings } = args;
    const fields = { ...readings, receivedAt: now };
    if (previous) await ctx.db.replace(previous._id, fields);
    else await ctx.db.insert('federationHostResources', fields);
  },
});

export async function hostResourceHealth(db: DatabaseReader, now = Date.now()) {
  const thresholds = (await db.query('federationResourcePolicy').unique())?.hostResourceThresholds ?? null;
  const local = await db.query('federationIdentity').unique();
  const sample = await db.query('federationHostResources').unique();
  const sameDeployment = !!sample && !!local && sample.townId === local.townId &&
    sample.deploymentInstanceId === local.deploymentInstanceId && sample.deploymentEpoch === local.deploymentEpoch;
  const fresh = sameDeployment && sample.measuredAt <= now && sample.receivedAt <= now &&
    now - sample.measuredAt <= (thresholds?.maxSampleAgeMs ?? 30000);
  const status = !sample ? 'UNAVAILABLE' : !sameDeployment ? 'DEPLOYMENT_MISMATCH' : !fresh ? 'STALE' : 'AVAILABLE';
  const cpu = fresh ? sample.cpuPercent : null;
  const memory = fresh ? {
    usedBytes: sample.memoryUsedBytes, totalBytes: sample.memoryTotalBytes,
    usedPercent: 100 * sample.memoryUsedBytes / sample.memoryTotalBytes,
  } : null;
  const reasons: string[] = [];
  if (thresholds) {
    if (!fresh) reasons.push(`HOST_RESOURCE_MEASUREMENTS_${status}`);
    else {
      if (cpu! >= thresholds.maxCpuPercent) reasons.push('HOST_CPU_THRESHOLD');
      if (memory!.usedPercent >= thresholds.maxMemoryPercent) reasons.push('HOST_MEMORY_THRESHOLD');
    }
  }
  return {
    cpu, memory, status, thresholds, reasons,
    scope: sample?.scope ?? null, measuredAt: sample?.measuredAt ?? null,
    receivedAt: sample?.receivedAt ?? null,
    sampleIntervalMs: sample ? sample.measuredAt - sample.sampleStartedAt : null,
  };
}
export { resourceMetricKind } from './resourceValidators';
type MetricKind =
  | 'CHAT_QUEUE'
  | 'CHAT_PROVIDER'
  | 'CHAT_SUCCESS'
  | 'CHAT_FAILURE'
  | 'CHAT_ABANDONED'
  | 'INBOUND_EVENT'
  | 'DECISION_SUCCESS'
  | 'DECISION_FAILURE';

export async function recordResourceMetric(
  ctx: MutationCtx,
  kind: MetricKind,
  durationMs?: number,
) {
  const now = Date.now(),
    bucketStart = Math.floor(now / BUCKET_MS) * BUCKET_MS;
  if (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs < 0))
    throw new Error('INVALID_RESOURCE_MEASUREMENT');
  const bucket = await ctx.db
    .query('federationResourceMetrics')
    .withIndex('kind_bucket', (q) => q.eq('kind', kind).eq('bucketStart', bucketStart))
    .unique();
  const samples =
    durationMs === undefined
      ? (bucket?.samples ?? [])
      : [...(bucket?.samples ?? []), durationMs].slice(-MAX_SAMPLES_PER_BUCKET);
  const values = {
    kind,
    bucketStart,
    count: (bucket?.count ?? 0) + 1,
    durationCount: (bucket?.durationCount ?? 0) + (durationMs === undefined ? 0 : 1),
    durationSumMs: (bucket?.durationSumMs ?? 0) + (durationMs ?? 0),
    samples,
  };
  if (bucket) await ctx.db.patch(bucket._id, values);
  else await ctx.db.insert('federationResourceMetrics', values);
  // Aggregate-only data is bounded; no prompts, message bodies or credentials are stored.
  const expired = await ctx.db
    .query('federationResourceMetrics')
    .withIndex('bucket', (q) => q.lt('bucketStart', now - RETENTION_MS))
    .take(100);
  for (const row of expired) await ctx.db.delete(row._id);
}

export async function sourceVisitorQuota(db: DatabaseReader) {
  return (await db.query('federationResourcePolicy').unique())?.maxVisitorsPerSourceTown ?? null;
}
export async function remoteEventRate(db: DatabaseReader) {
  return (await db.query('federationResourcePolicy').unique())?.maxRemoteEventsPerSecond ?? null;
}

const WORK_EVENT_TYPES = new Set(['VISIT_RESERVE', 'OBSERVATION', 'DECISION', 'ACTION_RESULT']);
export async function consumeRemoteEventBudget(ctx: MutationCtx, type: string) {
  // Lease renewals, return/cleanup, stream recovery and durable history remain
  // available under pressure. Retries hit Inbox deduplication before this guard.
  if (!WORK_EVENT_TYPES.has(type)) return;
  const limit = await remoteEventRate(ctx.db);
  if (limit === null) return;
  if (limit === 0) throw new Error('REMOTE_EVENT_RATE_EXCEEDED');
  const previous = await ctx.db.query('federationInboundBudget').unique();
  const now = Date.now();
  const tokens = previous?.limit === limit
    ? Math.min(limit, previous.tokens + Math.max(0, now - previous.measuredAt) * limit / 1000)
    : limit;
  if (tokens < 1) throw new Error('REMOTE_EVENT_RATE_EXCEEDED');
  const next = { tokens: tokens - 1, measuredAt: Math.max(now, previous?.measuredAt ?? now), limit };
  if (previous) await ctx.db.patch(previous._id, next);
  else await ctx.db.insert('federationInboundBudget', next);
}

export const configureRemoteEventRate = mutation({
  args: { adminToken: v.string(), maxRemoteEventsPerSecond: v.union(v.number(), v.null()) },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const value = args.maxRemoteEventsPerSecond;
    if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 1000))
      throw new Error('INVALID_REMOTE_EVENT_RATE');
    if (!(await identity(ctx))) throw new Error('INITIALIZE_IDENTITY_FIRST');
    const previous = await ctx.db.query('federationResourcePolicy').unique();
    if (previous) await ctx.db.patch(previous._id, { maxRemoteEventsPerSecond: value });
    else await ctx.db.insert('federationResourcePolicy', {
      maxVisitorsPerSourceTown: null, maxRemoteEventsPerSecond: value,
    });
    // Repeated saves of the same policy cannot replenish the admission bucket.
    if ((previous?.maxRemoteEventsPerSecond ?? null) !== value) {
      const budget = await ctx.db.query('federationInboundBudget').unique();
      if (budget) await ctx.db.delete(budget._id);
    }
    await ctx.db.insert('federationResourceAudit', {
      operation: 'REMOTE_EVENT_RATE_CHANGED', previous: previous?.maxRemoteEventsPerSecond ?? null,
      next: value, createdAt: Date.now(),
    });
  },
});
export const configureSourceQuota = mutation({
  args: { adminToken: v.string(), maxVisitorsPerSourceTown: v.union(v.number(), v.null()) },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const value = args.maxVisitorsPerSourceTown;
    if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 1000))
      throw new Error('INVALID_SOURCE_VISITOR_QUOTA');
    if (!(await identity(ctx))) throw new Error('INITIALIZE_IDENTITY_FIRST');
    const previous = await ctx.db.query('federationResourcePolicy').unique();
    if (previous) await ctx.db.patch(previous._id, { maxVisitorsPerSourceTown: value });
    else await ctx.db.insert('federationResourcePolicy', { maxVisitorsPerSourceTown: value });
    await ctx.db.insert('federationResourceAudit', {
      operation: 'SOURCE_QUOTA_CHANGED',
      previous: previous?.maxVisitorsPerSourceTown ?? null,
      next: value,
      createdAt: Date.now(),
    });
  },
});

function summarize(
  rows: Array<{ count: number; durationCount: number; durationSumMs: number; samples: number[] }>,
) {
  const count = rows.reduce((total, row) => total + row.count, 0);
  const durationCount = rows.reduce((total, row) => total + row.durationCount, 0);
  const samples = rows.flatMap((row) => row.samples).sort((a, b) => a - b);
  return {
    count,
    durationCount,
    sampleCount: samples.length,
    sampled: samples.length < durationCount,
    meanMs: durationCount
      ? rows.reduce((total, row) => total + row.durationSumMs, 0) / durationCount
      : null,
    p95Ms: samples.length ? samples[Math.ceil(samples.length * 0.95) - 1] : null,
  };
}
export async function resourceMeasurements(db: DatabaseReader, now = Date.now()) {
  // Whole 10-second buckets make the exact observed interval explicit. Rates
  // use this interval's elapsed time, never queue limits or request deadlines.
  const windowStartedAt = Math.floor(now / BUCKET_MS) * BUCKET_MS - WINDOW_MS;
  const buckets = await db
    .query('federationResourceMetrics')
    .withIndex('bucket', (q) => q.gte('bucketStart', windowStartedAt).lte('bucketStart', now))
    .collect();
  const metric = (kind: MetricKind) => summarize(buckets.filter((row) => row.kind === kind));
  const events = metric('INBOUND_EVENT');
  return {
    windowStartedAt,
    measuredAt: now,
    inboundEvents: events.count,
    inboundEventsPerSecond: events.count / ((now - windowStartedAt) / 1000),
    chatQueue: metric('CHAT_QUEUE'),
    chatProvider: metric('CHAT_PROVIDER'),
    chatSucceeded: metric('CHAT_SUCCESS').count,
    chatFailed: metric('CHAT_FAILURE').count,
    chatAbandoned: metric('CHAT_ABANDONED').count,
    decision: metric('DECISION_SUCCESS'),
    failedDecision: metric('DECISION_FAILURE'),
  };
}


/** Disabling a queue terminates waiting authorizations in bounded transactions. */
export const reconcileVisitorQueuePolicy = internalMutation({
  args: {},
  handler: async (ctx) => {
    if ((await configuredVisitorQueue(ctx.db)).enabled) return;
    const waiting = await ctx.db.query('visitLedger')
      .withIndex('role_state_queued', q => q.eq('role', 'host').eq('state', 'QUEUED')).take(16);
    for (const row of waiting) await beginReturn(ctx, row, 'HOST_QUEUE_DISABLED');
    if (waiting.length === 16)
      await ctx.scheduler.runAfter(0, mutationRef('resourceMonitoring/reconcileVisitorQueuePolicy'), {});
  },
});
export const configureVisitorQueue = mutation({
  args: {
    adminToken: v.string(), enabled: v.boolean(), maxQueuedVisits: v.number(),
    visitQueueTtlMs: v.number(), mode: v.union(v.literal('FIFO'), v.literal('SOURCE_ROUND_ROBIN')),
    maxQueuedVisitsPerSourceTown: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    if (!Number.isSafeInteger(args.maxQueuedVisits) || args.maxQueuedVisits < 1 || args.maxQueuedVisits > 1000 ||
        !Number.isSafeInteger(args.visitQueueTtlMs) || args.visitQueueTtlMs < 1000 || args.visitQueueTtlMs > 3600000 ||
        (args.maxQueuedVisitsPerSourceTown !== null && (!Number.isSafeInteger(args.maxQueuedVisitsPerSourceTown) ||
          args.maxQueuedVisitsPerSourceTown < 0 || args.maxQueuedVisitsPerSourceTown > 1000)))
      throw new Error('INVALID_VISITOR_QUEUE_POLICY');
    if (!(await identity(ctx))) throw new Error('INITIALIZE_IDENTITY_FIRST');
    const previous = await configuredVisitorQueue(ctx.db);
    const fields = {
      visitorQueueEnabled: args.enabled, maxQueuedVisits: args.maxQueuedVisits,
      visitQueueTtlMs: args.visitQueueTtlMs, visitorQueueMode: args.mode,
      maxQueuedVisitsPerSourceTown: args.maxQueuedVisitsPerSourceTown,
    };
    const current = await ctx.db.query('federationResourcePolicy').unique();
    if (current) await ctx.db.patch(current._id, fields);
    else await ctx.db.insert('federationResourcePolicy', { maxVisitorsPerSourceTown: null, ...fields });
    await ctx.db.insert('federationResourceAudit', {
      operation: 'VISITOR_QUEUE_POLICY_CHANGED', previous, next: fields, createdAt: Date.now(),
    });
    if (!args.enabled)
      await ctx.scheduler.runAfter(0, mutationRef('resourceMonitoring/reconcileVisitorQueuePolicy'), {});
    else await drainVisitorQueue(ctx);
  },
});

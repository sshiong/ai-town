import { v } from 'convex/values';
import { DatabaseReader, MutationCtx, mutation } from '../maintenanceFunctions';
import { requireAdmin } from './security';
import { identity } from './store';

const BUCKET_MS = 10_000;
const WINDOW_MS = 300_000;
const RETENTION_MS = 24 * 60 * 60_000;
const MAX_SAMPLES_PER_BUCKET = 256;
export const resourceMetricKind = v.union(
  v.literal('CHAT_QUEUE'),
  v.literal('CHAT_PROVIDER'),
  v.literal('CHAT_SUCCESS'),
  v.literal('CHAT_FAILURE'),
  v.literal('CHAT_ABANDONED'),
  v.literal('INBOUND_EVENT'),
  v.literal('DECISION_SUCCESS'),
  v.literal('DECISION_FAILURE'),
);
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

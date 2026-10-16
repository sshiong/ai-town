import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { ActionCtx, internalMutation, mutation, query } from '../maintenanceFunctions';
import type { DatabaseReader, MutationCtx } from '../maintenanceFunctions';
import type { Id } from '../_generated/dataModel';
import { assertFederationAdmin } from '../federation/auth';
import { playerId } from '../aiTown/ids';
import { modelKind, requestQuota, residentRequestQuotas, validateRequestQuota, validateProviderQuotaPortable } from './usageSchema';
export { modelProviderQuotaFields, validateProviderQuotaPortable } from './usageSchema';

const DAY_MS = 86400000;
const zero = { started: 0, succeeded: 0, failed: 0, denied: 0, reportedTokenCalls: 0,
  unknownTokenCalls: 0, totalTokens: 0, retries: 0 };
type Kind = 'CHAT' | 'EMBEDDING';
type Dimension = 'PROVIDER' | 'PROFILE' | 'RESIDENT';
export type UsageOwner = { worldId?: Id<'worlds'>; playerId?: string };
export type UsageRoute = UsageOwner & { profileId: Id<'chatProfiles'> | Id<'embeddingProfiles'> };
export const providerUsageKey = (profile: { provider: string; url: string }) => JSON.stringify([profile.provider, profile.url]);
const residentUsageKey = (worldId: string, id: string) => `${worldId}/${id}`;
const startRef = makeFunctionReference<'mutation'>('models/usage:startCall');
const finishRef = makeFunctionReference<'mutation'>('models/usage:finishCall');
async function bucket(db: DatabaseReader, kind: Kind, dimension: Dimension, key: string, day: number) {
  return db.query('modelUsageBuckets').withIndex('dimension_day', q =>
    q.eq('kind', kind).eq('dimension', dimension).eq('key', key).eq('day', day)).unique();
}
async function increment(ctx: MutationCtx, kind: Kind, dimension: Dimension, key: string, day: number,
  delta: Partial<typeof zero>) {
  const previous = await bucket(ctx.db, kind, dimension, key, day), next = { ...zero };
  for (const field of Object.keys(zero) as Array<keyof typeof zero>)
    next[field] = (previous?.[field] ?? 0) + (delta[field] ?? 0);
  if (previous) await ctx.db.patch(previous._id, next);
  else await ctx.db.insert('modelUsageBuckets', { kind, dimension, key, day, ...next });
}
function auditReason(reason: string) {
  if (!reason.trim() || reason.length > 1000) throw new Error('AUDIT_REASON_REQUIRED');
}
export const configureProviderQuota = mutation({
  args: { adminToken: v.string(), kind: modelKind, providerKey: v.string(), maxRequestsPerDay: requestQuota, reason: v.string() },
  handler: async (ctx, args) => {
    assertFederationAdmin(args.adminToken); auditReason(args.reason);
    validateProviderQuotaPortable({ ...args, updatedAt: Date.now() });
    const previous = await ctx.db.query('modelProviderQuotas').withIndex('provider', q =>
      q.eq('kind', args.kind).eq('providerKey', args.providerKey)).unique();
    const fields = { kind: args.kind, providerKey: args.providerKey, maxRequestsPerDay: args.maxRequestsPerDay, updatedAt: Date.now() };
    if (previous) await ctx.db.patch(previous._id, fields);
    else await ctx.db.insert('modelProviderQuotas', fields);
    await ctx.db.insert('modelAudits', { actor: 'FEDERATION_ADMIN', operation: 'SET_PROVIDER_QUOTA', subject: `${args.kind}/${args.providerKey}`,
      previous: JSON.stringify(previous?.maxRequestsPerDay ?? null), next: JSON.stringify(args.maxRequestsPerDay), reason: args.reason, at: Date.now() });
  },
});
export const configureProfileQuota = mutation({
  args: { adminToken: v.string(), profileId: v.union(v.id('chatProfiles'), v.id('embeddingProfiles')),
    maxRequestsPerDay: requestQuota, reason: v.string() },
  handler: async (ctx, args) => {
    assertFederationAdmin(args.adminToken); auditReason(args.reason); validateRequestQuota(args.maxRequestsPerDay);
    const profile = await ctx.db.get(args.profileId);
    if (!profile) throw new Error('MODEL_PROFILE_NOT_FOUND');
    await ctx.db.patch(profile._id, { dailyRequestLimit: args.maxRequestsPerDay });
    await ctx.db.insert('modelAudits', { actor: 'FEDERATION_ADMIN', operation: 'SET_PROFILE_QUOTA', subject: profile._id,
      previous: JSON.stringify(profile.dailyRequestLimit ?? null), next: JSON.stringify(args.maxRequestsPerDay), reason: args.reason, at: Date.now() });
  },
});
export const configureResidentQuota = mutation({
  args: { adminToken: v.string(), bindingId: v.id('residentModelBindings'), quotas: residentRequestQuotas, reason: v.string() },
  handler: async (ctx, args) => {
    assertFederationAdmin(args.adminToken); auditReason(args.reason);
    validateRequestQuota(args.quotas.chat); validateRequestQuota(args.quotas.embedding);
    const binding = await ctx.db.get(args.bindingId);
    if (!binding) throw new Error('RESIDENT_MODEL_BINDING_MISSING');
    await ctx.db.patch(binding._id, { requestQuotas: args.quotas });
    await ctx.db.insert('modelAudits', { actor: 'FEDERATION_ADMIN', operation: 'SET_RESIDENT_QUOTA', subject: residentUsageKey(binding.worldId, binding.playerId),
      previous: JSON.stringify(binding.requestQuotas ?? null), next: JSON.stringify(args.quotas), reason: args.reason, at: Date.now() });
  },
});

export const startCall = internalMutation({
  args: { kind: modelKind, profileId: v.union(v.id('chatProfiles'), v.id('embeddingProfiles')),
    worldId: v.optional(v.id('worlds')), playerId: v.optional(playerId) },
  handler: async (ctx, args): Promise<{ callId: Id<'modelCallReceipts'> | null; deniedReason?: string }> => {
    const profile = await ctx.db.get(args.profileId);
    if (!profile) throw new Error('MODEL_PROFILE_NOT_FOUND');
    if (profile.disabled) throw new Error('MODEL_PROFILE_DISABLED');
    if ((args.kind === 'CHAT') !== ('stopWords' in profile)) throw new Error('MODEL_PROFILE_KIND_MISMATCH');
    const day = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    const providerKey = providerUsageKey(profile);
    const providerQuota = await ctx.db.query('modelProviderQuotas').withIndex('provider', q =>
      q.eq('kind', args.kind).eq('providerKey', providerKey)).unique();
    const scopes: Array<{ dimension: Dimension; key: string; limit: number | null }> = [
      { dimension: 'PROVIDER', key: providerKey, limit: providerQuota?.maxRequestsPerDay ?? null },
      { dimension: 'PROFILE', key: profile._id, limit: profile.dailyRequestLimit ?? null },
    ];
    let residentKey;
    if (args.worldId && args.playerId) {
      residentKey = residentUsageKey(args.worldId, args.playerId);
      const binding = await ctx.db.query('residentModelBindings').withIndex('resident', q =>
        q.eq('worldId', args.worldId!).eq('playerId', args.playerId!)).unique();
      scopes.push({ dimension: 'RESIDENT', key: residentKey,
        limit: binding?.requestQuotas?.[args.kind === 'CHAT' ? 'chat' : 'embedding'] ?? null });
    } else if (args.worldId || args.playerId) throw new Error('MODEL_USAGE_RESIDENT_IDENTITY_INCOMPLETE');
    let deniedReason;
    for (const scope of scopes)
      if (scope.limit !== null && ((await bucket(ctx.db, args.kind, scope.dimension, scope.key, day))?.started ?? 0) >= scope.limit)
        deniedReason ??= `MODEL_${scope.dimension}_DAILY_QUOTA_EXCEEDED`;
    for (const scope of scopes) await increment(ctx, args.kind, scope.dimension, scope.key, day,
      deniedReason ? { denied: 1 } : { started: 1 });
    if (deniedReason) return { callId: null, deniedReason };
    const callId = await ctx.db.insert('modelCallReceipts', {
      kind: args.kind, profileId: profile._id, providerKey, residentKey, day, startedAt: Date.now(),
    });
    // Telemetry retains thirty daily windows; never retain private request content.
    for (const row of await ctx.db.query('modelUsageBuckets').withIndex('day', q => q.lt('day', day - 30 * DAY_MS)).take(100))
      await ctx.db.delete(row._id);
    for (const row of await ctx.db.query('modelCallReceipts').withIndex('started', q => q.lt('startedAt', Date.now() - 2 * DAY_MS)).take(100))
      await ctx.db.delete(row._id);
    return { callId };
  },
});
export const finishCall = internalMutation({
  args: { callId: v.id('modelCallReceipts'), ok: v.boolean(), totalTokens: v.optional(v.number()), retries: v.optional(v.number()), errorCode: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const call = await ctx.db.get(args.callId);
    if (!call || call.finishedAt !== undefined) return;
    if (args.totalTokens !== undefined && (!Number.isSafeInteger(args.totalTokens) || args.totalTokens < 0) ||
        args.retries !== undefined && (!Number.isSafeInteger(args.retries) || args.retries < 0)) throw new Error('INVALID_MODEL_USAGE');
    // Only fixed categories may be persisted; raw provider exceptions may contain private input.
    const errorCode = args.ok ? undefined : args.errorCode === 'DEADLINE' ? 'DEADLINE' : 'PROVIDER_FAILURE';
    await ctx.db.patch(call._id, { finishedAt: Date.now(), outcome: args.ok ? 'SUCCESS' : 'FAILED', errorCode });
    const delta = { succeeded: args.ok ? 1 : 0, failed: args.ok ? 0 : 1,
      reportedTokenCalls: args.totalTokens === undefined ? 0 : 1,
      unknownTokenCalls: args.totalTokens === undefined || (args.retries ?? 0) > 0 ? 1 : 0,
      totalTokens: args.totalTokens ?? 0, retries: args.retries ?? 0 };
    for (const [dimension, key] of [['PROVIDER', call.providerKey], ['PROFILE', call.profileId], ['RESIDENT', call.residentKey]] as const)
      if (key) await increment(ctx, call.kind, dimension, key, call.day, delta);
  },
});

const SETTLEMENT_BACKOFF_MS = [100, 300, 900];
function isSettlementConflict(error: unknown) {
  return error instanceof Error && error.message.includes(
    'Documents read from or written to the "modelUsageBuckets" table changed while this mutation was being run and on every subsequent retry.',
  );
}
async function settleCall(ctx: ActionCtx, args: {
  callId: Id<'modelCallReceipts'>; ok: boolean; totalTokens?: number; retries?: number; errorCode?: string;
}) {
  for (let attempt = 0; ; attempt++) {
    try {
      await ctx.runMutation(finishRef, args);
      return;
    } catch (error) {
      if (!isSettlementConflict(error) || attempt === SETTLEMENT_BACKOFF_MS.length)
        throw new Error('MODEL_USAGE_SETTLEMENT_FAILED', { cause: error });
      // Reuse the receipt and outcome: finishCall atomically ignores duplicate completion.
      await new Promise(resolve => setTimeout(resolve, SETTLEMENT_BACKOFF_MS[attempt]));
    }
  }
}
/** A logical request, including transport retries, reserves one daily request slot. */
export async function trackedModelCall<T extends { retries?: number }>(ctx: ActionCtx, kind: Kind, route: UsageRoute | undefined,
  run: () => Promise<T>, tokens: (result: T) => number | undefined): Promise<T> {
  if (!route) return run(); // Original environment diagnostics have no persisted Profile.
  const admission: { callId: Id<'modelCallReceipts'> | null; deniedReason?: string } = await ctx.runMutation(startRef, { kind, ...route });
  if (!admission.callId) throw new Error(admission.deniedReason);
  let result: T;
  try {
    result = await run();
  } catch (error) {
    try {
      await settleCall(ctx, { callId: admission.callId, ok: false,
        errorCode: error instanceof Error && error.message === 'CHAT_REQUEST_DEADLINE' ? 'DEADLINE' : 'PROVIDER_FAILURE' });
    } catch (settlementError) {
      throw new AggregateError([error, settlementError], 'MODEL_CALL_AND_USAGE_SETTLEMENT_FAILED', { cause: error });
    }
    throw error;
  }
  const count = tokens(result);
  const totalTokens = Number.isSafeInteger(count) && count! >= 0 ? count : undefined;
  await settleCall(ctx, { callId: admission.callId, ok: true, totalTokens, retries: result.retries });
  return result;
}
export const summary = query({
  args: { adminToken: v.string() },
  handler: async (ctx, args) => {
    assertFederationAdmin(args.adminToken);
    const day = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    const rows = await ctx.db.query('modelUsageBuckets').withIndex('day', q => q.eq('day', day)).take(5001);
    return { day, measuredAt: Date.now(), countsAreLowerBounds: rows.length > 5000,
      buckets: rows.slice(0, 5000).map(row => ({ ...row,
        totalTokens: row.reportedTokenCalls ? row.totalTokens : null,
        errorRate: row.succeeded + row.failed ? row.failed / (row.succeeded + row.failed) : null,
        unfinished: row.started - row.succeeded - row.failed,
      })), providerQuotas: await ctx.db.query('modelProviderQuotas').collect(),
      failures: await ctx.db.query('modelCallReceipts').withIndex('outcome_started', q =>
        q.eq('outcome', 'FAILED').gte('startedAt', day)).order('desc').take(100),
    };
  },
});

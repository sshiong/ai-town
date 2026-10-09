import { Infer, v } from 'convex/values';
import { ActionCtx, DatabaseReader, internalMutation } from '../maintenanceFunctions';
import { MAX_HUMAN_PLAYERS } from '../constants';
import { Id } from '../_generated/dataModel';
import {
  ChatConfig,
  ChatRequestOptions,
  CreateChatCompletionRequest,
  chatCompletion,
} from '../util/llm';
import { sleep } from '../util/sleep';
import { mutationRef } from './refs';
import { recordResourceMetric } from './resourceMonitoring';

export const resourceLimits = v.object({
  maxResidentAgents: v.number(),
  maxHumanPlayers: v.number(),
  maxVisitReservations: v.number(),
  maxConcurrentLocalLLM: v.number(),
  maxPendingDecisions: v.number(),
  maxPendingLocalLLM: v.number(),
});
export type ResourceLimits = Infer<typeof resourceLimits>;
export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  maxResidentAgents: 100,
  maxHumanPlayers: MAX_HUMAN_PLAYERS,
  maxVisitReservations: 100,
  maxConcurrentLocalLLM: 2,
  maxPendingDecisions: 100,
  maxPendingLocalLLM: 100,
};
export function validateResourceLimits(limits: ResourceLimits) {
  const keys = Object.keys(DEFAULT_RESOURCE_LIMITS) as Array<keyof ResourceLimits>;
  if (!limits || typeof limits !== 'object' || Object.keys(limits).length !== keys.length)
    throw new Error('INVALID_RESOURCE_LIMITS');
  for (const key of keys) {
    const value = limits[key];
    const maximum = key === 'maxConcurrentLocalLLM' ? 32 : 1000;
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
      throw new Error(`INVALID_RESOURCE_LIMIT:${key}`);
  }
}
export async function configuredResourceLimits(db: DatabaseReader): Promise<ResourceLimits> {
  const local = await db.query('federationIdentity').unique();
  return local?.resourceLimits ?? DEFAULT_RESOURCE_LIMITS;
}
export async function pendingDecisionCount(db: DatabaseReader, now = Date.now()) {
  const turns = await db
    .query('federationTurns')
    .withIndex('state_deadline', (q) => q.eq('state', 'PENDING').gt('deadline', now))
    .take(1001);
  const remote = await db.query('federationDecisionJobs')
    .filter(q => q.and(
      q.or(q.eq(q.field('state'), 'PENDING'), q.eq(q.field('state'), 'RUNNING')),
      q.gt(q.field('deadline'), now),
    )).take(1001);
  const autonomous = await db.query('autonomousTravelDecisions')
    .withIndex('state', q => q.eq('state', 'RUNNING'))
    .filter(q => q.gt(q.field('deadline'), now)).take(1001);
  return turns.length + remote.length + autonomous.length;
}

// Permits are durable across separate Convex action workers. Requests contain no prompts
// or credentials. The expiry grace allows an aborted HTTP request to finish unwinding.
const REQUEST_TIMEOUT_MS = 90_000;
const QUEUE_TIMEOUT_MS = 30_000;
const EXPIRY_GRACE_MS = 5_000;
export const enqueueChat = internalMutation({
  args: { deadline: v.number() },
  handler: async (ctx, { deadline }) => {
    const now = Date.now();
    if (!Number.isSafeInteger(deadline) || deadline <= now || deadline > now + REQUEST_TIMEOUT_MS)
      throw new Error('INVALID_CHAT_DEADLINE');
    const limits = await configuredResourceLimits(ctx.db);
    if (!limits.maxConcurrentLocalLLM) throw new Error('LOCAL_LLM_PAUSED');
    // Reclaim abandoned permits only after their bounded HTTP deadline plus grace.
    for (const state of ['PENDING', 'RUNNING']) {
      const expired = await ctx.db
        .query('federationLlmRequests')
        .withIndex('state_expiry', (q) => q.eq('state', state).lte('expiresAt', now))
        .take(1001);
      for (const request of expired) {
        await recordResourceMetric(ctx, 'CHAT_ABANDONED');
        await ctx.db.delete(request._id);
      }
    }
    const pending = await ctx.db
      .query('federationLlmRequests')
      .withIndex('state_created', (q) => q.eq('state', 'PENDING'))
      .take(1001);
    const running = await ctx.db
      .query('federationLlmRequests')
      .withIndex('state_expiry', (q) => q.eq('state', 'RUNNING').gt('expiresAt', now))
      .take(33);
    const canRun = pending.length === 0 && running.length < limits.maxConcurrentLocalLLM;
    if (!canRun && pending.length >= limits.maxPendingLocalLLM)
      throw new Error('LOCAL_LLM_QUEUE_FULL');
    return ctx.db.insert('federationLlmRequests', {
      state: canRun ? 'RUNNING' : 'PENDING',
      createdAt: now,
      ...(canRun ? { startedAt: now } : {}),
      deadline,
      queueDeadline: Math.min(deadline, now + QUEUE_TIMEOUT_MS),
      expiresAt: canRun ? deadline + EXPIRY_GRACE_MS : Math.min(deadline, now + QUEUE_TIMEOUT_MS),
    });
  },
});
export const claimChat = internalMutation({
  args: { requestId: v.id('federationLlmRequests') },
  handler: async (ctx, { requestId }) => {
    const request = await ctx.db.get(requestId),
      now = Date.now();
    if (!request || request.deadline <= now) throw new Error('CHAT_REQUEST_DEADLINE');
    if (request.state === 'RUNNING') return true;
    if (request.queueDeadline <= now) throw new Error('LOCAL_LLM_QUEUE_TIMEOUT');
    const limits = await configuredResourceLimits(ctx.db);
    const expired = await ctx.db
      .query('federationLlmRequests')
      .withIndex('state_expiry', (q) => q.eq('state', 'PENDING').lte('expiresAt', now))
      .take(1001);
    for (const row of expired) {
      await recordResourceMetric(ctx, 'CHAT_ABANDONED');
      await ctx.db.delete(row._id);
    }
    const first = await ctx.db
      .query('federationLlmRequests')
      .withIndex('state_created', (q) => q.eq('state', 'PENDING'))
      .first();
    const running = await ctx.db
      .query('federationLlmRequests')
      .withIndex('state_expiry', (q) => q.eq('state', 'RUNNING').gt('expiresAt', now))
      .take(33);
    if (first?._id !== requestId || running.length >= limits.maxConcurrentLocalLLM) return false;
    await ctx.db.patch(requestId, {
      state: 'RUNNING',
      startedAt: now,
      expiresAt: request.deadline + EXPIRY_GRACE_MS,
    });
    return true;
  },
});
export const releaseChat = internalMutation({
  args: { requestId: v.id('federationLlmRequests'), outcome: v.optional(v.union(v.literal('SUCCESS'), v.literal('FAILED'))), providerDurationMs: v.optional(v.number()) },
  handler: async (ctx, { requestId, outcome, providerDurationMs }) => {
    const request = await ctx.db.get(requestId);
    if (!request) return;
    if (outcome) {
      await recordResourceMetric(ctx, outcome === 'SUCCESS' ? 'CHAT_SUCCESS' : 'CHAT_FAILURE');
      if (request.startedAt !== undefined) {
        await recordResourceMetric(ctx, 'CHAT_QUEUE', Math.max(0, request.startedAt - request.createdAt));
        if (providerDurationMs !== undefined) await recordResourceMetric(ctx, 'CHAT_PROVIDER', providerDurationMs);
      } else await recordResourceMetric(ctx, 'CHAT_QUEUE', Math.max(0, Date.now() - request.createdAt));
    }
    await ctx.db.delete(requestId);
  },
});

/** All resident Chat calls, including visiting brains and memory work, share this budget. */
export async function residentChatCompletion(
  ctx: ActionCtx,
  body: Omit<CreateChatCompletionRequest, 'model' | 'stream'> & { model?: string; stream?: false },
  config: ChatConfig,
  options?: ChatRequestOptions,
): Promise<{ content: string; retries: number; ms: number }> {
  const deadline = Math.min(options?.deadline ?? Infinity, Date.now() + REQUEST_TIMEOUT_MS);
  const requestId: Id<'federationLlmRequests'> = await ctx.runMutation(
    mutationRef('resources/enqueueChat'),
    { deadline },
  );
  let outcome: 'SUCCESS' | 'FAILED' = 'FAILED';
  let providerStartedAt: number | undefined;
  try {
    while (!(await ctx.runMutation(mutationRef('resources/claimChat'), { requestId })))
      await sleep(250);
    providerStartedAt = Date.now();
    const result = await chatCompletion(body, config, { deadline });
    outcome = 'SUCCESS';
    return result;
  } finally {
    await ctx.runMutation(mutationRef('resources/releaseChat'), { requestId, outcome,
      ...(providerStartedAt === undefined ? {} : { providerDurationMs: Math.max(0, Date.now() - providerStartedAt) }) });
  }
}

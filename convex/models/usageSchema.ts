import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const modelKind = v.union(v.literal('CHAT'), v.literal('EMBEDDING'));
export const requestQuota = v.union(v.number(), v.null());
export const residentRequestQuotas = v.object({ chat: requestQuota, embedding: requestQuota });
export function validateRequestQuota(value: unknown) {
  if (value !== null && (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1000000))
    throw new Error('INVALID_MODEL_REQUEST_QUOTA');
}
export const modelProviderQuotaFields = {
  kind: modelKind, providerKey: v.string(), maxRequestsPerDay: requestQuota, updatedAt: v.number(),
};
export function validateProviderQuotaPortable(row: Record<string, unknown>) {
  if (!['CHAT', 'EMBEDDING'].includes(String(row.kind)) || typeof row.providerKey !== 'string' ||
      !Number.isSafeInteger(row.updatedAt) || (row.updatedAt as number) < 0) throw new Error('INVALID_MODEL_PROVIDER_QUOTA');
  let key: unknown;
  try { key = JSON.parse(row.providerKey); } catch { throw new Error('INVALID_MODEL_PROVIDER_QUOTA'); }
  if (!Array.isArray(key) || key.length !== 2 || typeof key[0] !== 'string' || !['openai', 'together', 'ollama', 'custom'].includes(key[0]) ||
      typeof key[1] !== 'string') throw new Error('INVALID_MODEL_PROVIDER_QUOTA');
  const url = new URL(key[1]);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('INVALID_MODEL_PROVIDER_QUOTA');
  validateRequestQuota(row.maxRequestsPerDay);
}
/** Validate optional policy fields without requiring them in older archives. */
export function validateModelPolicyPortable(table: string, row: Record<string, unknown>) {
  if (table === 'modelProviderQuotas') validateProviderQuotaPortable(row);
  if (table === 'chatProfiles' || table === 'embeddingProfiles') {
    if (row.disabled !== undefined && typeof row.disabled !== 'boolean') throw new Error('INVALID_MODEL_PROFILE_DISABLED');
    if (row.dailyRequestLimit !== undefined) validateRequestQuota(row.dailyRequestLimit);
  }
  if (table === 'residentModelBindings' && row.requestQuotas !== undefined) {
    const quotas = row.requestQuotas;
    if (!quotas || typeof quotas !== 'object' || Array.isArray(quotas) ||
        Object.keys(quotas).sort().join() !== 'chat,embedding') throw new Error('INVALID_MODEL_REQUEST_QUOTA');
    validateRequestQuota((quotas as Record<string, unknown>).chat);
    validateRequestQuota((quotas as Record<string, unknown>).embedding);
  }
}
export const modelUsageTables = {
  modelProviderQuotas: defineTable(modelProviderQuotaFields).index('provider', ['kind', 'providerKey']),
  modelUsageBuckets: defineTable({
    kind: modelKind, dimension: v.union(v.literal('PROVIDER'), v.literal('PROFILE'), v.literal('RESIDENT')),
    key: v.string(), day: v.number(), started: v.number(), succeeded: v.number(), failed: v.number(), denied: v.number(),
    reportedTokenCalls: v.number(), unknownTokenCalls: v.number(), totalTokens: v.number(), retries: v.number(),
  }).index('dimension_day', ['kind', 'dimension', 'key', 'day']).index('day', ['day']),
  modelCallReceipts: defineTable({
    kind: modelKind, profileId: v.string(), providerKey: v.string(), residentKey: v.optional(v.string()),
    day: v.number(), startedAt: v.number(), finishedAt: v.optional(v.number()), outcome: v.optional(v.string()),
    errorCode: v.optional(v.string()),
  }).index('started', ['startedAt']).index('outcome_started', ['outcome', 'startedAt']),
};

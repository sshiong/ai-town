import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { digest } from './security';
import { sourceNetworkKeys } from './networkPolicy';

const WINDOW_MS = 60_000;
const MAX_BUCKETS = 4096;
export type PublicLimitScope = 'HEALTH' | 'PAIR_SOURCE' | 'PAIR_TOWN' | 'PAIR_ACCOUNT';

export function publicLimitKeys(scope: PublicLimitScope, ip: string | null, claim?: string) {
  if (scope === 'PAIR_TOWN' || scope === 'PAIR_ACCOUNT') {
    if (typeof claim !== 'string' || !claim || claim.length > 400) throw new Error('INVALID_RATE_LIMIT_CLAIM');
    return [{ key: `${scope}:${claim}`, limit: scope === 'PAIR_TOWN' ? 4 : 10 }];
  }
  const health = scope === 'HEALTH';
  return [{ key: `${scope}:global`, limit: health ? 240 : 60 }, ...sourceNetworkKeys(ip).map(key => ({
    key: `${scope}:${key}`, limit: key.startsWith('prefix:') ? health ? 120 : 30 : health ? 60 : 15,
  }))];
}

// Separate transaction from request parsing/signature work: failed requests
// still consume their source budget. Never trust X-Forwarded-For from clients.
export const consume = internalMutation({
  args: { scope: v.union(v.literal('HEALTH'), v.literal('PAIR_SOURCE'), v.literal('PAIR_TOWN'), v.literal('PAIR_ACCOUNT')), claim: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const metadata = await ctx.meta.getRequestMetadata();
    const limits = publicLimitKeys(args.scope, metadata.ip, args.claim);
    const now = Date.now(), windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
    const buckets = await Promise.all(limits.map(async item => {
      const key = await digest(item.key);
      return { ...item, key, row: await ctx.db.query('federationPublicRateLimits').withIndex('key', q => q.eq('key', key)).unique() };
    }));
    if (buckets.some(({ row, limit }) => row && row.windowStart === windowStart && row.count >= limit))
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((windowStart + WINDOW_MS - now) / 1000)) };
    const stale = await ctx.db.query('federationPublicRateLimits').withIndex('expiry', q => q.lte('expiresAt', now)).take(100);
    // Do not delete a row about to be reset below.
    const reused = new Set(buckets.map(bucket => bucket.row?._id));
    for (const row of stale) if (!reused.has(row._id)) await ctx.db.delete(row._id);
    if (buckets.some(bucket => !bucket.row)) {
      const active = await ctx.db.query('federationPublicRateLimits').take(MAX_BUCKETS);
      if (active.length + buckets.filter(bucket => !bucket.row).length > MAX_BUCKETS) return { allowed: false, retryAfter: 60 };
    }
    for (const { key, row } of buckets) {
      const fields = { windowStart, count: row?.windowStart === windowStart ? row.count + 1 : 1, expiresAt: windowStart + WINDOW_MS };
      if (row) await ctx.db.patch(row._id, fields);
      else await ctx.db.insert('federationPublicRateLimits', { key, ...fields });
    }
    return { allowed: true, retryAfter: 0 };
  },
});

export function rateLimitedResponse(retryAfter: number) {
  return new Response(JSON.stringify({ error: 'RATE_LIMITED' }), { status: 429, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': String(retryAfter),
  } });
}

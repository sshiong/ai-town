import { v } from 'convex/values';
import { internalMutation, query } from '../_generated/server';
import { paginationOptsValidator } from 'convex/server';
import { requireAdmin } from './security';

export const exportAttribution = {
  operator: v.optional(v.string()),
  reason: v.optional(v.string()),
};

// A shared admin token authenticates access; an operator label is self-declared,
// not a separately authenticated user identity.
export function attribution(args: { operator?: string; reason?: string }) {
  if (args.operator === undefined && args.reason === undefined)
    return {
      operator: 'Unspecified administrator',
      reason: 'Legacy export client',
      attribution: 'legacy-admin-token' as const,
    };
  const operator = args.operator?.trim();
  const reason = args.reason?.trim();
  if (!operator || operator.length > 200 || !reason || reason.length > 1000)
    throw new Error('BACKUP_EXPORT_ATTRIBUTION_REQUIRED');
  return { operator, reason, attribution: 'declared' as const };
}

export const record = internalMutation({
  args: {
    adminToken: v.string(),
    ...exportAttribution,
    scope: v.union(v.literal('town'), v.literal('resident')),
    sourceTownId: v.string(),
    exportedAt: v.number(),
    manifestDigest: v.string(),
    sectionCounts: v.record(v.string(), v.number()),
    bytes: v.number(),
    worldId: v.optional(v.id('worlds')),
    playerId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    const { adminToken: _adminToken, operator: _operator, reason: _reason, ...summary } = args;
    return ctx.db.insert('backupExportAudits', {
      ...summary,
      ...attribution(args),
      recordedAt: Date.now(),
    });
  },
});

export const history = query({
  args: { adminToken: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    return ctx.db
      .query('backupExportAudits')
      .withIndex('recorded')
      .order('desc')
      .paginate({
        ...args.paginationOpts,
        numItems: Math.max(1, Math.min(30, args.paginationOpts.numItems)),
      });
  },
});

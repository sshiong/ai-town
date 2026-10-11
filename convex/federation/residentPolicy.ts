import { v } from 'convex/values';
import { mutation, query } from '../maintenanceFunctions';
import type { DatabaseReader } from '../_generated/server';
import { requireAdmin } from './security';
import { MAX_DENIED_RESIDENTS, validateResidentGlobalId } from './residentPolicySchema';

export const RESIDENT_VISITS_DENIED = 'RESIDENT_VISITS_DENIED';

/** Admission only: existing leases, idempotent retries and cleanup remain valid. */
export async function residentAdmissionReason(db: DatabaseReader, agentGlobalId: string) {
  const row = await db.query('federationResidentPolicy')
    .withIndex('agentGlobalId', q => q.eq('agentGlobalId', agentGlobalId)).unique();
  return row ? RESIDENT_VISITS_DENIED : undefined;
}

export const status = query({
  args: { adminToken: v.string() },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    return {
      denied: await ctx.db.query('federationResidentPolicy').order('desc').take(MAX_DENIED_RESIDENTS),
      audit: await ctx.db.query('federationResidentPolicyAudit').order('desc').take(100),
      maximum: MAX_DENIED_RESIDENTS,
    };
  },
});

export const set = mutation({
  args: {
    adminToken: v.string(), agentGlobalId: v.string(), denied: v.boolean(),
    operator: v.string(), reason: v.string(),
  },
  handler: async (ctx, args) => {
    requireAdmin(args.adminToken);
    // Match the existing <homeTownId>/agent:<residentId> identity contract,
    // retaining IDs byte-for-byte rather than silently normalizing them.
    validateResidentGlobalId(args.agentGlobalId);
    if (!args.operator.trim() || args.operator.length > 100 || !args.reason.trim() || args.reason.length > 1000)
      throw new Error('RESIDENT_POLICY_REVIEW_DETAILS_REQUIRED');
    const previous = await ctx.db.query('federationResidentPolicy')
      .withIndex('agentGlobalId', q => q.eq('agentGlobalId', args.agentGlobalId)).unique();
    const now = Date.now();
    if (args.denied && !previous) {
      const rows = await ctx.db.query('federationResidentPolicy').take(MAX_DENIED_RESIDENTS);
      if (rows.length >= MAX_DENIED_RESIDENTS) throw new Error('RESIDENT_POLICY_CAPACITY_EXCEEDED');
      await ctx.db.insert('federationResidentPolicy', { agentGlobalId: args.agentGlobalId, createdAt: now, updatedAt: now });
    } else if (args.denied && previous) await ctx.db.patch(previous._id, { updatedAt: Math.max(now, previous.createdAt) });
    else if (previous) await ctx.db.delete(previous._id);
    // Operator is an administrator-supplied label, not a verified user identity.
    // Private review notes are never copied to travel ledgers or peer messages.
    await ctx.db.insert('federationResidentPolicyAudit', {
      agentGlobalId: args.agentGlobalId, operation: args.denied ? 'DENY' : 'ALLOW',
      previousDenied: !!previous, denied: args.denied, operator: args.operator.trim(),
      authenticatedBy: 'FEDERATION_ADMIN_TOKEN', reason: args.reason.trim(), createdAt: now,
    });
    return { agentGlobalId: args.agentGlobalId, denied: args.denied };
  },
});
